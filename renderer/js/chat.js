/* chat.js — transcript rendering, streaming, composer, busy state.
 * Exposes window.Chat. Classic script-tag module: talks to window.Markdown2,
 * window.App (shell store) and window.kimi (preload bridge); no imports.
 *
 * Wire facts (docs/ref/webui-bundle.js + live probe of kimi 0.28.1):
 * - WS frames: {type:'event.X'|agent-type, session_id, seq, payload:{type, ...}};
 *   applyEvent also tolerates the bare payload. Field names are accepted in
 *   both snake_case (wire) and camelCase (normalized) forms.
 * - message.created: {message:{id, role, content:[parts], ...}}
 * - message.updated: {message_id, content:[parts], status}
 * - assistant.delta / thinking.delta: either {message_id, content_index, delta}
 *   or — for live turns — {turnId, delta} with NO message id and NO
 *   event.message.* frames at all. Those render into a provisional .msg-live
 *   row, and turn.ended / prompt.completed / prompt.aborted trigger an
 *   authoritative REST resync (GET messages returns newest-first).
 * - session.status_changed: {status, previous_status} — busy unless idle/aborted;
 *   session.work_changed: {busy}. A busy:false frame is NOT always emitted at
 *   turn end, so turn.ended also unlocks the composer.
 * Content parts: text | thinking | tool_use{tool_call_id,tool_name,input} |
 * tool_result{tool_call_id,output,is_error} | image | video | file.
 *
 * v2 additive: every rendered message row carries data-message-id, and
 * Chat.scrollToMessage(id) scrolls a row into view with a 1.2s highlight
 * flash (.search-highlight, keyframes in styles/search.css) — used by the
 * search palette (js/search.js) via App.openSessionAtMessage.
 *
 * v5 (R-UX):
 * - While the active session is busy, #send-btn morphs into a STOP button
 *   (.stop-mode, CSS square glyph); clicking it calls App.abort(). The old
 *   header #abort-btn is gone. Chat.setBusy drives the morph.
 * - Foreign-engine sessions (engine mismatch — e.g. a direct session opened
 *   under the cli engine) are read-only: Chat.setReadOnly(true) disables the
 *   composer + send button and swaps the placeholder/title for the
 *   chat.foreign_readonly notice. The backend also rejects such sends with an
 *   {type:'error', message} event, rendered here as a chat system note.
 *
 * v6 (tool display): tool rows present Claude-Code-style — header is
 * `ToolName  concise-target` (basename for file tools, word-boundary
 * truncation at 80 chars, full target as hover tooltip), the expanded body is
 * formatted blocks (command line, path, diff-ish edit excerpt, labeled output
 * trimmed to ~4KB) instead of a raw JSON dump. A text part that is entirely
 * one raw tool-invocation JSON blob (leaked function call) is converted to a
 * tool row rather than rendered inline.
 */
