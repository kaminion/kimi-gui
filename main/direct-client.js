'use strict';

// CLI-free chat engine: talks directly to the Anthropic-compatible Kimi Code
// endpoint (POST https://api.kimi.com/coding/v1/messages) with the OAuth access
// token from main/auth.js (guarded lazy require; falls back to reading the
// CLI-compatible credentials file read-only when auth.js is unavailable).
//
// runTurn() drives a full agentic turn: stream one request, execute tool_use
// blocks (Bash/Read/Write/Edit/Grep/Glob, cwd-scoped), feed tool_results back,
// repeat (≤25 iterations), then persist the whole turn via store.appendTurn.
//
// NEVER logs tokens or Authorization headers.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const API_URL = (process.env.KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '') + '/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_ITERATIONS = 25;
const MAX_TOKENS = 32768;
const BASH_TIMEOUT_MS = 120000;
const BASH_MAX_OUTPUT = 1024 * 1024; // 1MB
const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 4 * 1024 * 1024;
const GREP_MAX_HITS = 200;
const GLOB_MAX_RESULTS = 500;
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);

// Verified live (docs/direct-api.md): thinking effort maps to Anthropic's
// `thinking` parameter; `thinking:{type:'disabled'}` turns it off.
const EFFORT_BUDGETS = { low: 2048, high: 8192, max: 16384 };
const DEFAULT_MODEL = 'k3';
const DEFAULT_EFFORT = 'high';

const MODELS = [
  { id: 'k3', display_name: 'K3', max_context_size: 1048576 },
  { id: 'kimi-for-coding', display_name: 'Kimi for Coding', max_context_size: 262144 },
  { id: 'kimi-for-coding-highspeed', display_name: 'Kimi for Coding (Highspeed)', max_context_size: 262144 },
];

const SYSTEM_PROMPT = [
  'You are Kimi, a coding assistant running inside the Kimi Desktop app.',
  'You help the user with software engineering tasks in their current working directory.',
  'Working directory (cwd): {{CWD}}. All relative paths resolve against it.',
  '',
  'Tool etiquette:',
  '- Use the provided tools to inspect and modify files; never invent file contents.',
  '- Prefer Read/Grep/Glob before editing; keep changes minimal and focused.',
  '- Use Bash for shell commands; keep them short and non-destructive.',
  '- Never print secrets, tokens, or credentials in tool calls or replies.',
  '- When a task is ambiguous, make a reasonable choice and state it briefly.',
  '',
  'Reply concisely in the user\'s language. Prefer minimal diffs over rewrites.',
].join('\n');

// ---------------------------------------------------------------------------
// Token resolution (auth.js preferred, read-only file fallback)
// ---------------------------------------------------------------------------

function kimiHome() {
  const home = process.env.KIMI_CODE_HOME;
  return home && home.trim() ? home.trim() : path.join(os.homedir(), '.kimi-code');
}

