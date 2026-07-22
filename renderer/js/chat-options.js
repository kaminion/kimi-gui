/* chat-options.js — composer options row (v3).
 * window.ChatOptions = { init(), refresh(sessionId) }
 *
 * The options cluster lives in #composer-options (inside #composer-wrap, below
 * the textarea) since v3; v2 kept it in the chat header.
 *
 * #model-select opens a custom dropdown: models from window.kimi.listModels();
 * picking one calls window.kimi.setSessionModel() and persists the alias per
 * session (localStorage). Pill label = per-session override, else the session's
 * server-side model, else the server default (getState().defaultModel).
 * Pill stays hidden when listModels is not exposed by the preload.
 *
 * #swarm-toggle renders in BOTH engines (v4): fully wired when
 * window.kimi.setSessionSwarm exists (the cli engine exposes it); rendered
 * but disabled (.disabled + aria-disabled, click no-op, explanatory title)
 * when the direct engine omits it. Fresh cli sessions seed their on/off state
 * from localStorage 'kimi.defaultSwarm' (settings '스웜 기본값') when no
 * per-session value exists. State is per-session, optimistic UI with revert
 * on failure.
 *
 * #effort-select (v3) is shown ONLY when window.kimi.setSessionEffort exists.
 * Per-session thinking level off/low/high/max (끄기/낮음/높음/최대, default
 * 높음) persisted in localStorage 'kimi.sessionEffort.<sid>'; selecting a level
 * calls setSessionEffort() optimistically and reverts on failure. Dropdown
 * styling/behavior is identical to the model dropdown (same .model-dropdown
 * classes), anchored to the pill and flipped above it when near the window
 * bottom — the composer sits at the bottom edge, so this is the common case.
 *
 * All copy via T() ('options.*' keys, Korean fallback).
 */
