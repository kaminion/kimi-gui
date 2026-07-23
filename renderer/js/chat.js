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
 * - While the active session is busy, the composer stays editable and Enter
 *   steers the active turn. #composer-abort-btn remains a separate stop action
 *   so adjusting work never hides or overloads cancellation.
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
 *
 * v7 (process block): each assistant message renders as one collapsible
 * <details class="msg-process"> ("사고 과정") holding the thinking content and
 * the v6 tool rows in chronological order, followed by the markdown answer.
 * While the turn runs the header shows a spinner + live activity ('생각하는
 * 중…' / '<Tool> 실행 중…' / '작업하는 중…') and the block auto-opens; at turn
 * end it auto-closes unless the user took control of the disclosure. Live
 * turns (id-less turnId deltas + tool.call.started/tool.result frames) update
 * the same block in real time; turn.ended still triggers the authoritative
 * REST resync. Machine-only context appends (origin.kind injection /
 * skill_activation / task / background_task, or text starting with
 * '<system-reminder' / '<notification' / skill-wrapper blobs) are dropped
 * from the transcript entirely.
 *
 * v8 (file changes): Edit/Write/MultiEdit/NotebookEdit/apply_patch steps render
 * as first-class, file-by-file diff cards in the assistant surface. They show
 * live/done/error state, line counts, old/new gutters, compacted context, and
 * preserve disclosure state while streaming results settle.
 */
(function () {
  'use strict';

  const SCROLL_PIN_PX = 80;      // user is "at bottom" within this distance
  const COMPOSER_MAX_PX = 200;   // auto-grow ceiling
  const SUMMARY_MAX = 80;        // one-line tool target in the row header
  const TOOL_BODY_MAX = 4000;    // per-block truncation (~4KB) in the tool body
  const CHANGE_ROWS_MAX = 260;   // keep large file writes responsive in the transcript
  const RELOAD_DEBOUNCE_MS = 300;
  const HIGHLIGHT_FLASH_MS = 1200;  // keep in sync with search-highlight-flash in search.css
  const HISTORY_LOADING_DELAY_MS = 120; // avoid flashing a skeleton for warm reads

  const T = (k, f) => (window.I18N?.t ? window.I18N.t(k, f) : f);

  // Event types we deliberately ignore (no transcript impact).
  // NOTE: turn.ended / prompt.completed / prompt.aborted are NOT ignored — they
  // trigger an authoritative REST resync, because live turns stream deltas
  // without message_id and no event.message.* frames are emitted (verified
  // against kimi 0.28.1). v7: turn.started / tool.call.started / tool.result
  // are NOT ignored either — they drive the live process block.
  const IGNORE_TYPES = new Set([
    'session.created', 'session.updated', 'session.deleted', 'session.meta.updated',
    'session.usage_updated', 'agent.status.updated', 'context.spliced',
    'turn.step.started', 'turn.step.completed',
    'turn.step.retrying', 'turn.step.interrupted',
    'tool.call.delta', 'tool.progress',
    'tool.list.updated', 'mcp.server.status',
    'shell.output', 'shell.started', 'shell.completed',
    'subagent.spawned', 'subagent.started', 'subagent.suspended',
    'subagent.completed', 'subagent.failed',
    'compaction.started', 'compaction.blocked', 'compaction.cancelled', 'compaction.completed',
    'task.started', 'task.terminated', 'task.created', 'task.progress', 'task.completed',
    'background.task.started', 'background.task.terminated',
    'cron.fired', 'hook.result', 'goal.updated',
    'skill.activated', 'plugin_command.activated',
    'prompt.submitted',
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
  let abortBtn = null;
  let slashAutocomplete = null;
  let initialized = false;

  let activeSessionId = null;
  let messages = [];                    // normalized cache of the rendered session
  const streamNodes = new Map();        // messageId -> true for in-progress assistant rows
  const liveStreams = new Map();        // turnId -> live process-block state for id-less deltas
  const processIntent = new Map();      // messageId -> 'open'|'closed' (user disclosure intent)
  let optimisticUser = null;            // { text, el } echoed locally until server confirms
  let optimisticSteers = [];            // [{ text, el }] current-turn adjustments
  let busy = false;
  let readOnly = false;                 // foreign-engine session: composer locked, notice shown
  let currentChangeSnapshot = { sessionId: null, fileCount: 0, additions: 0, deletions: 0, files: [] };
  let pinned = true;
  let reloadTimer = null;
  let highlightTimer = null;        // pending removal of a .search-highlight flash
  let historyLoadingTimer = null;
  let historyLoadingSessionId = null;

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
      // Machine-content filtering (v7): REST wire carries metadata.origin
      // ({kind:'injection'|'task'|...}); the local replay may attach origin.
      origin: m.origin ?? (m.metadata && m.metadata.origin) ?? null,
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

  // ---- machine-content filtering (v7) ---------------------------------------
  // Machine-only context appends never surface in the transcript: CLI
  // injections (<system-reminder>), task notifications (<notification …>),
  // and skill-wrapper blobs. Detected by origin.kind when the shape carries
  // it, else by the well-known text prefixes (user-role only, so genuine
  // assistant prose quoting such text is never eaten). Genuine user/system
  // notes (error notes, send-failed) are renderer-local and unaffected.
  const MACHINE_ORIGINS = new Set(['injection', 'skill_activation', 'task', 'background_task']);

  function isMachineMessage(m) {
    const kind = m.origin && m.origin.kind;
    if (kind && MACHINE_ORIGINS.has(kind)) return true;
    if (m.role !== 'user') return false;
    const t = textOfMessage(m).trimStart();
    return t.startsWith('<system-reminder') || t.startsWith('<notification') ||
      t.startsWith('<kimi-skill-loaded') || t.startsWith('Skill tool loaded instructions');
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
      case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': case 'ReadMediaFile': {
        const p = pick('file_path', 'path');
        return p ? basename(p) : firstScalar(input);
      }
      case 'apply_patch': {
        const paths = parseApplyPatch(input).map((change) => change.path);
        return paths.length ? paths.map(basename).join(', ') : firstScalar(input);
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

  // ---- file-change presentation ---------------------------------------------
  // Mutation tools are promoted out of the generic tool log into GPT-style
  // change cards in the assistant surface. The renderer only uses tool input,
  // so it works for both live events and persisted message history.
  function toolKey(name) {
    const parts = String(name || '').toLowerCase().split(/(?:__|[.:/])/);
    return parts[parts.length - 1].replace(/-/g, '_');
  }

  function mutationKind(part) {
    const key = toolKey(part && part.tool_name);
    const aliases = {
      edit: 'edit',
      edit_file: 'edit',
      write: 'write',
      write_file: 'write',
      multiedit: 'multiedit',
      multi_edit: 'multiedit',
      notebookedit: 'notebookedit',
      notebook_edit: 'notebookedit',
      applypatch: 'apply_patch',
      apply_patch: 'apply_patch',
    };
    return aliases[key] || null;
  }

  function inputPath(input) {
    if (!input || typeof input !== 'object') return '';
    return input.file_path ?? input.filePath ?? input.path ?? input.notebook_path ?? input.notebookPath ?? '';
  }

  function contentLines(value) {
    if (value == null || value === '') return [];
    if (Array.isArray(value)) return value.flatMap((line) => contentLines(line));
    return String(value).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  }

  // Line-level LCS keeps unchanged context readable for Edit/MultiEdit instead
  // of painting the entire replacement red and green. Very large replacements
  // take the linear fallback to avoid quadratic work on the UI thread.
  function pairedDiffRows(oldValue, newValue) {
    const before = contentLines(oldValue);
    const after = contentLines(newValue);
    if (!before.length) return after.map((text, i) => ({ type: 'add', text, oldNo: null, newNo: i + 1 }));
    if (!after.length) return before.map((text, i) => ({ type: 'del', text, oldNo: i + 1, newNo: null }));

    if (before.length * after.length > 40000) {
      return [
        ...before.map((text, i) => ({ type: 'del', text, oldNo: i + 1, newNo: null })),
        ...after.map((text, i) => ({ type: 'add', text, oldNo: null, newNo: i + 1 })),
      ];
    }

    const dp = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
    for (let i = before.length - 1; i >= 0; i--) {
      for (let j = after.length - 1; j >= 0; j--) {
        dp[i][j] = before[i] === after[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const rows = [];
    let i = 0;
    let j = 0;
    while (i < before.length || j < after.length) {
      if (i < before.length && j < after.length && before[i] === after[j]) {
        rows.push({ type: 'context', text: before[i], oldNo: i + 1, newNo: j + 1 });
        i++;
        j++;
      } else if (j < after.length && (i >= before.length || dp[i][j + 1] > dp[i + 1][j])) {
        rows.push({ type: 'add', text: after[j], oldNo: null, newNo: j + 1 });
        j++;
      } else {
        rows.push({ type: 'del', text: before[i], oldNo: i + 1, newNo: null });
        i++;
      }
    }
    return rows;
  }

  function changeFromPair(path, oldValue, newValue, kind) {
    const rows = pairedDiffRows(oldValue, newValue);
    return {
      path: String(path || T('chat.change.unknown_file', '이름 없는 파일')),
      kind: kind || 'modified',
      rows,
      additions: rows.filter((r) => r.type === 'add').length,
      deletions: rows.filter((r) => r.type === 'del').length,
    };
  }

  function patchText(input) {
    if (typeof input === 'string') return input;
    if (!input || typeof input !== 'object') return '';
    return input.patch ?? input.input ?? input.diff ?? '';
  }

  // Parses the custom *** Update File format used by apply_patch. Numeric
  // unified-diff hunk headers are honored when present; anchor-only hunks keep
  // the number gutter blank rather than inventing source locations.
  function parseApplyPatch(input) {
    const lines = String(patchText(input)).replace(/\r\n?/g, '\n').split('\n');
    const changes = [];
    let current = null;
    let oldLine = null;
    let newLine = null;

    const finish = () => {
      if (!current) return;
      current.additions = current.rows.filter((r) => r.type === 'add').length;
      current.deletions = current.rows.filter((r) => r.type === 'del').length;
      changes.push(current);
      current = null;
    };

    for (const line of lines) {
      const file = line.match(/^\*\*\*\s+(Add|Update|Delete) File:\s*(.+?)\s*$/);
      if (file) {
        finish();
        const kind = file[1] === 'Add' ? 'added' : file[1] === 'Delete' ? 'deleted' : 'modified';
        current = { path: file[2], kind, rows: [], additions: 0, deletions: 0 };
        oldLine = null;
        newLine = null;
        continue;
      }
      if (!current) continue;

      const move = line.match(/^\*\*\*\s+Move to:\s*(.+?)\s*$/);
      if (move) {
        current.oldPath = current.path;
        current.path = move[1];
        current.kind = 'renamed';
        continue;
      }
      if (/^\*\*\*\s+(?:End Patch|End of File)\s*$/.test(line)) {
        if (/End Patch/.test(line)) finish();
        continue;
      }
      if (line.startsWith('@@')) {
        const range = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        oldLine = range ? Number(range[1]) : null;
        newLine = range ? Number(range[2]) : null;
        current.rows.push({ type: 'hunk', text: line.replace(/^@@\s*|\s*@@.*$/g, '').trim() });
        continue;
      }

      const marker = line[0];
      if (marker !== '+' && marker !== '-' && marker !== ' ') continue;
      const type = marker === '+' ? 'add' : marker === '-' ? 'del' : 'context';
      current.rows.push({
        type,
        text: line.slice(1),
        oldNo: type === 'add' ? null : oldLine,
        newNo: type === 'del' ? null : newLine,
      });
      if (type !== 'add' && oldLine != null) oldLine++;
      if (type !== 'del' && newLine != null) newLine++;
    }
    finish();
    return changes;
  }

  function mutationChanges(part) {
    const key = mutationKind(part);
    if (!key) return [];
    const input = part.input && typeof part.input === 'object' ? part.input : null;

    if (key === 'apply_patch') return parseApplyPatch(part.input);
    if (!input) return [];

    const path = inputPath(input);
    if (key === 'edit') {
      return [changeFromPair(path, input.old_string ?? input.oldString ?? '', input.new_string ?? input.newString ?? '', 'modified')];
    }
    if (key === 'write') {
      return [changeFromPair(path, '', input.content ?? input.text ?? '', 'modified')];
    }
    if (key === 'notebookedit') {
      const before = input.old_source ?? input.oldSource ?? input.old_string ?? input.oldString ?? '';
      const after = input.new_source ?? input.newSource ?? input.new_string ?? input.newString ??
        input.content ?? input.source ?? '';
      return [changeFromPair(path, before, after, 'modified')];
    }
    if (key === 'multiedit' && Array.isArray(input.edits)) {
      const rows = [];
      input.edits.forEach((edit, index) => {
        if (index) rows.push({ type: 'hunk', text: '' });
        rows.push(...pairedDiffRows(
          edit.old_string ?? edit.oldString ?? '',
          edit.new_string ?? edit.newString ?? '',
        ));
      });
      return [{
        path: String(path || T('chat.change.unknown_file', '이름 없는 파일')),
        kind: 'modified',
        rows,
        additions: rows.filter((r) => r.type === 'add').length,
        deletions: rows.filter((r) => r.type === 'del').length,
      }];
    }
    return [];
  }

  function compactContextRows(rows) {
    const result = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i].type !== 'context') {
        result.push(rows[i++]);
        continue;
      }
      let end = i;
      while (end < rows.length && rows[end].type === 'context') end++;
      const run = rows.slice(i, end);
      if (run.length > 8) {
        result.push(...run.slice(0, 3), { type: 'fold', count: run.length - 6 }, ...run.slice(-3));
      } else {
        result.push(...run);
      }
      i = end;
    }
    return result;
  }

  function changeVerb(kind, state) {
    if (state === 'running') return T('chat.change.editing', '수정 중');
    if (state === 'error') return T('chat.change.failed', '수정 실패');
    if (kind === 'added') return T('chat.change.created', '생성함');
    if (kind === 'deleted') return T('chat.change.deleted', '삭제함');
    if (kind === 'renamed') return T('chat.change.renamed', '이동함');
    return T('chat.change.edited', '수정함');
  }

  function buildChangeLine(row) {
    const line = el('div', 'msg-change-line ' + row.type);
    if (row.type === 'fold') {
      const label = row.more
        ? T('chat.change.more_lines', 'N줄 더 있음').replace('N', row.count)
        : T('chat.change.unchanged', '변경 없는 N줄').replace('N', row.count);
      line.append(el('span', 'msg-change-fold', label));
      return line;
    }
    if (row.type === 'hunk') {
      line.append(el('span', 'msg-change-hunk', row.text || T('chat.change.next_hunk', '다음 변경')));
      return line;
    }
    line.append(
      el('span', 'msg-change-number', row.oldNo == null ? '' : row.oldNo),
      el('span', 'msg-change-number', row.newNo == null ? '' : row.newNo),
      el('span', 'msg-change-marker', row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '),
      el('code', 'msg-change-code', row.text),
    );
    return line;
  }

  function buildChangeCard(change, result, streaming, index, total) {
    const state = result ? (result.is_error ? 'error' : 'done') : (streaming ? 'running' : 'done');
    const hasBody = change.rows.length > 0 || state === 'error';
    const card = el(hasBody ? 'details' : 'div', 'msg-change ' + state + (hasBody ? '' : ' no-detail'));
    card.dataset.changePath = change.path;
    if (hasBody) card.open = total === 1 || index === 0;

    const summary = document.createElement(hasBody ? 'summary' : 'div');
    summary.className = 'msg-change-header';
    summary.title = change.oldPath ? change.oldPath + ' → ' + change.path : change.path;
    const path = el('span', 'msg-change-path', change.oldPath ? change.oldPath + ' → ' + change.path : change.path);
    const stats = el('span', 'msg-change-stats');
    if (change.additions) stats.append(el('span', 'msg-change-additions', '+' + change.additions));
    if (change.deletions) stats.append(el('span', 'msg-change-deletions', '-' + change.deletions));
    if (!change.additions && !change.deletions) {
      stats.append(el('span', 'msg-change-neutral', T('chat.change.no_lines', '파일 변경')));
    }
    const headerItems = [
      el('span', 'tool-status', ''),
      el('span', 'msg-change-verb', changeVerb(change.kind, state)),
      path,
      stats,
    ];
    if (hasBody) headerItems.push(el('span', 'msg-change-chevron', '▸'));
    summary.append(...headerItems);

    card.append(summary);
    if (hasBody) {
      const body = el('div', 'msg-change-body');
      if (change.rows.length) {
        const diff = el('div', 'msg-change-diff');
        diff.setAttribute('role', 'region');
        diff.setAttribute('aria-label', T('chat.change.diff_aria', '파일 변경 내용') + ': ' + change.path);
        const rows = compactContextRows(change.rows);
        const visible = rows.slice(0, CHANGE_ROWS_MAX);
        for (const row of visible) diff.append(buildChangeLine(row));
        if (rows.length > visible.length) {
          diff.append(buildChangeLine({ type: 'fold', count: rows.length - visible.length, more: true }));
        }
        body.append(diff);
      }
      if (state === 'error') {
        const output = resultText(result).trim() || T('chat.change.failed_detail', '변경사항을 적용하지 못했습니다.');
        body.append(el('pre', 'msg-change-error', bodyTrim(output)));
      }
      card.append(body);
    }
    return card;
  }

  function buildChangeSet(part, result, streaming) {
    const changes = mutationChanges(part);
    if (!changes.length) return null;
    const wrap = el('div', 'msg-change-set');
    changes.forEach((change, index) => {
      wrap.append(buildChangeCard(change, result, streaming, index, changes.length));
    });
    return wrap;
  }

  function emptyChangeSnapshot(sessionId) {
    return { sessionId: sessionId ?? null, fileCount: 0, additions: 0, deletions: 0, files: [] };
  }

  function addSnapshotChange(files, change, state, callId) {
    let file = files.get(change.path);
    if (!file) {
      file = {
        path: change.path,
        oldPath: change.oldPath || null,
        kind: change.kind,
        state,
        additions: 0,
        deletions: 0,
        rows: [],
        callIds: [],
      };
      files.set(change.path, file);
    } else if (file.rows.length && change.rows.length) {
      file.rows.push({ type: 'hunk', text: '' });
    }
    file.oldPath = change.oldPath || file.oldPath;
    file.kind = change.kind || file.kind;
    if (state === 'running') file.state = 'running';
    file.additions += change.additions || 0;
    file.deletions += change.deletions || 0;
    file.rows.push(...compactContextRows(change.rows));
    if (callId && !file.callIds.includes(callId)) file.callIds.push(callId);
  }

  // Message history is the source of truth. Provisional live mutation tools
  // are layered on top until the end-of-turn history resync replaces them.
  function buildChangeSnapshot() {
    if (!activeSessionId) return emptyChangeSnapshot(null);
    const files = new Map();
    const seenCalls = new Set();
    const results = collectResults();

    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const part of message.content) {
        if (part.type !== 'tool_use') continue;
        const changes = mutationChanges(part);
        if (!changes.length) continue;
        const callId = String(part.tool_call_id || '');
        const result = callId ? results.get(callId) : undefined;
        if (result?.is_error) continue;
        const state = result ? 'done' : 'running';
        for (const change of changes) addSnapshotChange(files, change, state, callId);
        if (callId) seenCalls.add(callId);
      }
    }

    for (const live of liveStreams.values()) {
      for (const tool of live.tools.values()) {
        const callId = String(tool.part.tool_call_id || '');
        if ((callId && seenCalls.has(callId)) || tool.result?.is_error) continue;
        const changes = mutationChanges(tool.part);
        const state = tool.result ? 'done' : 'running';
        for (const change of changes) addSnapshotChange(files, change, state, callId);
      }
    }

    const list = Array.from(files.values());
    return {
      sessionId: activeSessionId,
      fileCount: list.length,
      additions: list.reduce((sum, file) => sum + file.additions, 0),
      deletions: list.reduce((sum, file) => sum + file.deletions, 0),
      files: list,
    };
  }

  function emitChangeSnapshot(snapshot) {
    currentChangeSnapshot = snapshot;
    if (typeof window.CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('kimi:changes-updated', { detail: snapshot }));
    }
  }

  function publishChanges() {
    emitChangeSnapshot(buildChangeSnapshot());
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

  // ---- process block (v7) ----------------------------------------------------
  // One collapsible "사고 과정" block per assistant turn: thinking content and
  // v6 tool rows in chronological order. Done header: '사고 과정' + dim tool
  // count; running header: live activity line (see updateLiveHeader).
  function processToolCount(parts) {
    return parts.filter((p) => p.type === 'tool_use').length;
  }

  // '도구 N개 사용' — the table strings hold a literal N placeholder swapped
  // for the count (ko '도구 N개 사용' / en 'N tools used').
  function setProcessHeaderDone(titleEl, metaEl, toolCount) {
    titleEl.textContent = T('chat.thinking', '사고 과정');
    metaEl.textContent = toolCount > 0
      ? T('chat.process.tools_used', '도구 N개 사용').replace('N', toolCount)
      : '';
  }

  function updateProcessAction(box, action) {
    if (!box || !action) return;
    const open = box.open;
    action.textContent = open
      ? T('chat.process.collapse', '접기')
      : T('chat.process.expand', '펼치기');
    action.setAttribute(
      'aria-label',
      open
        ? T('chat.process.collapse', '접기')
        : T('chat.process.expand', '펼치기')
    );
  }

  function buildProcessShell(running) {
    const box = el('details', 'msg-process' + (running ? ' running' : ''));
    const sum = document.createElement('summary');
    sum.className = 'msg-process-header';
    const status = el('span', 'process-status', '');
    const chev = el('span', 'msg-process-chevron', '▸');
    const title = el('span', 'msg-process-title', '');
    const meta = el('span', 'msg-process-meta', '');
    const action = el('span', 'msg-process-action', '');
    sum.append(status, chev, title, meta, action);
    const body = el('div', 'msg-process-body');
    box.append(sum, body);
    box.addEventListener('toggle', () => updateProcessAction(box, action));
    updateProcessAction(box, action);
    return { box, title, meta, action, body };
  }

  function appendProcessThinking(body, text) {
    const div = el('div', 'msg-process-thinking');
    const md = el('div', 'md');
    md.innerHTML = mdRender(text);
    div.append(md);
    body.append(div);
    return div;
  }

  // Activity line for a still-streaming (id-based) process block: the last
  // unfinished tool wins, else thinking, else generic working.
  function processActivityText(parts, results) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.type === 'tool_use') {
        if (!(p.tool_call_id && results.has(p.tool_call_id))) {
          return (p.tool_name || 'tool') + ' ' + T('chat.process.tool_running', '실행 중…');
        }
      } else if (p.type === 'thinking') {
        return T('chat.process.thinking', '생각하는 중…');
      }
    }
    return T('chat.process.working', '작업하는 중…');
  }

  // History/id-stream block: open while running (unless the user closed it),
  // collapsed when done (unless the user opened it) — processIntent rules.
  function buildProcessBlock(parts, results, running, msgId, toolCount) {
    const { box, title, meta, action, body } = buildProcessShell(running);
    for (const p of parts) {
      if (p.type === 'thinking') {
        appendProcessThinking(body, p.thinking);
      } else if (p.type === 'tool_use') {
        const result = p.tool_call_id ? results.get(p.tool_call_id) : undefined;
        body.append(buildToolRow(p, result, running));
      }
    }
    if (running) {
      title.textContent = processActivityText(parts, results);
      box.open = processIntent.get(msgId) !== 'closed';
    } else {
      setProcessHeaderDone(title, meta, toolCount ?? processToolCount(parts));
      box.open = processIntent.get(msgId) === 'open';
    }
    updateProcessAction(box, action);
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
    // assistant: one process block (thinking + tool steps, any position) plus
    // the markdown answer text outside it; attachments keep their order.
    const processParts = [];
    const surface = []; // ordered {kind:'md'|'change'|'attach'} items rendered after the block
    let toolCount = 0;
    let mdBuffer = '';
    const flushMd = () => {
      if (!mdBuffer.trim()) { mdBuffer = ''; return; }
      surface.push({ kind: 'md', text: mdBuffer });
      mdBuffer = '';
    };
    for (const p of m.content) {
      if (p.type === 'text') {
        // Leaked function call (a whole text part that is one invocation JSON
        // blob) becomes a tool step in the block, not inline JSON.
        const raw = parseRawToolCall(p.text);
        if (raw) {
          flushMd();
          processParts.push(raw);
          toolCount++;
        } else {
          mdBuffer += (mdBuffer ? '\n' : '') + p.text;
        }
      } else if (p.type === 'thinking') {
        if (p.thinking && p.thinking.trim()) processParts.push(p);
      } else if (p.type === 'tool_use') {
        flushMd();
        toolCount++;
        if (mutationChanges(p).length) surface.push({ kind: 'change', part: p });
        else processParts.push(p);
      } else if (p.type === 'image' || p.type === 'file') {
        flushMd();
        surface.push({ kind: 'attach', part: p });
      }
      // tool_result parts inside assistant messages are consumed via the map
    }
    flushMd();
    if (processParts.length) {
      row.append(buildProcessBlock(
        processParts,
        results,
        !!(streaming && streamNodes.get(m.id)),
        m.id,
        toolCount,
      ));
    }
    for (const item of surface) {
      if (item.kind === 'md') {
        const block = el('div', 'msg-assistant');
        const md = el('div', 'md');
        md.innerHTML = mdRender(item.text);
        block.append(md);
        row.append(block);
      } else if (item.kind === 'change') {
        const result = item.part.tool_call_id ? results.get(item.part.tool_call_id) : undefined;
        row.append(buildChangeSet(item.part, result, !!(streaming && streamNodes.get(m.id))));
      } else {
        row.append(buildAttachment(item.part));
      }
    }
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
    const changeOpen = new Map();
    // Index over ALL details (not just open ones) so keys stay stable when a
    // closed details sits between open ones. The .msg-process block is
    // excluded: its open state is driven by processIntent in buildProcessBlock.
    const all = Array.from(row.querySelectorAll('details'));
    all.forEach((d, i) => {
      if (d.classList.contains('msg-change')) {
        changeOpen.set(d.dataset.changePath || String(i), d.open);
      }
      if (!d.open || d.classList.contains('msg-process')) return;
      const nameEl = d.querySelector('.msg-tool-name');
      open.add(nameEl ? 'tool:' + nameEl.textContent + ':' + i : 'idx:' + i);
    });
    fillMessage(row, m, collectResults(), busy);
    Array.from(row.querySelectorAll('details')).forEach((d, i) => {
      if (d.classList.contains('msg-process')) return;
      if (d.classList.contains('msg-change')) {
        const key = d.dataset.changePath || String(i);
        if (changeOpen.has(key)) d.open = changeOpen.get(key);
        return;
      }
      const nameEl = d.querySelector('.msg-tool-name');
      if (open.has(nameEl ? 'tool:' + nameEl.textContent + ':' + i : 'idx:' + i)) d.open = true;
    });
  }

  function fullRedraw() {
    if (!transcriptEl) return;
    streamNodes.clear();
    liveStreams.clear(); // provisional live rows are replaced by history
    transcriptEl.innerHTML = '';
    if (!messages.length) {
      renderEmptyState();
      publishChanges();
      return;
    }
    const results = collectResults();
    for (const m of messages) {
      if (isFullyClaimedToolMessage(m)) continue; // folded into existing tool rows
      const row = el('div', 'msg-row');
      row.dataset.messageId = m.id;
      fillMessage(row, m, results, false);
      transcriptEl.append(row);
    }
    publishChanges();
  }

  function renderEmptyState() {
    const wrap = el('div', 'transcript-empty');
    wrap.append(el('p', 'transcript-empty-text', T('chat.empty_state', '무엇을 도와드릴까요?')));
    transcriptEl.append(wrap);
  }

  function clearHistoryLoading() {
    if (historyLoadingTimer) {
      clearTimeout(historyLoadingTimer);
      historyLoadingTimer = null;
    }
    historyLoadingSessionId = null;
    transcriptEl?.classList.remove('is-load-pending');
    transcriptEl?.removeAttribute('aria-busy');
  }

  function skeletonLine(widthClass) {
    return el('span', `transcript-skeleton-line ${widthClass}`);
  }

  function renderHistorySkeleton(sessionId) {
    if (!transcriptEl || historyLoadingSessionId !== sessionId) return;
    historyLoadingTimer = null;
    activeSessionId = sessionId;
    messages = [];
    streamNodes.clear();
    liveStreams.clear();
    processIntent.clear();
    optimisticUser = null;
    optimisticSteers = [];
    transcriptEl.classList.remove('is-load-pending');
    transcriptEl.innerHTML = '';

    const wrap = el('div', 'transcript-loading');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute(
      'aria-label',
      T('chat.loading_history', '대화 기록을 불러오는 중…'),
    );

    const user = el('div', 'transcript-skeleton-row is-user');
    const userBubble = el('div', 'transcript-skeleton-bubble');
    userBubble.append(skeletonLine('is-medium'), skeletonLine('is-short'));
    user.append(userBubble);

    const assistant = el('div', 'transcript-skeleton-row is-assistant');
    assistant.append(
      skeletonLine('is-label'),
      skeletonLine('is-long'),
      skeletonLine('is-full'),
      skeletonLine('is-medium'),
    );

    const nextUser = el('div', 'transcript-skeleton-row is-user is-secondary');
    const nextBubble = el('div', 'transcript-skeleton-bubble');
    nextBubble.append(skeletonLine('is-long'), skeletonLine('is-medium'));
    nextUser.append(nextBubble);

    wrap.append(user, assistant, nextUser);
    transcriptEl.append(wrap);
  }

  /**
   * Mark a history request as pending. Warm reads replace the transcript
   * directly; only requests that exceed 120ms swap to the skeleton.
   */
  function beginLoading(sessionId) {
    if (!initialized) init();
    if (!initialized) return;
    clearHistoryLoading();
    historyLoadingSessionId = sessionId ?? null;
    transcriptEl.classList.add('is-load-pending');
    transcriptEl.setAttribute('aria-busy', 'true');
    historyLoadingTimer = setTimeout(
      () => renderHistorySkeleton(historyLoadingSessionId),
      HISTORY_LOADING_DELAY_MS,
    );
  }

  function renderLoadError(sessionId, error) {
    if (!initialized) init();
    if (!initialized || historyLoadingSessionId !== sessionId) return;
    clearHistoryLoading();
    activeSessionId = sessionId;
    messages = [];
    transcriptEl.innerHTML = '';
    const wrap = el('div', 'transcript-load-error');
    wrap.setAttribute('role', 'alert');
    wrap.append(el(
      'p',
      'transcript-load-error-title',
      T('chat.load_failed', '대화 기록을 불러오지 못했습니다.'),
    ));
    if (error?.message) {
      wrap.append(el('p', 'transcript-load-error-detail', error.message));
    }
    transcriptEl.append(wrap);
    publishChanges();
  }

  function clearEmptyState() {
    const empty = transcriptEl && transcriptEl.querySelector('.transcript-empty');
    if (empty) empty.remove();
    const loading = transcriptEl && transcriptEl.querySelector('.transcript-loading');
    if (loading) {
      clearHistoryLoading();
      loading.remove();
    }
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
          optimisticSteers = [];
          messages = sortByTime(list.map(normMessage).filter((m) => !isMachineMessage(m)));
          fullRedraw();
          maybeScroll();
        }
      } catch { /* transient: next event will retry */ }
    }, RELOAD_DEBOUNCE_MS);
  }

  // ---- live (id-less) delta streaming -----------------------------------------
  // Live turns stream assistant.delta/thinking.delta keyed only by turnId and
  // emit no event.message.* frames; they render into a provisional row built
  // around the same .msg-process block as history. turn.started opens the
  // block, thinking/tool events update it in real time, and turn.ended (or
  // the busy flip) settles it: done header + auto-close unless the user
  // toggled the disclosure. The end-of-turn REST resync then replaces the
  // provisional row with authoritative messages.
  function findLiveByRow(row) {
    for (const ls of liveStreams.values()) if (ls.row === row) return ls;
    return null;
  }

  function setLiveOpen(ls, open) {
    ls.block.open = open;
  }

  // Header while running: spinner + activity line; settled: static summary.
  function updateLiveHeader(ls) {
    if (ls.settled) {
      setProcessHeaderDone(ls.titleEl, ls.metaEl, ls.tools.size);
      return;
    }
    ls.metaEl.textContent = '';
    if (ls.activity === 'tool' && ls.toolName) {
      ls.titleEl.textContent = ls.toolName + ' ' + T('chat.process.tool_running', '실행 중…');
    } else if (ls.activity === 'thinking') {
      ls.titleEl.textContent = T('chat.process.thinking', '생각하는 중…');
    } else {
      ls.titleEl.textContent = T('chat.process.working', '작업하는 중…');
    }
  }

  function ensureLiveStream(key) {
    let ls = liveStreams.get(key);
    if (ls) return ls;
    clearEmptyState();
    const row = el('div', 'msg-row msg-live');
    const { box, title, meta, body } = buildProcessShell(true);
    box.open = true; // auto-open while the turn runs
    const changeWrap = el('div', 'msg-live-changes');
    const textWrap = el('div', 'msg-assistant');
    const textMd = el('div', 'md');
    textWrap.append(textMd);
    row.append(box, changeWrap, textWrap);
    transcriptEl.append(row);
    ls = {
      row, block: box, titleEl: title, metaEl: meta, bodyEl: body, changeWrap,
      textMd, thinking: '', thinkMd: null, text: '',
      tools: new Map(),          // toolCallId -> { part, rowEl, done }
      activity: 'working', toolName: '',
      userToggled: false, settled: false,
    };
    liveStreams.set(key, ls);
    updateLiveHeader(ls);
    return ls;
  }

  function onLiveDelta(data, kind) {
    const delta = typeof data.delta === 'string' ? data.delta : '';
    if (!delta) return;
    const key = String(data.turnId ?? data.turn_id ?? 'live');
    const ls = ensureLiveStream(key);
    if (kind === 'thinking') {
      ls.thinking += delta;
      if (!ls.thinkMd) {
        const div = el('div', 'msg-process-thinking');
        ls.thinkMd = el('div', 'md');
        div.append(ls.thinkMd);
        ls.bodyEl.append(div);
      }
      ls.thinkMd.innerHTML = mdRender(ls.thinking);
      if (ls.activity !== 'tool') ls.activity = 'thinking';
    } else {
      ls.text += delta;
      ls.textMd.innerHTML = mdRender(ls.text);
    }
    updateLiveHeader(ls);
    maybeScroll();
  }

  function onTurnStarted(data) {
    const key = String(data.turnId ?? data.turn_id ?? 'live');
    const ls = ensureLiveStream(key);
    if (!ls.settled) {
      ls.activity = 'working';
      updateLiveHeader(ls);
      if (!ls.userToggled) setLiveOpen(ls, true);
    }
    maybeScroll();
  }

  // tool.call.started: {turnId, toolCallId, name, args} (cli) or
  // {turn_id, tool_call_id, tool_name, args} (direct backend).
  function onToolStarted(data) {
    const key = String(data.turnId ?? data.turn_id ?? 'live');
    const ls = ensureLiveStream(key);
    const id = String(data.toolCallId ?? data.tool_call_id ?? '');
    const part = {
      type: 'tool_use',
      tool_call_id: id,
      tool_name: data.name ?? data.tool_name ?? 'tool',
      input: data.args ?? data.input ?? null,
    };
    const changeSet = buildChangeSet(part, null, true);
    const rowEl = changeSet || buildToolRow(part, null, true);
    ls.tools.set(id, { part, rowEl, done: false, isChange: !!changeSet });
    (changeSet ? ls.changeWrap : ls.bodyEl).append(rowEl);
    ls.activity = 'tool';
    ls.toolName = part.tool_name;
    updateLiveHeader(ls);
    publishChanges();
    maybeScroll();
  }

  // tool.result: flips its step row to done/error (preserving disclosure),
  // then the header falls back to the next running tool or generic working.
  function onToolResult(data) {
    const key = String(data.turnId ?? data.turn_id ?? 'live');
    const ls = liveStreams.get(key);
    if (!ls) return;
    const id = String(data.toolCallId ?? data.tool_call_id ?? '');
    const t = ls.tools.get(id);
    if (!t) return; // result for a tool we never saw start: ignore
    const result = {
      type: 'tool_result',
      tool_call_id: id,
      output: data.output,
      is_error: !!(data.is_error ?? data.isError),
    };
    const changeOpen = new Map();
    if (t.isChange) {
      t.rowEl.querySelectorAll('details.msg-change').forEach((card) => {
        changeOpen.set(card.dataset.changePath || '', card.open);
      });
    }
    const rowEl = t.isChange
      ? (buildChangeSet(t.part, result, false) || buildToolRow(t.part, result, false))
      : buildToolRow(t.part, result, false);
    if (t.isChange) {
      rowEl.querySelectorAll('details.msg-change').forEach((card) => {
        if (changeOpen.has(card.dataset.changePath || '')) {
          card.open = changeOpen.get(card.dataset.changePath || '');
        }
      });
    } else if (t.rowEl.open) {
      rowEl.open = true;
    }
    t.rowEl.replaceWith(rowEl);
    t.rowEl = rowEl;
    t.done = true;
    t.result = result;
    let next = null;
    for (const e of ls.tools.values()) { if (!e.done) next = e; }
    if (next) {
      ls.activity = 'tool';
      ls.toolName = next.part.tool_name;
    } else {
      ls.activity = 'working';
    }
    updateLiveHeader(ls);
    publishChanges();
    maybeScroll();
  }

  // Turn finished (or the busy flag dropped): settle every live block —
  // done summary header, spinner off, auto-close unless the user toggled.
  function settleLiveStreams() {
    for (const ls of liveStreams.values()) {
      if (ls.settled) continue;
      ls.settled = true;
      ls.block.classList.remove('running');
      updateLiveHeader(ls);
      if (!ls.userToggled) setLiveOpen(ls, false);
    }
  }

  // ---- event handlers --------------------------------------------------------
  function onMessageCreated(raw) {
    const m = normMessage(raw && raw.message ? raw.message : raw);
    if (!m.id) return;
    if (isMachineMessage(m)) return; // machine-only context append: never shown
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
    if (m.role === 'user') {
      const steerIndex = optimisticSteers.findIndex((item) => item.text === textOfMessage(m));
      if (steerIndex >= 0) {
        messages.push(m);
        const pending = optimisticSteers[steerIndex];
        pending.message = m;
        pending.messageId = m.id;
        pending.el.dataset.messageId = m.id;
        if (pending.status === 'sent') finalizeOptimisticSteer(pending, m);
        maybeScroll();
        return;
      }
    }
    messages.push(m);
    if (m.role === 'assistant') streamNodes.set(m.id, true);
    appendMessageNode(m);
    // A tool-result message flips its claimant tool rows to done/error.
    if (m.role === 'tool') for (const c of claimantMessages(m)) rerenderMessageNode(c);
    publishChanges();
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
    publishChanges();
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
      case 'turn.started': onTurnStarted(data); break;
      case 'tool.call.started': onToolStarted(data); break;
      case 'tool.result': onToolResult(data); break;
      case 'prompt.steer_sending':
        setOptimisticSteersSending(promptIdsOf(data));
        break;
      case 'prompt.steered':
        setOptimisticSteersSent(promptIdsOf(data));
        break;
      case 'prompt.steer_failed':
        setOptimisticSteersFailed(promptIdsOf(data));
        break;
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
        settleLiveStreams();
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
      // Stream ended: settle any leftover running tool rows and live blocks.
      streamNodes.clear();
      settleLiveStreams();
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
    composerEl.disabled = readOnly;
    if (readOnly) {
      const notice = T('chat.foreign_readonly', '내장 엔진 세션은 열어보기만 가능합니다 · 엔진 전환 시 이어쓸 수 있습니다');
      composerEl.setAttribute('placeholder', notice);
    } else if (busy) {
      composerEl.setAttribute('placeholder', T('chat.steer_placeholder', '현재 작업에 조정할 내용을 입력하세요…'));
    } else {
      composerEl.setAttribute('placeholder', T('chat.composer_placeholder', '메시지를 입력하세요…'));
    }
    updateSendBtn();
  }

  function updateSendBtn() {
    if (!sendBtn) return;
    const steering = busy && !readOnly;
    sendBtn.classList.remove('stop-mode');
    sendBtn.classList.toggle('steer-mode', steering);
    sendBtn.disabled = readOnly || !composerEl.value.trim();
    if (abortBtn) {
      abortBtn.hidden = !steering;
      abortBtn.disabled = !steering;
      abortBtn.setAttribute('aria-label', T('chat.abort_title', '중단'));
      abortBtn.title = T('chat.abort_title', '중단');
    }
    if (steering) {
      sendBtn.setAttribute('aria-label', T('chat.steer_aria', '현재 작업 조정'));
      sendBtn.title = T('chat.steer_title', '현재 작업 조정 (↵)');
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

  function appendOptimisticSteer(text) {
    clearEmptyState();
    const row = el('div', 'msg-row msg-user msg-steer msg-optimistic');
    const header = el('div', 'msg-steer-header');
    const label = el(
      'span',
      'msg-steer-label',
      T('chat.steer_pending', '대기 중인 작업 조정')
    );
    const actions = el('div', 'msg-steer-actions');
    const editButton = el('button', 'msg-steer-action', T('chat.steer_edit', '편집'));
    editButton.type = 'button';
    editButton.disabled = true;
    editButton.setAttribute('aria-label', T('chat.steer_edit_aria', '대기 중인 작업 조정 편집'));
    const deleteButton = el(
      'button',
      'msg-steer-action danger',
      T('chat.steer_delete', '삭제')
    );
    deleteButton.type = 'button';
    deleteButton.disabled = true;
    deleteButton.setAttribute('aria-label', T('chat.steer_delete_aria', '대기 중인 작업 조정 삭제'));
    actions.append(editButton, deleteButton);
    header.append(label, actions);

    const textNode = el('div', 'msg-user-text', text);
    const editor = el('div', 'msg-steer-editor');
    editor.hidden = true;
    const textarea = document.createElement('textarea');
    textarea.className = 'msg-steer-editor-input';
    textarea.rows = 2;
    textarea.setAttribute(
      'aria-label',
      T('chat.steer_edit_aria', '대기 중인 작업 조정 편집')
    );
    textarea.setAttribute(
      'placeholder',
      T('chat.steer_edit_placeholder', '조정할 내용을 입력하세요…')
    );
    const editorActions = el('div', 'msg-steer-editor-actions');
    const cancelButton = el('button', 'msg-steer-editor-button', T('common.cancel', '취소'));
    cancelButton.type = 'button';
    const saveButton = el(
      'button',
      'msg-steer-editor-button primary',
      T('chat.steer_save', '저장')
    );
    saveButton.type = 'button';
    editorActions.append(cancelButton, saveButton);
    editor.append(textarea, editorActions);
    row.append(header, textNode, editor);
    transcriptEl.append(row);
    const pending = {
      text,
      el: row,
      label,
      actions,
      editButton,
      deleteButton,
      textNode,
      editor,
      textarea,
      cancelButton,
      saveButton,
      promptId: null,
      sessionId: activeSessionId,
      messageId: null,
      message: null,
      status: 'submitting',
    };
    optimisticSteers.push(pending);
    editButton.addEventListener('click', () => { void openOptimisticSteerEditor(pending); });
    deleteButton.addEventListener('click', () => { void deleteOptimisticSteer(pending); });
    cancelButton.addEventListener('click', () => { void cancelOptimisticSteerEditor(pending); });
    saveButton.addEventListener('click', () => { void saveOptimisticSteer(pending); });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void cancelOptimisticSteerEditor(pending);
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault();
        void saveOptimisticSteer(pending);
      }
    });
    scrollToBottom();
    return pending;
  }

  function promptIdsOf(data) {
    const ids = [];
    const one = data?.prompt_id ?? data?.promptId;
    if (one) ids.push(String(one));
    const many = data?.prompt_ids ?? data?.promptIds;
    if (Array.isArray(many)) {
      for (const id of many) if (id != null) ids.push(String(id));
    }
    return [...new Set(ids)];
  }

  function pendingSteerByPromptId(promptId) {
    return optimisticSteers.find((item) => item.promptId === promptId) ?? null;
  }

  function setOptimisticSteerState(pending, status, labelText) {
    if (!pending || !optimisticSteers.includes(pending)) return;
    pending.status = status;
    pending.label.textContent = labelText;
    pending.label.classList.toggle('error', status === 'error');
    const editable = status === 'queued' || status === 'error';
    pending.actions.hidden = !editable;
    pending.editButton.disabled = !editable;
    pending.deleteButton.disabled = !editable;
  }

  function finishOptimisticSteerSubmission(pending, result) {
    if (!pending || !optimisticSteers.includes(pending)) return;
    if (!result || typeof result !== 'object') {
      rejectOptimisticSteer(pending);
      return;
    }
    pending.promptId = result.prompt_id ?? result.promptId ?? null;
    if (result.status === 'queued' && pending.promptId) {
      setOptimisticSteerState(
        pending,
        'queued',
        T('chat.steer_pending', '대기 중인 작업 조정')
      );
    } else {
      markOptimisticSteerSent(pending);
    }
  }

  function finalizeOptimisticSteer(pending, message) {
    const index = optimisticSteers.indexOf(pending);
    if (index >= 0) optimisticSteers.splice(index, 1);
    pending.el.classList.remove('msg-optimistic', 'msg-steer');
    pending.el.dataset.messageId = message.id;
    fillMessage(pending.el, message, collectResults(), busy);
  }

  function markOptimisticSteerSent(pending) {
    if (!pending || !optimisticSteers.includes(pending)) return;
    setOptimisticSteerState(
      pending,
      'sent',
      T('chat.steer_sent', '작업 조정 전달됨')
    );
    pending.editor.hidden = true;
    pending.textNode.hidden = false;
    if (pending.message) finalizeOptimisticSteer(pending, pending.message);
  }

  function setOptimisticSteersSending(promptIds) {
    for (const promptId of promptIds) {
      const pending = pendingSteerByPromptId(promptId);
      if (!pending) continue;
      setOptimisticSteerState(
        pending,
        'sending',
        T('chat.steer_sending', '작업 조정 전달 중…')
      );
      pending.saveButton.disabled = true;
      pending.cancelButton.disabled = true;
    }
  }

  function setOptimisticSteersSent(promptIds) {
    for (const promptId of promptIds) markOptimisticSteerSent(pendingSteerByPromptId(promptId));
  }

  function setOptimisticSteersFailed(promptIds) {
    for (const promptId of promptIds) {
      const pending = pendingSteerByPromptId(promptId);
      if (!pending) continue;
      pending.saveButton.disabled = false;
      pending.cancelButton.disabled = false;
      pending.editor.hidden = true;
      pending.textNode.hidden = false;
      setOptimisticSteerState(
        pending,
        'error',
        T('chat.steer_still_queued', '전달하지 못했습니다. 아직 대기 중입니다.')
      );
    }
  }

  async function openOptimisticSteerEditor(pending) {
    if (!pending?.promptId || !['queued', 'error'].includes(pending.status)) return;
    const app = window.App;
    if (typeof app?.holdSteer !== 'function') return;
    setOptimisticSteerState(
      pending,
      'holding',
      T('chat.steer_edit_opening', '편집 준비 중…')
    );
    const held = await app.holdSteer(pending.promptId);
    if (!held || !optimisticSteers.includes(pending) || pending.status === 'sent') {
      if (optimisticSteers.includes(pending)) {
        setOptimisticSteerState(
          pending,
          'error',
          T('chat.steer_edit_failed', '대기 메시지를 편집할 수 없습니다.')
        );
      }
      return;
    }
    pending.status = 'editing';
    pending.label.classList.remove('error');
    pending.label.textContent = T('chat.steer_editing', '작업 조정 편집 중');
    pending.actions.hidden = true;
    pending.textNode.hidden = true;
    pending.editor.hidden = false;
    pending.textarea.value = pending.text;
    pending.saveButton.disabled = false;
    pending.cancelButton.disabled = false;
    requestAnimationFrame(() => {
      pending.textarea.focus();
      pending.textarea.setSelectionRange(pending.textarea.value.length, pending.textarea.value.length);
    });
  }

  function detachPendingSteerMessage(pending) {
    if (pending.messageId) {
      messages = messages.filter((message) => message.id !== pending.messageId);
    }
    pending.messageId = null;
    pending.message = null;
    pending.el.removeAttribute('data-message-id');
  }

  async function saveOptimisticSteer(pending) {
    if (pending?.status !== 'editing') return;
    const value = pending.textarea.value.trim();
    if (!value) {
      pending.label.textContent = T('chat.steer_empty', '내용을 입력해 주세요.');
      pending.label.classList.add('error');
      pending.textarea.focus();
      return;
    }
    const app = window.App;
    if (typeof app?.updateSteer !== 'function') return;
    pending.status = 'updating';
    pending.label.classList.remove('error');
    pending.label.textContent = T('chat.steer_updating', '작업 조정 저장 중…');
    pending.saveButton.disabled = true;
    pending.cancelButton.disabled = true;
    const result = await app.updateSteer(pending.promptId, value);
    if (!result || !optimisticSteers.includes(pending)) {
      if (optimisticSteers.includes(pending)) {
        pending.status = 'editing';
        pending.label.classList.add('error');
        pending.label.textContent = T('chat.steer_edit_failed', '대기 메시지를 편집할 수 없습니다.');
        pending.saveButton.disabled = false;
        pending.cancelButton.disabled = false;
      }
      return;
    }
    detachPendingSteerMessage(pending);
    pending.text = value;
    pending.textNode.textContent = value;
    pending.promptId = result.prompt_id ?? result.promptId ?? pending.promptId;
    pending.editor.hidden = true;
    pending.textNode.hidden = false;
    if (result.status === 'queued') {
      setOptimisticSteerState(
        pending,
        'queued',
        T('chat.steer_pending', '대기 중인 작업 조정')
      );
    } else {
      markOptimisticSteerSent(pending);
    }
  }

  async function cancelOptimisticSteerEditor(pending) {
    if (pending?.status !== 'editing') return;
    const app = window.App;
    if (typeof app?.resumeSteer !== 'function') return;
    pending.status = 'resuming';
    pending.label.textContent = T('chat.steer_resuming', '대기열로 돌아가는 중…');
    pending.saveButton.disabled = true;
    pending.cancelButton.disabled = true;
    const resumed = await app.resumeSteer(pending.promptId);
    if (!resumed || !optimisticSteers.includes(pending)) {
      if (optimisticSteers.includes(pending)) {
        pending.status = 'editing';
        pending.label.classList.add('error');
        pending.label.textContent = T('chat.steer_resume_failed', '편집을 닫을 수 없습니다.');
        pending.saveButton.disabled = false;
        pending.cancelButton.disabled = false;
      }
      return;
    }
    pending.editor.hidden = true;
    pending.textNode.hidden = false;
    setOptimisticSteerState(
      pending,
      'queued',
      T('chat.steer_pending', '대기 중인 작업 조정')
    );
  }

  function removeOptimisticSteer(pending) {
    const index = optimisticSteers.indexOf(pending);
    if (index >= 0) optimisticSteers.splice(index, 1);
    if (pending?.messageId) messages = messages.filter((message) => message.id !== pending.messageId);
    pending?.el?.remove();
  }

  function releaseHeldOptimisticSteers() {
    if (typeof window.kimi?.resumeSteer !== 'function') return;
    for (const pending of optimisticSteers) {
      if (
        pending.status !== 'editing' ||
        !pending.promptId ||
        !pending.sessionId
      ) {
        continue;
      }
      window.kimi
        .resumeSteer(pending.sessionId, pending.promptId)
        .catch(() => { /* engine shutdown or prompt already consumed */ });
    }
  }

  async function deleteOptimisticSteer(pending) {
    if (!pending?.promptId || !['queued', 'error'].includes(pending.status)) return;
    const app = window.App;
    if (typeof app?.deleteSteer !== 'function') return;
    setOptimisticSteerState(
      pending,
      'deleting',
      T('chat.steer_deleting', '작업 조정 삭제 중…')
    );
    const result = await app.deleteSteer(pending.promptId);
    if (result && optimisticSteers.includes(pending)) {
      removeOptimisticSteer(pending);
      return;
    }
    if (optimisticSteers.includes(pending)) {
      setOptimisticSteerState(
        pending,
        'error',
        T('chat.steer_delete_failed', '대기 메시지를 삭제하지 못했습니다.')
      );
    }
  }

  function rejectOptimisticSteer(pending) {
    removeOptimisticSteer(pending);
    appendSystemNote(T('chat.steer_failed', '작업 조정 요청을 전송하지 못했습니다. 다시 시도해 주세요.'));
  }

  function appendSystemNote(text) {
    clearEmptyState();
    const row = el('div', 'msg-row msg-system');
    row.append(el('div', 'msg-system-text', text));
    transcriptEl.append(row);
    maybeScroll();
  }

  function doSend() {
    if (readOnly) return;
    const text = composerEl.value.trim();
    if (!text) return;
    const app = window.App;
    if (!app) return;
    if (busy) {
      if (typeof app.steer !== 'function') return;
      composerEl.value = '';
      autoGrow();
      updateSendBtn();
      const pending = appendOptimisticSteer(text);
      Promise.resolve()
        .then(() => app.steer(text))
        .then((result) => finishOptimisticSteerSubmission(pending, result))
        .catch(() => rejectOptimisticSteer(pending));
      return;
    }
    if (typeof app.sendPrompt !== 'function') return;
    composerEl.value = '';
    autoGrow();
    updateSendBtn();
    appendOptimisticUser(text);
    setBusy(true); // enables steer mode until the server reports idle again
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
      if (slashAutocomplete?.handleKeydown?.(e)) return;
      // Enter sends; Shift+Enter inserts a newline. isComposing guards IME (한글) input.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        doSend();
      }
    });
    composerEl.addEventListener('input', () => {
      autoGrow();
      updateSendBtn();
      slashAutocomplete?.handleInput?.();
    });
    sendBtn.addEventListener('click', doSend);
    abortBtn?.addEventListener('click', () => {
      if (busy && !readOnly && typeof window.App?.abort === 'function') window.App.abort();
    });
  }

  // ---- public API ---------------------------------------------------------------
  function init() {
    if (initialized) return;
    transcriptEl = document.getElementById('transcript');
    composerEl = document.getElementById('composer');
    sendBtn = document.getElementById('send-btn');
    abortBtn = document.getElementById('composer-abort-btn');
    if (!transcriptEl || !composerEl || !sendBtn) return; // DOM not ready
    initialized = true;
    slashAutocomplete = window.SlashAutocomplete?.create?.({
      composer: composerEl,
      onValueChange: () => {
        autoGrow();
        updateSendBtn();
      },
      getContext: () => {
        const app = window.App;
        const sessionId = app?.state?.activeId ?? null;
        const session = app?.state?.sessions?.find?.((item) => item.id === sessionId);
        let recentCwd = null;
        try { recentCwd = localStorage.getItem('kimi.lastCwd'); } catch { /* ignore */ }
        return {
          sessionId,
          cwd: session?.cwd || recentCwd,
          engine: app?.state?.engine ?? null,
        };
      },
    }) ?? null;
    wireComposer();
    transcriptEl.addEventListener('scroll', () => { pinned = isPinned(); });
    // User disclosure intent for process blocks: a click on the header records
    // intent before the default toggle (box.open is still pre-toggle here), so
    // auto-close at turn end and re-renders can respect it.
    transcriptEl.addEventListener('click', (e) => {
      const sum = e.target && e.target.closest ? e.target.closest('summary.msg-process-header') : null;
      if (!sum) return;
      const box = sum.parentElement;
      const row = box.closest('.msg-row');
      if (!row) return;
      if (row.dataset.messageId) {
        processIntent.set(row.dataset.messageId, box.open ? 'closed' : 'open');
      } else {
        const ls = findLiveByRow(row);
        if (ls) ls.userToggled = true;
      }
    });
    pinned = true;
    renderEmptyState();
    refreshComposerUi();
  }

  function renderMessages(list, sessionId) {
    if (!initialized) init();
    if (!initialized) return;
    clearHistoryLoading();
    releaseHeldOptimisticSteers();
    if (sessionId !== undefined) activeSessionId = sessionId;
    slashAutocomplete?.refresh?.();
    if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    optimisticUser = null;
    optimisticSteers = [];
    liveStreams.clear();
    processIntent.clear();
    messages = sortByTime((Array.isArray(list) ? list : []).map(normMessage).filter((m) => !isMachineMessage(m)));
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
    clearHistoryLoading();
    const next = id ?? null;
    const changed = next !== activeSessionId;
    activeSessionId = next;
    slashAutocomplete?.refresh?.();
    if (changed) emitChangeSnapshot(emptyChangeSnapshot(next));
  }

  function reset() {
    releaseHeldOptimisticSteers();
    messages = [];
    streamNodes.clear();
    liveStreams.clear();
    processIntent.clear();
    optimisticUser = null;
    optimisticSteers = [];
    readOnly = false;
    if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
    clearHistoryLoading();
    if (initialized) {
      transcriptEl.innerHTML = '';
      composerEl.value = '';
      slashAutocomplete?.close?.();
      autoGrow();
      setBusy(false);
      refreshComposerUi();
      renderEmptyState();
      pinned = true;
    }
    emitChangeSnapshot(emptyChangeSnapshot(activeSessionId));
  }

  window.Chat = {
    init,
    beginLoading,
    renderLoadError,
    renderMessages,
    applyEvent,
    setBusy,
    setReadOnly,
    setActiveSession,
    reset,
    scrollToBottom,
    scrollToMessage,
    getChangeSummary: () => currentChangeSnapshot,
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
    transcriptEl.querySelectorAll('.msg-process').forEach((box) => {
      updateProcessAction(box, box.querySelector('.msg-process-action'));
    });
    for (const pending of optimisticSteers) {
      pending.editButton.textContent = T('chat.steer_edit', '편집');
      pending.editButton.setAttribute('aria-label', T('chat.steer_edit_aria', '대기 중인 작업 조정 편집'));
      pending.deleteButton.textContent = T('chat.steer_delete', '삭제');
      pending.deleteButton.setAttribute('aria-label', T('chat.steer_delete_aria', '대기 중인 작업 조정 삭제'));
      pending.cancelButton.textContent = T('common.cancel', '취소');
      pending.saveButton.textContent = T('chat.steer_save', '저장');
      pending.textarea.setAttribute('placeholder', T('chat.steer_edit_placeholder', '조정할 내용을 입력하세요…'));
      if (pending.status === 'queued') {
        pending.label.textContent = T('chat.steer_pending', '대기 중인 작업 조정');
      } else if (pending.status === 'editing') {
        pending.label.textContent = T('chat.steer_editing', '작업 조정 편집 중');
      } else if (pending.status === 'sending') {
        pending.label.textContent = T('chat.steer_sending', '작업 조정 전달 중…');
      } else if (pending.status === 'sent') {
        pending.label.textContent = T('chat.steer_sent', '작업 조정 전달됨');
      }
    }
  });
})();
