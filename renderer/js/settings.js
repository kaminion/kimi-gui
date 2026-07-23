/* settings.js — settings modal (v2).
 * window.Settings = { open(), close(), isOpen(), getDefaultModel() }
 *
 * macOS-Settings-style modal rendered into #settings-root: left section rail,
 * right content. The main sidebar opens Skills as a focused library without
 * the Settings navigation. Settings sections:
 *   일반     — language segment (한국어/English) + theme segment (시스템/다크/라이트)
 *   모델     — default model for NEW sessions (localStorage 'kimi.defaultModel');
 *             App applies it right after createSession via Settings.getDefaultModel()
 *             + v4: 스웜 기본값 toggle (localStorage 'kimi.defaultSwarm', CLI 전용)
 *   엔진     — engine picker (v3): 내장 엔진(direct, 기본) vs Kimi Code CLI(에이전트
 *             모드); switching asks to confirm, then setEngine + location.reload().
 *             Under the CLI card: CLI install status + manual install button with
 *             inline progress (onboarding phase:'install' push events).
 *   계정     — login status dot + re-login (same onboarding APIs as first-run)
 *             + 'Kimi Code Console 열기'
 *   업데이트 — app version, manual update check, live {type:'update'} push events
 *   정보     — CLI path/version (onboardingGetState) + server version (getState)
 * ESC / backdrop click closes. All preload additions are optional — every
 * section degrades gracefully when a window.kimi method is missing.
 * All copy via T() ('settings.*' keys, Korean fallback).
 */
