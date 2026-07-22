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
 */
(function () {
  'use strict';

  const SCROLL_PIN_PX = 80;      // user is "at bottom" within this distance
  const COMPOSER_MAX_PX = 200;   // auto-grow ceiling
  const SUMMARY_MAX = 80;        // one-line tool input summary
  const TOOL_BODY_MAX = 4000;    // collapsed tool body truncation
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
    'error', 'warning',
  ]);

  // ---- module state --------------------------------------------------------
  let transcriptEl = null;
  let composerEl = null;
  let sendBtn = null;
  let abortBtn = null;
  let initialized = false;

  let activeSessionId = null;
  let messages = [];                    // normalized cache of the rendered session
  const streamNodes = new Map();        // messageId -> true for in-progress assistant rows
  const liveStreams = new Map();        // turnId -> { row, thinking, text } for id-less deltas
  let optimisticUser = null;            // { text, el } echoed locally until server confirms
  let busy = false;
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

  function trunc(s, max) {
    s = String(s);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
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

  function toolSummary(name, input) {
    if (input == null) return '';
    if (typeof input === 'string') return trunc(oneLine(input), SUMMARY_MAX);
    if (typeof input !== 'object') return trunc(oneLine(String(input)), SUMMARY_MAX);
    const pick = (k) => (typeof input[k] === 'string' && input[k] ? input[k] : null);
    let s = null;
    switch (name) {
      case 'Read': case 'Edit': case 'Write': case 'NotebookEdit':
        s = pick('file_path'); break;
      case 'ReadMediaFile': s = pick('path'); break;
      case 'Glob': s = pick('pattern'); break;
      case 'Grep':
        s = pick('pattern');
        if (s && input.path) s += '  ·  ' + String(input.path);
        break;
      case 'Bash': s = pick('command'); break;
      case 'WebFetch': case 'FetchURL': s = pick('url'); break;
      case 'WebSearch': s = pick('query'); break;
      case 'Task': case 'Agent': s = pick('description') || pick('prompt'); break;
      case 'Skill': s = pick('skill'); break;
      case 'TodoList': s = ''; break;
      default: s = null;
    }
    if (s == null) {
      try { s = JSON.stringify(input); } catch { s = String(input); }
    }
    return trunc(oneLine(s || ''), SUMMARY_MAX);
  }

  function toolBodyText(part, result) {
    let out = '';
    if (part.input !== undefined) {
      try { out = typeof part.input === 'string' ? part.input : JSON.stringify(part.input, null, 2); }
      catch { out = String(part.input); }
    }
    if (result) {
      let o = result.output;
      if (o == null) o = '';
      if (typeof o !== 'string') { try { o = JSON.stringify(o, null, 2); } catch { o = String(o); } }
      out += (out ? '\n\n' : '') + o;
    }
    if (!out.trim()) out = T('chat.tool.no_content', '(내용 없음)');
    return trunc(out, TOOL_BODY_MAX);
  }

  function buildToolRow(part, result, streaming) {
    const state = result ? (result.is_error ? 'error' : 'done') : (streaming ? 'running' : 'done');
    const row = el('details', 'msg-tool ' + state);
    const summary = document.createElement('summary');
    summary.className = 'msg-tool-header';
    summary.append(
      el('span', 'msg-tool-chevron', '▸'),
      el('span', 'msg-tool-name', part.tool_name || 'tool'),
      el('span', 'msg-tool-summary', toolSummary(part.tool_name, part.input)),
    );
    const body = el('pre', 'msg-tool-body', toolBodyText(part, result));
    row.append(summary, body);
    return row;
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
        mdBuffer += (mdBuffer ? '\n' : '') + p.text;
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
    wrap.innerHTML =
      '<svg class="transcript-empty-glyph" viewBox="0 0 64 64" width="44" height="44" aria-hidden="true">' +
      '<path fill="currentColor" d="M44.6 6.9A27 27 0 1 0 57 44.6 24.5 24.5 0 0 1 44.6 6.9z"/>' +
      '</svg>';
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
    composerEl.disabled = busy;
    abortBtn.hidden = !busy;
    updateSendBtn();
    if (!busy) {
      // Stream ended: settle any leftover running tool rows.
      streamNodes.clear();
      for (const m of messages) {
        if (m.role === 'assistant' || m.role === 'tool') rerenderMessageNode(m);
      }
      // Safety resync when a busy period with live traffic ends.
      if (wasBusy && liveStreams.size > 0) scheduleReload();
    }
  }

  function updateSendBtn() {
    if (!sendBtn) return;
    sendBtn.disabled = busy || !composerEl.value.trim();
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
    if (busy) return;
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
          appendSystemNote(T('chat.send_failed', '메시지 전송에 실패했어요. 다시 시도해 주세요.'));
          setBusy(false);
        }
      })
      .catch(() => {
        appendSystemNote(T('chat.send_failed', '메시지 전송에 실패했어요. 다시 시도해 주세요.'));
        setBusy(false);
      });
  }

  function wireComposer() {
    composerEl.setAttribute('placeholder', T('chat.composer_placeholder', '메시지를 입력하세요…'));
    composerEl.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter inserts a newline. isComposing guards IME (한글) input.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        doSend();
      }
    });
    composerEl.addEventListener('input', () => { autoGrow(); updateSendBtn(); });
    sendBtn.addEventListener('click', doSend);
    abortBtn.addEventListener('click', () => {
      if (window.App && typeof window.App.abort === 'function') window.App.abort();
    });
  }

  // ---- public API ---------------------------------------------------------------
  function init() {
    if (initialized) return;
    transcriptEl = document.getElementById('transcript');
    composerEl = document.getElementById('composer');
    sendBtn = document.getElementById('send-btn');
    abortBtn = document.getElementById('abort-btn');
    if (!transcriptEl || !composerEl || !sendBtn || !abortBtn) return; // DOM not ready
    initialized = true;
    wireComposer();
    transcriptEl.addEventListener('scroll', () => { pinned = isPinned(); });
    pinned = true;
    renderEmptyState();
    updateSendBtn();
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
    if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
    if (initialized) {
      transcriptEl.innerHTML = '';
      composerEl.value = '';
      autoGrow();
      setBusy(false);
      renderEmptyState();
      pinned = true;
    }
  }

  window.Chat = {
    init,
    renderMessages,
    applyEvent,
    setBusy,
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

  // Language change: refresh the composer placeholder and the empty-state
  // copy. The transcript itself is not re-rendered (history stays as-is).
  window.I18N?.onChange?.(() => {
    if (!initialized) return;
    composerEl.setAttribute('placeholder', T('chat.composer_placeholder', '메시지를 입력하세요…'));
    const empty = transcriptEl.querySelector('.transcript-empty-text');
    if (empty) empty.textContent = T('chat.empty_state', '무엇을 도와드릴까요?');
  });
})();
