/* onboarding.js — splash + first-run onboarding flow (R4, v3).
 * Exposes window.Onboarding.init(launchApp); the shell (R6) calls it at boot
 * with the v1 boot sequence as `launchApp`.
 *
 * v3 gate (CONTRACT-V3): the app runs CLI-free (direct engine), so the ONLY
 * first-run gate is login — flow = splash → login card (when needsOnboarding)
 * → app. needsOnboarding is purely "not logged in" and engine-independent.
 * The v2 CLI-install step is gone from the gate: the preload still exports
 * window.kimi.onboardingInstallCli, but the settings engine section owns it
 * now — it is never offered or called from here.
 *
 * Defensive for both gate shapes: v3 main returns { needsOnboarding } while a
 * v2 main could still attach { cliInstalled, loggedIn } — a state that says
 * loggedIn === true never gates, whatever else it carries.
 *
 * Drives the shell-owned contract DOM (CONTRACT-V2, ids fixed):
 *   #splash > #splash-logo + #splash-word
 *   #onboarding > #onboarding-card: #onboarding-logo, #onboarding-title,
 *   #onboarding-desc, #onboarding-progress (.progress-bar>div +
 *   #onboarding-progress-label), #onboarding-login (#login-code,
 *   #login-url-btn, #login-status), #onboarding-primary-btn,
 *   #onboarding-secondary-btn
 *
 * Preload APIs used (window.kimi, M1): onboardingGetState,
 * onboardingStartLogin, onboardingCancelLogin, bootstrapRetry, openExternal,
 * onEvent. Push events:
 *   { type:'onboarding', phase:'login', status:'done'|'error', message? }
 * Every API is called defensively: when the preload surface is incomplete the
 * flow degrades to "skip onboarding" (v1 behavior) instead of trapping the
 * user on the card.
 */
