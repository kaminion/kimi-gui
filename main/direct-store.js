'use strict';

// Local session store for the CLI-free "direct" engine.
//
// Layout (root is configurable; default <userData>/direct-sessions):
//   <root>/<session_id>/
//     state.json                 { id, version, cwd, title, lastPrompt, createdAt,
//                                  updatedAt (ms), archived:false, isCustomTitle, engine:'direct' }
//     agents/main/wire.jsonl     wire-compatible event log (see main/search.js)
//
// wire.jsonl mirrors the CLI's format line-for-line (completed turns only) so
// main/search.js can index direct sessions once it learns one more root:
//   {"type":"metadata","protocol_version":"1.5","created_at":<ms>}
//   {"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text"}],
//      "toolCalls":[],"origin":{"kind":"user"},"id":"msg_..."},"time":<ms>}
//   {"type":"context.append_loop_event","event":{"type":"step.begin"|"content.part"|"tool.call"|
//      "tool.result"|"step.end", ...},"time":<ms>}
//   {"type":"usage.record","model":...,"usage":{"inputOther","output","inputCacheRead",
//      "inputCacheCreation"},"usageScope":"turn","time":<ms>}
// content.part part types mirror the CLI: "text" ({text}) and "think" ({think}) —
// search.js aggregates only "text" parts, so thinking never pollutes search.

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const TITLE_MAX = 60; // auto title = first prompt truncated to this many chars
const ID_PAD = 6; // mirrors search.js message id numbering