async function resolveAccessToken() {
  try {
    // Lazy + guarded: main/auth.js is owned by another module and may be absent.
    // eslint-disable-next-line global-require
    const auth = require('./auth');
    if (auth && typeof auth.getAccessToken === 'function') {
      const token = await Promise.resolve(auth.getAccessToken());
      if (typeof token === 'string' && token) return token;
    }
  } catch {
    // auth.js missing or failed — fall through to the read-only fallback
  }
  try {
    const raw = await fsp.readFile(path.join(kimiHome(), 'credentials', 'kimi-code.json'), 'utf8');
    const data = JSON.parse(raw);
    const token = data.access_token ?? data.accessToken;
    if (typeof token === 'string' && token) {
      const exp = Number(data.expires_at ?? data.expiresAt ?? 0);
      if (exp) {
        const ms = exp > 1e12 ? exp : exp * 1000;
        if (ms - 60000 <= Date.now()) return null; // expired; refresh needs auth.js
      }
      return token;
    }
  } catch {
    // not logged in
  }
  return null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class DirectApiError extends Error {
  constructor(message, { status, code, retryable } = {}) {
    super(message);
    this.name = 'DirectApiError';
    this.status = status ?? 0;
    this.code = code || 'api_error'; // 'auth' | 'rate_limit' | 'quota' | 'api_error' | 'network'
    this.retryable = !!retryable;
  }
}

function classifyHttpError(status, bodyText) {
  let msg = `HTTP ${status}`;
  let type = '';
  try {
    const j = JSON.parse(bodyText);
    const err = j.error || j;
    if (err && typeof err.message === 'string') msg = err.message;
    if (err && typeof err.type === 'string') type = err.type;
  } catch {
    if (bodyText) msg = `${msg}: ${bodyText.slice(0, 200)}`;
  }
  if (status === 401 || status === 403) return new DirectApiError(msg, { status, code: 'auth' });
  if (status === 429) {
    const quota = /quota|limit|insufficient/i.test(msg + type);
    return new DirectApiError(msg, { status, code: quota ? 'quota' : 'rate_limit', retryable: !quota });
  }
  return new DirectApiError(msg, { status, code: 'api_error', retryable: status >= 500 });
}

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic input_schema) + implementations
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'Bash',
    description: 'Run a shell command in the working directory. Returns stdout+stderr. 120s timeout, 1MB output cap.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
        timeout: { type: 'number', description: 'Timeout in ms (max 120000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read a text file. Relative paths resolve against the cwd.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number', description: '1-based start line' },
        limit: { type: 'number', description: 'Max lines to return' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Write',
    description: 'Write a text file (creates parent directories). Overwrites existing content.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Replace a unique string in a file. Fails if old_string is absent or occurs more than once.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents with a regex. Skips node_modules/.git. Caps at 200 matches.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression' },
        path: { type: 'string', description: 'Directory or file to search (default cwd)' },
        glob: { type: 'string', description: 'Filename filter, e.g. "*.js"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files by glob pattern (supports **, *, ?). Skips node_modules/.git.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Base directory (default cwd)' },
      },
      required: ['pattern'],
    },
  },
];

function resolveInCwd(cwd, p) {
  if (typeof p !== 'string' || !p) throw new Error('path is required');
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

function execFileP(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, opts, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

function truncate(str, cap) {
  if (str.length <= cap) return str;
  return str.slice(0, cap) + `\n… [truncated, ${str.length - cap} more chars]`;
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1; // '**/' matches zero dirs too
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

async function runBash(cwd, input) {
  const command = String(input.command ?? '');
  if (!command.trim()) throw new Error('command is required');
  const timeout = Math.min(Math.max(Number(input.timeout) || BASH_TIMEOUT_MS, 1000), BASH_TIMEOUT_MS);
  const isWin = process.platform === 'win32';
  const { error, stdout, stderr } = await execFileP(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/c', command] : ['-c', command], {
    cwd,
    timeout,
    maxBuffer: BASH_MAX_OUTPUT,
    env: process.env,
    windowsHide: true,
  });
  let out = '';
  if (stdout) out += stdout;
  if (stderr) out += (out ? '\n' : '') + stderr;
  out = truncate(out, BASH_MAX_OUTPUT);
  if (error) {
    const why = error.killed ? `timed out after ${timeout}ms` : `exited with code ${error.code ?? '?'}`;
    out += (out ? '\n' : '') + `[command ${why}]`;
    if (!out.trim()) throw new Error(`command ${why}`);
    return out; // return partial output with the failure note — more useful to the model
  }
  return out || '(no output)';
}

async function runRead(cwd, input) {
  const file = resolveInCwd(cwd, input.path);
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > READ_MAX_BYTES) throw new Error(`file too large (${stat.size} bytes, cap ${READ_MAX_BYTES})`);
  const text = await fsp.readFile(file, 'utf8');
  const lines = text.split('\n');
  const offset = Math.max(1, Number(input.offset) || 1);
  const limit = Math.min(Math.max(Number(input.limit) || READ_MAX_LINES, 1), READ_MAX_LINES);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  let out = slice.join('\n');
  if (offset > 1 || offset - 1 + limit < lines.length) {
    out += `\n[showing lines ${offset}–${offset - 1 + slice.length} of ${lines.length}]`;
  }
  return out;
}

async function runWrite(cwd, input) {
  const file = resolveInCwd(cwd, input.path);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, String(input.content ?? ''), 'utf8');
  return `wrote ${file}`;
}