(function () {
  'use strict';

  const T = (k, f) => (window.I18N?.t ? window.I18N.t(k, f) : f);

  const LS_LANG = 'kimi.lang';
  const LS_THEME = 'kimi.theme';
  const LS_DEFAULT_MODEL = 'kimi.defaultModel';
  const LS_DEFAULT_SWARM = 'kimi.defaultSwarm'; // v4: '1' | '0' (스웜 기본값)
  const CONSOLE_URL = 'https://www.kimi.com/code/console';

  let backdropEl = null;      // .modal-backdrop.settings-backdrop while open
  let activeSection = 'general';
  let focusedSkills = false;
  let unsubscribe = null;     // window.kimi.onEvent unsubscribe fn
  let onboardingState = null; // cached onboardingGetState() result
  let appVersion = null;      // cached getAppVersion() result
  let login = null;           // { pending, userCode?, verificationUrl? } while re-login runs
                              // (v4: verificationUrl stores verificationUrlComplete ?? verificationUrl)
  let loginError = null;      // last re-login failure message
  let updateState = null;     // last known { status, version?, message? }
  let engineInfo = null;      // cached getState() { engine, cliInstalled } for the 엔진 section
  let cliInstall = null;      // { running, line } while onboardingInstallCli runs
  let skillsState = null;     // { cwd, loading, data?, error?, busyId?, notice? }
  let skillInstallScope = null;

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
  function lsGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (_) { /* ignore */ } }

  function isOpen() { return !!backdropEl; }

  /* ---- data loaders (defensive: preload additions may be absent or throw) ---- */

  async function loadOnboardingState() {
    if (typeof window.kimi?.onboardingGetState !== 'function') return null;
    try { onboardingState = await window.kimi.onboardingGetState(); }
    catch (err) { console.error('onboardingGetState failed', err); onboardingState = null; }
    return onboardingState;
  }

  async function loadAppVersion() {
    if (typeof window.kimi?.getAppVersion !== 'function') return null;
    try { appVersion = await window.kimi.getAppVersion(); }
    catch (err) { console.error('getAppVersion failed', err); appVersion = null; }
    return appVersion;
  }

  /* ---- shared builders ---- */

  function sections() {
    return [
      { id: 'general', label: T('settings.section.general', '일반') },
      { id: 'model', label: T('settings.section.model', '모델') },
      { id: 'engine', label: T('settings.section.engine', '엔진') },
      { id: 'account', label: T('settings.section.account', '계정') },
      { id: 'updates', label: T('settings.section.updates', '업데이트') },
      { id: 'info', label: T('settings.section.info', '정보') },
    ];
  }

  function buildRow(labelText, control, descText) {
    const row = el('div', 'settings-row');
    const texts = el('div', 'settings-row-texts');
    texts.appendChild(el('div', 'settings-row-label', labelText));
    if (descText) texts.appendChild(el('div', 'settings-row-desc', descText));
    row.append(texts, control);
    return row;
  }

  function buildSegment(options, current, onChange) {
    const seg = el('div', 'settings-segment');
    seg.setAttribute('role', 'group');
    for (const opt of options) {
      const b = el('button', 'settings-segment-btn', opt.label);
      b.type = 'button';
      const active = opt.value === current;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      b.addEventListener('click', () => onChange(opt.value));
      seg.appendChild(b);
    }
    return seg;
  }

  /* ---- section: 일반 (language / theme) ---- */

  function applyLang(lang) {
    lsSet(LS_LANG, lang);
    window.I18N?.setLang?.(lang);
    rerender(); // re-run T() over the whole modal
  }

  function applyTheme(theme) {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    lsSet(LS_THEME, theme);
    rerender();
  }

  function renderGeneral(content) {
    content.appendChild(el('h2', 'settings-section-title', T('settings.section.general', '일반')));

    const lang = lsGet(LS_LANG) || window.I18N?.lang || 'en';
    const langSeg = buildSegment(
      [
        { value: 'ko', label: T('settings.general.lang.ko', '한국어') },
        { value: 'en', label: T('settings.general.lang.en', 'English') },
      ],
      lang,
      applyLang
    );
    content.appendChild(buildRow(T('settings.general.language', '언어'), langSeg));

    const theme = lsGet(LS_THEME) || 'system';
    const themeSeg = buildSegment(
      [
        { value: 'system', label: T('settings.general.theme.system', '시스템') },
        { value: 'dark', label: T('settings.general.theme.dark', '다크') },
        { value: 'light', label: T('settings.general.theme.light', '라이트') },
      ],
      theme,
      applyTheme
    );
    content.appendChild(buildRow(T('settings.general.theme', '테마'), themeSeg));
  }

  /* ---- section: 모델 (default model for new sessions) ---- */

  function getDefaultModel() {
    return lsGet(LS_DEFAULT_MODEL) || window.App?.state?.defaultModel || null;
  }

  function renderModel(content) {
    content.appendChild(el('h2', 'settings-section-title', T('settings.section.model', '모델')));

    const select = document.createElement('select');
    select.className = 'settings-select';
    select.setAttribute('aria-label', T('settings.model.default', '기본 모델'));
    const ph = document.createElement('option');
    ph.textContent = T('settings.model.loading', '불러오는 중…');
    select.appendChild(ph);
    select.disabled = true;
    select.addEventListener('change', () => lsSet(LS_DEFAULT_MODEL, select.value));
    content.appendChild(buildRow(
      T('settings.model.default', '기본 모델'),
      select,
      T('settings.model.desc', '새 대화에 적용되는 모델입니다.')
    ));

    // v4 (R2): swarm default for NEW sessions — app.js applies it right after
    // createSession (CLI engine) and chat-options seeds the pill from it.
    const swarmSeg = buildSegment(
      [
        { value: '1', label: T('settings.swarm_default.on', '켬') },
        { value: '0', label: T('settings.swarm_default.off', '끔') },
      ],
      lsGet(LS_DEFAULT_SWARM) === '1' ? '1' : '0',
      (v) => { lsSet(LS_DEFAULT_SWARM, v); rerender(); }
    );
    content.appendChild(buildRow(
      T('settings.swarm_default', '스웜 기본값'),
      swarmSeg,
      T('settings.swarm_default_desc', '새 대화에 적용 · CLI 에이전트 모드 전용')
    ));

    if (typeof window.kimi?.listModels !== 'function') {
      ph.textContent = T('settings.model.unavailable', '모델 목록을 사용할 수 없습니다');
      return;
    }
    window.kimi.listModels().then((models) => {
      if (!isOpen() || !select.isConnected) return;
      const list = Array.isArray(models) ? models : [];
      select.textContent = '';
      if (!list.length) {
        const none = document.createElement('option');
        none.textContent = T('settings.model.empty', '사용 가능한 모델이 없습니다');
        select.appendChild(none);
        return;
      }
      const current = getDefaultModel();
      for (const m of list) {
        const alias = m?.alias ?? m?.model ?? String(m);
        const opt = document.createElement('option');
        opt.value = alias;
        opt.textContent = alias;
        if (alias === current) opt.selected = true;
        select.appendChild(opt);
      }
      select.disabled = false;
    }).catch((err) => {
      console.error('listModels failed', err);
      if (isOpen() && select.isConnected) {
        ph.textContent = T('settings.model.load_failed', '모델 목록을 불러오지 못했습니다');
      }
    });
  }

  /* ---- section: 엔진 (v3 — 내장 엔진 direct vs Kimi Code CLI 에이전트 모드) ---- */

  async function loadEngineInfo() {
    if (typeof window.kimi?.getState !== 'function') return null;
    try { engineInfo = await window.kimi.getState(); }
    catch (err) { console.error('getState failed', err); engineInfo = null; }
    return engineInfo;
  }

  /** Promise confirm dialog stacked above the settings modal (same .modal
   * classes as the sidebar confirm; cancel is the default focus target). */
  function confirmDialog({ title, body, confirmLabel }) {
    return new Promise((resolve) => {
      const root = document.getElementById('modal-root');
      if (!root) { resolve(false); return; }
      const backdrop = el('div', 'modal-backdrop');
      const modal = el('div', 'modal modal-confirm');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      if (title) modal.appendChild(el('div', 'modal-title', title));
      modal.appendChild(el('div', 'modal-body', body));
      const actions = el('div', 'modal-actions');
      const cancelBtn = el('button', 'btn', T('common.cancel', '취소'));
      cancelBtn.type = 'button';
      const okBtn = el('button', 'btn btn-primary', confirmLabel);
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
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) done(false); });
      cancelBtn.addEventListener('click', () => done(false));
      okBtn.addEventListener('click', () => done(true));
      root.appendChild(backdrop);
      cancelBtn.focus();
    });
  }

  /** Log out: tombstone the shared credentials, then reload into the login gate. */
  async function doLogout() {
    const ok = await confirmDialog({
      title: T('settings.account.logout_title', '로그아웃'),
      body: T(
        'settings.account.logout_confirm',
        '로그아웃하면 다시 로그인할 때까지 Kimi를 사용할 수 없습니다.'
      ),
      confirmLabel: T('settings.account.logout', '로그아웃'),
    });
    if (!ok) return;
    try {
      await window.kimi?.logout?.();
    } catch (err) {
      console.warn('logout failed', err);
    }
    location.reload();
  }

  async function switchEngine(next) {
    if (typeof window.kimi?.setEngine !== 'function') return;
    const ok = await confirmDialog({
      title: T('settings.engine.switch_title', '엔진 전환'),
      body: T('settings.engine.switch_confirm', '전환하면 앱이 다시 시작됩니다.'),
      confirmLabel: T('settings.engine.switch_action', '전환 및 재시작'),
    });
    if (!ok) return;    try { await window.kimi.setEngine(next); }
    catch (err) {
      console.error('setEngine failed', err);
      return;
    }
    location.reload(); // reload so the preload re-evaluates engine capabilities
  }

  function engineCard(id, titleKey, titleFb, descKey, descFb, current) {
    const card = el('button', 'engine-card');
    card.type = 'button';
    card.classList.toggle('current', current);
    card.setAttribute('aria-pressed', current ? 'true' : 'false');
    const texts = el('div', 'engine-card-texts');
    texts.appendChild(el('div', 'engine-card-title', T(titleKey, titleFb)));
    texts.appendChild(el('div', 'engine-card-desc', T(descKey, descFb)));
    card.appendChild(texts);
    if (current) {
      card.appendChild(el('span', 'engine-card-badge', T('settings.engine.current', '사용 중')));
    } else {
      card.addEventListener('click', () => void switchEngine(id));
    }
    return card;
  }

  function renderEngine(content) {
    content.appendChild(el('h2', 'settings-section-title', T('settings.section.engine', '엔진')));
    content.appendChild(el('p', 'settings-engine-desc',
      T('settings.engine.desc', '대화를 처리할 엔진을 선택합니다.')));

    const engine = engineInfo?.engine === 'cli' ? 'cli' : 'direct';
    const cards = el('div', 'engine-cards');
    cards.appendChild(engineCard(
      'direct',
      'settings.engine.direct.title', '내장 엔진',
      'settings.engine.direct.desc', 'CLI 없이 바로 사용 — 기본',
      engine === 'direct'
    ));
    cards.appendChild(engineCard(
      'cli',
      'settings.engine.cli.title', 'Kimi Code CLI',
      'settings.engine.cli.desc', '에이전트 모드 — 스웜 등 고급 기능',
      engine === 'cli'
    ));
    content.appendChild(cards);

    // CLI install status (with path/version when known) + manual installer.
    const cliInstalled = !!(engineInfo?.cliInstalled ?? onboardingState?.cliInstalled);
    const statusText = cliInstalled
      ? T('settings.engine.cli_installed', '설치됨') +
        (onboardingState?.cliPath ? ` — ${onboardingState.cliPath}` : '') +
        (onboardingState?.cliVersion ? ` (${onboardingState.cliVersion})` : '')
      : T('settings.engine.cli_not_installed', '미설치');
    content.appendChild(buildRow(
      T('settings.engine.cli_status', 'CLI 상태'),
      el('span', 'settings-value', statusText)
    ));

    if (cliInstall?.running) {
      content.appendChild(el('p', 'engine-install-progress',
        cliInstall.line || T('settings.engine.cli_installing', '설치 중…')));
    } else {
      const installBtn = el('button', 'btn', T('settings.engine.cli_install', 'CLI 설치'));
      installBtn.type = 'button';
      installBtn.disabled = typeof window.kimi?.onboardingInstallCli !== 'function';
      installBtn.addEventListener('click', () => void installCli());
      content.appendChild(installBtn);
      if (cliInstall?.line) content.appendChild(el('p', 'engine-install-progress', cliInstall.line));
    }

    if (!engineInfo) void loadEngineInfo().then(() => { if (isOpen()) rerender(); });
    if (!onboardingState) void loadOnboardingState().then(() => { if (isOpen()) rerender(); });
  }

  async function installCli() {
    if (cliInstall?.running || typeof window.kimi?.onboardingInstallCli !== 'function') return;
    cliInstall = { running: true, line: T('settings.engine.cli_installing', '설치 중…') };
    rerender();
    try {
      await window.kimi.onboardingInstallCli();
      cliInstall = null;
      await Promise.all([loadOnboardingState(), loadEngineInfo()]);
    } catch (err) {
      console.error('onboardingInstallCli failed', err);
      cliInstall = {
        running: false,
        line: err?.message || T('settings.engine.cli_install_failed', '설치에 실패했습니다'),
      };
    }
    if (isOpen()) rerender();
  }

  function onInstallPush(msg) {
    if (!cliInstall) return; // not our install run
    cliInstall.line = msg.message || T('settings.engine.cli_installing', '설치 중…');
    if (!isOpen()) return;
    const line = backdropEl.querySelector('.engine-install-progress');
    if (line) line.textContent = cliInstall.line;
  }

  /* ---- section: 계정 (login status / re-login / console) ---- */

  function renderAccount(content) {
    content.appendChild(el('h2', 'settings-section-title', T('settings.section.account', '계정')));

    const dot = el('span', 'settings-dot');
    const statusText = el('span', 'settings-status-text', T('settings.account.checking', '확인 중…'));
    const status = el('div', 'settings-account-status');
    status.append(dot, statusText);
    content.appendChild(buildRow(T('settings.account.status', '로그인 상태'), status));

    const btns = el('div', 'settings-btn-row');
    const reloginBtn = el('button', 'btn', T('settings.account.relogin', '다시 로그인'));
    reloginBtn.type = 'button';
    reloginBtn.addEventListener('click', () => void startLogin());
    const consoleBtn = el('button', 'btn btn-ghost', T('settings.account.console', 'Kimi Code Console 열기'));
    consoleBtn.type = 'button';
    consoleBtn.addEventListener('click', () => { window.kimi?.openExternal?.(CONSOLE_URL); });
    const logoutBtn = el('button', 'btn btn-ghost danger', T('settings.account.logout', '로그아웃'));
    logoutBtn.type = 'button';
    logoutBtn.addEventListener('click', () => void doLogout());
    btns.append(reloginBtn, consoleBtn, logoutBtn);
    content.appendChild(btns);

    const loginArea = el('div', 'settings-login');
    content.appendChild(loginArea);
    renderLoginArea(loginArea);

    applyLoginStatus(dot, statusText);
    if (typeof window.kimi?.onboardingGetState === 'function' && !onboardingState) {
      statusText.textContent = T('settings.account.checking', '확인 중…');
    }
    void loadOnboardingState().then(() => {
      if (isOpen() && statusText.isConnected) applyLoginStatus(dot, statusText);
    });
  }

  function applyLoginStatus(dot, statusText) {
    if (typeof window.kimi?.onboardingGetState !== 'function') {
      dot.className = 'settings-dot';
      statusText.textContent = T('settings.account.unknown', '확인할 수 없음');
      return;
    }
    const loggedIn = !!onboardingState?.loggedIn;
    dot.className = `settings-dot ${loggedIn ? 'ok' : 'err'}`;
    statusText.textContent = loggedIn
      ? T('settings.account.logged_in', '로그인됨')
      : T('settings.account.login_required', '로그인 필요');
  }

  async function startLogin() {
    if (login?.pending) return;
    loginError = null;
    if (typeof window.kimi?.onboardingStartLogin !== 'function') {
      loginError = T('settings.account.login_unavailable', '로그인 기능을 사용할 수 없습니다');
      rerender();
      return;
    }
    login = { pending: true, userCode: null, verificationUrl: null };
    rerender();
    try {
      const res = await window.kimi.onboardingStartLogin();
      if (!login) return; // cancelled meanwhile
      login.userCode = res?.userCode ?? null;
      // v4 (R2): the device page requires ?user_code= — prefer the complete
      // URL; renderLoginArea's openExternal uses this stored value.
      login.verificationUrl = res?.verificationUrlComplete ?? res?.verificationUrl ?? null;
      rerender();
    } catch (err) {
      console.error('onboardingStartLogin failed', err);
      login = null;
      loginError = err?.message || T('settings.account.login_failed', '로그인에 실패했습니다');
      rerender();
    }
  }

  async function cancelLogin() {
    try { await window.kimi?.onboardingCancelLogin?.(); } catch (_) { /* ignore */ }
    login = null;
    loginError = null;
    rerender();
  }

  function renderLoginArea(area) {
    area.textContent = '';
    if (loginError) area.appendChild(el('p', 'settings-login-error', loginError));
    if (!login) return;
    if (!login.userCode) {
      area.appendChild(el('p', 'settings-login-hint', T('settings.account.preparing', '로그인 준비 중…')));
      return;
    }
    area.appendChild(el('p', 'settings-login-hint',
      T('settings.account.login_hint', '브라우저가 열리면 아래 코드를 입력하세요.')));
    area.appendChild(el('code', 'settings-login-code', login.userCode));
    const row = el('div', 'settings-btn-row');
    if (login.verificationUrl) {
      const openBtn = el('button', 'btn btn-primary', T('settings.account.open_browser', '브라우저에서 인증'));
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => { window.kimi?.openExternal?.(login.verificationUrl); });
      row.appendChild(openBtn);
    }
    const cancelBtn = el('button', 'btn btn-ghost', T('settings.account.cancel_login', '취소'));
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => void cancelLogin());
    row.appendChild(cancelBtn);
    area.appendChild(row);
    area.appendChild(el('p', 'settings-login-waiting', T('settings.account.waiting', '인증 대기 중…')));
  }

  function onLoginPush(msg) {
    if (msg.status === 'done') {
      login = null;
      loginError = null;
      void Promise.resolve(window.kimi?.bootstrapRetry?.())
        .catch((error) => {
          console.warn('bootstrapRetry after login failed', error);
        })
        .then(() => loadOnboardingState())
        .then(() => {
          void window.App?.refreshSessions?.();
          if (isOpen()) rerender();
        });
    } else if (msg.status === 'error') {
      if (!login) return; // not our flow
      login = null;
      loginError = msg.message || T('settings.account.login_failed', '로그인에 실패했습니다');
      rerender();
    }
  }

  /* ---- section: 업데이트 ---- */

  function updateStatusText(s) {
    switch (s?.status) {
      case 'dev':
        return T('settings.update.status.dev', '개발 빌드입니다');
      case 'checking':
        return T('settings.update.status.checking', '확인 중…');
      case 'available':
        return s.version
          ? T('settings.update.status.available', '새 버전') +
            ` v${s.version}` +
            T('settings.update.status.available_suffix', ' 사용 가능')
          : T('settings.update.status.available_unknown', '새 버전을 사용할 수 있습니다');
      case 'downloading':
        return s.version
          ? T('settings.update.status.downloading', '새 버전') +
            ` v${s.version}` +
            T('settings.update.status.downloading_suffix', ' 다운로드 중…')
          : T('settings.update.status.downloading_unknown', '새 버전 다운로드 중…');
      case 'downloaded':
        return s.version
          ? T('settings.update.status.downloaded', '새 버전') +
            ` v${s.version}` +
            T('settings.update.status.downloaded_suffix', ' 설치 준비 완료')
          : T('settings.update.status.downloaded_unknown', '설치 준비 완료');
      case 'none':
        return T('settings.update.status.none', '최신입니다');
      case 'error':
        return s.message || T('settings.update.status.error', '업데이트 확인에 실패했습니다');
      default:
        return '';
    }
  }

  function renderUpdateStatus(statusEl, restartBtn) {
    if (statusEl) statusEl.textContent = updateStatusText(updateState);
    if (restartBtn) {
      restartBtn.hidden = !(
        updateState?.status === 'downloaded' &&
        typeof window.kimi?.updateQuitAndInstall === 'function'
      );
    }
  }

  function applyUpdateState(s) {
    updateState = s ?? null;
    if (!isOpen()) return;
    renderUpdateStatus(
      backdropEl.querySelector('.settings-update-status'),
      backdropEl.querySelector('.settings-update-restart')
    );
  }

  async function checkUpdates() {
    if (typeof window.kimi?.updateCheck !== 'function') {
      applyUpdateState({ status: 'dev' });
      return;
    }
    applyUpdateState({ status: 'checking' });
    try {
      applyUpdateState(await window.kimi.updateCheck());
    } catch (err) {
      console.error('updateCheck failed', err);
      applyUpdateState({ status: 'error', message: err?.message });
    }
  }

  function renderUpdates(content) {
    content.appendChild(el('h2', 'settings-section-title', T('settings.section.updates', '업데이트')));

    const versionVal = el('span', 'settings-value', appVersion ? `v${appVersion}` : '—');
    content.appendChild(buildRow(T('settings.update.current_version', '현재 버전'), versionVal));
    if (!appVersion) {
      void loadAppVersion().then(() => {
        if (isOpen() && versionVal.isConnected) {
          versionVal.textContent = appVersion ? `v${appVersion}` : '—';
        }
      });
    }

    const checkBtn = el('button', 'btn', T('settings.update.check', '업데이트 확인'));
    checkBtn.type = 'button';
    checkBtn.addEventListener('click', () => void checkUpdates());
    const statusEl = el('span', 'settings-update-status settings-value');
    const controls = el('div', 'settings-update-controls');
    controls.append(checkBtn, statusEl);
    content.appendChild(buildRow(T('settings.update.row_label', '앱 업데이트'), controls));

    const restartBtn = el('button', 'btn btn-primary settings-update-restart',
      T('settings.update.restart', '재시작 및 설치'));
    restartBtn.type = 'button';
    restartBtn.addEventListener('click', () => {
      try { window.kimi?.updateQuitAndInstall?.(); } catch (_) { /* ignore */ }
    });
    content.appendChild(restartBtn);
    renderUpdateStatus(statusEl, restartBtn);
  }

  /* ---- section: Agent Skills ---- */

  function activeSkillCwd() {
    const app = window.App;
    const active = app?.state?.sessions?.find?.((session) => session.id === app.state.activeId);
    if (active?.cwd) return active.cwd;
    return lsGet('kimi.lastCwd') || null;
  }

  function skillScopeLabel(scope) {
    return scope === 'project'
      ? T('settings.skills.scope_project', '프로젝트')
      : T('settings.skills.scope_user', '사용자');
  }

  function skillFamilyLabel(family) {
    if (family === 'agents') return 'Agents';
    if (family === 'agents-legacy') return 'Agents legacy';
    return family ? family.charAt(0).toUpperCase() + family.slice(1) : '';
  }

  function startSkillsLoad(cwd, { keepNotice = false } = {}) {
    if (typeof window.kimi?.skillsList !== 'function') {
      skillsState = {
        cwd,
        loading: false,
        error: T('settings.skills.unavailable', 'Skills 관리 기능을 사용할 수 없습니다.'),
      };
      rerender();
      return;
    }
    const notice = keepNotice ? skillsState?.notice : null;
    skillsState = { cwd, loading: true, notice };
    window.kimi.skillsList({ cwd }).then((data) => {
      if (!isOpen() || activeSection !== 'skills' || skillsState?.cwd !== cwd) return;
      skillsState = { cwd, loading: false, data, notice };
      if (!skillInstallScope) skillInstallScope = data?.projectRoot ? 'project' : 'user';
      if (!data?.projectRoot && skillInstallScope === 'project') skillInstallScope = 'user';
      rerender();
    }).catch((error) => {
      if (!isOpen() || activeSection !== 'skills' || skillsState?.cwd !== cwd) return;
      skillsState = {
        cwd,
        loading: false,
        error: error?.message || String(error),
        notice,
      };
      rerender();
    });
  }

  async function addSkill(kind) {
    if (typeof window.kimi?.skillsAdd !== 'function' || skillsState?.busyId) return;
    const cwd = activeSkillCwd();
    skillsState = { ...skillsState, busyId: 'add', error: null, notice: null };
    rerender();
    try {
      const result = await window.kimi.skillsAdd({
        kind,
        scope: skillInstallScope,
        cwd,
      });
      if (result?.cancelled) {
        skillsState = { ...skillsState, busyId: null };
        rerender();
        return;
      }
      skillsState.notice = T('settings.skills.added', 'Skill을 추가했습니다.');
      startSkillsLoad(cwd, { keepNotice: true });
    } catch (error) {
      skillsState = {
        ...skillsState,
        busyId: null,
        error: error?.message || String(error),
      };
      rerender();
    }
  }

  async function setSkillEnabled(skill, enabled) {
    if (!skill?.id || skillsState?.busyId || typeof window.kimi?.skillsSetEnabled !== 'function') return;
    const cwd = activeSkillCwd();
    skillsState = { ...skillsState, busyId: skill.id, error: null, notice: null };
    rerender();
    try {
      await window.kimi.skillsSetEnabled({ id: skill.id, enabled, cwd });
      skillsState.notice = enabled
        ? T('settings.skills.enabled_notice', 'Skill을 활성화했습니다.')
        : T('settings.skills.disabled_notice', 'Skill을 비활성화했습니다.');
      startSkillsLoad(cwd, { keepNotice: true });
    } catch (error) {
      skillsState = {
        ...skillsState,
        busyId: null,
        error: error?.message || String(error),
      };
      rerender();
    }
  }

  async function removeSkill(skill) {
    if (!skill?.id || skillsState?.busyId || typeof window.kimi?.skillsRemove !== 'function') return;
    const ok = await confirmDialog({
      title: T('settings.skills.remove_title', 'Skill 삭제'),
      body: T(
        'settings.skills.remove_confirm',
        '이 Skill을 휴지통으로 이동할까요? 휴지통에서 복구할 수 있습니다.'
      ),
      confirmLabel: T('settings.skills.remove', '휴지통으로 이동'),
    });
    if (!ok) return;
    const cwd = activeSkillCwd();
    skillsState = { ...skillsState, busyId: skill.id, error: null, notice: null };
    rerender();
    try {
      await window.kimi.skillsRemove({ id: skill.id, cwd });
      skillsState.notice = T('settings.skills.removed_notice', 'Skill을 휴지통으로 이동했습니다.');
      startSkillsLoad(cwd, { keepNotice: true });
    } catch (error) {
      skillsState = {
        ...skillsState,
        busyId: null,
        error: error?.message || String(error),
      };
      rerender();
    }
  }

  function renderSkillsLoading(content) {
    const loading = el('div', 'skills-loading');
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-label', T('settings.skills.loading', 'Skills 불러오는 중…'));
    for (let i = 0; i < 3; i += 1) {
      const row = el('div', 'skill-row skill-row-skeleton');
      row.append(el('span', 'skill-skeleton-name'), el('span', 'skill-skeleton-line'));
      loading.appendChild(row);
    }
    content.appendChild(loading);
  }

  function renderSkillRow(skill) {
    const row = el('div', 'skill-row');
    row.classList.toggle('disabled', !skill.enabled);

    const main = el('div', 'skill-main');
    const title = el('div', 'skill-title-row');
    title.appendChild(el('span', 'skill-name', skill.name));
    title.appendChild(el('span', 'skill-badge', skillScopeLabel(skill.scope)));
    if (skill.type === 'flow') title.appendChild(el('span', 'skill-badge', 'Flow'));
    const description = el('div', 'skill-description', skill.description);
    const pathLine = el('div', 'skill-path', `${skillFamilyLabel(skill.family)} · ${skill.path}`);
    pathLine.title = skill.path;
    main.append(title, description, pathLine);

    const actions = el('div', 'skill-actions');
    const toggle = el(
      'button',
      `skill-toggle${skill.enabled ? ' on' : ''}`,
      skill.enabled
        ? T('settings.skills.enabled', '활성')
        : T('settings.skills.disabled', '비활성')
    );
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', skill.enabled ? 'true' : 'false');
    toggle.setAttribute(
      'aria-label',
      skill.enabled
        ? T('settings.skills.disable_aria', 'Skill 비활성화')
        : T('settings.skills.enable_aria', 'Skill 활성화')
    );
    toggle.disabled = !!skillsState?.busyId;
    toggle.addEventListener('click', () => void setSkillEnabled(skill, !skill.enabled));

    const remove = el('button', 'skill-remove', T('settings.skills.remove_short', '삭제'));
    remove.type = 'button';
    remove.disabled = !!skillsState?.busyId;
    remove.addEventListener('click', () => void removeSkill(skill));
    actions.append(toggle, remove);
    row.append(main, actions);
    return row;
  }

  function renderSkills(content) {
    content.appendChild(el('h2', 'settings-section-title', T('settings.section.skills', 'Skills')));
    content.appendChild(el(
      'p',
      'settings-section-lede',
      T(
        'settings.skills.desc',
        'Kimi Code가 프로젝트 규칙과 작업 절차를 불러올 수 있도록 Agent Skills를 관리합니다.'
      )
    ));

    const cwd = activeSkillCwd();
    if (!skillsState || skillsState.cwd !== cwd) {
      queueMicrotask(() => startSkillsLoad(cwd));
      renderSkillsLoading(content);
      return;
    }

    const toolbar = el('div', 'skills-toolbar');
    const availability = el('label', 'skills-availability');
    availability.appendChild(el(
      'span',
      'skills-availability-label',
      T('settings.skills.install_scope', '사용 범위'),
    ));
    const scope = document.createElement('select');
    scope.className = 'settings-select skills-scope';
    scope.setAttribute('aria-label', T('settings.skills.install_scope', '사용 범위'));
    const user = document.createElement('option');
    user.value = 'user';
    user.textContent = T('settings.skills.scope_user', '모든 프로젝트');
    const project = document.createElement('option');
    project.value = 'project';
    project.textContent = T('settings.skills.scope_project', '현재 프로젝트');
    project.disabled = !skillsState.data?.projectRoot;
    scope.append(user, project);
    scope.value = project.disabled ? 'user' : skillInstallScope;
    scope.addEventListener('change', () => { skillInstallScope = scope.value; });
    availability.appendChild(scope);

    const askBtn = el(
      'button',
      'btn btn-primary skills-ask-kimi',
      T('settings.skills.ask_kimi', 'Kimi에게 추가 부탁하기'),
    );
    askBtn.type = 'button';
    askBtn.addEventListener('click', () => {
      const selectedScope = skillInstallScope || (skillsState.data?.projectRoot ? 'project' : 'user');
      close();
      window.App?.startSkillDraft?.(selectedScope);
    });
    const folderBtn = el('button', 'btn', T('settings.skills.add_folder', '폴더 추가'));
    folderBtn.type = 'button';
    folderBtn.disabled = !!skillsState.busyId;
    folderBtn.addEventListener('click', () => void addSkill('directory'));
    const fileBtn = el('button', 'btn', T('settings.skills.add_file', 'Markdown 추가'));
    fileBtn.type = 'button';
    fileBtn.disabled = !!skillsState.busyId;
    fileBtn.addEventListener('click', () => void addSkill('file'));
    const toolbarActions = el('div', 'skills-toolbar-actions');
    toolbarActions.append(askBtn, folderBtn, fileBtn);
    toolbar.append(availability, toolbarActions);
    content.appendChild(toolbar);

    if (skillsState.notice) {
      const notice = el('div', 'skills-notice', skillsState.notice);
      notice.setAttribute('role', 'status');
      content.appendChild(notice);
    }
    if (skillsState.error) {
      const error = el('div', 'skills-error', skillsState.error);
      error.setAttribute('role', 'alert');
      content.appendChild(error);
    }
    if (skillsState.loading) {
      renderSkillsLoading(content);
      return;
    }

    const list = Array.isArray(skillsState.data?.skills) ? skillsState.data.skills : [];
    if (!list.length) {
      const empty = el('div', 'skills-empty');
      empty.append(
        el('div', 'skills-empty-title', T('settings.skills.empty_title', '추가된 Skills가 없습니다')),
        el(
          'div',
          'skills-empty-desc',
          T(
            'settings.skills.empty_desc',
            'SKILL.md가 있는 폴더나 단일 Markdown Skill을 추가해 보세요.'
          )
        )
      );
      content.appendChild(empty);
    } else {
      const listEl = el('div', 'skills-list');
      for (const skill of list) listEl.appendChild(renderSkillRow(skill));
      content.appendChild(listEl);
    }

    content.appendChild(el(
      'p',
      'skills-footnote',
      T(
        'settings.skills.reload_hint',
        '변경사항은 새 대화에서 확실하게 반영됩니다. 삭제한 Skill은 운영체제 휴지통에서 복구할 수 있습니다.'
      )
    ));
  }

  /* ---- section: 정보 ---- */

  function renderInfo(content) {
    content.appendChild(el('h2', 'settings-section-title', T('settings.section.info', '정보')));

    const cliPathVal = el('span', 'settings-value', '—');
    const cliVerVal = el('span', 'settings-value', '—');
    const srvVerVal = el('span', 'settings-value', window.App?.state?.version || '—');
    content.appendChild(buildRow(T('settings.info.cli_path', 'CLI 경로'), cliPathVal));
    content.appendChild(buildRow(T('settings.info.cli_version', 'CLI 버전'), cliVerVal));
    content.appendChild(buildRow(T('settings.info.server_version', '서버 버전'), srvVerVal));

    void loadOnboardingState().then(() => {
      if (!isOpen() || !cliPathVal.isConnected) return;
      cliPathVal.textContent = onboardingState?.cliPath || T('settings.info.not_found', '찾을 수 없음');
      cliPathVal.title = onboardingState?.cliPath || '';
      cliVerVal.textContent = onboardingState?.cliVersion || '—';
    });
    if (!window.App?.state?.version && typeof window.kimi?.getState === 'function') {
      window.kimi.getState().then((st) => {
        if (isOpen() && srvVerVal.isConnected) srvVerVal.textContent = st?.version || '—';
      }).catch(() => { /* ignore */ });
    }
  }

  /* ---- render plumbing ---- */

  function renderNav(nav) {
    nav.textContent = '';
    for (const s of sections()) {
      const b = el('button', 'settings-nav-item', s.label);
      b.type = 'button';
      b.classList.toggle('active', s.id === activeSection);
      b.addEventListener('click', () => {
        if (activeSection === s.id) return;
        activeSection = s.id;
        rerender();
      });
      nav.appendChild(b);
    }
  }

  function renderSection(content) {
    content.textContent = '';
    switch (activeSection) {
      case 'model': renderModel(content); break;
      case 'skills': renderSkills(content); break;
      case 'engine': renderEngine(content); break;
      case 'account': renderAccount(content); break;
      case 'updates': renderUpdates(content); break;
      case 'info': renderInfo(content); break;
      default: renderGeneral(content); break;
    }
  }

  function rerender() {
    if (!backdropEl) return;
    const nav = backdropEl.querySelector('.settings-nav');
    if (nav) renderNav(nav);
    renderSection(backdropEl.querySelector('.settings-content'));
  }

  /* ---- push events (update + login completion) while open ---- */

  function subscribeEvents() {
    if (typeof window.kimi?.onEvent !== 'function') return;
    unsubscribe = window.kimi.onEvent((msg) => {
      if (!isOpen() || !msg || typeof msg !== 'object') return;
      if (msg.type === 'update') applyUpdateState(msg);
      else if (msg.type === 'onboarding' && msg.phase === 'login') onLoginPush(msg);
      else if (msg.type === 'onboarding' && msg.phase === 'install') onInstallPush(msg);
    });
  }

  /* ---- public API ---- */

  function open(section, options = {}) {
    if (backdropEl) return;
    const root = document.getElementById('settings-root');
    if (!root) return;
    if (section === 'skills' || sections().some((item) => item.id === section)) {
      activeSection = section;
    }
    focusedSkills = section === 'skills' && options.focused === true;
    if (activeSection === 'account' && options.notice) {
      loginError = String(options.notice);
    }

    backdropEl = el('div', 'modal-backdrop settings-backdrop');
    const modal = el('div', `settings-modal${focusedSkills ? ' skills-library-modal' : ''}`);
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute(
      'aria-label',
      focusedSkills
        ? T('skills.manager_title', 'Skills 관리')
        : T('settings.title', '설정'),
    );
    const content = el('div', 'settings-content');
    let nav = null;
    if (focusedSkills) {
      const header = el('div', 'skills-library-header');
      header.appendChild(el(
        'h1',
        'skills-library-title',
        T('skills.manager_title', 'Skills 관리'),
      ));
      const closeBtn = el('button', 'skills-library-close', '×');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', T('common.close', '닫기'));
      closeBtn.addEventListener('click', close);
      header.appendChild(closeBtn);
      modal.append(header, content);
    } else {
      nav = el('nav', 'settings-nav');
      modal.append(nav, content);
    }
    backdropEl.appendChild(modal);
    backdropEl.addEventListener('mousedown', (e) => { if (e.target === backdropEl) close(); });
    root.appendChild(backdropEl);
    document.addEventListener('keydown', onKeydown, true);
    subscribeEvents();
    if (nav) renderNav(nav);
    renderSection(content);
    // Warm the caches so 계정/정보/업데이트 render promptly when opened.
    void loadOnboardingState();
    void loadAppVersion();
  }

  function close() {
    if (!backdropEl) return;
    if (login?.pending) {
      try { window.kimi?.onboardingCancelLogin?.(); } catch (_) { /* ignore */ }
    }
    login = null;
    if (unsubscribe) { try { unsubscribe(); } catch (_) { /* ignore */ } unsubscribe = null; }
    document.removeEventListener('keydown', onKeydown, true);
    backdropEl.remove();
    backdropEl = null;
    if (focusedSkills) activeSection = 'general';
    focusedSkills = false;
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      if (activeSection === 'skills' && skillsState?.busyId) return;
      e.stopPropagation();
      close();
    }
  }

  function openSkills() {
    open('skills', { focused: true });
  }

  window.Settings = { open, openSkills, close, isOpen, getDefaultModel };
})();