function padSeq(n) {
  return String(n).padStart(ID_PAD, '0');
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function sessionDir(root, id) {
  return path.join(root, id);
}

function wirePath(root, id) {
  return path.join(root, id, 'agents', 'main', 'wire.jsonl');
}

function statePath(root, id) {
  return path.join(root, id, 'state.json');
}

async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

// Atomic-ish write: tmp file + rename so a crash never leaves half a state.json.
async function writeJson(p, obj) {
  const tmp = `${p}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fs.rename(tmp, p);
}

function toIso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

// --- wire.jsonl replay (mirrors search.js numbering rules exactly) ----------
//
// Message slots: one per context.append_message (non-task), one per step.begin,
// one per tool.result. Assistant ids are always msg_<sid>_<pad(slot)>; user
// messages keep their wire id. Replay produces REST-shaped messages
// (GET /sessions/{id}/messages equivalents) in chronological order (newest LAST).
function replayWire(contents, sessionId) {
  const messages = [];
  let seq = 0;
  let inStep = false;
  let pendingUsers = [];
  let pendingTools = []; // tool messages of the open step, flushed after its assistant message
  let assistant = null; // { slot, time, content: [] }

  const nextId = (wireId) => {
    const id = wireId || `msg_${sessionId}_${padSeq(seq)}`;
    seq += 1;
    return id;
  };

  function commitUser(rec) {
    const id = nextId(rec.wireId);
    if (rec.kind !== 'user' && rec.kind !== null && rec.kind !== undefined) return;
    if (!rec.text.trim()) return;
    messages.push({
      id,
      session_id: sessionId,
      role: 'user',
      content: [{ type: 'text', text: rec.text }],
      created_at: toIso(rec.time),
    });
  }

  function endStep() {
    if (assistant) {
      messages.push({
        id: `msg_${sessionId}_${padSeq(assistant.slot)}`,
        session_id: sessionId,
        role: 'assistant',
        content: assistant.content,
        created_at: toIso(assistant.time),
      });
      assistant = null;
    }
    inStep = false;
    // A step's tool results follow its assistant message (ids were already
    // assigned in wire order, so numbering still mirrors search.js).
    for (const tm of pendingTools) messages.push(tm);
    pendingTools = [];
    for (const rec of pendingUsers) commitUser(rec);
    pendingUsers = [];
  }

  for (const line of contents.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // tolerate a truncated tail line
    }

    if (j.type === 'context.append_message' && j.message) {
      const m = j.message;
      const text = Array.isArray(m.content)
        ? m.content
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n')
        : '';
      const kind = m.origin && m.origin.kind;
      if (kind === 'task' || text.startsWith('<notification')) continue;
      const rec = { wireId: m.id || null, text, time: j.time, kind };
      if (inStep) pendingUsers.push(rec);
      else commitUser(rec);
    } else if (j.type === 'context.append_loop_event' && j.event) {
      const e = j.event;
      if (e.type === 'step.begin') {
        endStep(); // defensive: close a dangling step
        inStep = true;
        assistant = { slot: seq, time: j.time, content: [] };
        seq += 1;
      } else if (e.type === 'content.part' && assistant && e.part) {
        if (e.part.type === 'text' && typeof e.part.text === 'string') {
          assistant.content.push({ type: 'text', text: e.part.text });
        } else if ((e.part.type === 'think' || e.part.type === 'thinking') && typeof (e.part.think ?? e.part.thinking) === 'string') {
          const part = { type: 'thinking', thinking: e.part.think ?? e.part.thinking };
          if (typeof e.part.signature === 'string') part.signature = e.part.signature;
          assistant.content.push(part);
        }
      } else if (e.type === 'tool.call' && assistant) {
        const part = {
          type: 'tool_use',
          tool_call_id: e.toolCallId || e.uuid || '',
          tool_name: e.name || 'tool',
          input: e.args && typeof e.args === 'object' ? e.args : {},
        };
        assistant.content.push(part);
      } else if (e.type === 'tool.result') {
        const id = nextId(null); // tool message slot
        const r = e.result && typeof e.result === 'object' ? e.result : {};
        const tm = {
          id,
          session_id: sessionId,
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              tool_call_id: e.toolCallId || '',
              output: typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? ''),
              is_error: !!(r.is_error ?? r.isError),
            },
          ],
          created_at: toIso(j.time),
        };
        // Results are written inside the step; they belong AFTER its assistant
        // message in the replayed transcript (REST order).
        if (inStep) pendingTools.push(tm);
        else messages.push(tm);
      } else if (e.type === 'step.end') {
        endStep();
      }
    }
  }
  endStep(); // session may have died mid-step
  return messages;
}

// --- usage.record rows ------------------------------------------------------
function parseUsageRows(contents, sessionId) {
  const rows = [];
  for (const line of contents.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type !== 'usage.record') continue;
    const u = j.usage && typeof j.usage === 'object' ? j.usage : {};
    const time = typeof j.time === 'number' ? j.time : 0;
    // Local-day bucket (YYYY-MM-DD) — B4 aggregates per local day.
    const d = time ? new Date(time) : null;
    const date = d
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : '';
    rows.push({
      sessionId,
      time,
      date,
      model: typeof j.model === 'string' ? j.model : '',
      // CLI wire usage is camelCase; expose snake_case (B4 contract shape).
      input_tokens: Number(u.inputOther ?? u.input_tokens ?? 0) || 0,
      output_tokens: Number(u.output ?? u.output_tokens ?? 0) || 0,
      cache_read_tokens: Number(u.inputCacheRead ?? u.cache_read_tokens ?? 0) || 0,
      cache_creation_tokens: Number(u.inputCacheCreation ?? u.cache_creation_tokens ?? 0) || 0,
    });
  }
  return rows;
}

/**
 * Create a store rooted at `root` (created lazily on first use).
 * Tests pass a temp dir; production uses <userData>/direct-sessions.
 */
function createStore({ root }) {
  if (!root || typeof root !== 'string') throw new Error('direct-store: root is required');

  async function ensureRoot() {
    await fs.mkdir(root, { recursive: true });
  }

  async function readState(id) {
    return readJsonOrNull(statePath(root, id));
  }

  async function writeState(state) {
    await writeJson(statePath(root, state.id), state);
  }

  function summary(state) {
    return {
      id: state.id,
      title: state.title || state.lastPrompt || state.id,
      cwd: state.cwd || '',
      updatedAt: toIso(state.updatedAt),
      busy: false,
      engine: 'direct',
      archived: !!state.archived,
      isCustomTitle: !!state.isCustomTitle,
      model: state.model || null,
      effort: state.effort || null,
    };
  }

  /** List all sessions, most recently updated first. */
  async function list() {
    let dirs;
    try {
      dirs = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const states = await Promise.all(
      dirs.filter((d) => d.isDirectory() && d.name.startsWith('session_')).map((d) => readState(d.name))
    );
    return states
      .filter((s) => s && !s.archived)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(summary);
  }

  /** Create a session. Returns its summary. */
  async function create({ cwd, title, model, effort } = {}) {
    await ensureRoot();
    const id = newId('session');
    const now = Date.now();
    const dir = sessionDir(root, id);
    await fs.mkdir(path.join(dir, 'agents', 'main'), { recursive: true });
    const state = {
      id,
      version: 2,
      engine: 'direct',
      cwd: cwd || process.cwd(),
      title: typeof title === 'string' && title ? title : '',
      lastPrompt: '',
      createdAt: now,
      updatedAt: now,
      archived: false,
      isCustomTitle: !!(title && title.length),
      model: model || null,
      effort: effort || null,
      agents: { main: { homedir: path.join(dir, 'agents', 'main'), type: 'main' } },
      custom: {},
    };
    await writeState(state);
    await fs.appendFile(
      wirePath(root, id),
      JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: now }) + '\n',
      'utf8'
    );
    return summary(state);
  }

  /** Full state.json for a session (null when missing). */
  async function get(id) {
    const state = await readState(id);
    return state;
  }

  /** REST-shaped messages, chronological (newest LAST). */
  async function getMessages(id) {
    let contents;
    try {
      contents = await fs.readFile(wirePath(root, id), 'utf8');
    } catch {
      return [];
    }
    return replayWire(contents, id);
  }

  /** Rename; marks the title as custom so auto-titling stops. */
  async function rename(id, title) {
    const state = await readState(id);
    if (!state) throw new Error(`direct-store: no such session ${id}`);
    state.title = String(title ?? '');
    state.isCustomTitle = true;
    state.updatedAt = Date.now();
    await writeState(state);
    return summary(state);
  }

  /** Store per-session config flags (model / effort). */
  async function setConfig(id, patch = {}) {
    const state = await readState(id);
    if (!state) throw new Error(`direct-store: no such session ${id}`);
    if (typeof patch.model === 'string') state.model = patch.model;
    if (typeof patch.effort === 'string') state.effort = patch.effort;
    state.updatedAt = Date.now();
    await writeState(state);
    return summary(state);
  }

  /** Permanently delete a session directory. */
  async function remove(id) {
    await fs.rm(sessionDir(root, id), { recursive: true, force: true });
    return { removed: true, id };
  }

  /**
   * Append one completed (or aborted) turn to the wire log and update state.json.
   *
   * turnRecord:
   * {
   *   prompt: string,
   *   steps: [{
   *     blocks:  [{type:'text',text} | {type:'thinking',thinking,signature?} |
   *              {type:'tool_use',id,name,input}],   // assistant content, in order
   *     results: [{tool_use_id, output, is_error?}], // results for this step's calls
   *     stopReason: string,
   *     usage: {input_tokens, output_tokens, cache_read_tokens?, cache_creation_tokens?}
   *   }],
   *   usage:  {input_tokens, output_tokens, cache_read_tokens?, cache_creation_tokens?}, // turn total
   *   model: string, aborted?: bool, startedAt: ms, endedAt: ms
   * }
   */
  async function appendTurn(id, turn) {
    const state = await readState(id);
    if (!state) throw new Error(`direct-store: no such session ${id}`);
    const lines = [];
    const t0 = turn.startedAt || Date.now();
    const turnId = String(state.turnCount || 0);

    lines.push({
      type: 'turn.prompt',
      input: [{ type: 'text', text: turn.prompt }],
      origin: { kind: turn.aborted ? 'user' : 'user' },
      time: t0,
    });
    lines.push({
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: turn.prompt }],
        toolCalls: [],
        origin: { kind: 'user' },
        id: newId('msg'),
      },
      time: t0,
    });

    const steps = Array.isArray(turn.steps) ? turn.steps : [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepUuid = crypto.randomUUID();
      lines.push({
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: stepUuid, turnId, step: i + 1 },
        time: t0,
      });
      for (const b of step.blocks || []) {
        if (b.type === 'text' && b.text) {
          lines.push({
            type: 'context.append_loop_event',
            event: {
              type: 'content.part',
              uuid: crypto.randomUUID(),
              turnId,
              step: i + 1,
              stepUuid,
              part: { type: 'text', text: b.text },
            },
            time: Date.now(),
          });
        } else if (b.type === 'thinking' && b.thinking) {
          const part = { type: 'think', think: b.thinking };
          if (typeof b.signature === 'string') part.signature = b.signature;
          lines.push({
            type: 'context.append_loop_event',
            event: {
              type: 'content.part',
              uuid: crypto.randomUUID(),
              turnId,
              step: i + 1,
              stepUuid,
              part,
            },
            time: Date.now(),
          });
        } else if (b.type === 'tool_use') {
          lines.push({
            type: 'context.append_loop_event',
            event: {
              type: 'tool.call',
              uuid: b.id || newId('tool'),
              turnId,
              step: i + 1,
              stepUuid,
              toolCallId: b.id,
              name: b.name,
              args: b.input && typeof b.input === 'object' ? b.input : {},
            },
            time: Date.now(),
          });
        }
      }
      for (const r of step.results || []) {
        lines.push({
          type: 'context.append_loop_event',
          event: {
            type: 'tool.result',
            parentUuid: r.tool_use_id,
            toolCallId: r.tool_use_id,
            result: { output: String(r.output ?? ''), ...(r.is_error ? { is_error: true } : {}) },
          },
          time: Date.now(),
        });
      }
      lines.push({
        type: 'context.append_loop_event',
        event: {
          type: 'step.end',
          uuid: stepUuid,
          turnId,
          step: i + 1,
          finishReason: turn.aborted && i === steps.length - 1 ? 'aborted' : step.stopReason || 'end_turn',
          ...(step.usage
            ? {
                usage: {
                  inputOther: step.usage.input_tokens || 0,
                  output: step.usage.output_tokens || 0,
                  inputCacheRead: step.usage.cache_read_tokens || 0,
                  inputCacheCreation: step.usage.cache_creation_tokens || 0,
                },
              }
            : {}),
        },
        time: Date.now(),
      });
    }

    if (turn.usage) {
      lines.push({
        type: 'usage.record',
        model: turn.model || state.model || '',
        usage: {
          inputOther: turn.usage.input_tokens || 0,
          output: turn.usage.output_tokens || 0,
          inputCacheRead: turn.usage.cache_read_tokens || 0,
          inputCacheCreation: turn.usage.cache_creation_tokens || 0,
        },
        usageScope: 'turn',
        time: turn.endedAt || Date.now(),
      });
    }

    await fs.appendFile(wirePath(root, id), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

    state.turnCount = (state.turnCount || 0) + 1;
    state.lastPrompt = turn.prompt;
    state.updatedAt = turn.endedAt || Date.now();
    if (!state.isCustomTitle && !state.title) {
      const firstLine = String(turn.prompt).split('\n').find((l) => l.trim()) || '';
      state.title = firstLine.trim().slice(0, TITLE_MAX);
    }
    if (turn.model) state.model = turn.model;
    await writeState(state);
    return summary(state);
  }

  /**
   * Raw usage rows (snake_case, local-day `date`) across one session or all.
   * B4 aggregates these per day.
   */
  async function usageByDay(id) {
    const ids = id ? [id] : (await list()).map((s) => s.id);
    const all = [];
    for (const sid of ids) {
      let contents;
      try {
        contents = await fs.readFile(wirePath(root, sid), 'utf8');
      } catch {
        continue;
      }
      all.push(...parseUsageRows(contents, sid));
    }
    all.sort((a, b) => a.time - b.time);
    return all;
  }

  return {
    root,
    list,
    create,
    get,
    getMessages,
    rename,
    setConfig,
    remove,
    appendTurn,
    usageByDay,
    // exposed for tests / B3 diagnostics
    _wirePath: (id) => wirePath(root, id),
    _statePath: (id) => statePath(root, id),
  };
}

module.exports = { createStore };
