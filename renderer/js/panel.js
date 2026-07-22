/* panel.js — right-side agent-work panel (v2).
 * Exposes window.Panel = { toggle(force?), setActiveSession(id), handleEvent(sessionId, event) }.
 * Classic script-tag module: reads window.kimi (preload bridge), window.App (shell
 * store, optional), window.I18N (optional); no imports.
 *
 * The shell (R6) owns the static markup (#panel > #panel-header + #panel-content
 * with #panel-status/#panel-tasks/#panel-activity/#panel-files) and wires the
 * header toggle button; Panel owns everything rendered INSIDE those containers.
 *
 * Wire facts (docs/protocol.md + docs/ref/webui-bundle.js, kimi 0.28.1):
 * - Events arrive as raw WS frames {type, session_id, payload:{...}}; the type may
 *   carry an `event.` prefix (stripped here, mirroring chat.js). Payload fields
 *   are snake_case for protocol events (session.work_changed) but camelCase for
 *   agent events (tool.call.started, task.started) — both forms are accepted.
 * - tool.call.started: {turnId, toolCallId, name, args, description, display}
 * - tool.result:       {turnId, toolCallId, output, is_error?}
 * - session.work_changed: {busy, main_turn_active, pending_interaction, last_turn_reason}
 * - task.* events:     {taskId, info:{taskId, status, exitCode, ...}} — used only as
 *   a signal to refetch the REST task list (GET /sessions/{id}/tasks, shape
 *   {items:[{id, kind, description, status, command, created_at, started_at, ...}]}).
 */
