/* sidebar.js — session list rendering (v3).
 *
 * v1/v2 (kept): auto project groups by cwd basename, collapsible chevron
 * groups (state in localStorage 'kimi.sidebarCollapsed'), busy dots, relative
 * time, active highlight, flat fallback when no cwd exists anywhere.
 *
 * v3 (CONTRACT-V3 R1):
 * - Custom groups pinned ABOVE the project groups: '그룹' header row + '+'
 *   add button (inline-editable '새 그룹' row), collapsible, rename by
 *   double-click, delete by hover '×' (confirm modal; sessions return to
 *   their project groups). Persistence: localStorage 'kimi.customGroups' =
 *   { groups:[{id,name,collapsed}], assign:{sessionId:groupId} }.
 * - HTML5 drag & drop: .session-item[draggable]; custom group headers AND
 *   containers are drop targets (.drop-target highlight); a '그룹 해제'
 *   drop zone (#group-unassign-zone) appears pinned at the sidebar bottom
 *   while dragging and removes the assignment on drop. body.dnd-active is
 *   set for the duration of a drag; dragend cleans all highlights.
 * - Session rename (double-click title or hover pencil) → inline input →
 *   window.kimi.renameSession(id, title) (guarded) → state + re-render.
 * - Session delete (hover trash) → confirm modal → window.kimi.deleteSession(id)
 *   (guarded) → App.refreshSessionsAfterMutation() (delete-active fallback
 *   lives in app.js: next-most-recent session, else draft).
 *
 * Every new user-visible string goes through T() with a Korean fallback;
 * i18n.js itself is owned by the integration wave.
 */
'use strict';