(function () {
  'use strict';

  const SCROLL_PIN_PX = 80;      // user is "at bottom" within this distance
  const COMPOSER_MAX_PX = 200;   // auto-grow ceiling
  const SUMMARY_MAX = 80;        // one-line tool target in the row header
  const TOOL_BODY_MAX = 4000;    // per-block truncation (~4KB) in the tool body
  const RELOAD_DEBOUNCE_MS = 300;
  const HIGHLIGHT_FLASH_MS = 1200;  // keep in sync with search-highlight-flash in search.css

  const T = (k, f) => (window.I18N?.t ? window.I18N.t(k, f) : f);

  // Event types we deliberately ignore (no transcript impact).
  // NOTE: turn.ended / prompt.completed / prompt.aborted are NOT ignored — they
  // trigger an authoritative REST resync, because live turns stream deltas
  // without message_id and no event.message.* frames are emitted (verified
  // against kimi 0.28.1).
  const IGNORE_TYPES = new Set([
    'session.created', 'session.updated', 'session.deleted', 'session.meta.updated',
    'session.usage_updated', 'agent.status.updated', 'context.spliced',
    'turn.started', 'turn.step.started', 'turn.step.completed',
    'turn.step.retrying', 'turn.step.interrupted',
    'tool.call.delta', 'tool.call.started', 'tool.progress', 'tool.result',
    'tool.list.updated', 'mcp.server.status',
    'shell.output', 'shell.started', 'shell.completed',
    'subagent.spawned', 'subagent.started', 'subagent.suspended',
    'subagent.completed', 'subagent.failed',
    'compaction.started', 'compaction.blocked', 'compaction.cancelled', 'compaction.completed',
    'task.started', 'task.terminated', 'task.created', 'task.progress', 'task.completed',
    'background.task.started', 'background.task.terminated',
    'cron.fired', 'hook.result', 'goal.updated',
    'skill.activated', 'plugin_command.activated',
    'prompt.submitted', 'prompt.steered',
    'approval.requested', 'approval.resolved', 'approval.expired',
    'question.requested', 'question.answered', 'question.dismissed',
    'config.changed', 'model_catalog.changed',
    'workspace.created', 'workspace.updated', 'workspace.deleted',
    'warning',
  ]);

  // ---- module state --------------------------------------------------------
  let transcriptEl = null;
  let composerEl = null;
  let sendBtn = null;
  let initialized = false;

  let activeSessionId = null;
  let messages = [];                    // normalized cache of the rendered session
  const streamNodes = new Map();        // messageId -> true for in-progress assistant rows
  const liveStreams = new Map();        // turnId -> { row, thinking, text } for id-less deltas
  let optimisticUser = null;            // { text, el } echoed locally until server confirms
  let busy = false;
  let readOnly = false;                 // foreign-engine session: composer locked, notice shown
  let pinned = true;
  let reloadTimer = null;
  let highlightTimer = null;        // pending removal of a .search-highlight flash

  // ---- small helpers -------------------------------------------------------
  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function oneLine(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  function basename(p) {
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p);
  }

  // Header truncation: cut at a word boundary when the cut would not throw
  // away most of the string (keeps long commands/paths readable).
  function truncWord(s, max) {
    s = oneLine(s);
    if (s.length <= max) return s;
    let cut = s.slice(0, max - 1);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > max * 0.5) cut = cut.slice(0, lastSpace);
    return cut.replace(/[\s.,;:!?—·-]+$/, '') + '…';
  }

  function esc(s) {
    return (window.Markdown2 && window.Markdown2.escapeHtml)
      ? window.Markdown2.escapeHtml(s)
      : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function mdRender(text) {
    if (window.Markdown2 && typeof window.Markdown2.render === 'function') {
      try { return window.Markdown2.render(text); } catch { /* fall through */ }
    }
    return '<p>' + esc(text) + '</p>';
  }

  // ---- normalization (accept snake_case wire + camelCase normalized) -------
  function normPart(p) {
    if (p == null) return { type: 'text', text: '' };
    if (typeof p === 'string') return { type: 'text', text: p };
    if (typeof p !== 'object') return { type: 'text', text: String(p) };
    switch (p.type) {
      case 'text':
        return { type: 'text', text: p.text ?? '' };
      case 'thinking':
        return { type: 'thinking', thinking: p.thinking ?? p.text ?? '' };
      case 'tool_use':
      case 'toolUse':
        return {
          type: 'tool_use',
          tool_call_id: p.tool_call_id ?? p.toolCallId ?? p.id ?? '',
          tool_name: p.tool_name ?? p.toolName ?? p.name ?? 'tool',
          input: p.input,
        };
      case 'tool_result':
      case 'toolResult':
        return {
          type: 'tool_result',
          tool_call_id: p.tool_call_id ?? p.toolCallId ?? '',
          output: p.output,
          is_error: !!(p.is_error ?? p.isError),
        };
      case 'image':
      case 'video':
        return { type: p.type, source: p.source };
      case 'file':
        return { type: 'file', name: p.name ?? 'file', media_type: p.media_type ?? p.mediaType ?? '', size: p.size ?? 0 };
      default:
        return { type: 'unknown', raw: p };
    }
  }

  function normMessage(m) {
    if (!m || typeof m !== 'object') {
      return { id: 'msg-' + Math.random().toString(36).slice(2), role: 'system', content: [{ type: 'text', text: String(m ?? '') }] };
    }
    let content = m.content;
    if (typeof content === 'string') content = [{ type: 'text', text: content }];
    if (!Array.isArray(content)) content = [];
    return {
      id: m.id ?? m.message_id ?? m.messageId ?? ('msg-' + Math.random().toString(36).slice(2)),
      role: m.role ?? 'assistant',
      content: content.map(normPart),
      status: m.status,
      created_at: m.created_at ?? m.createdAt,
    };
  }

  // ---- scrolling -----------------------------------------------------------
  function isPinned() {
    if (!transcriptEl) return true;
    const gap = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
    return gap <= SCROLL_PIN_PX;
  }

  function scrollToBottom() {
    if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function maybeScroll() { if (pinned) scrollToBottom(); }

  // ---- public: search jump target (v2) --------------------------------------
  // Scroll the row for message `id` into view and flash it for 1.2s.
  // Returns true when the row was found and flashed.
  function scrollToMessage(id) {
    if (!initialized || !transcriptEl || id == null) return false;
    const esc = (window.CSS && typeof CSS.escape === 'function') ? CSS.escape(String(id)) : String(id);
    const row = transcriptEl.querySelector('[data-message-id="' + esc + '"]');
    if (!row) return false;
    if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
    transcriptEl.querySelectorAll('.search-highlight').forEach((n) => n.classList.remove('search-highlight'));
    row.scrollIntoView({ block: 'center' });
    void row.offsetWidth; // reflow: restart the flash when jumping to the same row twice
    row.classList.add('search-highlight');
    highlightTimer = setTimeout(() => {
      highlightTimer = null;
      row.classList.remove('search-highlight');
    }, HIGHLIGHT_FLASH_MS);
    return true;
  }

  // ---- message DOM ---------------------------------------------------------
  // Map of tool_call_id -> tool_result part, across the whole transcript.
  function collectResults() {
    const map = new Map();
    for (const m of messages) {
      for (const part of m.content) {
        if (part.type === 'tool_result' && part.tool_call_id) map.set(part.tool_call_id, part);
      }
    }
    return map;
  }

  // Set of tool_call_ids that appear as tool_use parts (i.e. have their own row).
  function collectToolUseIds() {
    const set = new Set();
    for (const m of messages) {
      for (const part of m.content) {
        if (part.type === 'tool_use' && part.tool_call_id) set.add(part.tool_call_id);
      }
    }
    return set;
  }

  // A role:'tool' message whose results all belong to existing tool rows is
  // folded into those rows and gets no row of its own.
  function isFullyClaimedToolMessage(m) {
    if (m.role !== 'tool') return false;
    const results = m.content.filter((p) => p.type === 'tool_result');
    if (!results.length) return false;
    const claims = collectToolUseIds();
    return results.every((p) => p.tool_call_id && claims.has(p.tool_call_id));
  }

  // Messages holding tool_use parts claimed by a role:'tool' message.
  function claimantMessages(toolMessage) {
    const ids = new Set(toolMessage.content.filter((p) => p.type === 'tool_result').map((p) => p.tool_call_id));
    return messages.filter((m) => m.content.some((p) => p.type === 'tool_use' && ids.has(p.tool_call_id)));
  }

  function textOfMessage(m) {
    return m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
  }

  // Fallback header target for unknown tools: the first scalar (string /
  // number / boolean) argument value, else ''. Keeps raw JSON out of the row
  // header (the body still shows the full input for debugging).
  function firstScalar(input) {
    for (const k of Object.keys(input)) {
      const v = input[k];
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
    return '';
  }

  // One-line, human-readable target for a tool call — the concise form shown
  // next to the tool name in the row header (Claude Code style: `Read x.js`,
  // `Bash ls -la`). File tools collapse to the basename; the full path shows
  // in the expanded body and in the header's hover tooltip. Returns null for
  // unrecognized tools so callers can fall back (header: first scalar arg,
  // body: pretty-printed input).
  function toolTarget(name, input) {
    if (input == null) return '';
    if (typeof input === 'string') return oneLine(input);
    if (typeof input !== 'object') return oneLine(String(input));
    const pick = (...keys) => {
      for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k];
      return null;
    };
    switch (name) {
      case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': case 'ReadMediaFile': {
        const p = pick('file_path', 'path');
        return p ? basename(p) : firstScalar(input);
      }
      case 'Bash': return pick('command') || firstScalar(input);
      case 'Grep': {
        const pat = pick('pattern');
        const p = pick('path');
        const s = pat ? '"' + oneLine(pat) + '"' : '';
        return s && p ? s + ' — ' + p : (s || p || firstScalar(input));
      }
      case 'Glob': return pick('pattern') || firstScalar(input);
      case 'WebFetch': case 'FetchURL': return pick('url') || firstScalar(input);
      case 'WebSearch': return pick('query') || firstScalar(input);
      case 'Task': case 'Agent': return pick('description', 'prompt') || firstScalar(input);
      case 'AgentSwarm': return pick('description', 'prompt_template') || firstScalar(input);
      case 'Skill': return pick('skill') || firstScalar(input);
      case 'TaskOutput': case 'TaskStop': return pick('task_id') || firstScalar(input);
      case 'TodoList': return '';
      default: return null;
    }
  }

  // Header summary: { short } renders next to the tool name, { full } is the
  // untruncated one-liner used as the hover tooltip. Unknown tools fall back
  // to their first scalar argument.
  function toolSummary(name, input) {
    let full = toolTarget(name, input);
    if (full == null) full = (input && typeof input === 'object') ? firstScalar(input) : '';
    return { short: truncWord(full, SUMMARY_MAX), full };
  }

  // Trim a body block to ~4KB; a trailing notice marks the cut.
  function bodyTrim(s) {
    s = String(s);
    if (s.length <= TOOL_BODY_MAX) return s;
    return s.slice(0, TOOL_BODY_MAX) + '\n' + T('chat.tool.trimmed', '… (이하 생략)');
  }

  function resultText(result) {
    if (!result) return '';
    let o = result.output;
    if (o == null) return '';
    if (typeof o !== 'string') { try { o = JSON.stringify(o, null, 2); } catch { o = String(o); } }
    return o;
  }

  function addLabel(body, key, fallback) {
    body.append(el('div', 'msg-tool-label', T(key, fallback)));
  }

  function addPre(body, className, text) {
    body.append(el('pre', className, bodyTrim(text)));
  }

  // Diff-ish excerpt: prefix every line with the given marker.
  function diffLines(marker, text) {
    return String(text).split('\n').map((l) => marker + l).join('\n');
  }

  // Expanded tool row body: formatted blocks (built with textContent only, so
  // tool output can never inject markup), never a raw JSON dump for known
  // tools. Unknown tools keep a pretty-printed input for debuggability.
  function buildToolBody(part, result) {
    const body = el('div', 'msg-tool-body');
    const name = part.tool_name || '';
    const input = (part.input && typeof part.input === 'object') ? part.input : null;
    const out = resultText(result);
    const path = input && ((typeof input.file_path === 'string' && input.file_path) ||
      (typeof input.path === 'string' && input.path) || null);
    let shown = false;

    if (name === 'Bash' && input && typeof input.command === 'string' && input.command) {
      addLabel(body, 'chat.tool.command', '명령');
      body.append(el('div', 'msg-tool-cmd', '$ ' + input.command));
      shown = true;
    } else if (path) {
      body.append(el('div', 'msg-tool-path', path));
      shown = true;
      if ((name === 'Write' || name === 'NotebookEdit') && typeof input.content === 'string' && input.content) {
        addLabel(body, 'chat.tool.content', '내용');
        addPre(body, 'msg-tool-output', input.content);
      } else if (name === 'Edit') {
        if (typeof input.old_string === 'string' && input.old_string) addPre(body, 'msg-tool-diff-old', diffLines('- ', input.old_string));
        if (typeof input.new_string === 'string' && input.new_string) addPre(body, 'msg-tool-diff-new', diffLines('+ ', input.new_string));
      }
    } else if (input) {
      const target = toolTarget(name, input);
      if (target) {
        // Known non-file tool (Grep/Glob/WebSearch/…): echo the header target.
        body.append(el('div', 'msg-tool-path', target));
        shown = true;
      } else if (target == null) {
        // Unknown tool: keep a readable pretty-print for debugging.
        let pretty;
        try { pretty = JSON.stringify(input, null, 2); } catch { pretty = String(part.input); }
        if (pretty && pretty !== '{}') { addPre(body, 'msg-tool-output', pretty); shown = true; }
      }
    } else if (typeof part.input === 'string' && part.input) {
      addPre(body, 'msg-tool-output', part.input);
      shown = true;
    }

    if (out.trim()) {
      addLabel(body, 'chat.tool.output', '출력');
      addPre(body, 'msg-tool-output' + (result.is_error ? ' is-error' : ''), out);
      shown = true;
    }
    if (!shown) body.append(el('div', 'msg-tool-label', T('chat.tool.no_content', '(내용 없음)')));
    return body;
  }

  function buildToolRow(part, result, streaming) {
    const state = result ? (result.is_error ? 'error' : 'done') : (streaming ? 'running' : 'done');
    const row = el('details', 'msg-tool ' + state);
    const summary = document.createElement('summary');
    summary.className = 'msg-tool-header';
    const { short, full } = toolSummary(part.tool_name, part.input);
    summary.append(
      el('span', 'tool-status', ''),
      el('span', 'msg-tool-chevron', '▸'),
      el('span', 'msg-tool-name', part.tool_name || 'tool'),
      el('span', 'msg-tool-summary', short),
    );
    if (full) summary.title = full; // hover tooltip: untruncated target
    row.append(summary, buildToolBody(part, result));
    return row;
  }

  // A text part that is entirely one raw tool-invocation JSON blob (leaked
  // function call from a model without native tool calls) is converted to a
  // proper tool row instead of rendering as inline JSON.
  function parseRawToolCall(text) {
    const s = String(text).trim();
    if (s.length < 2 || s[0] !== '{' || s[s.length - 1] !== '}') return null;
    let j;
    try { j = JSON.parse(s); } catch { return null; }
    if (!j || typeof j !== 'object' || typeof j.name !== 'string' || !j.name) return null;
    const input = j.input ?? j.arguments ?? j.args;
    const invocationType = j.type === 'tool_use' || j.type === 'tool_call' || j.type === 'function_call';
    const ALLOWED = new Set(['type', 'name', 'input', 'arguments', 'args', 'id', 'tool_call_id']);
    if (!invocationType &&
        !(input != null && typeof input === 'object' && Object.keys(j).every((k) => ALLOWED.has(k)))) {
      return null;
    }
    return { type: 'tool_use', tool_call_id: j.tool_call_id ?? j.id ?? '', tool_name: j.name, input };
  }

  function buildThinking(details) {
    const box = el('details', 'msg-thinking');
    const sum = document.createElement('summary');
    sum.className = 'msg-thinking-header';
    sum.textContent = T('chat.thinking', '사고 과정');
    const body = el('div', 'msg-thinking-body');
    body.innerHTML = mdRender(details);
    box.append(sum, body);
    return box;
  }

  function buildAttachment(part) {
    // Minimal attachment rendering: images inline, everything else as a chip.
    if (part.type === 'image' && part.source) {
      const src = part.source;
      const url = src.kind === 'url' ? src.url
        : src.kind === 'base64' ? ('data:' + (src.media_type || src.mediaType || 'image/png') + ';base64,' + src.data)
        : null;
      if (url && /^(https?:|data:image\/)/i.test(url)) {
        const img = document.createElement('img');
        img.className = 'msg-attachment-img';
        img.src = url;
        img.alt = T('chat.attachment.image', '첨부 이미지');
        return img;
      }
    }
    return el('div', 'msg-attachment-chip', part.name || part.type || T('chat.attachment.file', '첨부 파일'));
  }

  // Fill a .msg-row element with the blocks of one message.
  // results: tool_call_id -> tool_result map; streaming: session currently busy.
  function fillMessage(row, m, results, streaming) {
    row.innerHTML = '';
    if (m.role === 'user') {
      row.classList.add('msg-user');
      const text = textOfMessage(m);
      if (text) row.append(el('div', 'msg-user-text', text));
      for (const p of m.content) {
        if (p.type === 'image' || p.type === 'file') row.append(buildAttachment(p));
      }
      if (!text && !row.childNodes.length) row.append(el('div', 'msg-user-text', ''));
      return;
    }
    if (m.role === 'system') {
      row.classList.add('msg-system');
      row.append(el('div', 'msg-system-text', textOfMessage(m)));
      return;
    }
    if (m.role === 'tool') {
      // Only results without a matching tool_use row render standalone.
      const claims = collectToolUseIds();
      for (const p of m.content) {
        if (p.type === 'tool_result' && !(p.tool_call_id && claims.has(p.tool_call_id))) {
          row.append(buildToolRow(
            { type: 'tool_use', tool_call_id: p.tool_call_id, tool_name: 'tool', input: undefined }, p, false));
        }
      }
      return;
    }
    // assistant: blocks in part order
    let mdBuffer = '';
    const flushMd = () => {
      if (!mdBuffer.trim()) { mdBuffer = ''; return; }
      const block = el('div', 'msg-assistant');
      const md = el('div', 'md');
      md.innerHTML = mdRender(mdBuffer);
      block.append(md);
      row.append(block);
      mdBuffer = '';
    };
    for (const p of m.content) {
      if (p.type === 'text') {
        // Leaked function call (a whole text part that is one invocation JSON
        // blob) renders as a tool row, not as inline JSON.
        const raw = parseRawToolCall(p.text);
        if (raw) {
          flushMd();
          const result = raw.tool_call_id ? results.get(raw.tool_call_id) : undefined;
          row.append(buildToolRow(raw, result, streaming && streamNodes.get(m.id)));
        } else {
          mdBuffer += (mdBuffer ? '\n' : '') + p.text;
        }
      } else if (p.type === 'thinking') {
        flushMd();
        if (p.thinking && p.thinking.trim()) row.append(buildThinking(p.thinking));
      } else if (p.type === 'tool_use') {
        flushMd();
        const result = p.tool_call_id ? results.get(p.tool_call_id) : undefined;
        row.append(buildToolRow(p, result, streaming && streamNodes.get(m.id)));
      } else if (p.type === 'image' || p.type === 'file') {
        flushMd();
        row.append(buildAttachment(p));
      }
      // tool_result parts inside assistant messages are consumed via the map
    }
    flushMd();
    if (!row.childNodes.length) {
      // Empty streaming placeholder: keep the row alive for upcoming deltas.
      row.append(el('div', 'msg-assistant msg-pending', ''));
    }
  }

  function appendMessageNode(m) {
    if (isFullyClaimedToolMessage(m)) return null; // folded into existing tool rows
    const row = el('div', 'msg-row');
    row.dataset.messageId = m.id;
    fillMessage(row, m, collectResults(), busy);
    transcriptEl.append(row);
    return row;
  }

  // Re-render one message in place, preserving <details> open state.
  function rerenderMessageNode(m) {
    const row = transcriptEl.querySelector('[data-message-id="' + (window.CSS ? CSS.escape(m.id) : m.id) + '"]');
    if (!row) { appendMessageNode(m); return; }
    const open = new Set();
    row.querySelectorAll('details[open]').forEach((d, i) => {
      const nameEl = d.querySelector('.msg-tool-name');
      open.add(nameEl ? 'tool:' + nameEl.textContent + ':' + i : 'idx:' + i);
    });
    fillMessage(row, m, collectResults(), busy);
    row.querySelectorAll('details').forEach((d, i) => {
      const nameEl = d.querySelector('.msg-tool-name');
      if (open.has(nameEl ? 'tool:' + nameEl.textContent + ':' + i : 'idx:' + i)) d.open = true;
    });
  }

  function fullRedraw() {
    if (!transcriptEl) return;
    streamNodes.clear();
    liveStreams.clear(); // provisional live rows are replaced by history
    transcriptEl.innerHTML = '';
    if (!messages.length) { renderEmptyState(); return; }
    const results = collectResults();
    for (const m of messages) {
      if (isFullyClaimedToolMessage(m)) continue; // folded into existing tool rows
      const row = el('div', 'msg-row');
      row.dataset.messageId = m.id;
      fillMessage(row, m, results, false);
      transcriptEl.append(row);
    }
  }

  function renderEmptyState() {
    const wrap = el('div', 'transcript-empty');
    wrap.append(el('p', 'transcript-empty-text', T('chat.empty_state', '무엇을 도와드릴까요?')));
    transcriptEl.append(wrap);
  }

  function clearEmptyState() {
    const empty = transcriptEl && transcriptEl.querySelector('.transcript-empty');
    if (empty) empty.remove();
  }

  // ---- defensive resync ------------------------------------------------------
  function scheduleReload() {
    if (reloadTimer || !activeSessionId) return;
    if (!window.kimi || typeof window.kimi.getMessages !== 'function') return;
    reloadTimer = setTimeout(async () => {
      reloadTimer = null;
      try {
        const list = await window.kimi.getMessages(activeSessionId);
        if (Array.isArray(list)) {
          optimisticUser = null;
          messages = sortByTime(list.map(normMessage));
          fullRedraw();
          maybeScroll();
        }
      } catch { /* transient: next event will retry */ }
    }, RELOAD_DEBOUNCE_MS);
  }

  // ---- live (id-less) delta streaming -----------------------------------------
  // Live turns stream assistant.delta/thinking.delta keyed only by turnId and
  // emit no event.message.* frames; render those into a provisional row that
  // the end-of-turn REST resync replaces with authoritative messages.
  function onLiveDelta(data, kind) {
    const delta = typeof data.delta === 'string' ? data.delta : '';
    if (!delta) return;
    const key = String(data.turnId ?? data.turn_id ?? 'live');
    let ls = liveStreams.get(key);
    if (!ls) {
      clearEmptyState();
      const row = el('div', 'msg-row msg-live');
      transcriptEl.append(row);
      ls = { row, thinking: '', text: '' };
      liveStreams.set(key, ls);
    }
    if (kind === 'thinking') ls.thinking += delta; else ls.text += delta;
    ls.row.innerHTML = '';
    if (ls.thinking.trim()) ls.row.append(buildThinking(ls.thinking));
    const block = el('div', 'msg-assistant');
    const md = el('div', 'md');
    md.innerHTML = mdRender(ls.text);
    block.append(md);
    ls.row.append(block);
    maybeScroll();
  }

  // ---- event handlers --------------------------------------------------------
  function onMessageCreated(raw) {
    const m = normMessage(raw && raw.message ? raw.message : raw);
    if (!m.id) return;
    const existing = messages.find((x) => x.id === m.id);
    if (existing) { onMessageUpdated({ message_id: m.id, content: m.content, status: m.status }); return; }
    clearEmptyState();
    // Reconcile the optimistic user echo with the server's copy.
    if (m.role === 'user' && optimisticUser && optimisticUser.text === textOfMessage(m)) {
      messages.push(m);
      const row = optimisticUser.el;
      optimisticUser = null;
      row.dataset.messageId = m.id;
      fillMessage(row, m, collectResults(), busy);
      maybeScroll();
      return;
    }
    messages.push(m);
    if (m.role === 'assistant') streamNodes.set(m.id, true);
    appendMessageNode(m);
    // A tool-result message flips its claimant tool rows to done/error.
    if (m.role === 'tool') for (const c of claimantMessages(m)) rerenderMessageNode(c);
    maybeScroll();
  }

  function onMessageUpdated(data) {
    const id = data.message_id ?? data.messageId ?? data.id;
    if (!id) { scheduleReload(); return; }
    const m = messages.find((x) => x.id === id);
    if (!m) { scheduleReload(); return; }
    if (Array.isArray(data.content)) m.content = data.content.map(normPart);
    if (data.status != null) m.status = data.status;
    if (isFinalStatus(m.status)) streamNodes.delete(id);
    rerenderMessageNode(m);
    if (m.role === 'tool') {
      for (const c of claimantMessages(m)) if (c.id !== m.id) rerenderMessageNode(c);
    }
    maybeScroll();
  }

  function onDelta(data, kind) {
    const id = data.message_id ?? data.messageId ?? data.id;
    const delta = typeof data.delta === 'string' ? data.delta : '';
    if (!delta) return;
    if (!id) { onLiveDelta(data, kind); return; } // live turns stream without message ids
    let m = messages.find((x) => x.id === id);
    if (!m) {
      // Delta for a message we never saw created: synthesize a placeholder.
      m = normMessage({ id, role: 'assistant', content: [] });
      messages.push(m);
      streamNodes.set(id, true);
      clearEmptyState();
      appendMessageNode(m);
    }
    const idx = Number.isInteger(data.content_index) ? data.content_index
      : Number.isInteger(data.contentIndex) ? data.contentIndex : 0;
    let part = m.content[idx];
    const want = kind === 'thinking' ? 'thinking' : 'text';
    if (!part || part.type !== want) {
      part = want === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
      m.content[idx] = part;
    }
    if (want === 'thinking') part.thinking += delta; else part.text += delta;
    streamNodes.set(id, true);
    rerenderMessageNode(m);
    maybeScroll();
  }

  function isFinalStatus(status) {
    return typeof status === 'string' &&
      /^(complete|completed|done|final|aborted|cancelled|error)$/i.test(status);
  }

  function setBusyFromStatus(status) {
    if (typeof status !== 'string') return;
    setBusy(status !== 'idle' && status !== 'aborted');
  }

  // ---- public: event entry point --------------------------------------------
  function applyEvent(sessionId, event) {
    if (!initialized || !event || typeof event !== 'object') return;
    let type = typeof event.type === 'string' ? event.type : '';
    if (type.startsWith('event.')) type = type.slice(6);
    const data = (event.payload && typeof event.payload === 'object') ? event.payload : event;
    const sid = sessionId ?? event.session_id ?? event.sessionId ?? data.session_id ?? null;
    if (activeSessionId && sid && sid !== activeSessionId) return; // background session

    switch (type) {
      case 'message.created': onMessageCreated(data); break;
      case 'message.updated': onMessageUpdated(data); break;
      case 'assistant.delta': onDelta(data, 'text'); break;
      case 'thinking.delta': onDelta(data, 'thinking'); break;
      case 'session.status_changed':
        setBusyFromStatus(data.status);
        // Status flip often accompanies the final message.updated; nothing else to do.
        break;
      case 'session.work_changed': setBusy(!!data.busy); break;
      case 'session.history_compacted': scheduleReload(); break;
      // Turn finished (or aborted): pull the authoritative history — live turns
      // stream id-less deltas and emit no event.message.* frames. The server
      // does not always send a busy:false status afterwards, so unlock here too.
      case 'turn.ended':
      case 'prompt.completed':
      case 'prompt.aborted':
        setBusy(false);
        scheduleReload();
        break;
      case 'error': {
        // Backend rejection surfaced mid-chat (e.g. a send attempted on a
        // foreign-engine session, or a failed direct turn): render as a
        // system note. Wire shape: {type:'error', message} (backend.js).
        const note = data.message ?? data.error ?? data.detail;
        if (typeof note === 'string' && note.trim()) appendSystemNote(note);
        break;
      }
      default:
        if (!IGNORE_TYPES.has(type)) scheduleReload(); // unknown shape: full resync
        break;
    }
  }

  // ---- busy state ------------------------------------------------------------
  function setBusy(b) {
    const wasBusy = busy;
    busy = !!b;
    if (!initialized) return;
    refreshComposerUi();
    if (wasBusy && !busy) {
      // Stream ended: settle any leftover running tool rows.
      streamNodes.clear();
      for (const m of messages) {
        if (m.role === 'assistant' || m.role === 'tool') rerenderMessageNode(m);
      }
      // Safety resync when a busy period with live traffic ends.
      if (liveStreams.size > 0) scheduleReload();
    }
  }

  // ---- read-only (foreign-engine session) --------------------------------------
  // v5 (R-UX): app.js flags sessions the active engine cannot continue (e.g.
  // a direct session listed under the cli engine). The transcript still
  // renders; the composer + send button lock and show the notice instead.
  function setReadOnly(flag) {
    const next = !!flag;
    if (next === readOnly) return;
    readOnly = next;
    if (initialized) refreshComposerUi();
  }

  /** Composer + send-button chrome for the current busy/readOnly state. */
  function refreshComposerUi() {
    if (!initialized) return;
    composerEl.disabled = busy || readOnly;
    if (readOnly) {
      const notice = T('chat.foreign_readonly', '내장 엔진 세션은 열어보기만 가능합니다 · 엔진 전환 시 이어쓸 수 있습니다');
      composerEl.setAttribute('placeholder', notice);
    } else {
      composerEl.setAttribute('placeholder', T('chat.composer_placeholder', '메시지를 입력하세요…'));
    }
    updateSendBtn();
  }

  function updateSendBtn() {
    if (!sendBtn) return;
    // Busy (and not read-only): the send button becomes a stop button —
    // always clickable; click routes to App.abort() (see wireComposer).
    const stop = busy && !readOnly;
    sendBtn.classList.toggle('stop-mode', stop);
    sendBtn.disabled = readOnly || (!stop && !composerEl.value.trim());
    if (stop) {
      sendBtn.setAttribute('aria-label', T('chat.abort_title', '중단'));
      sendBtn.title = T('chat.abort_title', '중단');
    } else {
      sendBtn.setAttribute('aria-label', T('chat.send_aria', '전송'));
      // Read-only (foreign-engine) sessions explain why the button is inert.
      sendBtn.title = readOnly
        ? T('chat.foreign_readonly', '내장 엔진 세션은 열어보기만 가능합니다 · 엔진 전환 시 이어쓸 수 있습니다')
        : T('chat.send_title', '전송 (↵)');
    }
  }

  // ---- composer ----------------------------------------------------------------
  function autoGrow() {
    composerEl.style.height = 'auto';
    composerEl.style.height = Math.min(composerEl.scrollHeight, COMPOSER_MAX_PX) + 'px';
  }

  function appendOptimisticUser(text) {
    clearEmptyState();
    const row = el('div', 'msg-row msg-user msg-optimistic');
    row.append(el('div', 'msg-user-text', text));
    transcriptEl.append(row);
    optimisticUser = { text, el: row };
    scrollToBottom();
  }

  function appendSystemNote(text) {
    clearEmptyState();
    const row = el('div', 'msg-row msg-system');
    row.append(el('div', 'msg-system-text', text));
    transcriptEl.append(row);
    maybeScroll();
  }

  function doSend() {
    if (busy || readOnly) return;
    const text = composerEl.value.trim();
    if (!text) return;
    const app = window.App;
    if (!app || typeof app.sendPrompt !== 'function') return;
    composerEl.value = '';
    autoGrow();
    updateSendBtn();
    appendOptimisticUser(text);
    setBusy(true); // input locks until the server reports idle again
    Promise.resolve()
      .then(() => app.sendPrompt(text))
      .then((ok) => {
        // App.sendPrompt swallows its errors and reports failure as false.
        if (ok === false) {
          appendSystemNote(T('chat.send_failed', '메시지 전송에 실패했습니다. 다시 시도해 주세요.'));
          setBusy(false);
        }
      })
      .catch(() => {
        appendSystemNote(T('chat.send_failed', '메시지 전송에 실패했습니다. 다시 시도해 주세요.'));
        setBusy(false);
      });
  }

  function wireComposer() {
    composerEl.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter inserts a newline. isComposing guards IME (한글) input.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        doSend();
      }
    });
    composerEl.addEventListener('input', () => { autoGrow(); updateSendBtn(); });
    sendBtn.addEventListener('click', () => {
      // Stop-mode: while the session is busy the button aborts instead of sending.
      if (busy && !readOnly) {
        if (window.App && typeof window.App.abort === 'function') window.App.abort();
        return;
      }
      doSend();
    });
  }

  // ---- public API ---------------------------------------------------------------
  function init() {
    if (initialized) return;
    transcriptEl = document.getElementById('transcript');
    composerEl = document.getElementById('composer');
    sendBtn = document.getElementById('send-btn');
    if (!transcriptEl || !composerEl || !sendBtn) return; // DOM not ready
    initialized = true;
    wireComposer();
    transcriptEl.addEventListener('scroll', () => { pinned = isPinned(); });
    pinned = true;
    renderEmptyState();
    refreshComposerUi();
  }

  function renderMessages(list, sessionId) {
    if (!initialized) init();
    if (!initialized) return;
    if (sessionId !== undefined) activeSessionId = sessionId;
    if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    optimisticUser = null;
    liveStreams.clear();
    messages = sortByTime((Array.isArray(list) ? list : []).map(normMessage));
    fullRedraw();
    pinned = true;
    scrollToBottom();
    updateSendBtn();
  }

  // GET messages returns newest-first; render oldest-first (stable sort,
  // messages without a parseable timestamp keep their relative order at 0).
  function sortByTime(list) {
    const ts = (m) => {
      const v = m.created_at;
      const n = typeof v === 'number' ? v : Date.parse(v);
      return Number.isFinite(n) ? n : 0;
    };
    return list.slice().sort((a, b) => ts(a) - ts(b));
  }

  function setActiveSession(id) {
    activeSessionId = id ?? null;
  }

  function reset() {
    messages = [];
    streamNodes.clear();
    liveStreams.clear();
    optimisticUser = null;
    readOnly = false;
    if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
    if (initialized) {
      transcriptEl.innerHTML = '';
      composerEl.value = '';
      autoGrow();
      setBusy(false);
      refreshComposerUi();
      renderEmptyState();
      pinned = true;
    }
  }

  window.Chat = {
    init,
    renderMessages,
    applyEvent,
    setBusy,
    setReadOnly,
    setActiveSession,
    reset,
    scrollToBottom,
    scrollToMessage,
  };

  // app.js may load after us; init as soon as the DOM is usable either way.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Language change: refresh the composer placeholder/notice, the send/stop
  // tooltip and the empty-state copy. The transcript itself is not
  // re-rendered (history stays as-is).
  window.I18N?.onChange?.(() => {
    if (!initialized) return;
    refreshComposerUi();
    const empty = transcriptEl.querySelector('.transcript-empty-text');
    if (empty) empty.textContent = T('chat.empty_state', '무엇을 도와드릴까요?');
  });
})();
