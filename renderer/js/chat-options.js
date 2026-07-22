/* chat-options.js — chat-header affordances (v2).
 * window.ChatOptions = { init(), refresh(sessionId) }
 *
 * #model-select pill (shell-owned button) opens a custom dropdown: models from
 * window.kimi.listModels(); picking one calls window.kimi.setSessionModel() and
 * persists the alias per session (localStorage). Pill label = per-session
 * override, else the server default model (getState().defaultModel).
 * Pill stays hidden when listModels is not exposed by the preload.
 *
 * #swarm-toggle (shell-owned, starts hidden) is shown ONLY when
 * window.kimi.setSessionSwarm exists (i.e. M1 discovered a swarm endpoint).
 * State is per-session, optimistic UI with revert on failure.
 *
 * All copy via T() ('options.*' keys, Korean fallback).
 */
(function () {
  'use strict';

  const T = (k, f) => (window.I18N?.t ? window.I18N.t(k, f) : f);

  const LS_MODEL = 'kimi.sessionModel.'; // + sessionId -> model alias
  const LS_SWARM = 'kimi.sessionSwarm.'; // + sessionId -> '1' | '0'

  const $ = (sel) => document.querySelector(sel);

  let pill = null;      // #model-select
  let swarmBtn = null;  // #swarm-toggle
  let dropdown = null;  // open .model-dropdown element (null = closed)

  function lsGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (_) { /* ignore */ } }

  function activeSessionId() {
    const st = window.App?.state;
    return st?.activeSessionId ?? st?.activeId ?? null;
  }

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

  /* ---- model pill + dropdown ---- */

  function updatePillLabel(sessionId) {
    if (!pill) return;
    const model = currentModel(sessionId);
    pill.textContent = model || T('options.model.none', '모델');
    pill.title = T('options.model.pick', '모델 선택');
  }

  function closeDropdown() {
    if (dropdown) dropdown.remove();
    dropdown = null;
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onDropdownKey, true);
  }

  function onDocMouseDown(e) {
    if (!dropdown) return;
    if (dropdown.contains(e.target) || pill?.contains(e.target)) return;
    closeDropdown();
  }

  function onDropdownKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDropdown();
      pill?.focus();
    }
  }

  async function toggleDropdown() {
    if (dropdown) { closeDropdown(); return; }
    await openDropdown();
  }

  async function openDropdown() {
    closeDropdown();
    const sid = activeSessionId();
    dropdown = document.createElement('div');
    dropdown.className = 'model-dropdown';
    dropdown.setAttribute('role', 'listbox');
    const note = document.createElement('div');
    note.className = 'model-dropdown-note';
    note.textContent = T('options.model.loading', '불러오는 중…');
    dropdown.appendChild(note);
    // Anchor to the pill (fixed: immune to overflow/clipping ancestors).
    const r = pill.getBoundingClientRect();
    dropdown.style.left = `${Math.max(8, r.left)}px`;
    dropdown.style.top = `${r.bottom + 4}px`;
    document.body.appendChild(dropdown);
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDropdownKey, true);

    let models = [];
    try { models = (await window.kimi.listModels()) ?? []; }
    catch (err) { console.error('listModels failed', err); }
    if (!dropdown) return; // closed while loading
    dropdown.textContent = '';
    if (!Array.isArray(models) || !models.length) {
      const empty = document.createElement('div');
      empty.className = 'model-dropdown-note';
      empty.textContent = T('options.model.empty', '사용 가능한 모델이 없습니다');
      dropdown.appendChild(empty);
      return;
    }
    const current = currentModel(sid);
    for (const m of models) {
      const alias = m?.alias ?? m?.model ?? String(m);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'model-dropdown-item';
      item.setAttribute('role', 'option');
      const check = document.createElement('span');
      check.className = 'model-dropdown-check';
      check.textContent = alias === current ? '✓' : '';
      const label = document.createElement('span');
      label.className = 'model-dropdown-label';
      label.textContent = alias;
      item.append(check, label);
      if (alias === current) {
        item.classList.add('current');
        item.setAttribute('aria-selected', 'true');
      }
      item.addEventListener('click', () => void selectModel(alias));
      dropdown.appendChild(item);
    }
    // Keep the dropdown inside the window horizontally.
    const dr = dropdown.getBoundingClientRect();
    if (dr.right > window.innerWidth - 8) {
      dropdown.style.left = `${Math.max(8, window.innerWidth - 8 - dr.width)}px`;
    }
  }

  async function selectModel(alias) {
    const sid = activeSessionId();
    closeDropdown();
    if (!sid) return; // draft chat: new-session model comes from Settings default
    try {
      await window.kimi.setSessionModel(sid, alias);
      lsSet(LS_MODEL + sid, alias);
      updatePillLabel(sid);
    } catch (err) {
      console.error('setSessionModel failed', err);
    }
  }

  /* ---- swarm toggle ---- */

  function swarmEnabled(sid) {
    return sid ? lsGet(LS_SWARM + sid) === '1' : false;
  }

  function updateSwarm(sid) {
    if (!swarmBtn || swarmBtn.hidden) return;
    if (!swarmBtn.textContent.trim()) swarmBtn.textContent = T('options.swarm.label', '스웜');
    const on = swarmEnabled(sid);
    swarmBtn.classList.toggle('on', on);
    swarmBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    swarmBtn.title = on
      ? T('options.swarm.on', '스웜 모드 켜짐')
      : T('options.swarm.off', '스웜 모드 꺼짐');
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

  /* ---- public API ---- */

  /** Wire header buttons. Idempotent; safe to call again after DOM changes. */
  function init() {
    pill = $('#model-select');
    swarmBtn = $('#swarm-toggle');
    if (pill) {
      if (typeof window.kimi?.listModels !== 'function') {
        pill.hidden = true;
      } else if (!pill.dataset.chatOptionsWired) {
        pill.dataset.chatOptionsWired = '1';
        pill.addEventListener('click', () => void toggleDropdown());
      }
    }
    if (swarmBtn) {
      if (typeof window.kimi?.setSessionSwarm !== 'function') {
        swarmBtn.hidden = true; // no swarm endpoint discovered: stays hidden
      } else {
        swarmBtn.hidden = false;
        if (!swarmBtn.dataset.chatOptionsWired) {
          swarmBtn.dataset.chatOptionsWired = '1';
          swarmBtn.addEventListener('click', () => void toggleSwarm());
        }
      }
    }
    refresh(activeSessionId());
  }

  /** Re-sync pill label + swarm state with a (possibly new) active session. */
  function refresh(sessionId) {
    const sid = sessionId ?? activeSessionId();
    if (pill && !pill.hidden) updatePillLabel(sid);
    if (swarmBtn && !swarmBtn.hidden) updateSwarm(sid);
  }

  window.ChatOptions = { init, refresh };
})();