(function () {
  'use strict';

  const T = (k, f) => (window.I18N?.t ? window.I18N.t(k, f) : f);

  // Splash timing (ms): logo fade/scale-in 600 (word +100/500), hold 300,
  // slide-down + fade-out 350. Easing lives in onboarding.css.
  const SPLASH_ANIM_MS = 600;
  const SPLASH_HOLD_MS = 300;
  const SPLASH_OUT_MS = 350;
  const CHECK_MS = 600; // login-success checkmark draw

  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let started = false;        // init() runs at most once
  let launchAppFn = null;
  let unsubEvents = null;     // window.kimi.onEvent unsubscribe
  let pendingAction = null;   // resolve fn for the action the flow awaits
  let loginActive = false;    // a device-flow login is believed to be in flight
  let flashTimer = null;      // login-status "copied" flash timer
  let buttonsWired = false;
  let lastStepUI = null;      // thunk re-rendering the current step (language change)

  /* ---- tiny plumbing ------------------------------------------------------- */

  function reducedMotion() {
    try {
      return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  // Button clicks and login push events both funnel into the awaiting step
  // loop. Actions fired while nothing awaits are dropped on purpose.
  function wake(action) {
    const resolve = pendingAction;
    pendingAction = null;
    if (resolve) resolve(action);
  }

  function nextAction() {
    return new Promise((resolve) => { pendingAction = resolve; });
  }

  // Kimi chevron mark (assets/icon.svg concept, minus the black rounded
  // square — the splash overlay already is true black).
  function logoSvg(size) {
    return (
      `<svg width="${size}" height="${size}" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">` +
      '<path d="M376 352 L552 512 L376 672" fill="none" stroke="currentColor" stroke-width="88" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<rect x="608" y="612" width="128" height="80" rx="16" fill="#0a84ff"/>' +
      '</svg>'
    );
  }

  function checkSvg() {
    return (
      '<svg viewBox="0 0 52 52" aria-hidden="true" focusable="false">' +
      '<circle class="check-circle" cx="26" cy="26" r="24" fill="none"/>' +
      '<path class="check-mark" fill="none" d="M15 27l7.5 7.5L37 20"/>' +
      '</svg>'
    );
  }

  function openExternal(url) {
    if (!url) return;
    try { window.kimi?.openExternal?.(url); } catch (err) { console.warn('openExternal failed', err); }
  }

  /* ---- splash (every launch) ----------------------------------------------- */

  async function playSplash() {
    const splash = $('splash');
    if (!splash || splash.hidden) return;
    const logo = $('splash-logo');
    if (logo && !logo.firstChild) logo.innerHTML = logoSvg(72);
    const word = $('splash-word');
    if (word && !word.textContent.trim()) word.textContent = 'Kimi';
    if (reducedMotion()) { splash.hidden = true; return; } // instant swap
    void splash.offsetWidth; // commit initial styles so the transitions run
    splash.classList.add('on');
    await wait(SPLASH_ANIM_MS + SPLASH_HOLD_MS);
    splash.classList.add('out');
    await wait(SPLASH_OUT_MS);
    splash.hidden = true;
    splash.classList.remove('on', 'out');
  }

  /* ---- state + step scaffolding --------------------------------------------- */

  // Never rejects: null means "cannot determine" -> skip onboarding entirely.
  async function getOnboardingState() {
    try {
      if (!window.kimi || typeof window.kimi.onboardingGetState !== 'function') return null;
      const state = await window.kimi.onboardingGetState();
      return state && typeof state === 'object' ? state : null;
    } catch (err) {
      console.warn('onboardingGetState failed', err);
      return null;
    }
  }

  function showOnboarding() {
    const root = $('onboarding');
    if (!root || !$('onboarding-card')) return false; // contract DOM missing
    const logo = $('onboarding-logo');
    if (logo && !logo.firstChild) logo.innerHTML = logoSvg(44);
    if (!unsubEvents && typeof window.kimi?.onEvent === 'function') {
      try { unsubEvents = window.kimi.onEvent(handleKimiEvent); } catch { unsubEvents = null; }
    }
    wireButtons();
    root.hidden = false;
    return true;
  }

  function wireButtons() {
    if (buttonsWired) return;
    buttonsWired = true;
    $('onboarding-primary-btn')?.addEventListener('click', () => wake({ type: 'primary' }));
    $('onboarding-secondary-btn')?.addEventListener('click', () => wake({ type: 'secondary' }));
    const code = $('login-code');
    code?.addEventListener('click', () => void copyLoginCode());
    code?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void copyLoginCode(); }
    });
    $('login-url-btn')?.addEventListener('click', (e) => openExternal(e.currentTarget.dataset.url));
  }

  function handleKimiEvent(msg) {
    if (!msg || msg.type !== 'onboarding') return;
    if (msg.phase !== 'login') return; // v3: login is the only gated phase
    if (msg.status === 'done') wake({ type: 'login-done' });
    else if (msg.status === 'error') wake({ type: 'login-error', message: msg.message });
  }

  // One place to re-render the card: title/desc, the two action buttons, and
  // which of the progress/login blocks is visible.
  function setStepUI({ title, desc, descError, primary, primaryDisabled, secondary, showProgress, showLogin }) {
    const titleEl = $('onboarding-title');
    if (titleEl) titleEl.textContent = title || '';
    const descEl = $('onboarding-desc');
    if (descEl) {
      descEl.textContent = desc || '';
      descEl.classList.toggle('error', !!descError);
    }
    const primaryBtn = $('onboarding-primary-btn');
    if (primaryBtn) {
      primaryBtn.hidden = !primary;
      if (primary) primaryBtn.textContent = primary;
      primaryBtn.disabled = !!primaryDisabled;
    }
    const secondaryBtn = $('onboarding-secondary-btn');
    if (secondaryBtn) {
      secondaryBtn.hidden = !secondary;
      if (secondary) secondaryBtn.textContent = secondary;
      secondaryBtn.disabled = false;
    }
    const progress = $('onboarding-progress');
    if (progress) progress.hidden = !showProgress;
    const login = $('onboarding-login');
    if (login) login.hidden = !showLogin;
  }

  /* ---- the one and only step: Kimi login (v3 gate) ---------------------------- */

  function showLoginIntro() {
    lastStepUI = () => showLoginIntro();
    loginActive = false;
    setStepUI({
      title: T('onboarding.login_title_v3', 'Kimi에 로그인'),
      desc: T('onboarding.login_desc_v3', '브라우저에서 인증 코드를 입력하면 바로 시작할 수 있습니다.'),
      primary: T('onboarding.login_start', '로그인 시작'),
    });
  }

  function setLoginStatus(text, isError) {
    const status = $('login-status');
    if (!status) return;
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    status.textContent = text || '';
    status.classList.toggle('error', !!isError);
  }

  function showLoginWaiting(userCode, verificationUrl) {
    lastStepUI = () => showLoginWaiting(userCode, verificationUrl);
    setStepUI({
      title: T('onboarding.login_title_v3', 'Kimi에 로그인'),
      desc: T('onboarding.login_desc_v3', '브라우저에서 인증 코드를 입력하면 바로 시작할 수 있습니다.'),
      secondary: T('onboarding.cancel', '취소'),
      showLogin: true,
    });
    const code = $('login-code');
    if (code) {
      code.textContent = userCode || '';
      code.setAttribute('role', 'button');
      code.tabIndex = 0;
    }
    const urlBtn = $('login-url-btn');
    if (urlBtn) {
      urlBtn.textContent = T('onboarding.login_open', '인증 페이지 열기');
      urlBtn.dataset.url = verificationUrl || '';
      urlBtn.disabled = !verificationUrl;
    }
    setLoginStatus(T('onboarding.login_waiting', '대기 중…'), false);
  }

  function showLoginError(message) {
    lastStepUI = () => showLoginError(message);
    loginActive = false;
    setStepUI({
      title: T('onboarding.login_title_v3', 'Kimi에 로그인'),
      desc: T('onboarding.login_desc_v3', '브라우저에서 인증 코드를 입력하면 바로 시작할 수 있습니다.'),
      primary: T('onboarding.retry', '다시 시도'),
      secondary: T('onboarding.cancel', '취소'),
      showLogin: true,
    });
    setLoginStatus(
      message || T('onboarding.login_error', '로그인에 실패했습니다. 다시 시도해 주세요.'),
      true
    );
  }

  // Checkmark draw, then hand back to the shell via bootstrapRetry + launchApp.
  async function showLoginSuccess() {
    lastStepUI = null; // transient success state: not safe to re-render
    setStepUI({
      title: T('onboarding.login_done', '로그인 완료'),
      desc: T('onboarding.login_done_desc', '잠시 후 시작합니다.'),
    });
    const card = $('onboarding-card');
    if (card) {
      const check = document.createElement('div');
      check.className = 'onboarding-check';
      check.innerHTML = checkSvg();
      card.insertBefore(check, $('onboarding-actions') || null);
    }
    if (!reducedMotion()) await wait(CHECK_MS);
    try { await window.kimi?.bootstrapRetry?.(); }
    catch (err) { console.warn('bootstrapRetry failed', err); }
  }

  // Resolves when login completes; cancel loops back to the step start.
  async function runLoginStep() {
    showLoginIntro();
    for (;;) {
      const action = await nextAction();
      if (action.type === 'secondary') {
        if (loginActive) {
          loginActive = false;
          try { await window.kimi?.onboardingCancelLogin?.(); } catch { /* best effort */ }
        }
        showLoginIntro();
        continue;
      }
      if (action.type === 'login-done') {
        if (!loginActive) continue; // stale event after cancel
        loginActive = false;
        await showLoginSuccess();
        return;
      }
      if (action.type === 'login-error') {
        if (!loginActive) continue; // late error from a cancelled login
        showLoginError(action.message);
        continue;
      }
      // primary: 로그인 시작 / 다시 시도
      const primaryBtn = $('onboarding-primary-btn');
      if (primaryBtn) {
        primaryBtn.disabled = true;
        primaryBtn.textContent = T('onboarding.preparing', '준비 중…');
      }
      loginActive = true;
      try {
        const res = await window.kimi.onboardingStartLogin();
        // v4 (R2): the device page REQUIRES ?user_code= — it errors
        // 'user_code 매개변수가 누락되었습니다' on the bare URL, so prefer the
        // complete URL main/auth.js already returns. dataset.url (and thus
        // the openExternal click) carries whatever is passed here.
        showLoginWaiting(
          res?.userCode || '',
          res?.verificationUrlComplete ?? res?.verificationUrl ?? ''
        );
      } catch (err) {
        showLoginError(err?.message);
      }
    }
  }

  async function copyLoginCode() {
    const codeEl = $('login-code');
    const code = codeEl?.textContent?.trim();
    if (!code) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(code);
      ok = true;
    } catch {
      try {
        const range = document.createRange();
        range.selectNodeContents(codeEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand('copy');
        sel.removeAllRanges();
      } catch { ok = false; }
    }
    flashStatus(ok ? T('onboarding.copied', '복사되었습니다') : T('onboarding.copy_failed', '복사에 실패했습니다'));
  }

  function flashStatus(text) {
    const status = $('login-status');
    if (!status) return;
    if (flashTimer) clearTimeout(flashTimer);
    const prev = status.textContent;
    status.textContent = text;
    flashTimer = setTimeout(() => {
      flashTimer = null;
      if (status.textContent === text) status.textContent = prev;
    }, 1200);
  }

  /* ---- entry point ------------------------------------------------------------- */

  async function finish() {
    lastStepUI = null;
    if (typeof unsubEvents === 'function') {
      try { unsubEvents(); } catch { /* ignore */ }
    }
    unsubEvents = null;
    const root = $('onboarding');
    if (root) root.hidden = true;
    const fn = launchAppFn;
    launchAppFn = null;
    if (fn) await fn();
  }

  async function init(launchApp) {
    if (started) return;
    started = true;
    launchAppFn = typeof launchApp === 'function' ? launchApp : null;
    const statePromise = getOnboardingState(); // fetch in parallel with the splash
    await playSplash();
    const state = await statePromise;
    // v3 gate: login only. Defensive for both gate shapes — v3 main returns
    // { needsOnboarding } (= "not logged in"); a v2 main could still attach
    // { cliInstalled, loggedIn }, but a logged-in user is never gated now
    // (the CLI is optional), so the login card is the only step left.
    if (!state || !state.needsOnboarding || state.loggedIn === true) { await finish(); return; }
    if (!showOnboarding()) { await finish(); return; } // contract DOM missing
    await runLoginStep();
    await finish();
  }

  window.Onboarding = { init };

  // Language change: re-render the current step only while the card is visible.
  window.I18N?.onChange?.(() => {
    const root = $('onboarding');
    if (root && !root.hidden && lastStepUI) lastStepUI();
  });
})();