(function () {
  'use strict';

  const T = (k, f) => (window.I18N?.t ? window.I18N.t(k, f) : f);

  const LS_MODEL = 'kimi.sessionModel.'; // + sessionId -> model alias
  const LS_SWARM = 'kimi.sessionSwarm.'; // + sessionId -> '1' | '0'
  const LS_EFFORT = 'kimi.sessionEffort.'; // + sessionId -> 'off'|'low'|'high'|'max'
  const LS_DEFAULT_SWARM = 'kimi.defaultSwarm'; // v4: settings '스웜 기본값' -> '1' | '0'

  const EFFORT_LEVELS = ['off', 'low', 'high', 'max'];
  const DEFAULT_EFFORT = 'high';
  const EFFORT_FALLBACKS = { off: '끄기', low: '낮음', high: '높음', max: '최대' };

  const $ = (sel) => document.querySelector(sel);

  let modelPill = null;   // #model-select
  let swarmBtn = null;    // #swarm-toggle
  let effortPill = null;  // #effort-select
  let dropdown = null;    // open .model-dropdown element (null = closed)
  let dropdownOwner = null; // pill the open dropdown is anchored to

  function lsGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (_) { /* ignore */ } }

  function activeSessionId() {
    const st = window.App?.state;
    return st?.activeSessionId ?? st?.activeId ?? null;
  }

  /* ---- shared dropdown machinery (model + effort) ---- */

  function closeDropdown(restoreFocus) {
    if (dropdown) dropdown.remove();
    const owner = dropdownOwner;
    dropdown = null;
    dropdownOwner = null;
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onDropdownKey, true);
    if (restoreFocus) owner?.focus?.();
  }

  function onDocMouseDown(e) {
    if (!dropdown) return;
    if (dropdown.contains(e.target) || dropdownOwner?.contains(e.target)) return;
    closeDropdown();
  }

  function onDropdownKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDropdown(true);
    }
  }

  /** Anchor the dropdown to its owner pill; clamp horizontally, flip above
   * the pill when it would overflow the bottom of the window (composer row
   * sits at the bottom edge). Safe to call again after content changes. */
  function placeDropdown() {
    if (!dropdown || !dropdownOwner) return;
    const r = dropdownOwner.getBoundingClientRect();
    dropdown.style.left = `${Math.max(8, r.left)}px`;
    dropdown.style.top = `${r.bottom + 4}px`;
    let dr = dropdown.getBoundingClientRect();
    if (dr.right > window.innerWidth - 8) {
      dropdown.style.left = `${Math.max(8, window.innerWidth - 8 - dr.width)}px`;
    }
    dr = dropdown.getBoundingClientRect();
    if (dr.bottom > window.innerHeight - 8) {
      dropdown.style.top = `${Math.max(8, r.top - dr.height - 4)}px`;
    }
  }

  function dropdownItem(label, current, onSelect) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'model-dropdown-item';
    item.setAttribute('role', 'option');
    const check = document.createElement('span');
    check.className = 'model-dropdown-check';
    check.textContent = label === current ? '✓' : '';
    const text = document.createElement('span');
    text.className = 'model-dropdown-label';
    text.textContent = label;
    item.append(check, text);
    if (label === current) {
      item.classList.add('current');
      item.setAttribute('aria-selected', 'true');
    }
    item.addEventListener('click', () => void onSelect());
    return item;
  }

  function dropdownNote(text) {
    const note = document.createElement('div');
    note.className = 'model-dropdown-note';
    note.textContent = text;
    return note;
  }

  /** Open (or replace) a dropdown anchored to `pill`; fill() appends content
   * and may be async — the dropdown is re-placed once it resolves. */
  function openDropdown(pill, fill) {
    closeDropdown();
    dropdown = document.createElement('div');
    dropdown.className = 'model-dropdown';
    dropdown.setAttribute('role', 'listbox');
    dropdownOwner = pill;
    document.body.appendChild(dropdown);
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDropdownKey, true);
    placeDropdown();
    Promise.resolve()
      .then(() => fill(dropdown))
      .then(() => placeDropdown())
      .catch((err) => console.error('dropdown fill failed', err));
  }

  function toggleDropdownFor(pill, fill) {
    if (dropdown && dropdownOwner === pill) { closeDropdown(); return; }
    openDropdown(pill, fill);
  }

  /* ---- model pill + dropdown ---- */

  /** Model alias shown on the pill: per-session override, else the session's
   * server-side model (listSessions), else the server default. */
  function currentModel(sessionId) {
    if (sessionId) {
      const stored = lsGet(LS_MODEL + sessionId);
      if (stored) return stored;
      const sessionModel = window.App?.state?.sessions?.find?.((s) => s && s.id === sessionId)?.model;
      if (sessionModel) return sessionModel;
    }
    return window.App?.state?.defaultModel ?? null;
  }

  function updateModelPill(sessionId) {
    if (!modelPill) return;
    const model = currentModel(sessionId);
    modelPill.textContent = model || T('options.model.none', '모델');
  }

  async function fillModelDropdown(box) {
    const sid = activeSessionId();
    box.appendChild(dropdownNote(T('options.model.loading', '불러오는 중…')));
    let models = [];
    try { models = (await window.kimi.listModels()) ?? []; }
    catch (err) { console.error('listModels failed', err); }
    if (box !== dropdown) return; // closed/replaced while loading
    box.textContent = '';
    if (!Array.isArray(models) || !models.length) {
      box.appendChild(dropdownNote(T('options.model.empty', '사용 가능한 모델이 없습니다')));
      return;
    }
    const current = currentModel(sid);
    for (const m of models) {
      const alias = m?.alias ?? m?.model ?? String(m);
      box.appendChild(dropdownItem(alias, current, () => selectModel(alias)));
    }
  }

  async function selectModel(alias) {
    const sid = activeSessionId();
    closeDropdown();
    if (!sid) return; // draft chat: new-session model comes from Settings default
    try {
      await window.kimi.setSessionModel(sid, alias);
      lsSet(LS_MODEL + sid, alias);
      updateModelPill(sid);
    } catch (err) {
      console.error('setSessionModel failed', err);
    }
  }

  /* ---- swarm toggle ---- */

  function swarmEnabled(sid) {
    if (!sid) return false; // draft chat: app.js applies the default on create
    const stored = lsGet(LS_SWARM + sid);
    if (stored === '1' || stored === '0') return stored === '1';
    // v4: fresh session with no per-session value — seed from the settings
    // default (스웜 기본값) so the pill matches what app.js applied.
    return lsGet(LS_DEFAULT_SWARM) === '1';
  }

  function updateSwarm(sid) {
    if (!swarmBtn || swarmBtn.hidden) return;
    if (!swarmBtn.textContent.trim()) swarmBtn.textContent = T('options.swarm.label', '스웜');
    // v4: engine without swarm (direct) — inert pill.
    if (typeof window.kimi?.setSessionSwarm !== 'function') {
      swarmBtn.classList.remove('on');
      swarmBtn.setAttribute('aria-pressed', 'false');
      return;
    }
    const on = swarmEnabled(sid);
    swarmBtn.classList.toggle('on', on);
    swarmBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  async function toggleSwarm() {
    const sid = activeSessionId();
    if (!sid) return;
    const next = !swarmEnabled(sid);
    lsSet(LS_SWARM + sid, next ? '1' : '0'); // optimistic
    updateSwarm(sid);
    try {
      await window.kimi.setSessionSwarm(sid, next);
    } catch (err) {
      console.error('setSessionSwarm failed', err);
      lsSet(LS_SWARM + sid, next ? '0' : '1'); // revert
      updateSwarm(sid);
    }
  }

  /* ---- effort pill + dropdown (v3) ---- */

  function currentEffort(sid) {
    const stored = sid ? lsGet(LS_EFFORT + sid) : null;
    return EFFORT_LEVELS.includes(stored) ? stored : DEFAULT_EFFORT;
  }

  function effortLabel(level) {
    return T(`options.effort.${level}`, EFFORT_FALLBACKS[level] || level);
  }

  function updateEffortPill(sid) {
    if (!effortPill || effortPill.hidden) return;
    effortPill.textContent = effortLabel(currentEffort(sid));
  }

  function fillEffortDropdown(box) {
    const current = effortLabel(currentEffort(activeSessionId()));
    for (const level of EFFORT_LEVELS) {
      box.appendChild(dropdownItem(effortLabel(level), current, () => selectEffort(level)));
    }
  }

  async function selectEffort(level) {
    const sid = activeSessionId();
    closeDropdown();
    if (!sid) return; // draft chat: nothing to persist against
    const prev = currentEffort(sid);
    lsSet(LS_EFFORT + sid, level); // optimistic
    updateEffortPill(sid);
    try {
      await window.kimi.setSessionEffort(sid, level);
    } catch (err) {
      console.error('setSessionEffort failed', err);
      lsSet(LS_EFFORT + sid, prev); // revert
      updateEffortPill(sid);
    }
  }

  /* ---- public API ---- */

  /** Wire option pills. Idempotent; safe to call again after DOM changes. */
  function init() {
    modelPill = $('#model-select');
    swarmBtn = $('#swarm-toggle');
    effortPill = $('#effort-select');
    if (modelPill) {
      if (typeof window.kimi?.listModels !== 'function') {
        modelPill.hidden = true;
      } else if (!modelPill.dataset.chatOptionsWired) {
        modelPill.dataset.chatOptionsWired = '1';
        modelPill.addEventListener('click', () =>
          toggleDropdownFor(modelPill, fillModelDropdown)
        );
      }
    }
    if (swarmBtn) {
      // v4: the pill renders in both engines — inert when the preload omits
      // setSessionSwarm (direct engine), fully wired when available (cli).
      swarmBtn.hidden = false;
      if (typeof window.kimi?.setSessionSwarm !== 'function') {
        swarmBtn.classList.add('disabled');
        swarmBtn.setAttribute('aria-disabled', 'true');
        swarmBtn.setAttribute('aria-pressed', 'false');
        // No click listener: the disabled pill is a deliberate no-op.
      } else {
        swarmBtn.classList.remove('disabled');
        swarmBtn.removeAttribute('aria-disabled');
        if (!swarmBtn.dataset.chatOptionsWired) {
          swarmBtn.dataset.chatOptionsWired = '1';
          swarmBtn.addEventListener('click', () => void toggleSwarm());
        }
      }
    }
    if (effortPill) {
      if (typeof window.kimi?.setSessionEffort !== 'function') {
        effortPill.hidden = true; // preload too old / engine without effort: hidden
      } else if (!effortPill.dataset.chatOptionsWired) {
        effortPill.hidden = false;
        effortPill.dataset.chatOptionsWired = '1';
        effortPill.addEventListener('click', () =>
          toggleDropdownFor(effortPill, fillEffortDropdown)
        );
      } else {
        effortPill.hidden = false; // API appeared after an earlier init
      }
    }
    refresh(activeSessionId());
  }

  /** Re-sync pill labels + toggle state with a (possibly new) active session. */
  function refresh(sessionId) {
    const sid = sessionId ?? activeSessionId();
    if (modelPill && !modelPill.hidden) updateModelPill(sid);
    if (swarmBtn && !swarmBtn.hidden) updateSwarm(sid);
    if (effortPill && !effortPill.hidden) updateEffortPill(sid);
  }

  // Language change: re-apply translated pill labels/tooltips in place.
  window.I18N?.onChange?.(() => refresh(activeSessionId()));

  window.ChatOptions = { init, refresh };
})();