async function runEdit(cwd, input) {
  const file = resolveInCwd(cwd, input.path);
  const oldS = String(input.old_string ?? '');
  const newS = String(input.new_string ?? '');
  if (!oldS) throw new Error('old_string is required');
  const text = await fsp.readFile(file, 'utf8');
  const first = text.indexOf(oldS);
  if (first < 0) throw new Error('old_string not found in file');
  if (text.indexOf(oldS, first + 1) >= 0) throw new Error('old_string is not unique in file');
  await fsp.writeFile(file, text.slice(0, first) + newS + text.slice(first + oldS.length), 'utf8');
  return `edited ${file}`;
}

let rgAvailable = null;
async function hasRg() {
  if (rgAvailable !== null) return rgAvailable;
  const { error } = await execFileP('rg', ['--version'], { timeout: 5000 });
  rgAvailable = !error;
  return rgAvailable;
}

async function runGrep(cwd, input) {
  const pattern = String(input.pattern ?? '');
  if (!pattern) throw new Error('pattern is required');
  const base = input.path ? resolveInCwd(cwd, input.path) : cwd;
  const hits = [];
  if (await hasRg()) {
    const args = ['--json', '--max-count', '50', '-e', pattern];
    if (input.glob) args.push('--glob', String(input.glob));
    args.push('--', base);
    const { stdout } = await execFileP('rg', args, { cwd, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    for (const line of (stdout || '').split('\n')) {
      if (hits.length >= GREP_MAX_HITS) break;
      if (!line || line[0] !== '{') continue;
      try {
        const j = JSON.parse(line);
        if (j.type !== 'match') continue;
        const file = j.data && j.data.path && j.data.path.text;
        const text = j.data && j.data.lines && j.data.lines.text;
        const lineNo = j.data && j.data.line_number;
        if (file && text) hits.push(`${file}:${lineNo}: ${text.trimEnd()}`);
      } catch {
        // skip malformed rg json line
      }
    }
  } else {
    let re;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      throw new Error(`invalid regex: ${e.message}`);
    }
    const globRe = input.glob ? globToRegex(String(input.glob)) : null;
    const stat = await fsp.stat(base).catch(() => null);
    const files = stat && stat.isFile() ? [base] : stat ? walk(base) : [];
    outer: for await (const file of files) {
      if (globRe && !globRe.test(path.basename(file))) continue;
      let text;
      try {
        const st = await fsp.stat(file);
        if (st.size > READ_MAX_BYTES) continue;
        text = await fsp.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${file}:${i + 1}: ${lines[i].trimEnd()}`);
          if (hits.length >= GREP_MAX_HITS) break outer;
        }
      }
    }
  }
  if (!hits.length) return '(no matches)';
  return hits.join('\n') + (hits.length >= GREP_MAX_HITS ? `\n[capped at ${GREP_MAX_HITS} matches]` : '');
}

async function runGlob(cwd, input) {
  const pattern = String(input.pattern ?? '');
  if (!pattern) throw new Error('pattern is required');
  const base = input.path ? resolveInCwd(cwd, input.path) : cwd;
  const re = globToRegex(pattern);
  const results = [];
  for await (const file of walk(base)) {
    const rel = path.relative(base, file);
    if (re.test(rel) || re.test(path.basename(file))) {
      results.push(rel);
      if (results.length >= GLOB_MAX_RESULTS) break;
    }
  }
  results.sort();
  if (!results.length) return '(no files)';
  return results.join('\n') + (results.length >= GLOB_MAX_RESULTS ? `\n[capped at ${GLOB_MAX_RESULTS}]` : '');
}

async function executeTool(cwd, name, input) {
  switch (name) {
    case 'Bash':
      return runBash(cwd, input);
    case 'Read':
      return runRead(cwd, input);
    case 'Write':
      return runWrite(cwd, input);
    case 'Edit':
      return runEdit(cwd, input);
    case 'Grep':
      return runGrep(cwd, input);
    case 'Glob':
      return runGlob(cwd, input);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// History conversion: store messages (REST shape) -> Anthropic messages
// ---------------------------------------------------------------------------

function toAnthropicMessages(storeMessages) {
  const out = [];
  const pendingResults = []; // tool_result parts waiting for a user message
  const seenCallIds = new Set();

  const flushResults = () => {
    if (pendingResults.length) {
      out.push({ role: 'user', content: pendingResults.splice(0) });
    }
  };

  for (const m of storeMessages) {
    if (m.role === 'user') {
      flushResults();
      const text = (m.content || [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      if (text.trim()) out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      flushResults();
      const blocks = [];
      for (const p of m.content || []) {
        if (p.type === 'text' && p.text) {
          blocks.push({ type: 'text', text: p.text });
        } else if (p.type === 'thinking' && p.thinking) {
          const b = { type: 'thinking', thinking: p.thinking };
          if (p.signature) b.signature = p.signature;
          blocks.push(b);
        } else if (p.type === 'tool_use' && p.tool_call_id) {
          blocks.push({ type: 'tool_use', id: p.tool_call_id, name: p.tool_name, input: p.input || {} });
          seenCallIds.add(p.tool_call_id);
        }
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      for (const p of m.content || []) {
        if (p.type !== 'tool_result' || !p.tool_call_id) continue;
        if (!seenCallIds.has(p.tool_call_id)) continue; // orphaned result — drop
        seenCallIds.delete(p.tool_call_id);
        pendingResults.push({
          type: 'tool_result',
          tool_use_id: p.tool_call_id,
          content: String(p.output ?? ''),
          ...(p.is_error ? { is_error: true } : {}),
        });
      }
    }
  }

  // Orphaned tool_use (aborted turn) — the API requires a result for every call.
  if (seenCallIds.size) {
    for (const callId of seenCallIds) {
      pendingResults.push({ type: 'tool_result', tool_use_id: callId, content: '(turn aborted before result)', is_error: true });
    }
  }
  flushResults();

  // The API alternates user/assistant; merge consecutive same-role messages.
  const merged = [];
  for (const msg of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      const lc = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
      const mc = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
      last.content = lc.concat(mc);
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// SSE streaming
// ---------------------------------------------------------------------------

// Parse an SSE byte stream into { event, data } objects.
async function* sseEvents(body, decoder) {
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      const data = dataLines.join('\n');
      if (data === '[DONE]') return;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      yield { event, data: parsed };
    }
  }
}

// One streaming request. Returns { blocks, stopReason, usage }.
// hooks.onDelta / onThinking fire per delta; hooks.onUsage fires once per request.
async function streamRequest({ token, body, signal, hooks }) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new DirectApiError(`network error: ${e.message}`, { code: 'network', retryable: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw classifyHttpError(res.status, text);
  }

  const decoder = new TextDecoder();
  const blocks = []; // indexed by content_block index
  let stopReason = null;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };

  try {
    for await (const { event, data } of sseEvents(res.body, decoder)) {
    if (event === 'message_start') {
      const u = data && data.message && data.message.usage;
      if (u) {
        usage.input_tokens = Number(u.input_tokens ?? 0) || 0;
        usage.cache_read_tokens = Number(u.cache_read_input_tokens ?? 0) || 0;
        usage.cache_creation_tokens = Number(u.cache_creation_input_tokens ?? 0) || 0;
      }
    } else if (event === 'content_block_start') {
      const b = data.content_block || {};
      const block = { type: b.type };
      if (b.type === 'text') block.text = '';
      else if (b.type === 'thinking') block.thinking = '';
      else if (b.type === 'tool_use') {
        block.id = b.id;
        block.name = b.name;
        block._json = '';
      }
      blocks[data.index] = block;
    } else if (event === 'content_block_delta') {
      const block = blocks[data.index];
      const d = data.delta || {};
      if (!block) continue;
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        block.text = (block.text || '') + d.text;
        if (hooks.onDelta) hooks.onDelta(d.text);
      } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
        block.thinking = (block.thinking || '') + d.thinking;
        if (hooks.onThinking) hooks.onThinking(d.thinking);
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        block._json = (block._json || '') + d.partial_json;
      } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
        block.signature = (block.signature || '') + d.signature;
      }
    } else if (event === 'content_block_stop') {
      const block = blocks[data.index];
      if (block && block.type === 'tool_use') {
        try {
          block.input = block._json ? JSON.parse(block._json) : {};
        } catch {
          block.input = {};
          block._inputError = true;
        }
        delete block._json;
      }
    } else if (event === 'message_delta') {
      if (data.delta && data.delta.stop_reason) stopReason = data.delta.stop_reason;
      const u = data.usage;
      if (u) {
        usage.output_tokens = Number(u.output_tokens ?? usage.output_tokens) || 0;
        if (u.input_tokens != null) usage.input_tokens = Number(u.input_tokens) || usage.input_tokens;
        if (u.cache_read_input_tokens != null) usage.cache_read_tokens = Number(u.cache_read_input_tokens) || 0;
        if (u.cache_creation_input_tokens != null) usage.cache_creation_tokens = Number(u.cache_creation_input_tokens) || 0;
      }
    } else if (event === 'message_stop') {
      break;
    } else if (event === 'error') {
      const err = (data && data.error) || {};
      throw new DirectApiError(err.message || 'stream error', { code: 'api_error', retryable: true });
    }
    // 'ping' and unknown events: ignore
    }
  } catch (e) {
    // Aborted mid-stream: keep whatever blocks accumulated so the partial
    // turn can be persisted. Any other stream error propagates.
    if (!(e && e.name === 'AbortError')) throw e;
    stopReason = 'aborted';
  }

  if (hooks.onUsage) hooks.onUsage({ ...usage });
  return { blocks: blocks.filter(Boolean), stopReason, usage };
}

// ---------------------------------------------------------------------------
// runTurn
// ---------------------------------------------------------------------------

/**
 * Run one full agentic turn against the direct API.
 *
 * @param {object} args
 * @param {object} args.store    direct-store instance
 * @param {string} args.sessionId
 * @param {string} args.cwd
 * @param {string} [args.model]  default 'k3'
 * @param {string} [args.effort] 'off'|'low'|'high'|'max' (default 'high')
 * @param {string} args.prompt
 * @param {AbortSignal} [args.signal]
 * @param {object} [args.hooks]  { onDelta(text), onThinking(text),
 *   onToolStart({id,name,input}), onToolEnd({id,name,input},{output,is_error}),
 *   requireApproval({id,name,input}) -> Promise<'approved'|'rejected'>,
 *   onUsage({input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens}) }
 * @returns {Promise<{aborted:boolean, stopReason:string, usage:object, text:string}>}
 */
async function runTurn({ store, sessionId, cwd, model, effort, prompt, signal, hooks = {} }) {
  const token = await resolveAccessToken();
  if (!token) {
    throw new DirectApiError('not logged in — sign in to use the direct engine', { code: 'auth', status: 401 });
  }
  const session = await store.get(sessionId);
  if (!session) throw new Error(`direct-client: no such session ${sessionId}`);
  const workdir = cwd || session.cwd || process.cwd();
  const modelId = model || session.model || DEFAULT_MODEL;
  const requested = effort || session.effort || DEFAULT_EFFORT;
  const effortLevel = requested === 'off' || EFFORT_BUDGETS[requested] ? requested : DEFAULT_EFFORT;

  const startedAt = Date.now();
  let aborted = false;

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const history = toAnthropicMessages(await store.getMessages(sessionId));
  history.push({ role: 'user', content: String(prompt) });

  const body = {
    model: modelId,
    max_tokens: MAX_TOKENS,
    stream: true,
    system: SYSTEM_PROMPT.replace('{{CWD}}', workdir),
    messages: history,
    tools: TOOLS,
  };
  if (effortLevel && effortLevel !== 'off' && EFFORT_BUDGETS[effortLevel]) {
    body.thinking = { type: 'enabled', budget_tokens: EFFORT_BUDGETS[effortLevel] };
  } else if (effortLevel === 'off') {
    body.thinking = { type: 'disabled' };
  }

  const steps = [];
  const turnUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  let stopReason = 'end_turn';
  let finalText = '';

  const addUsage = (u) => {
    turnUsage.input_tokens += u.input_tokens || 0;
    turnUsage.output_tokens += u.output_tokens || 0;
    turnUsage.cache_read_tokens += u.cache_read_tokens || 0;
    turnUsage.cache_creation_tokens += u.cache_creation_tokens || 0;
  };

  try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const { blocks, stopReason: sr, usage } = await streamRequest({ token, body, signal: controller.signal, hooks });
      addUsage(usage);
      stopReason = sr || 'end_turn';

      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const step = { blocks, results: [], stopReason, usage };
      steps.push(step);
      finalText = blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n');

      // Record this step into the running request history.
      body.messages.push({ role: 'assistant', content: blocks.map(wireBlockToApi) });

      if (controller.signal.aborted) {
        aborted = true;
        stopReason = 'aborted';
        break;
      }
      if (stopReason !== 'tool_use' || !toolUses.length) break;

      const resultParts = [];
      for (const call of toolUses) {
        const toolInfo = { id: call.id, name: call.name, input: call.input || {} };
        let decision = 'approved';
        if (hooks.requireApproval) {
          decision = await hooks.requireApproval(toolInfo);
        }
        if (controller.signal.aborted) {
          aborted = true;
          stopReason = 'aborted';
          break;
        }
        let output;
        let isError = false;
        if (decision === 'rejected') {
          output = 'Tool call rejected by the user.';
          isError = true;
        } else {
          if (hooks.onToolStart) hooks.onToolStart(toolInfo);
          try {
            output = call._inputError ? (() => { throw new Error('malformed tool input JSON'); })() : await executeTool(workdir, call.name, call.input || {});
          } catch (e) {
            output = `Error: ${e.message}`;
            isError = true;
          }
          if (hooks.onToolEnd) hooks.onToolEnd(toolInfo, { output, is_error: isError });
        }
        step.results.push({ tool_use_id: call.id, output, is_error: isError });
        resultParts.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: String(output),
          ...(isError ? { is_error: true } : {}),
        });
      }
      if (aborted) break;
      body.messages.push({ role: 'user', content: resultParts });
    }
  } catch (e) {
    if (e && (e.name === 'AbortError' || controller.signal.aborted)) {
      aborted = true;
      stopReason = 'aborted';
    } else {
      throw e;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }

  if (aborted) {
    // Close out any tool calls left pending by the aborted request.
    const lastStep = steps[steps.length - 1];
    if (lastStep) {
      for (const b of lastStep.blocks.filter((x) => x.type === 'tool_use')) {
        if (!lastStep.results.some((r) => r.tool_use_id === b.id)) {
          const info = { id: b.id, name: b.name, input: b.input || {} };
          if (hooks.onToolEnd) hooks.onToolEnd(info, { output: '(aborted)', is_error: true });
          lastStep.results.push({ tool_use_id: b.id, output: '(aborted)', is_error: true });
        }
      }
    }
  }

  await store.appendTurn(sessionId, {
    prompt: String(prompt),
    steps,
    usage: turnUsage,
    model: modelId,
    aborted,
    startedAt,
    endedAt: Date.now(),
  });

  return { aborted, stopReason, usage: turnUsage, text: finalText };
}

// Convert an accumulated stream block back to an API-shaped content block.
function wireBlockToApi(b) {
  if (b.type === 'text') return { type: 'text', text: b.text || '' };
  if (b.type === 'thinking') {
    const out = { type: 'thinking', thinking: b.thinking || '' };
    if (b.signature) out.signature = b.signature;
    return out;
  }
  if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
  return { type: 'text', text: '' };
}

module.exports = {
  runTurn,
  MODELS,
  EFFORTS: ['off', 'low', 'high', 'max'],
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  DirectApiError,
  // exposed for tests
  _toAnthropicMessages: toAnthropicMessages,
  _resolveAccessToken: resolveAccessToken,
};
