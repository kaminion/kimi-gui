/* cli-connect-prompt.js
 *
 * Optional post-login prompt shown when kimi-gui starts with the built-in
 * engine. It keeps CLI discovery, installation, connection, and the
 * "don't show again" preference in one dialog.
 */
(function () {
  'use strict';

  const T = (key, fallback) => (window.I18N?.t ? window.I18N.t(key, fallback) : fallback);
  const DISMISSED_KEY = 'kimi.cliConnectPrompt.dismissed.v1';

  let backdrop = null;
  let installed = false;
  let installing = false;
  let connecting = false;
  let neverShow = false;
  let statusLine = '';
  let statusKind = '';
  let unsubscribe = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function isDismissed() {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  function persistDismissal() {
    if (!neverShow) return;
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* localStorage may be unavailable in hardened environments */
    }
  }

  function isBusy() {
    return installing || connecting;
  }

  function shouldShow(state) {
    return (
      state?.engine === 'direct' &&
      !state?.fallbackReason &&
      !isDismissed() &&
      typeof window.kimi?.setEngine === 'function'
    );
  }

  function currentStatus() {
    if (statusLine) return statusLine;
    if (installed) {
      return T(
        'cli_prompt.status_ready',
        'Kimi Code CLI가 준비되어 있습니다. 연결하면 CLI 모드로 다시 시작합니다.'
      );
    }
    return T(
      'cli_prompt.status_missing',
      '이 컴퓨터에 Kimi Code CLI가 설치되어 있지 않습니다.'
    );
  }

  function render({ focusPrimary = false } = {}) {
    if (!backdrop) return;
    const previousCheck = backdrop.querySelector('.cli-connect-never input');
    if (previousCheck) neverShow = previousCheck.checked;

    backdrop.textContent = '';
    const modal = el('div', 'modal modal-cli-connect');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'cli-connect-title');
    modal.setAttribute('aria-describedby', 'cli-connect-description cli-connect-status');
    modal.setAttribute('aria-busy', isBusy() ? 'true' : 'false');

    const title = el(
      'div',
      'modal-title cli-connect-title',
      T('cli_prompt.title', 'CLI 에이전트 모드를 연결할까요?')
    );
    title.id = 'cli-connect-title';

    const body = el('div', 'modal-body cli-connect-body');
    const description = el(
      'p',
      'cli-connect-description',
      T(
        'cli_prompt.description',
        '현재 내장 엔진을 사용 중입니다. Kimi Code CLI를 연결하면 고급 에이전트 기능을 사용할 수 있습니다.'
      )
    );
    description.id = 'cli-connect-description';

    const capabilities = el('section', 'cli-connect-capabilities');
    const capabilitiesTitle = el(
      'h3',
      'cli-connect-capabilities-title',
      T('cli_prompt.capabilities_title', '연결하면 사용할 수 있는 기능')
    );
    capabilitiesTitle.id = 'cli-connect-capabilities-title';
    capabilities.setAttribute('aria-labelledby', capabilitiesTitle.id);

    const capabilityList = el('div', 'cli-connect-capability-list');
    const featureCopy = [
      [
        T('cli_prompt.feature_swarm_title', 'Swarm 및 서브에이전트'),
        T('cli_prompt.feature_swarm_desc', '여러 에이전트가 독립적인 작업을 나누어 병렬로 처리합니다.'),
      ],
      [
        T('cli_prompt.feature_plan_title', 'Plan mode'),
        T('cli_prompt.feature_plan_desc', '파일을 수정하기 전에 작업 방향과 순서를 검토합니다.'),
      ],
      [
        T('cli_prompt.feature_tools_title', '전체 CLI 도구'),
        T('cli_prompt.feature_tools_desc', 'Kimi Code CLI의 에이전트, 도구, 워크스페이스 기능을 사용합니다.'),
      ],
      [
        T('cli_prompt.feature_sessions_title', 'CLI 세션 연속성'),
        T('cli_prompt.feature_sessions_desc', 'Kimi Code CLI에서 만든 세션을 에이전트 모드로 이어서 작업합니다.'),
      ],
    ];
    for (const [featureTitle, featureDescription] of featureCopy) {
      const item = el('div', 'cli-connect-capability');
      item.append(
        el('strong', 'cli-connect-capability-title', featureTitle),
        el('span', 'cli-connect-capability-description', featureDescription)
      );
      capabilityList.appendChild(item);
    }
    capabilities.append(capabilitiesTitle, capabilityList);

    const status = el('p', `cli-connect-status${statusKind ? ` ${statusKind}` : ''}`, currentStatus());
    status.id = 'cli-connect-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    body.append(description, capabilities, status);

    const footer = el('div', 'cli-connect-footer');
    const neverLabel = el('label', 'cli-connect-never');
    const neverInput = document.createElement('input');
    neverInput.type = 'checkbox';
    neverInput.checked = neverShow;
    neverInput.addEventListener('change', () => { neverShow = neverInput.checked; });
    neverLabel.append(
      neverInput,
      el('span', '', T('cli_prompt.never_show', '다시 보지 않음'))
    );

    const buttons = el('div', 'cli-connect-buttons');
    const secondary = el(
      'button',
      'btn btn-ghost',
      T('cli_prompt.keep_direct', '내장 엔진 계속 사용')
    );
    secondary.type = 'button';
    secondary.disabled = isBusy();
    secondary.addEventListener('click', () => close());

    let primaryText;
    if (installing) primaryText = T('cli_prompt.installing', '설치 중…');
    else if (connecting) primaryText = T('cli_prompt.connecting', '연결 중…');
    else if (installed) primaryText = T('cli_prompt.connect', 'CLI 연결');
    else primaryText = T('cli_prompt.install', 'CLI 설치');

    const primary = el('button', 'btn btn-primary cli-connect-primary', primaryText);
    primary.type = 'button';
    primary.disabled = isBusy() || (
      installed
        ? typeof window.kimi?.setEngine !== 'function'
        : typeof window.kimi?.onboardingInstallCli !== 'function'
    );
    primary.addEventListener('click', () => {
      if (installed) void connect();
      else void install();
    });

    buttons.append(secondary, primary);
    footer.append(neverLabel, buttons);
    modal.append(title, body, footer);
    backdrop.appendChild(modal);

    if (focusPrimary) requestAnimationFrame(() => primary.focus());
  }

  function updateProgress(message, kind = '') {
    statusLine = String(message || '');
    statusKind = kind;
    const status = backdrop?.querySelector('.cli-connect-status');
    if (!status) return;
    status.className = `cli-connect-status${kind ? ` ${kind}` : ''}`;
    status.textContent = currentStatus();
  }

  function installProgressText(message) {
    switch (message?.step) {
      case 'download_script':
        return T('cli_prompt.downloading', 'CLI 설치 프로그램을 다운로드하고 있습니다…');
      case 'run_installer':
        return T('cli_prompt.installing_detail', 'Kimi Code CLI를 설치하고 있습니다…');
      case 'verify':
        return T('cli_prompt.verifying', 'CLI 설치를 확인하고 있습니다…');
      case 'done':
        return T('cli_prompt.install_done', '설치가 완료되었습니다. 이제 CLI에 연결할 수 있습니다.');
      default:
        return message?.message ||
          T('cli_prompt.installing_detail', 'Kimi Code CLI를 설치하고 있습니다…');
    }
  }

  function onKeydown(event) {
    if (event.key !== 'Escape' || isBusy()) return;
    event.stopPropagation();
    close();
  }

  function close() {
    if (!backdrop || isBusy()) return;
    persistDismissal();
    if (unsubscribe) {
      try { unsubscribe(); } catch { /* renderer is closing */ }
      unsubscribe = null;
    }
    document.removeEventListener('keydown', onKeydown, true);
    backdrop.remove();
    backdrop = null;
  }

  async function install() {
    if (isBusy() || installed || typeof window.kimi?.onboardingInstallCli !== 'function') return;
    installing = true;
    statusKind = '';
    statusLine = T('cli_prompt.installing_detail', 'Kimi Code CLI를 설치하고 있습니다…');
    render();
    try {
      const result = await window.kimi.onboardingInstallCli();
      installed = result?.ok !== false;
      installing = false;
      statusKind = installed ? 'success' : 'error';
      statusLine = installed
        ? T('cli_prompt.install_done', '설치가 완료되었습니다. 이제 CLI에 연결할 수 있습니다.')
        : T('cli_prompt.install_failed', '설치에 실패했습니다. 설정의 엔진 메뉴에서 다시 시도할 수 있습니다.');
    } catch (error) {
      installing = false;
      statusKind = 'error';
      statusLine = error?.message ||
        T('cli_prompt.install_failed', '설치에 실패했습니다. 설정의 엔진 메뉴에서 다시 시도할 수 있습니다.');
    }
    render({ focusPrimary: true });
  }

  async function connect() {
    if (isBusy() || !installed || typeof window.kimi?.setEngine !== 'function') return;
    connecting = true;
    statusKind = '';
    statusLine = T('cli_prompt.connecting_detail', 'CLI 서버를 시작하고 연결을 확인하고 있습니다…');
    render();
    try {
      const state = await window.kimi.setEngine('cli');
      if (state?.engine !== 'cli' || state?.ready === false) {
        connecting = false;
        statusKind = 'error';
        statusLine = T(
          'cli_prompt.connect_failed',
          'CLI에 연결하지 못해 내장 엔진을 계속 사용합니다. 설정에서 다시 시도할 수 있습니다.'
        );
        render({ focusPrimary: true });
        return;
      }
      persistDismissal();
      location.reload();
    } catch (error) {
      connecting = false;
      statusKind = 'error';
      statusLine = error?.message ||
        T(
          'cli_prompt.connect_failed',
          'CLI에 연결하지 못해 내장 엔진을 계속 사용합니다. 설정에서 다시 시도할 수 있습니다.'
        );
      render({ focusPrimary: true });
    }
  }

  function show(state) {
    if (backdrop || !shouldShow(state)) return false;
    const root = document.getElementById('modal-root');
    if (!root) return false;

    installed = !!state.cliInstalled;
    installing = false;
    connecting = false;
    neverShow = false;
    statusLine = '';
    statusKind = '';
    backdrop = el('div', 'modal-backdrop cli-connect-backdrop');
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop && !isBusy()) close();
    });
    root.appendChild(backdrop);
    document.addEventListener('keydown', onKeydown, true);
    if (typeof window.kimi?.onEvent === 'function') {
      unsubscribe = window.kimi.onEvent((message) => {
        if (!backdrop || message?.type !== 'onboarding' || message.phase !== 'install') return;
        updateProgress(installProgressText(message));
      });
    }
    render({ focusPrimary: true });
    return true;
  }

  window.I18N?.onChange?.(() => {
    if (backdrop) render();
  });

  window.CliConnectPrompt = { show, close };
})();
