/* app.js — application store (window.App), boot sequence, global event dispatch. */
'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);
  const T = (k, f) => (window.I18N?.t ? window.I18N.t(k, f) : f);
  const intFmt = new Intl.NumberFormat('ko-KR');
  const LAST_CWD_KEY = 'kimi.lastCwd';
  const DEFAULT_MODEL_KEY = 'kimi.defaultModel';
  const DEFAULT_SWARM_KEY = 'kimi.defaultSwarm'; // v4 (R2): settings 스웜 기본값

  let refreshTimer = null;
  let unsubscribeEvents = null;   // guard against double-subscribe on re-entry
  let chatOptionsInited = false;  // ChatOptions.init() runs exactly once
  let updateReady = false;        // a downloaded update is waiting to install
  let updateVersion = null;       // version of the downloaded update

  const App = {
    state: {
      ready: false,        // backend answered getState with ready:true
      version: null,
      defaultModel: null,
      sessions: [],        // [{ id, title, cwd, updatedAt, busy, usage?, engine? }]
      activeId: null,      // selected session id (null = draft new chat)
      view: 'chat',        // 'chat' | 'usage'
      serverReady: false,  // live WS/server status from 'status' events
      engine: null,        // 'direct' | 'cli' from getState (v4: swarm default gate)
    },

    /** Re-fetch the session list; re-render sidebar and header affordances. */
    async refreshSessions() {
      try {
        App.state.sessions = await window.kimi.listSessions();
      } catch (err) {
        console.error('listSessions failed', err);
        return;
      }
      const { sessions, activeId } = App.state;
      if (activeId && !sessions.some((s) => s.id === activeId)) {
        // The active session was deleted elsewhere.
        App.state.activeId = null;
        updateChatHeader();
        updateContextMeter(null);
        window.Chat?.renderMessages?.([], null);
        syncComposerForSession(null);
      }
      window.Sidebar?.render?.(App.state);
    },

    /**
     * v3 (R1): re-sync after a renderer-initiated session mutation (rename /
     * delete from the sidebar). Selection intent is preserved: when the
     * active session still exists it stays selected and only the chrome
     * refreshes (this is how a rename of the active session reaches
     * #chat-title); when it vanished, switch to the most recent remaining
     * session, or to draft mode when none are left.
     */
    async refreshSessionsAfterMutation() {
      const prevActive = App.state.activeId;
      try {
        App.state.sessions = await window.kimi.listSessions();
      } catch (err) {
        console.error('listSessions failed', err);
        return;
      }
      window.Sidebar?.render?.(App.state);
      if (!prevActive || App.state.sessions.some((s) => s.id === prevActive)) {
        updateChatHeader();
        return;
      }
      // The active session was deleted: fall back to the next-most-recent.
      const sorted = [...App.state.sessions].sort(
        (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
      );
      if (sorted.length) await App.selectSession(sorted[0].id);
      else App.startNewChat();
    },

    /** Select a session: highlight it, load its transcript and context meter. */
    async selectSession(id) {
      App.state.activeId = id;
      App.showView('chat');
      window.Sidebar?.render?.(App.state);
      updateChatHeader();
      syncComposerForSession(App.state.sessions.find((s) => s.id === id));
      refreshChatOptions(id);
      notifyPanelSession(id);
      try {
        const messages = await window.kimi.getMessages(id);
        if (App.state.activeId !== id) return; // user switched meanwhile
        // Pass the id: chat.js filters WS events by its activeSessionId.
        window.Chat?.renderMessages?.(messages, id);
      } catch (err) {
        console.error('getMessages failed', err);
      }
      try {
        const profile = await window.kimi.getProfile(id);
        if (App.state.activeId !== id) return;
        updateContextMeter(profile?.usage);
      } catch (err) {
        console.error('getProfile failed', err);
      }
    },

    /** Search-result entry point: open a session and jump to a message. */
    async openSessionAtMessage(sessionId, messageId) {
      await App.selectSession(sessionId);
      window.Chat?.scrollToMessage?.(messageId);
    },

    /** Enter draft mode: no active session; one is created lazily on first send. */
    startNewChat() {
      App.state.activeId = null;
      App.showView('chat');
      window.Sidebar?.render?.(App.state);
      updateChatHeader();
      updateContextMeter(null);
      syncComposerForSession(null);
      refreshChatOptions(null);
      notifyPanelSession(null);
      window.Chat?.renderMessages?.([], null);
      $('#composer')?.focus();
    },

    /**
     * Send a prompt. Creates a session lazily on first send, reusing the last
     * working directory when known, otherwise asking via the native picker.
     * Returns true when the prompt was dispatched.
     */
    async sendPrompt(text) {
      text = String(text ?? '').trim();
      if (!text || !App.state.serverReady) return false;
      try {
        let id = App.state.activeId;
        if (!id) {
          let cwd = null;
          try { cwd = localStorage.getItem(LAST_CWD_KEY); } catch (_) { /* ignore */ }
          if (!cwd) {
            cwd = await window.kimi.pickDirectory();
            if (!cwd) return false; // user cancelled the picker
            try { localStorage.setItem(LAST_CWD_KEY, cwd); } catch (_) { /* ignore */ }
          }
          const session = await window.kimi.createSession({ cwd });
          // The server ignores agent_config.model in the create body, so the
          // model must be set via the profile endpoint before the first prompt.
          await applyDefaultModel(session.id);
          await applyDefaultSwarm(session.id); // v4 (R2): settings 스웜 기본값
          await App.refreshSessions();
          App.state.activeId = session.id;
          window.Sidebar?.render?.(App.state);
          updateChatHeader();
          refreshChatOptions(session.id);
          notifyPanelSession(session.id);
          // Do NOT renderMessages([]) here: that would wipe the optimistic
          // user echo. Just point chat.js at the new session for WS filtering.
          window.Chat?.setActiveSession?.(session.id);
          id = session.id;
        }
        await window.kimi.sendPrompt(id, text);
        scheduleRefreshSessions(); // pick up the busy state promptly
        return true;
      } catch (err) {
        console.error('sendPrompt failed', err);
        return false;
      }
    },

    /** Abort the active session's current turn. */
    abort() {
      const id = App.state.activeId;
      if (!id) return;
      window.kimi.abort(id).catch((err) => console.error('abort failed', err));
    },

    /** Toggle between the chat and usage views. */
    showView(name) {
      App.state.view = name === 'usage' ? 'usage' : 'chat';
      $('#chat-view').hidden = App.state.view !== 'chat';
      $('#usage-view').hidden = App.state.view !== 'usage';
      $('#usage-nav-btn').classList.toggle('active', App.state.view === 'usage');
      if (App.state.view === 'usage') window.Usage?.render?.(App.state);
    },
  };

  window.App = App;

  /* v3 (R1): additive hook so the sidebar can refresh #chat-title after a
   * rename when no backend rename IPC is available (local-only fallback). */
  App.updateChatHeader = updateChatHeader;

  // Re-render language-dependent chrome on language change (sidebar, header,
  // status dot, update dot). Static markup is handled by I18N.applyToDom.
  window.I18N?.onChange?.(() => {
    if (!App.state.ready) return; // nothing rendered yet; boot paints fresh strings
    window.Sidebar?.render?.(App.state);
    updateChatHeader();
    setServerStatus(App.state.serverReady);
    setUpdateDot(updateReady, updateVersion);
    updateContextMeter(App.state.contextUsage);
  });

  /** Invoke an optional hook on a sibling module without ever breaking boot. */
  function safeCall(fn) {
    try {
      const r = fn?.();
      if (r && typeof r.catch === 'function') {
        r.catch((err) => console.error(err));
      }
    } catch (err) {
      console.error(err);
    }
  }

  /* ---- chat options (model picker / swarm toggle, owned by R4) ---- */

  function initChatOptionsOnce() {
    if (chatOptionsInited) return;
    chatOptionsInited = true;
    safeCall(() => window.ChatOptions?.init?.());
    updateModelSelectLabel();
  }

  function refreshChatOptions(sessionId) {
    if (!chatOptionsInited) return;
    safeCall(() => window.ChatOptions?.refresh?.(sessionId));
    updateModelSelectLabel();
  }

  /**
   * Fallback label for the #model-select pill. ChatOptions (R4) owns the
   * label whenever it is loaded; this only covers its absence and never
   * overwrites a label ChatOptions has already set.
   */
  function updateModelSelectLabel() {
    const btn = $('#model-select');
    if (!btn || window.ChatOptions) return;
    const label =
      App.state.sessions.find((s) => s.id === App.state.activeId)?.model ||
      App.state.defaultModel ||
      '';
    if (label) btn.textContent = label;
  }

  /**
   * Tell the agent-work panel (R3) which session is active. The shipped
   * interface is Panel.setActiveSession(id); Panel.setSession is accepted
   * as a fallback name.
   */
  function notifyPanelSession(id) {
    const panel = window.Panel;
    if (!panel) return;
    if (typeof panel.setActiveSession === 'function') {
      safeCall(() => panel.setActiveSession(id));
    } else {
      safeCall(() => panel.setSession?.(id));
    }
  }

  /* ---- default model on new sessions (Settings, owned by R4) ---- */

  function readStoredDefaultModel() {
    try { return localStorage.getItem(DEFAULT_MODEL_KEY); } catch (_) { return null; }
  }

  /** Best-effort: apply the configured default model to a fresh session. */
  async function applyDefaultModel(sessionId) {
    try {
      const model =
        window.Settings?.getDefaultModel?.() ||
        readStoredDefaultModel() ||
        App.state.defaultModel;
      if (model && typeof window.kimi.setSessionModel === 'function') {
        await window.kimi.setSessionModel(sessionId, model);
      }
    } catch (err) {
      console.error('setSessionModel failed (best-effort)', err);
    }
  }

  function readStoredDefaultSwarm() {
    try { return localStorage.getItem(DEFAULT_SWARM_KEY) === '1'; } catch (_) { return false; }
  }

  /**
   * v4 (R2): apply the configured swarm default (settings '스웜 기본값') to a
   * fresh session. CLI agent mode only — the preload omits setSessionSwarm
   * under the direct engine, which the feature-check also covers.
   */
  async function applyDefaultSwarm(sessionId) {
    try {
      if (
        readStoredDefaultSwarm() &&
        App.state.engine === 'cli' &&
        typeof window.kimi.setSessionSwarm === 'function'
      ) {
        await window.kimi.setSessionSwarm(sessionId, true);
      }
    } catch (err) {
      console.error('setSessionSwarm failed (best-effort)', err);
    }
  }

  /* ---- header / composer helpers ---- */

  function updateChatHeader() {
    const session = App.state.sessions.find((s) => s.id === App.state.activeId);
    $('#chat-title').textContent = session?.title || T('chat.new_chat', '새 대화');
    // The v2 model pill (ChatOptions) owns model display; #model-label is the
    // v1 fallback, kept empty while the pill exists to avoid showing it twice.
    $('#model-label').textContent = window.ChatOptions ? '' : App.state.defaultModel || '';
  }

  /**
   * v5 (R-UX): a session the active engine cannot continue. Only the cli
   * engine is affected (it lists direct-engine sessions read-only); the
   * direct engine continues legacy CLI sessions natively (CONTRACT-V4), so
   * those are never foreign.
   */
  function isForeignEngineSession(session) {
    const engine = App.state.engine;
    return !!(session && session.engine && engine === 'cli' && session.engine !== engine);
  }

  /**
   * v5 (R-UX): sync the composer with the freshly selected session — foreign
   * sessions become read-only, and the send button starts in STOP mode when
   * the session is busy. Called on session switches/draft entry only:
   * mid-session busy flips stream in via WS events (chat.js applyEvent), and
   * syncing the busy flag from the session list on every refresh would race
   * the send path (listSessions can lag a just-dispatched prompt).
   */
  function syncComposerForSession(session) {
    window.Chat?.setReadOnly?.(isForeignEngineSession(session));
    window.Chat?.setBusy?.(!!session?.busy);
  }

  /** Labeled "% of context window" meter at the composer options row (right edge). */
  function updateContextMeter(usage) {
    App.state.contextUsage = usage; // kept so language switches can re-render the label
    const el = $('#context-meter');
    const used = Number(usage?.context_tokens ?? 0);
    const limit = Number(usage?.context_limit ?? 0);
    if (!limit) {
      el.textContent = '';
      el.removeAttribute('title');
      el.style.color = '';
      return;
    }
    const pct = (used / limit) * 100;
    // Small conversations round to 0 — show "<1%" so the meter stays informative.
    const pctText = pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
    el.textContent = `${T('chat.context_label', '컨텍스트')} ${pctText}`;
    // Tooltip: first line explains the metric, second the exact numbers.
    el.title =
      T('chat.context_meter_title', '컨텍스트 사용량 — 모델에 전달 중인 대화 토큰 비율') +
      '\n' +
      T('chat.context_title_pre', '컨텍스트 ') +
      `${intFmt.format(used)} / ${intFmt.format(limit)}` +
      T('common.tokens', ' 토큰');
    el.style.color = pct >= 80 ? 'var(--warn)' : '';
  }

  function setServerStatus(ready, error) {
    App.state.serverReady = !!ready;
    const dot = $('#server-status');
    dot.classList.toggle('ok', !!ready);
    dot.classList.toggle('err', !ready);
    dot.title = ready
      ? T('app.server_connected', '서버 연결됨')
      : T('app.server_disconnected', '서버 연결 끊김') + (error ? `: ${error}` : '');
  }

  function scheduleRefreshSessions() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => App.refreshSessions(), 150);
  }

  /* ---- update status dot on #settings-btn ---- */

  function setUpdateDot(show, version) {
    updateReady = !!show;
    if (version) updateVersion = version;
    const dot = $('#settings-update-dot');
    if (dot) dot.hidden = !updateReady;
    const btn = $('#settings-btn');
    if (!btn) return;
    btn.classList.toggle('has-update', updateReady);
    btn.title = updateReady
      ? T('update.ready_title', '업데이트 준비됨 — 설정에서 다시 시작하여 적용') +
        (version ? ` (v${version})` : '')
      : T('settings.open_title', '설정');
  }

  /* ---- push-event dispatch (window.kimi.onEvent) ---- */

  function handleEvent(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'status':
        if (msg.engine === 'direct' || msg.engine === 'cli') {
          App.state.engine = msg.engine;
          refreshChatOptions(App.state.activeSessionId);
        }
        setServerStatus(msg.ready, msg.error);
        if (msg.ready) App.refreshSessions(); // resync after reconnect
        break;
      case 'session':
        onSessionEvent(msg.sessionId, msg.event);
        break;
      case 'usage':
        if (msg.sessionId === App.state.activeId) updateContextMeter(msg.usage);
        if (App.state.view === 'usage') {
          window.Usage?.updateUsage?.(msg.sessionId, msg.usage);
        }
        break;
      case 'onboarding':
        // Login progress for the onboarding gate; CLI-install progress is
        // consumed by the settings 엔진 section's own onEvent subscription.
        safeCall(() => window.Onboarding?.handleEvent?.(msg));
        break;
      case 'update':
        if (msg.status === 'downloaded') setUpdateDot(true, msg.version);
        break;
    }
  }

  function onSessionEvent(sessionId, ev) {
    if (!ev) return;
    const type = String(ev.type || '');
    // Chat transcript and approval dialogs handle their own event kinds.
    // Pass the event's own sessionId — chat.js drops background sessions.
    window.Chat?.applyEvent?.(sessionId, ev);
    window.Approvals?.maybeHandle?.(ev);
    // The agent-work panel (R3) sees every session event.
    safeCall(() =>
      window.Panel?.handleEvent?.(
        sessionId ?? ev.session_id ?? ev.sessionId ?? ev.payload?.sessionId ?? null,
        ev
      )
    );
    // Session-lifecycle events change sidebar membership/title/busy state.
    if (/session\.(created|updated|deleted|status_changed|work_changed)/.test(type)) {
      scheduleRefreshSessions();
    }
  }

  /* ---- static chrome wiring ---- */

  function wireChrome() {
    $('#new-chat-btn').addEventListener('click', () => App.startNewChat());
    $('#usage-nav-btn').addEventListener('click', () => {
      App.showView(App.state.view === 'usage' ? 'chat' : 'usage');
    });
    // NOTE: #composer / #send-btn are owned by chat.js (optimistic echo, busy
    // lock/stop-mode, autoresize). Binding them here too would double-send.
    // Retry must actually relaunch the engine: a dead cli daemon does not come
    // back from a plain reload (nothing re-launches it), so ask the backend to
    // re-init first (no-op fast path for the direct engine), then reload.
    $('#boot-retry-btn').addEventListener('click', async () => {
      try {
        await window.kimi?.bootstrapRetry?.();
      } catch (err) {
        console.warn('bootstrapRetry failed', err);
      }
      location.reload();
    });
    // v2 chrome. Search palette (⌘F / #search-open-btn) is wired by R2's
    // search.js; model/swarm pill clicks are wired by R4's ChatOptions.init().
    $('#settings-btn')?.addEventListener('click', () => {
      safeCall(() => window.Settings?.open?.());
    });
    $('#panel-toggle-btn')?.addEventListener('click', () => {
      safeCall(() => window.Panel?.toggle?.());
    });
    // v4 (R2): #panel-close-btn is wired by panel.js itself (setOpen(false)).
    // Wiring it here too called Panel.toggle() after the close and reopened
    // the panel — do not re-add a listener for it.
    window.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        App.startNewChat();
      } else if (e.key === ',') {
        e.preventDefault();
        App.showView('usage');
      }
    });
    // Menu-less build: re-bind the shortcuts the macOS Edit/Window menu roles
    // used to provide (select-all/copy/cut/paste/undo + close/minimize/hide).
    // Cmd on mac, Ctrl elsewhere; never with Alt; never steals app shortcuts.
    window.addEventListener('keydown', (e) => {
      const mod = navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      const ae = document.activeElement;
      const editable =
        ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable);
      if (key === 'a' && editable) {
        e.preventDefault();
        ae.select();
      } else if (key === 'c' || key === 'x') {
        // Clipboard API, not execCommand — the latter needs transient
        // activation, which is also why the native menu role was required.
        const text = editable
          ? ae.value.substring(ae.selectionStart, ae.selectionEnd)
          : window.getSelection().toString();
        if (!text) return;
        e.preventDefault();
        navigator.clipboard.writeText(text).catch(() => {});
        if (key === 'x' && editable) {
          ae.setRangeText('', ae.selectionStart, ae.selectionEnd, 'start');
          ae.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else if (key === 'v' && editable) {
        e.preventDefault();
        navigator.clipboard
          .readText()
          .then((text) => {
            ae.setRangeText(text, ae.selectionStart, ae.selectionEnd, 'end');
            ae.dispatchEvent(new Event('input', { bubbles: true }));
          })
          .catch(() => {});
      } else if (key === 'z' && editable) {
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'redo' : 'undo');
      } else if (!e.shiftKey && (key === 'w' || key === 'm' || key === 'h')) {
        e.preventDefault();
        window.kimi?.windowAction?.({ w: 'close', m: 'minimize', h: 'hide' }[key]);
      }
    });
  }

  /* ---- boot ---- */

  function showBootError(message) {
    $('#boot-error-message').textContent =
      message || T('app.unknown_error', '알 수 없는 오류가 발생했습니다.');
    $('#boot-error').style.display = 'flex';
  }

  /** Hide the splash/onboarding layers when the gate module is unavailable. */
  function hideOnboardingLayers() {
    const splash = $('#splash');
    if (splash) splash.hidden = true;
    const onboarding = $('#onboarding');
    if (onboarding) onboarding.hidden = true;
  }

  /**
   * Boot: nothing visual happens until the onboarding gate (R1) resolves.
   * Onboarding.init(bootMain) plays the splash, routes through the login
   * gate when needed (v3: login only — no CLI install step), and calls
   * bootMain once the app may proceed. Without the module (or if it fails)
   * we hide the gate layers and boot directly (v1 behavior).
   */
  function boot() {
    wireChrome();
    if (typeof window.Onboarding?.init === 'function') {
      const fallback = (err) => {
        console.error('Onboarding.init failed; booting directly', err);
        hideOnboardingLayers();
        void bootMain();
      };
      try {
        const r = window.Onboarding.init(bootMain);
        if (r && typeof r.catch === 'function') r.catch(fallback);
      } catch (err) {
        fallback(err);
      }
      return;
    }
    hideOnboardingLayers();
    void bootMain();
  }

  async function bootMain() {
    let state;
    try {
      if (!window.kimi) {
        throw new Error(T('app.error.no_preload', 'preload API(window.kimi)를 사용할 수 없습니다.'));
      }
      state = await window.kimi.getState();
    } catch (err) {
      showBootError(err?.message || String(err));
      return;
    }
    if (state?.needsOnboarding) {
      // Logged out (v3: needsOnboarding = !isLoggedIn, engine-independent):
      // hand control back to the onboarding gate.
      if (typeof window.Onboarding?.show === 'function') {
        safeCall(() => window.Onboarding.show());
      } else if (typeof window.Onboarding?.init === 'function') {
        safeCall(() => window.Onboarding.init(bootMain));
      } else {
        showBootError(
          state?.error ||
            T('app.error.cli_or_login', 'Kimi Code CLI를 찾을 수 없거나 로그인이 필요합니다.')
        );
      }
      return;
    }
    if (!state?.ready) {
      showBootError(
        state?.error ||
          T('app.error.cli_or_server', 'Kimi Code CLI를 찾을 수 없거나 로컬 서버를 시작하지 못했습니다.')
      );
      return;
    }
    App.state.ready = true;
    App.state.version = state.version ?? null;
    App.state.defaultModel = state.defaultModel ?? null;
    App.state.engine = state.engine ?? null;
    setServerStatus(true);
    initChatOptionsOnce();
    if (!unsubscribeEvents) unsubscribeEvents = window.kimi.onEvent(handleEvent);
    try {
      App.state.sessions = await window.kimi.listSessions();
    } catch (err) {
      console.error('listSessions failed', err);
      App.state.sessions = [];
    }
    window.Sidebar?.render?.(App.state);
    updateChatHeader();
    // Select the most recently updated session, or start in draft mode.
    const sorted = [...App.state.sessions].sort(
      (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
    );
    if (sorted.length) await App.selectSession(sorted[0].id);
    else App.startNewChat();
  }

  void boot();
})();
