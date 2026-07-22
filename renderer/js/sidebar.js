/* sidebar.js — session list rendering, grouped by project (cwd basename). */
'use strict';

(function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const COLLAPSE_KEY = 'kimi.sidebarCollapsed'; // persisted array of group keys
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
    if (window.App?.state) render(window.App.state);
  }

  function chevronSvg() {
    // Always the right-pointing glyph: layout.css rotates it 90° (down) while
    // the group is expanded and snaps it back on .collapsed.
    const path = 'M5 3l4 3.5L5 10';
    return `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">` +
      `<path d="${path}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`;
  }

  function renderItem(session, state) {
    const el = document.createElement('div');
    el.className = 'session-item';
    el.dataset.sessionId = session.id;
    if (session.id === state.activeId) el.classList.add('active');
    if (session.busy) el.classList.add('busy');
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    if (session.cwd) el.title = session.cwd; // disambiguate identical basenames

    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = session.title || T('chat.new_chat', '새 대화');

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = relTime(session.updatedAt);

    el.append(title, meta);
    const select = () => window.App?.selectSession(session.id);
    el.addEventListener('click', select);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });
    return el;
  }

  /**
   * Group header: chevron + project name + session count.
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

  /**
   * Render the session list grouped by project (cwd basename).
   * Groups sort by latest activity desc, items by updatedAt desc.
   * When no session carries a cwd at all, fall back to a flat list.
   */
  function render(state) {
    const nav = document.getElementById('session-list');
    if (!nav) return;
    nav.textContent = '';
    const sessions = [...(state.sessions || [])];

    if (!sessions.some((s) => basename(s.cwd))) {
      // Flat fallback: no project information anywhere -> plain newest-first list.
      sessions.sort(byUpdatedDesc);
      for (const s of sessions) nav.appendChild(renderItem(s, state));
      return;
    }

    const groups = new Map(); // key -> { key, name, items, latest }
    for (const s of sessions) {
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