(function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const COLLAPSE_KEY = 'kimi.sidebarCollapsed'; // persisted array of project-group keys
  const CUSTOM_GROUPS_KEY = 'kimi.customGroups'; // v3: { groups:[{id,name,collapsed}], assign:{sid:gid} }
  const OTHER_GROUP_KEY = '__other__'; // stable key for sessions without a cwd
  const T = (k, f) => (window.I18N?.t ? window.I18N.t(k, f) : f);

  /** Short relative time for an ISO timestamp (locale-aware via I18N). */
  function relTime(iso) {
    const t = Date.parse(iso || '');
    if (Number.isNaN(t)) return '';
    const diff = Date.now() - t;
    if (diff < 0) return T('sidebar.time.just_now', '방금 전');
    if (diff < 60 * 1000) return T('sidebar.time.just_now', '방금 전');
    if (diff < 60 * 60 * 1000) return Math.floor(diff / (60 * 1000)) + T('sidebar.time.minutes_ago', '분 전');
    if (diff < DAY_MS) return Math.floor(diff / (60 * 60 * 1000)) + T('sidebar.time.hours_ago', '시간 전');
    if (diff < 7 * DAY_MS) return Math.floor(diff / DAY_MS) + T('sidebar.time.days_ago', '일 전');
    const d = new Date(t);
    return (d.getMonth() + 1) + T('sidebar.time.month_sep', '월 ') + d.getDate() + T('sidebar.time.day_suffix', '일');
  }

  /** Last path component of a working directory (macOS + Windows separators). */
  function basename(cwd) {
    if (!cwd) return '';
    const norm = String(cwd).replace(/[\\/]+$/, '');
    const parts = norm.split(/[\\/]/);
    return parts[parts.length - 1] || norm;
  }

  const byUpdatedDesc = (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  const ts = (s) => Date.parse(s.updatedAt || '') || 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function rerender() {
    if (window.App?.state) render(window.App.state);
  }

  /* ---- project-group collapse persistence (v1/v2, unchanged) ---- */

  function readCollapsed() {
    try {
      const arr = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]');
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch (_) {
      return new Set();
    }
  }

  function writeCollapsed(set) {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
    } catch (_) {
      /* ignore */
    }
  }

  function toggleCollapsed(key) {
    const set = readCollapsed();
    if (set.has(key)) set.delete(key);
    else set.add(key);
    writeCollapsed(set);
    rerender();
  }

  /* ---- custom groups store (v3) ---- */

  /** Read + sanitize the custom-groups object; never throws. */
  function readCustomGroups() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(CUSTOM_GROUPS_KEY) || 'null');
    } catch (_) {
      raw = null;
    }
    const data = { groups: [], assign: {} };
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.groups)) {
        for (const g of raw.groups) {
          if (!g || typeof g !== 'object') continue;
          const id = String(g.id || '');
          if (!id) continue;
          data.groups.push({
            id,
            name: typeof g.name === 'string' && g.name ? g.name : T('sidebar.group_new_name', '새 그룹'),
            collapsed: !!g.collapsed,
          });
        }
      }
      if (raw.assign && typeof raw.assign === 'object') {
        for (const [sid, gid] of Object.entries(raw.assign)) {
          if (sid && typeof gid === 'string' && gid) data.assign[String(sid)] = gid;
        }
      }
    }
    // Assignments pointing at a group that no longer exists are dropped.
    const ids = new Set(data.groups.map((g) => g.id));
    for (const [sid, gid] of Object.entries(data.assign)) {
      if (!ids.has(gid)) delete data.assign[sid];
    }
    return data;
  }

  function writeCustomGroups(data) {
    try {
      localStorage.setItem(
        CUSTOM_GROUPS_KEY,
        JSON.stringify({ groups: data.groups, assign: data.assign })
      );
    } catch (_) {
      /* ignore */
    }
  }

  /** Drop assignments whose session is gone from the current list. */
  function pruneAssign(data, sessionsById) {
    let dirty = false;
    for (const sid of Object.keys(data.assign)) {
      if (!sessionsById.has(sid)) {
        delete data.assign[sid];
        dirty = true;
      }
    }
    if (dirty) writeCustomGroups(data);
  }

  function newGroupId() {
    return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function mutateCustomGroups(fn) {
    const data = readCustomGroups();
    fn(data);
    writeCustomGroups(data);
  }

  function assignSession(sessionId, groupId) {
    mutateCustomGroups((data) => {
      if (groupId && data.groups.some((g) => g.id === groupId)) {
        data.assign[String(sessionId)] = groupId;
      } else {
        delete data.assign[String(sessionId)];
      }
    });
  }

  function toggleCustomCollapsed(groupId) {
    mutateCustomGroups((data) => {
      const g = data.groups.find((x) => x.id === groupId);
      if (g) g.collapsed = !g.collapsed;
    });
    rerender();
  }

  /* ---- confirm modal (v3; reuses .modal-backdrop/.modal + .btn classes) ---- */

  /**
   * Small promise-based confirm dialog rendered into #modal-root.
   * Danger confirmations use the existing .btn-ghost.danger style; the safe
   * (cancel) button is the default focus target per macOS convention.
   */
  function confirmModal({ title, body, confirmLabel, danger }) {
    return new Promise((resolve) => {
      const root = document.getElementById('modal-root');
      if (!root) {
        resolve(false);
        return;
      }
      const backdrop = el('div', 'modal-backdrop');
      const modal = el('div', 'modal modal-confirm');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      if (title) modal.appendChild(el('div', 'modal-title', title));
      const bodyEl = el('div', 'modal-body', body);
      modal.appendChild(bodyEl);
      const actions = el('div', 'modal-actions');
      const cancelBtn = el('button', 'btn', T('common.cancel', '취소'));
      cancelBtn.type = 'button';
      const okBtn = el('button', danger ? 'btn btn-ghost danger' : 'btn btn-primary', confirmLabel);
      okBtn.type = 'button';
      actions.append(cancelBtn, okBtn);
      modal.appendChild(actions);
      backdrop.appendChild(modal);

      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        resolve(ok);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          done(false);
        }
      };
      document.addEventListener('keydown', onKey, true);
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) done(false);
      });
      cancelBtn.addEventListener('click', () => done(false));
      okBtn.addEventListener('click', () => done(true));
      root.appendChild(backdrop);
      cancelBtn.focus();
    });
  }

  /* ---- inline editing (v3) ---- */

  /**
   * Swap `anchor` for a text input (same width context). Enter commits the
   * trimmed value (empty commits are treated as cancel), ESC or blur cancels.
   * Exactly one of onCommit/onCancel fires, exactly once.
   */
  function attachInlineInput({ anchor, value, ariaLabel, onCommit, onCancel }) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-input';
    input.value = value || '';
    input.setAttribute('aria-label', ariaLabel);
    let settled = false;
    const settle = (commit) => {
      if (settled) return;
      settled = true;
      if (commit) {
        const v = input.value.trim();
        if (v) onCommit(v);
        else onCancel();
      } else {
        onCancel();
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep item/group keyboard handlers out of the edit
      if (e.key === 'Enter') {
        e.preventDefault();
        settle(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('blur', () => settle(false));
    anchor.replaceWith(input);
    input.focus();
    input.select();
    return input;
  }

  /* ---- drag & drop (v3) ---- */

  let dragSessionId = null; // session id of the in-flight drag, if any
  let unassignZone = null;  // #group-unassign-zone element, created lazily

  function clearDropHighlights() {
    document
      .querySelectorAll('.drop-target')
      .forEach((n) => n.classList.remove('drop-target'));
  }

  function onDragStart(e, session) {
    dragSessionId = String(session.id);
    try {
      e.dataTransfer?.setData('text/plain', dragSessionId);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    } catch (_) {
      /* some harnesses expose a read-only dataTransfer */
    }
    document.body?.classList.add('dnd-active');
    setUnassignZoneVisible(true);
  }

  function onDragEnd() {
    dragSessionId = null;
    document.body?.classList.remove('dnd-active');
    clearDropHighlights();
    setUnassignZoneVisible(false);
  }

  /**
   * Wire an element as a drop target for the dragged session.
   * onDrop(sessionId) performs the assignment change + re-render.
   */
  function makeDropTarget(node, onDrop) {
    node.addEventListener('dragover', (e) => {
      if (!dragSessionId) return;
      e.preventDefault(); // required to allow a drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      node.classList.add('drop-target');
    });
    node.addEventListener('dragleave', (e) => {
      // Ignore leave events that merely move between children.
      if (e.relatedTarget && node.contains(e.relatedTarget)) return;
      node.classList.remove('drop-target');
    });
    node.addEventListener('drop', (e) => {
      if (!dragSessionId) return;
      e.preventDefault();
      e.stopPropagation();
      node.classList.remove('drop-target');
      const sid = e.dataTransfer?.getData('text/plain') || dragSessionId;
      onDragEnd();
      if (sid) onDrop(String(sid));
    });
  }

  /** The '그룹 해제' drop zone pinned at the sidebar bottom while dragging. */
  function ensureUnassignZone() {
    if (unassignZone && unassignZone.isConnected !== false) return unassignZone;
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return null;
    unassignZone = el('div', '', T('sidebar.unassign_zone', '그룹 해제'));
    unassignZone.id = 'group-unassign-zone';
    unassignZone.hidden = true;
    makeDropTarget(unassignZone, (sid) => {
      assignSession(sid, null);
      rerender();
    });
    sidebar.appendChild(unassignZone);
    return unassignZone;
  }

  function setUnassignZoneVisible(visible) {
    const zone = ensureUnassignZone();
    if (!zone) return;
    zone.hidden = !visible;
  }

  /* ---- session rename / delete (v3) ---- */

  function beginSessionRename(session, itemEl) {
    if (!itemEl || itemEl.querySelector('.inline-input')) return;
    const titleEl = itemEl.querySelector('.session-title');
    if (!titleEl) return;
    itemEl.draggable = false; // text selection inside the input must not start a drag
    attachInlineInput({
      anchor: titleEl,
      value: session.title || '',
      ariaLabel: T('sidebar.rename_aria', '대화 이름 변경'),
      onCommit: (v) => {
        if (v !== (session.title || '')) void commitSessionRename(session, v);
        else rerender();
      },
      onCancel: () => rerender(),
    });
  }

  async function commitSessionRename(session, title) {
    const rename = window.kimi?.renameSession;
    if (typeof rename === 'function') {
      try {
        await rename.call(window.kimi, session.id, title);
      } catch (err) {
        console.error('renameSession failed', err);
        rerender();
        return;
      }
      // Authoritative resync: also refreshes the chat header when active.
      if (typeof window.App?.refreshSessionsAfterMutation === 'function') {
        await window.App.refreshSessionsAfterMutation();
      } else {
        rerender();
      }
      return;
    }
    // Preload without rename support: local-only best effort (never crashes).
    const s = window.App?.state?.sessions?.find((x) => x.id === session.id);
    if (s) s.title = title;
    rerender();
    if (window.App?.state?.activeId === session.id) {
      try {
        window.App?.updateChatHeader?.();
      } catch (_) {
        /* older app.js without the hook */
      }
    }
  }

  function requestSessionDelete(session) {
    void confirmModal({
      title: T('sidebar.session_delete_title', '대화 삭제'),
      body: T('sidebar.session_delete_body', '이 대화를 삭제할까요? 복구할 수 없습니다.'),
      confirmLabel: T('common.delete', '삭제'),
      danger: true,
    }).then((ok) => {
      if (ok) void doDeleteSession(session);
    });
  }

  async function doDeleteSession(session) {
    const del = window.kimi?.deleteSession;
    if (typeof del === 'function') {
      try {
        await del.call(window.kimi, session.id);
      } catch (err) {
        console.error('deleteSession failed', err);
        rerender();
        return;
      }
      // A deleted session also leaves any custom group it was assigned to.
      assignSession(session.id, null);
      // Authoritative resync; delete-active fallback lives in app.js.
      if (typeof window.App?.refreshSessionsAfterMutation === 'function') {
        await window.App.refreshSessionsAfterMutation();
      } else if (typeof window.App?.refreshSessions === 'function') {
        await window.App.refreshSessions();
      } else {
        rerender();
      }
      return;
    }
    // Preload without delete support: local-only removal (never crashes).
    // A reload would resurrect the session, so the fallback switch is done
    // locally too — most recent remaining session, else draft mode.
    const state = window.App?.state;
    const arr = state?.sessions;
    const i = Array.isArray(arr) ? arr.findIndex((x) => x.id === session.id) : -1;
    if (i >= 0) arr.splice(i, 1);
    assignSession(session.id, null);
    if (state && state.activeId === session.id) {
      const sorted = [...(arr || [])].sort(byUpdatedDesc);
      if (sorted.length && typeof window.App?.selectSession === 'function') {
        await window.App.selectSession(sorted[0].id);
        return;
      }
      state.activeId = null;
      try {
        window.App?.startNewChat?.();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    rerender();
  }

  /* ---- group management (v3) ---- */

  let editingGroupId = null;   // group whose name row is an inline input
  let pendingNewGroupId = null; // group created by '+', removed if edit cancels

  function startAddGroup() {
    const data = readCustomGroups();
    const group = {
      id: newGroupId(),
      name: T('sidebar.group_new_name', '새 그룹'),
      collapsed: false,
    };
    data.groups.push(group);
    writeCustomGroups(data);
    editingGroupId = group.id;
    pendingNewGroupId = group.id;
    rerender();
  }

  function finishGroupEdit(commit, value) {
    const id = editingGroupId;
    const isNew = id && id === pendingNewGroupId;
    editingGroupId = null;
    pendingNewGroupId = null;
    if (!id) {
      rerender();
      return;
    }
    if (commit && value) {
      mutateCustomGroups((data) => {
        const g = data.groups.find((x) => x.id === id);
        if (g) g.name = value;
      });
    } else if (isNew) {
      // Cancelling the creation of a fresh group removes it again.
      mutateCustomGroups((data) => {
        data.groups = data.groups.filter((x) => x.id !== id);
        for (const [sid, gid] of Object.entries(data.assign)) {
          if (gid === id) delete data.assign[sid];
        }
      });
    }
    rerender();
  }

  function requestGroupDelete(group) {
    void confirmModal({
      title: T('sidebar.group_delete_title', '그룹 삭제'),
      body:
        '"' +
        group.name +
        '"' +
        T('sidebar.group_delete_body', ' 그룹을 삭제할까요? 대화는 프로젝트 그룹으로 돌아갑니다.'),
      confirmLabel: T('common.delete', '삭제'),
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      if (editingGroupId === group.id) {
        editingGroupId = null;
        pendingNewGroupId = null;
      }
      mutateCustomGroups((data) => {
        data.groups = data.groups.filter((x) => x.id !== group.id);
        for (const [sid, gid] of Object.entries(data.assign)) {
          if (gid === group.id) delete data.assign[sid];
        }
      });
      rerender();
    });
  }

  /* ---- SVG helpers ---- */

  function chevronSvg() {
    // Always the right-pointing glyph: layout.css rotates it 90° (down) while
    // the group is expanded and snaps it back on .collapsed.
    const path = 'M5 3l4 3.5L5 10';
    return `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">` +
      `<path d="${path}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`;
  }

  function pencilSvg() {
    return `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">` +
      `<path d="M8.2 1.8l2 2L4 10H2V8l6.2-6.2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>` +
      `</svg>`;
  }

  function trashSvg() {
    return `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">` +
      `<path d="M2 3.2h8M4.8 3.2V2.2c0-.4.3-.7.7-.7h1c.4 0 .7.3.7.7v1M3.2 3.2l.4 6.3c0 .4.4.7.8.7h3.2c.4 0 .8-.3.8-.7l.4-6.3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`;
  }

  /* ---- session item ---- */

  function renderItem(session, state) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.sessionId = session.id;
    if (session.id === state.activeId) item.classList.add('active');
    if (session.busy) item.classList.add('busy');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.draggable = true; // v3: HTML5 drag & drop into custom groups
    if (session.cwd) item.title = session.cwd; // disambiguate identical basenames

    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = session.title || T('chat.new_chat', '새 대화');

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = relTime(session.updatedAt);

    // v3: hover actions — rename (pencil) + delete (trash).
    const actions = el('span', 'session-actions');
    const renameBtn = el('button', 'session-action session-rename');
    renameBtn.type = 'button';
    renameBtn.innerHTML = pencilSvg();
    renameBtn.title = T('sidebar.rename_title', '이름 변경');
    renameBtn.setAttribute('aria-label', T('sidebar.rename_title', '이름 변경'));
    const deleteBtn = el('button', 'session-action session-delete');
    deleteBtn.type = 'button';
    deleteBtn.innerHTML = trashSvg();
    deleteBtn.title = T('sidebar.delete_title', '삭제');
    deleteBtn.setAttribute('aria-label', T('sidebar.delete_title', '삭제'));
    actions.append(renameBtn, deleteBtn);

    item.append(title, meta, actions);
    const select = () => window.App?.selectSession(session.id);
    item.addEventListener('click', select);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      beginSessionRename(session, item);
    });
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      requestSessionDelete(session);
    });
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      beginSessionRename(session, item);
    });
    item.addEventListener('dragstart', (e) => onDragStart(e, session));
    item.addEventListener('dragend', onDragEnd);
    return item;
  }

  /* ---- group headers ---- */

  /**
   * Project group header: chevron + project name + session count.
   * Click / Enter / Space toggles the group; state persists across launches.
   * Class names match layout.css (.session-group-label, rotation-based
   * chevron: right-pointing base glyph, CSS rotates it 90° when expanded).
   */
  function renderGroupHeader(group, isCollapsed) {
    const header = document.createElement('div');
    header.className = 'session-group-label';
    header.setAttribute('role', 'button');
    header.tabIndex = 0;
    header.setAttribute('aria-expanded', String(!isCollapsed));
    header.title = T('sidebar.group_toggle', '접기/펼치기');

    const chevron = document.createElement('span');
    chevron.className = 'session-group-chevron';
    chevron.innerHTML = chevronSvg(isCollapsed);

    const name = document.createElement('span');
    name.className = 'session-group-name';
    name.textContent = group.name;

    const count = document.createElement('span');
    count.className = 'session-group-count';
    count.textContent = String(group.items.length);

    header.append(chevron, name, count);
    header.addEventListener('click', () => toggleCollapsed(group.key));
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleCollapsed(group.key);
      }
    });
    return header;
  }

  /** Custom group header (v3): same chevron convention + rename/delete. */
  function renderCustomGroupLabel(group, itemCount) {
    const header = document.createElement('div');
    header.className = 'session-group-label custom-group-label';
    header.setAttribute('role', 'button');
    header.tabIndex = 0;
    header.setAttribute('aria-expanded', String(!group.collapsed));
    header.title = T('sidebar.group_toggle', '접기/펼치기');

    const chevron = document.createElement('span');
    chevron.className = 'session-group-chevron';
    chevron.innerHTML = chevronSvg();
    header.appendChild(chevron);

    if (editingGroupId === group.id) {
      const nameHost = el('span', 'session-group-name', group.name);
      header.appendChild(nameHost);
      attachInlineInput({
        anchor: nameHost,
        value: group.name,
        ariaLabel: T('sidebar.group_rename_aria', '그룹 이름 변경'),
        onCommit: (v) => finishGroupEdit(true, v),
        onCancel: () => finishGroupEdit(false),
      });
    } else {
      const name = el('span', 'session-group-name custom-group-name', group.name);
      name.title = group.name;
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        editingGroupId = group.id;
        rerender();
      });
      header.appendChild(name);
    }

    const count = el('span', 'session-group-count', String(itemCount));
    const del = el('button', 'custom-group-delete', '×');
    del.type = 'button';
    del.title = T('sidebar.group_delete_title', '그룹 삭제');
    del.setAttribute('aria-label', T('sidebar.group_delete_title', '그룹 삭제'));
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      requestGroupDelete(group);
    });
    header.append(count, del);

    header.addEventListener('click', () => toggleCustomCollapsed(group.id));
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleCustomCollapsed(group.id);
      }
    });
    return header;
  }

  /* ---- custom groups section (v3, pinned above project groups) ---- */

  function renderCustomSection(state, data, sessionsById) {
    const section = el('div');
    section.id = 'custom-groups-section';

    const headerRow = el('div', 'custom-groups-header');
    headerRow.appendChild(el('span', 'custom-groups-title', T('sidebar.groups_title', '그룹')));
    const addBtn = el('button', 'custom-group-add', '+');
    addBtn.type = 'button';
    addBtn.title = T('sidebar.group_add_title', '새 그룹 만들기');
    addBtn.setAttribute('aria-label', T('sidebar.group_add_title', '새 그룹 만들기'));
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startAddGroup();
    });
    headerRow.appendChild(addBtn);
    section.appendChild(headerRow);

    for (const group of data.groups) {
      const items = [];
      for (const [sid, gid] of Object.entries(data.assign)) {
        if (gid === group.id && sessionsById.has(sid)) items.push(sessionsById.get(sid));
      }
      items.sort(byUpdatedDesc);

      const groupEl = el('div', 'session-group custom-group');
      groupEl.dataset.groupId = group.id;
      if (group.collapsed) groupEl.classList.add('collapsed');
      groupEl.appendChild(renderCustomGroupLabel(group, items.length));
      if (!group.collapsed) {
        for (const s of items) groupEl.appendChild(renderItem(s, state));
      }
      // Header AND container accept drops (the listener on the wrapper
      // covers both, including while collapsed).
      makeDropTarget(groupEl, (sid) => {
        assignSession(sid, group.id);
        rerender();
      });
      section.appendChild(groupEl);
    }
    return section;
  }

  /* ---- render ---- */

  /**
   * Render the session list: custom groups first (assigned sessions leave
   * their project group), then auto project groups by cwd basename.
   * Groups sort by latest activity desc, items by updatedAt desc.
   * When no session carries a cwd at all, fall back to a flat list.
   */
  function render(state) {
    const nav = document.getElementById('session-list');
    if (!nav) return;
    if (dragSessionId) {
      // A re-render destroys the drag source, so dragend never fires; reset
      // the drag chrome here or body.dnd-active / the zone would stick.
      dragSessionId = null;
      document.body?.classList.remove('dnd-active');
      setUnassignZoneVisible(false);
    }
    nav.textContent = '';
    const sessions = [...(state.sessions || [])];
    const sessionsById = new Map(sessions.map((s) => [String(s.id), s]));

    const data = readCustomGroups();
    pruneAssign(data, sessionsById);

    // v3: custom groups section is always present (the '+' row is the only
    // way to create a group) and pinned above the project groups.
    nav.appendChild(renderCustomSection(state, data, sessionsById));

    const assigned = new Set(Object.keys(data.assign));
    const rest = sessions.filter((s) => !assigned.has(String(s.id)));

    if (!rest.some((s) => basename(s.cwd))) {
      // Flat fallback: no project information anywhere -> plain newest-first list.
      rest.sort(byUpdatedDesc);
      for (const s of rest) nav.appendChild(renderItem(s, state));
      return;
    }

    const groups = new Map(); // key -> { key, name, items, latest }
    for (const s of rest) {
      const base = basename(s.cwd);
      const key = base || OTHER_GROUP_KEY;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          name: base || T('sidebar.group_other', '기타'),
          items: [],
          latest: 0,
        });
      }
      const g = groups.get(key);
      g.items.push(s);
      g.latest = Math.max(g.latest, ts(s));
    }

    const collapsed = readCollapsed();
    const sorted = [...groups.values()].sort((a, b) => b.latest - a.latest);
    for (const g of sorted) {
      g.items.sort(byUpdatedDesc);
      const groupEl = document.createElement('div');
      groupEl.className = 'session-group';
      const isCollapsed = collapsed.has(g.key);
      if (isCollapsed) groupEl.classList.add('collapsed');
      groupEl.appendChild(renderGroupHeader(g, isCollapsed));
      if (!isCollapsed) {
        for (const s of g.items) groupEl.appendChild(renderItem(s, state));
      }
      nav.appendChild(groupEl);
    }
  }

  // Language change: re-render the list (group headers + relative times).
  window.I18N?.onChange?.(() => {
    if (window.App?.state) render(window.App.state);
  });

  window.Sidebar = { render };
})();
