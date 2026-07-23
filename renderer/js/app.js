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
  let updateStatus = null;        // available | downloading | downloaded
  let launchUpdateCheckStarted = false;
  let draftCwd = null;            // new-chat workspace chosen before first send
  let draftBranch = null;         // local branch chosen for the new chat
  let draftGitInfo = null;
  let draftInfoRequest = 0;
  let branchInfoRequest = 0;
  let sessionSelectionRequest = 0;

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
        void prepareDraftContext();
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
      const requestId = ++sessionSelectionRequest;
      App.state.activeId = id;
      App.showView('chat');
      window.Sidebar?.render?.(App.state);
      const session = App.state.sessions.find((s) => s.id === id);
      rememberCwd(session?.cwd);
      updateChatHeader();
      syncComposerForSession(session);
      refreshChatOptions(id);
      notifyPanelSession(id);
      window.Chat?.beginLoading?.(id);

      // Profile data is independent from transcript history. Fetch both at
      // once, but let the conversation become usable as soon as its messages
      // arrive instead of keeping the launch splash up for the slower request.
      void window.kimi.getProfile(id).then((profile) => {
        if (App.state.activeId !== id || requestId !== sessionSelectionRequest) return;
        updateContextMeter(profile?.usage);
      }).catch((err) => {
        console.error('getProfile failed', err);
      });

      try {
        const messages = await window.kimi.getMessages(id);
        if (App.state.activeId !== id || requestId !== sessionSelectionRequest) return;
        // Pass the id: chat.js filters WS events by its activeSessionId.
        window.Chat?.renderMessages?.(messages, id);
      } catch (err) {
        console.error('getMessages failed', err);
        if (App.state.activeId === id && requestId === sessionSelectionRequest) {
          window.Chat?.renderLoadError?.(id, err);
        }
      }
    },

    /** Search-result entry point: open a session and jump to a message. */
    async openSessionAtMessage(sessionId, messageId) {
      await App.selectSession(sessionId);
      window.Chat?.scrollToMessage?.(messageId);
    },

    /** Enter draft mode: no active session; one is created lazily on first send. */
    startNewChat() {
      sessionSelectionRequest += 1;
      App.state.activeId = null;
      App.showView('chat');
      window.Sidebar?.render?.(App.state);
      updateChatHeader();
      updateContextMeter(null);
      syncComposerForSession(null);
      refreshChatOptions(null);
      notifyPanelSession(null);
      window.Chat?.renderMessages?.([], null);
      void prepareDraftContext();
      $('#composer')?.focus();
    },

    startSkillDraft(scope = 'project') {
      App.startNewChat();
      const projectOnly = scope === 'project';
      const template = projectOnly
        ? T(
          'skills.ask_template_project',
          '이 프로젝트에서 반복해서 사용할 새 Agent Skill을 만들어 주세요.\n\n' +
          'Skill 목적:\n- [원하는 작업과 결과를 적어 주세요]\n\n' +
          '요구사항:\n- 기존 Skills와 중복되는지 먼저 확인\n' +
          '- .agents/skills/<skill-name>/SKILL.md 형식으로 현재 프로젝트에 추가\n' +
          '- 명확한 이름, 설명, 실행 절차와 안전 조건 포함\n' +
          '- 추가 후 사용 예시와 /skill:<skill-name> 명령 설명',
        )
        : T(
          'skills.ask_template_global',
          '모든 프로젝트에서 반복해서 사용할 새 Agent Skill을 만들어 주세요.\n\n' +
          'Skill 목적:\n- [원하는 작업과 결과를 적어 주세요]\n\n' +
          '요구사항:\n- 기존 Skills와 중복되는지 먼저 확인\n' +
          '- ~/.config/agents/skills/<skill-name>/SKILL.md 형식으로 추가\n' +
          '- 명확한 이름, 설명, 실행 절차와 안전 조건 포함\n' +
          '- 추가 후 사용 예시와 /skill:<skill-name> 명령 설명',
        );
      window.Chat?.setComposerText?.(template);
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
          let cwd = draftCwd || readRecentCwd();
          if (!cwd) {
            cwd = await window.kimi.pickDirectory();
            if (!cwd) return false; // user cancelled the picker
            draftCwd = cwd;
            await loadDraftGitInfo(cwd);
          }
          clearDraftContextError();
          if (
            draftBranch &&
            draftGitInfo?.isRepository &&
            draftBranch !== draftGitInfo.current
          ) {
            const switched = await window.kimi.checkoutGitBranch(cwd, draftBranch);
            draftGitInfo = switched;
          }
          rememberCwd(cwd);
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
        const rawMessage = err?.message || String(err);
        const authRequired = rawMessage.includes('[KIMI_AUTH_REQUIRED]');
        const userMessage = authRequired
          ? T(
            'chat.auth_required',
            'Kimi 로그인이 만료되었습니다. 계정에서 다시 로그인한 뒤 전송해 주세요.',
          )
          : rawMessage
            .replace(/^Error invoking remote method '[^']+':\s*/i, '')
            .replace(/^Error:\s*/i, '');
        if (authRequired) {
          safeCall(() => window.Settings?.open?.('account', {
            notice: T(
              'chat.auth_required',
              'Kimi 로그인이 만료되었습니다. 계정에서 다시 로그인한 뒤 전송해 주세요.',
            ),
          }));
        }
        if (!App.state.activeId) setDraftContextError(userMessage);
        return { ok: false, error: userMessage, authRequired };
      }
    },

    /** Inject a user adjustment into the active turn without starting a new turn. */
    async steer(text) {
      text = String(text ?? '').trim();
      const id = App.state.activeId;
      if (!text || !id || !App.state.serverReady || typeof window.kimi?.steer !== 'function') {
        return false;
      }
      try {
        const result = await window.kimi.steer(id, text);
        scheduleRefreshSessions();
        return result;
      } catch (err) {
        console.error('steer failed', err);
        return false;
      }
    },

    /** Pause delivery while the queued adjustment editor is open. */
    async holdSteer(promptId) {
      const id = App.state.activeId;
      if (!promptId || !id || typeof window.kimi?.holdSteer !== 'function') return false;
      try {
        return await window.kimi.holdSteer(id, promptId);
      } catch (err) {
        console.error('holdSteer failed', err);
        return false;
      }
    },

    /** Resume delivery when queued adjustment editing is cancelled. */
    async resumeSteer(promptId) {
      const id = App.state.activeId;
      if (!promptId || !id || typeof window.kimi?.resumeSteer !== 'function') return false;
      try {
        return await window.kimi.resumeSteer(id, promptId);
      } catch (err) {
        console.error('resumeSteer failed', err);
        return false;
      }
    },

    /** Replace a steering message while it is still waiting for delivery. */
    async updateSteer(promptId, text) {
      text = String(text ?? '').trim();
      const id = App.state.activeId;
      if (
        !text ||
        !promptId ||
        !id ||
        typeof window.kimi?.updateSteer !== 'function'
      ) {
        return false;
      }
      try {
        return await window.kimi.updateSteer(id, promptId, text);
      } catch (err) {
        console.error('updateSteer failed', err);
        return false;
      }
    },

    /** Remove a steering message before the active turn consumes it. */
    async deleteSteer(promptId) {
      const id = App.state.activeId;
      if (!promptId || !id || typeof window.kimi?.deleteSteer !== 'function') return false;
      try {
        return await window.kimi.deleteSteer(id, promptId);
      } catch (err) {
        console.error('deleteSteer failed', err);
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
    setUpdateDot(updateReady, updateVersion, updateStatus);
    updateContextMeter(App.state.contextUsage);
    if (!App.state.activeId) {
      const value = $('#draft-directory-value');
      if (value && !draftCwd) value.textContent = T('workspace.choose_project', '프로젝트 디렉터리 선택');
      setDraftBranchOptions(draftGitInfo, draftBranch);
    }
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

  /* ---- new-chat workspace / Git branch controls ---- */

  function readRecentCwd() {
    try { return localStorage.getItem(LAST_CWD_KEY); } catch (_) { return null; }
  }

  function rememberCwd(cwd) {
    if (typeof cwd !== 'string' || !cwd.trim()) return;
    try { localStorage.setItem(LAST_CWD_KEY, cwd); } catch (_) { /* storage unavailable */ }
  }

  function clearDraftContextError() {
    const error = $('#draft-context-error');
    if (!error) return;
    error.textContent = '';
    error.hidden = true;
  }

  function setDraftContextError(message) {
    const error = $('#draft-context-error');
    if (!error) return;
    error.textContent = String(message || T('workspace.branch_failed', '브랜치를 전환하지 못했습니다.'));
    error.hidden = false;
  }

  function setDraftBranchOptions(info, preferred) {
    const select = $('#draft-branch-select');
    if (!select) return;
    select.textContent = '';
    const branches = Array.isArray(info?.branches) ? info.branches : [];
    const none = document.createElement('option');
    none.value = '';
    none.textContent = T('workspace.none', '없음');
    select.append(none);
    for (const branch of branches) {
      const option = document.createElement('option');
      option.value = branch;
      option.textContent = branch;
      select.append(option);
    }
    const wanted = branches.includes(preferred)
      ? preferred
      : branches.includes(info?.current) ? info.current : '';
    select.value = wanted;
    draftBranch = wanted || null;
    select.disabled = !info?.isRepository || !branches.length;
    select.title = select.disabled
      ? T('workspace.branch_unavailable', '이 프로젝트에는 선택할 브랜치가 없습니다')
      : T('workspace.branch_title', '첫 메시지를 보낼 때 사용할 로컬 브랜치');
  }

  async function loadDraftGitInfo(cwd, preferredBranch) {
    const request = ++draftInfoRequest;
    const select = $('#draft-branch-select');
    if (select) {
      select.textContent = '';
      const loading = document.createElement('option');
      loading.textContent = T('common.loading', '불러오는 중…');
      select.append(loading);
      select.disabled = true;
    }
    let info = { isRepository: false, current: null, branches: [] };
    try {
      if (cwd && typeof window.kimi?.getGitInfo === 'function') {
        info = await window.kimi.getGitInfo(cwd);
      }
    } catch (err) {
      console.warn('getGitInfo failed', err);
    }
    if (request !== draftInfoRequest || App.state.activeId) return;
    draftGitInfo = info;
    setDraftBranchOptions(info, preferredBranch);
  }

  async function prepareDraftContext() {
    const wrap = $('#draft-context');
    if (!wrap || App.state.activeId) return;
    wrap.hidden = false;
    clearDraftContextError();
    draftCwd = readRecentCwd();
    draftBranch = null;
    draftGitInfo = null;
    const value = $('#draft-directory-value');
    if (value) {
      value.textContent = draftCwd || T('workspace.choose_project', '프로젝트 디렉터리 선택');
      value.title = draftCwd || T('workspace.choose_project', '프로젝트 디렉터리 선택');
    }
    await loadDraftGitInfo(draftCwd);
  }

  async function chooseDraftDirectory() {
    if (App.state.activeId) return;
    clearDraftContextError();
    let cwd = null;
    try {
      cwd = await window.kimi.pickDirectory(draftCwd || readRecentCwd());
    } catch (err) {
      setDraftContextError(err?.message || String(err));
      return;
    }
    if (!cwd || App.state.activeId) return;
    draftCwd = cwd;
    draftBranch = null;
    draftGitInfo = null;
    const value = $('#draft-directory-value');
    if (value) {
      value.textContent = cwd;
      value.title = cwd;
    }
    await loadDraftGitInfo(cwd);
  }

  async function updateBranchIndicator(session) {
    const indicator = $('#branch-indicator');
    if (!indicator) return;
    const request = ++branchInfoRequest;
    const draft = !session || !App.state.activeId;
    $('#draft-context').hidden = !draft;
    if (draft) {
      indicator.hidden = true;
      return;
    }

    indicator.hidden = false;
    indicator.classList.add('unavailable');
    indicator.textContent = '';
    const label = document.createElement('span');
    label.className = 'branch-indicator-label';
    label.textContent = T('workspace.branch', '브랜치');
    const value = document.createElement('span');
    value.className = 'branch-indicator-value';
    value.textContent = T('common.loading', '불러오는 중…');
    indicator.append(label, value);

    let info = { isRepository: false, current: null, branches: [] };
    try {
      if (session.cwd && typeof window.kimi?.getGitInfo === 'function') {
        info = await window.kimi.getGitInfo(session.cwd);
      }
    } catch (err) {
      console.warn('getGitInfo failed', err);
    }
    if (request !== branchInfoRequest || App.state.activeId !== session.id) return;
    const branch = info?.current || T('workspace.none', '없음');
    value.textContent = branch;
    indicator.classList.toggle('unavailable', !info?.current);
    indicator.title = info?.current
      ? T('workspace.current_branch', '현재 작업 브랜치') + ': ' + branch
      : T('workspace.branch_unavailable', '이 프로젝트에는 선택할 브랜치가 없습니다');
    indicator.setAttribute(
      'aria-label',
      T('workspace.current_branch', '현재 작업 브랜치') + ': ' + branch,
    );
  }

  /* ---- header / composer helpers ---- */

  function updateChatHeader() {
    const session = App.state.sessions.find((s) => s.id === App.state.activeId);
    $('#chat-title').textContent = session?.title || T('chat.new_chat', '새 대화');
    // The v2 model pill (ChatOptions) owns model display; #model-label is the
    // v1 fallback, kept empty while the pill exists to avoid showing it twice.
    $('#model-label').textContent = window.ChatOptions ? '' : App.state.defaultModel || '';
    void updateBranchIndicator(session);
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

  function setUpdateDot(show, version, status) {
    updateReady = !!show;
    if (version) updateVersion = version;
    if (status) updateStatus = status;
    if (!show) updateStatus = null;
    const dot = $('#settings-update-dot');
    if (dot) dot.hidden = !updateReady;
    const btn = $('#settings-btn');
    if (!btn) return;
    btn.classList.toggle('has-update', updateReady);
    if (!updateReady) {
      btn.title = T('settings.open_title', '설정');
      return;
    }
    const titleKey = updateStatus === 'downloaded'
      ? ['update.ready_title', '업데이트 준비됨. 설정에서 다시 시작하여 적용']
      : ['update.available_title', '새 앱 업데이트가 있습니다'];
    btn.title = T(titleKey[0], titleKey[1]) + (updateVersion ? ` (v${updateVersion})` : '');
  }

  /**
   * Start the one automatic check only after onEvent(handleEvent) is active.
   * The returned snapshot is also dispatched so a custom updater that does
   * not emit Electron events still reaches the prompt and settings indicator.
   */
  async function checkUpdatesOnLaunch() {
    if (
      launchUpdateCheckStarted ||
      typeof window.kimi?.updateCheck !== 'function'
    ) {
      return;
    }
    launchUpdateCheckStarted = true;
    try {
      const result = await window.kimi.updateCheck();
      if (result?.status) handleEvent({ type: 'update', ...result });
    } catch (error) {
      console.warn('automatic update check failed', error);
    }
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
        safeCall(() => window.UpdatePrompt?.handleEvent?.(msg));
        if (['available', 'downloading', 'downloaded'].includes(msg.status)) {
          setUpdateDot(true, msg.version, msg.status);
        } else if (msg.status === 'none') {
          setUpdateDot(false);
        }
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
    $('#draft-directory-btn')?.addEventListener('click', () => void chooseDraftDirectory());
    $('#draft-branch-select')?.addEventListener('change', (event) => {
      draftBranch = event.currentTarget.value || null;
      clearDraftContextError();
    });
    $('#usage-nav-btn').addEventListener('click', () => {
      App.showView(App.state.view === 'usage' ? 'chat' : 'usage');
    });
    $('#skills-btn')?.addEventListener('click', () => {
      safeCall(() => window.Settings?.openSkills?.());
    });
    // NOTE: composer send/steer/abort controls are owned by chat.js
    // (optimistic echo, busy state, autoresize). Binding them here too would
    // double-send.
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
    window.Sidebar?.renderLoading?.();
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
    safeCall(() => window.CliConnectPrompt?.show?.(state));
    // Start after the optional CLI dialog has claimed #modal-root. If an
    // update is available, UpdatePrompt queues behind that existing modal.
    void checkUpdatesOnLaunch();
  }

  void boot();
})();