(function () {
  'use strict';

  const T = (k, f) => (window.I18N?.t ? window.I18N.t(k, f) : f);

  const LS_OPEN = 'kimi.panelOpen';
  const POLL_MS = 5000;          // task-list poll cadence while open && busy
  const TASK_REFETCH_MS = 400;   // debounce for task.* event-driven refetches
  const ACTIVITY_MAX = 30;       // per-session ring buffer of tool activities
  const FILES_MAX = 50;          // per-session changed-file chips
  const SUMMARY_MAX = 80;        // one-line tool input summary

  // Tools that mutate files; value = arg keys holding the path (snake + camel).
  const FILE_TOOL_ARGS = {
    write: ['file_path', 'filePath', 'path'],
    edit: ['file_path', 'filePath', 'path'],
    notebookedit: ['file_path', 'filePath', 'path'],
    multiedit: ['file_path', 'filePath', 'path'],
  };

  // ---- module state --------------------------------------------------------
  const els = { root: null, title: null, closeBtn: null, content: null, status: null, tasks: null, activity: null, files: null, empty: null };
  let bound = false;
  let open = false;
  let activeId = null;
  const sessions = new Map();    // sid -> { busy, activeTool, activities, files, tasks, tasksErr }
  let pollTimer = null;
  let taskRefetchTimer = null;

  function freshState() {
    return { busy: false, activeTool: null, activities: [], files: [], tasks: null, tasksErr: false };
  }
  function stateFor(sid) {
    let st = sessions.get(sid);
    if (!st) { st = freshState(); sessions.set(sid, st); }
    return st;
  }

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
  function relTime(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 45) return T('panel.time_now', '방금');
    const m = Math.floor(s / 60);
    if (m < 60) return m + T('panel.time_min', '분 전');
    const h = Math.floor(m / 60);
    if (h < 24) return h + T('panel.time_hour', '시간 전');
    const d = Math.floor(h / 24);
    if (d < 7) return d + T('panel.time_day', '일 전');
    const dt = new Date(t);
    return (dt.getMonth() + 1) + '/' + dt.getDate();
  }

  // One-line tool-input summary — mirrors chat.js toolSummary (same arg keys).
  function summarize(name, input) {
    if (input == null) return '';
    if (typeof input === 'string') return trunc(oneLine(input), SUMMARY_MAX);
    if (typeof input !== 'object') return trunc(oneLine(String(input)), SUMMARY_MAX);
    const pick = (k) => (typeof input[k] === 'string' && input[k] ? input[k] : null);
    let s = null;
    switch (String(name || '').toLowerCase()) {
      case 'read': case 'edit': case 'write': case 'notebookedit': case 'multiedit':
        s = pick('file_path') || pick('filePath') || pick('path'); break;
      case 'readmediafile': s = pick('path'); break;
      case 'glob': s = pick('pattern'); break;
      case 'grep':
        s = pick('pattern');
        if (s && input.path) s += '  ·  ' + String(input.path);
        break;
      case 'bash': s = pick('command'); break;
      case 'webfetch': case 'fetchurl': s = pick('url'); break;
      case 'websearch': s = pick('query'); break;
      case 'task': case 'agent': s = pick('description') || pick('prompt'); break;
      case 'skill': s = pick('skill'); break;
      case 'todolist': s = ''; break;
      default: s = null;
    }
    if (s == null) {
      try { s = JSON.stringify(input); } catch { s = String(input); }
    }
    return trunc(oneLine(s || ''), SUMMARY_MAX);
  }

  // ---- changed-file extraction ----------------------------------------------
  function patchPaths(text) {
    const out = [];
    const re = /\*\*\*\s*(?:Add|Update|Delete) File:\s*(.+?)\s*$/gm;
    let m;
    while ((m = re.exec(text)) && out.length < 10) out.push(m[1]);
    return out;
  }
  function noteFile(st, path) {
    if (typeof path !== 'string' || !path.trim()) return;
    path = path.trim();
    const i = st.files.indexOf(path);
    if (i !== -1) st.files.splice(i, 1);
    st.files.unshift(path); // most recently touched first
    if (st.files.length > FILES_MAX) st.files.length = FILES_MAX;
  }
  function extractFiles(st, name, args) {
    const key = String(name || '').toLowerCase();
    if (key === 'apply_patch') {
      const text = typeof args === 'string' ? args
        : (args && typeof args === 'object' ? (args.patch ?? args.input ?? args.diff ?? '') : '');
      for (const p of patchPaths(String(text))) noteFile(st, p);
      return;
    }
    const argKeys = FILE_TOOL_ARGS[key];
    if (!argKeys || args == null || typeof args !== 'object') return;
    for (const k of argKeys) {
      if (typeof args[k] === 'string' && args[k]) { noteFile(st, args[k]); return; }
    }
  }

  // ---- activity ring buffer ---------------------------------------------------
  function findActivity(st, callId) {
    if (!callId) return null;
    return st.activities.find((a) => a.id === callId) || null;
  }
  function upsertActivity(st, entry) {
    let a = findActivity(st, entry.id);
    if (a) {
      if (entry.name && a.name === 'tool') a.name = entry.name;
      if (entry.summary) a.summary = entry.summary;
      if (entry.status) a.status = entry.status;
      return a;
    }
    a = { id: entry.id || '', name: entry.name || 'tool', summary: entry.summary || '', status: entry.status || 'running', at: Date.now() };
    st.activities.unshift(a); // newest first
    if (st.activities.length > ACTIVITY_MAX) st.activities.length = ACTIVITY_MAX;
    return a;
  }
  function refreshActiveTool(st) {
    const running = st.activities.find((a) => a.status === 'running');
    st.activeTool = running ? running.name : null;
  }
  function settleRunningActivities(st, status) {
    for (const a of st.activities) {
      if (a.status === 'running') a.status = status;
    }
  }

  // ---- busy + polling ---------------------------------------------------------
  function setBusy(sid, st, busy) {
    const was = st.busy;
    st.busy = !!busy;
    if (was === st.busy) return;
    if (!st.busy && sid === activeId) refreshTasks(sid); // final settle fetch
    ensurePolling();
  }
  function canListTasks() {
    return typeof window.kimi?.listTasks === 'function';
  }
  function ensurePolling() {
    const st = activeId ? sessions.get(activeId) : null;
    const should = open && !!activeId && !!st?.busy && canListTasks();
    if (should && pollTimer == null) {
      pollTimer = setInterval(() => { if (activeId) refreshTasks(activeId); }, POLL_MS);
    } else if (!should && pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  async function refreshTasks(sid) {
    if (!sid || !canListTasks()) return;
    const st = stateFor(sid);
    try {
      const res = await window.kimi.listTasks(sid);
      const items = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
      if (sid !== activeId) { st.tasks = items; return; }
      st.tasks = items;
      st.tasksErr = false;
    } catch (err) {
      st.tasksErr = true;
      if (st.tasks == null) st.tasks = [];
    }
    if (sid === activeId) renderTasks(st);
  }
  function scheduleTaskRefetch(sid) {
    if (sid !== activeId || !canListTasks()) return;
    if (taskRefetchTimer != null) clearTimeout(taskRefetchTimer);
    taskRefetchTimer = setTimeout(() => {
      taskRefetchTimer = null;
      refreshTasks(sid);
    }, TASK_REFETCH_MS);
  }

  // ---- rendering ---------------------------------------------------------------
  function sectionLabel(text) {
    return el('div', 'panel-section-label', text);
  }

  function renderStatus(st) {
    if (!els.status) return;
    els.status.textContent = '';
    const strip = el('div', 'panel-status-strip');
    const dot = el('span', 'panel-status-dot' + (st.busy ? ' running' : ''));
    strip.appendChild(dot);
    const label = el('span', 'panel-status-label', T('panel.status_label', '현재 상태'));
    strip.appendChild(label);
    const value = el('span', 'panel-status-value' + (st.busy ? ' running' : ''),
      st.busy ? T('panel.status_running', '실행 중') : T('panel.status_idle', '대기'));
    strip.appendChild(value);
    if (st.busy && st.activeTool) {
      strip.appendChild(el('span', 'panel-status-tool', st.activeTool));
    }
    els.status.appendChild(strip);
  }

  const TASK_GLYPH = { running: '◐', completed: '●', done: '●', failed: '●', error: '●', cancelled: '●' };
  function taskGlyphClass(status) {
    switch (status) {
      case 'running': return 'st-running';
      case 'completed': case 'done': return 'st-done';
      case 'failed': case 'error': return 'st-error';
      case 'cancelled': return 'st-cancelled';
      default: return 'st-pending';
    }
  }
  function renderTasks(st) {
    if (!els.tasks) return;
    els.tasks.textContent = '';
    const items = st.tasks || [];
    if (!items.length) { els.tasks.hidden = true; return; }
    els.tasks.hidden = false;
    els.tasks.appendChild(sectionLabel(T('panel.section_tasks', '작업')));
    const list = el('div', 'panel-task-list');
    for (const t of items.slice(0, 20)) {
      const status = String(t?.status || '').toLowerCase();
      const row = el('div', 'panel-task');
      row.appendChild(el('span', 'panel-task-glyph ' + taskGlyphClass(status), TASK_GLYPH[status] || '○'));
      const title = t?.description || t?.command || t?.kind || '';
      const titleEl = el('span', 'panel-task-title', title);
      row.appendChild(titleEl);
      const when = relTime(t?.started_at ?? t?.created_at ?? t?.completed_at);
      if (when) row.appendChild(el('span', 'panel-task-time', when));
      list.appendChild(row);
    }
    els.tasks.appendChild(list);
  }

  function renderActivity(st) {
    if (!els.activity) return;
    els.activity.textContent = '';
    if (!st.activities.length) { els.activity.hidden = true; return; }
    els.activity.hidden = false;
    els.activity.appendChild(sectionLabel(T('panel.section_activity', '최근 도구 활동')));
    const list = el('div', 'panel-act-list');
    for (const a of st.activities) {
      const row = el('div', 'panel-act');
      row.appendChild(el('span', 'panel-act-dot ' + a.status));
      const name = el('span', 'panel-act-name', a.name);
      row.appendChild(name);
      if (a.summary) row.appendChild(el('span', 'panel-act-summary', a.summary));
      list.appendChild(row);
    }
    els.activity.appendChild(list);
  }

  function renderFiles(st) {
    if (!els.files) return;
    els.files.textContent = '';
    if (!st.files.length) { els.files.hidden = true; return; }
    els.files.hidden = false;
    els.files.appendChild(sectionLabel(T('panel.section_files', '변경된 파일')));
    const list = el('div', 'panel-file-list');
    for (const p of st.files) {
      const chip = el('div', 'panel-file-chip', p);
      list.appendChild(chip);
    }
    els.files.appendChild(list);
  }

  function render() {
    if (!bound) return;
    const st = activeId ? sessions.get(activeId) : null;
    const hasSession = !!(activeId && st);
    if (els.empty) els.empty.hidden = hasSession;
    for (const key of ['status', 'tasks', 'activity', 'files']) {
      if (els[key]) els[key].hidden = !hasSession;
    }
    if (!hasSession) return;
    renderStatus(st);
    renderTasks(st);
    renderActivity(st);
    renderFiles(st);
  }

  // ---- open/close ----------------------------------------------------------------
  function setOpen(next) {
    open = !!next;
    try { localStorage.setItem(LS_OPEN, open ? '1' : '0'); } catch { /* private mode */ }
    if (els.root) els.root.hidden = !open;
    if (open) render();
    ensurePolling();
  }
  function toggle(force) {
    setOpen(typeof force === 'boolean' ? force : !open);
  }

  // ---- public: session selection ---------------------------------------------------
  function setActiveSession(id) {
    activeId = id || null;
    if (!activeId) { render(); ensurePolling(); return; }
    const st = stateFor(activeId);
    st.tasks = null; // loading; view resets to this session's own state
    st.tasksErr = false;
    // Seed busy from the shell store when known (panel may open mid-run, before
    // any work_changed event for this session has been seen).
    const known = window.App?.state?.sessions?.find?.((s) => s && s.id === activeId);
    if (known && typeof known.busy === 'boolean') st.busy = known.busy;
    render();
    refreshTasks(activeId);
    ensurePolling();
  }

  // ---- public: event entry point -----------------------------------------------------
  function handleEvent(sessionId, event) {
    if (!event || typeof event !== 'object') return;
    let type = typeof event.type === 'string' ? event.type : '';
    if (type.startsWith('event.')) type = type.slice(6);
    const data = (event.payload && typeof event.payload === 'object') ? event.payload : event;
    const sid = sessionId ?? event.session_id ?? event.sessionId ?? data.session_id ?? data.sessionId ?? null;
    if (!sid) return;
    const st = stateFor(sid);
    let changed = false;

    switch (type) {
      case 'session.work_changed':
        setBusy(sid, st, !!data.busy);
        changed = true;
        break;
      case 'session.status_changed':
        if (typeof data.status === 'string') {
          setBusy(sid, st, data.status !== 'idle' && data.status !== 'aborted');
          changed = true;
        }
        break;
      case 'turn.started':
        setBusy(sid, st, true);
        changed = true;
        break;
      case 'turn.ended': {
        settleRunningActivities(st, data.reason === 'failed' ? 'error' : 'done');
        refreshActiveTool(st);
        setBusy(sid, st, false);
        changed = true;
        break;
      }
      case 'prompt.completed':
      case 'prompt.aborted':
        settleRunningActivities(st, 'done');
        refreshActiveTool(st);
        setBusy(sid, st, false);
        changed = true;
        break;

      case 'tool.call.started':
      case 'tool.started': {
        const id = data.toolCallId ?? data.tool_call_id ?? '';
        const name = data.name ?? data.tool_name ?? data.toolName ?? 'tool';
        const args = data.args ?? data.input ?? null;
        upsertActivity(st, {
          id, name,
          summary: summarize(name, args) || (typeof data.description === 'string' ? trunc(oneLine(data.description), SUMMARY_MAX) : ''),
          status: 'running',
        });
        st.activeTool = name;
        setBusy(sid, st, true);
        extractFiles(st, name, args);
        changed = true;
        break;
      }
      case 'tool.call.delta': {
        // Volatile arg streaming; only ensure a placeholder row exists.
        const id = data.toolCallId ?? data.tool_call_id ?? '';
        if (id && !findActivity(st, id)) {
          upsertActivity(st, { id, name: data.name ?? 'tool', summary: '', status: 'running' });
          st.activeTool = data.name ?? st.activeTool;
          changed = true;
        }
        break;
      }
      case 'tool.result':
      case 'tool.completed': {
        const id = data.toolCallId ?? data.tool_call_id ?? '';
        const a = findActivity(st, id);
        if (a) a.status = (data.is_error ?? data.isError) ? 'error' : 'done';
        refreshActiveTool(st);
        changed = true;
        break;
      }

      case 'task.created':
      case 'task.started':
      case 'task.progress':
      case 'task.completed':
      case 'task.terminated':
        scheduleTaskRefetch(sid);
        break;

      default:
        break;
    }

    if (changed && sid === activeId && open) render();
  }

  // (Re)apply the language-dependent static strings (bind + language change).
  function applyStrings() {
    if (els.title) els.title.textContent = T('panel.title', '에이전트 작업');
    if (els.closeBtn) {
      els.closeBtn.setAttribute('aria-label', T('panel.close', '패널 닫기'));
    }
    if (els.empty) els.empty.textContent = T('panel.empty', '실행 중인 작업이 없습니다');
  }

  // ---- DOM binding -------------------------------------------------------------------
  function bind() {
    if (bound) return true;
    els.root = document.getElementById('panel');
    if (!els.root) return false;
    els.title = document.getElementById('panel-title');
    els.closeBtn = document.getElementById('panel-close-btn');
    els.content = document.getElementById('panel-content');
    els.status = document.getElementById('panel-status');
    els.tasks = document.getElementById('panel-tasks');
    els.activity = document.getElementById('panel-activity');
    els.files = document.getElementById('panel-files');

    if (els.closeBtn) {
      if (!els.closeBtn.textContent) els.closeBtn.textContent = '✕';
      // Direct idempotent close — safe even if the shell also wires this button.
      els.closeBtn.addEventListener('click', () => setOpen(false));
    }
    if (els.content) {
      els.empty = el('div', 'panel-empty');
      els.content.appendChild(els.empty);
    }
    applyStrings();

    let stored = null;
    try { stored = localStorage.getItem(LS_OPEN); } catch { /* ignore */ }
    open = stored === '1'; // hidden by default
    els.root.hidden = !open;
    bound = true;
    render();
    return true;
  }

  // Language change: refresh static strings; re-render contents if open.
  window.I18N?.onChange?.(() => {
    if (!bound) return;
    applyStrings();
    if (open) render();
  });

  window.Panel = { toggle, setActiveSession, handleEvent };

  if (!bind()) {
    document.addEventListener('DOMContentLoaded', () => bind(), { once: true });
  }
})();
