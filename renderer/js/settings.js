/* settings.js — settings modal (v2).
 * window.Settings = { open(), close(), isOpen(), getDefaultModel() }
 *
 * macOS-Settings-style modal rendered into #settings-root: left section rail,
 * right content. Sections:
 *   일반     — language segment (한국어/English) + theme segment (시스템/다크/라이트)
 *   모델     — default model for NEW sessions (localStorage 'kimi.defaultModel');
 *             App applies it right after createSession via Settings.getDefaultModel()
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
  const CONSOLE_URL = 'https://www.kimi.com/code/console';

  let backdropEl = null;      // .modal-backdrop.settings-backdrop while open
  let activeSection = 'general';
  let unsubscribe = null;     // window.kimi.onEvent unsubscribe fn
  let onboardingState = null; // cached onboardingGetState() result
  let appVersion = null;      // cached getAppVersion() result
  let login = null;           // { pending, userCode?, verificationUrl? } while re-login runs
  let loginError = null;      // last re-login failure message
  let updateState = null;     // last known { status, version?, message? }
  let engineInfo = null;      // cached getState() { engine, cliInstalled } for the 엔진 section
  let cliInstall = null;      // { running, line } while onboardingInstallCli runs

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

    const lang = lsGet(LS_LANG) || window.I18N?.lang || 'ko';
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

  async function switchEngine(next) {
    if (typeof window.kimi?.setEngine !== 'function') return;
    const ok = await confirmDialog({
      title: T('settings.engine.switch_title', '엔진 전환'),
      body: T('settings.engine.switch_confirm', '전환하면 앱이 다시 시작됩니다.'),
      confirmLabel: T('settings.engine.switch_action', '전환 및 재시작'),
    });
    if (!ok) return;
    try { await window.kimi.setEngine(next); }
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
    btns.append(reloginBtn, consoleBtn);
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
      login.verificationUrl = res?.verificationUrl ?? null;
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
      void loadOnboardingState().then(() => { if (isOpen()) rerender(); });
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
      case 'engine': renderEngine(content); break;
      case 'account': renderAccount(content); break;
      case 'updates': renderUpdates(content); break;
      case 'info': renderInfo(content); break;
      default: renderGeneral(content); break;
    }
  }

  function rerender() {
    if (!backdropEl) return;
    renderNav(backdropEl.querySelector('.settings-nav'));
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

  function open() {
    if (backdropEl) return;
    const root = document.getElementById('settings-root');
    if (!root) return;

    backdropEl = el('div', 'modal-backdrop settings-backdrop');
    const modal = el('div', 'settings-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', T('settings.title', '설정'));
    const nav = el('nav', 'settings-nav');
    const content = el('div', 'settings-content');
    modal.append(nav, content);
    backdropEl.appendChild(modal);
    backdropEl.addEventListener('mousedown', (e) => { if (e.target === backdropEl) close(); });
    root.appendChild(backdropEl);
    document.addEventListener('keydown', onKeydown, true);
    subscribeEvents();
    renderNav(nav);
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
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }

  window.Settings = { open, close, isOpen, getDefaultModel };
})();
