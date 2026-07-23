'use strict';

/**
 * ipc.js — registers every `kimi:<name>` ipcMain.handle backing the window.kimi
 * preload API.
 *
 * registerIpc({
 *   backend,   // ./backend facade — the ONLY path for session/chat methods (v3)
 *   getWindow, // () => BrowserWindow | null
 *   broadcast, // (payload) => void     (already targets the main window)
 * })
 *
 * V3 (CONTRACT-V3, B3): every session/chat handler routes through ./backend,
 * which dispatches to the active engine ('direct' | 'cli'). New handlers:
 * renameSession, deleteSession, setSessionEffort, setEngine, getDailyUsage
 * (B4's ./usage-stats, lazy) — plus a synchronous `kimi:capabilitiesSync`
 * channel the preload uses to omit engine-specific methods (e.g.
 * setSessionSwarm is cli-only).
 *
 * Kept from v2: onboarding (CLI install + login) via ./onboarding, ./quota,
 * and the lazy ./updater wiring — missing modules degrade to a thrown Error
 * or a graceful {status:'dev'} fallback, never a crash.
 */

const { app, ipcMain, dialog, shell } = require('electron');

/** require() a sibling module at most once; null (cached) when absent. */
function lazyLoader(relPath) {
  let mod = null;
  let failed = false;
  return () => {
    if (mod || failed) return mod;
    try {
      // eslint-disable-next-line global-require
      mod = require(relPath);
    } catch {
      failed = true;
      mod = null;
    }
    return mod;
  };
}

// ./quota and ./onboarding ship with the app; ./usage-stats (B4) and
// ./updater (M3) may not exist yet — all four are lazy so this file loads
// regardless.
const loadQuota = lazyLoader('./quota');
const loadOnboarding = lazyLoader('./onboarding');
const loadUsageStats = lazyLoader('./usage-stats');
const loadUpdater = lazyLoader('./updater');
const loadGitWorkspace = lazyLoader('./git-workspace');

function requireOnboarding() {
  const onboarding = loadOnboarding();
  if (!onboarding) throw new Error('onboarding is unavailable (main/onboarding.js failed to load)');
  return onboarding;
}

// Tracks whether ./updater's register() wired the real update handlers.
let updaterWired = false;
function wireUpdater(send) {
  if (updaterWired) return;
  const updater = loadUpdater();
  if (!updater || typeof updater.register !== 'function') return;
  try {
    updater.register({ ipcMain, send });
    updaterWired = true;
  } catch (err) {
    console.warn(`[kimi-desktop] updater.register failed: ${err.message}`);
  }
}

function registerIpc({ backend, getWindow, broadcast }) {
  if (!backend) throw new Error('registerIpc requires the ./backend facade');
  const handle = (name, fn) => {
    ipcMain.handle(`kimi:${name}`, (_event, ...args) => fn(...args));
  };

  // Synchronous capabilities query for the preload (runs before the page
  // loads, so conditional window.kimi methods reflect the active engine).
  ipcMain.on('kimi:capabilitiesSync', (event) => {
    try {
      event.returnValue = backend.capabilities();
    } catch {
      event.returnValue = null;
    }
  });

  // { ready, version, defaultModel, error?, engine, cliInstalled, loggedIn, needsOnboarding }
  handle('getState', () => backend.getState());

  // --- Onboarding (first-run gate): Kimi login (device flow) + CLI install ---

  handle('onboardingGetState', () => requireOnboarding().getOnboardingState());

  // Progress is pushed as {type:'onboarding', phase:'install', step, message}.
  handle('onboardingInstallCli', () => requireOnboarding().installCli(broadcast));

  // Resolves {verificationUrl, userCode}; completion pushed as
  // {type:'onboarding', phase:'login', status:'done'|'error', message?}.
  handle('onboardingStartLogin', () => requireOnboarding().startLogin(broadcast));

  handle('onboardingCancelLogin', () => requireOnboarding().cancelLogin());

  // Re-init the active engine once onboarding finished (e.g. first login).
  // Returns the fresh state (getState shape).
  handle('bootstrapRetry', async () => {
    await backend.retry();
    return backend.getState();
  });

  // --- Engine ---------------------------------------------------------------

  // Switch engines ('direct' | 'cli'); persists. The renderer reloads after.
  handle('setEngine', async (engineName) => {
    await backend.setEngine(engineName);
    return backend.getState();
  });

  // --- Sessions / chat (all routed through the backend facade) --------------

  handle('listSessions', () => backend.listSessions());

  handle('createSession', ({ cwd } = {}) => backend.createSession({ cwd }));

  handle('pickDirectory', async (defaultPath) => {
    const options = {
      title: '작업 폴더 선택', // pick a working directory for the new session
      properties: ['openDirectory', 'createDirectory'],
    };
    if (typeof defaultPath === 'string' && defaultPath.trim()) {
      options.defaultPath = defaultPath;
    }
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  handle('getGitInfo', (cwd) => {
    const git = loadGitWorkspace();
    if (!git || typeof git.listInfo !== 'function') {
      return { isRepository: false, current: null, branches: [] };
    }
    return git.listInfo(cwd);
  });

  handle('checkoutGitBranch', (cwd, branch) => {
    const git = loadGitWorkspace();
    if (!git || typeof git.checkout !== 'function') {
      throw new Error('Git 작업공간 기능을 사용할 수 없습니다.');
    }
    return git.checkout(cwd, branch);
  });

  // Window controls for the menu-less build (renderer re-binds Cmd+W/M/H).
  handle('windowAction', (action) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (action === 'close') win.close();
    else if (action === 'minimize') win.minimize();
    else if (action === 'hide') app.hide?.();
  });

  // Log out: tombstone the shared credentials (kept CLI-compatible).
  handle('logout', () => {
    try {
      return require('./auth').logout();
    } catch {
      return { ok: false };
    }
  });

  handle('getMessages', (sessionId) => backend.getMessages(sessionId));

  handle('getProfile', (sessionId) => backend.getProfile(sessionId));

  handle('sendPrompt', (sessionId, text) => backend.sendPrompt(sessionId, text));

  handle('steer', (sessionId, text) => backend.steer(sessionId, text));

  handle('abort', (sessionId) => backend.abort(sessionId));

  handle('respondApproval', (sessionId, approvalId, decision) =>
    backend.respondApproval(sessionId, approvalId, decision),
  );

  handle('answerQuestion', (sessionId, tail, body) =>
    backend.answerQuestion(sessionId, tail, body),
  );

  handle('listModels', () => backend.listModels());

  handle('setSessionModel', (sessionId, model) => backend.setSessionModel(sessionId, model));

  handle('setSessionSwarm', (sessionId, enabled) => backend.setSessionSwarm(sessionId, enabled));

  handle('setSessionEffort', (sessionId, effort) => backend.setSessionEffort(sessionId, effort));

  handle('renameSession', (sessionId, title) => backend.renameSession(sessionId, title));

  handle('deleteSession', (sessionId) => backend.deleteSession(sessionId));

  handle('listTasks', (sessionId) => backend.listTasks(sessionId));

  // --- Cross-agent lazy modules ---------------------------------------------

  handle('searchAll', (query, limit) => backend.searchAll(query, limit));

  handle('getDailyUsage', () => {
    const usage = loadUsageStats();
    if (!usage || typeof usage.getDailyUsage !== 'function') {
      throw new Error('usage stats are unavailable (main/usage-stats.js not installed)');
    }
    return usage.getDailyUsage();
  });

  handle('getQuota', async () => {
    const quota = loadQuota();
    if (!quota || typeof quota.getQuota !== 'function') return null;
    try {
      // Do NOT pass a server token: quota.js reads the OAuth credentials from
      // ~/.kimi-code/credentials itself (works for both engines).
      return await quota.getQuota({});
    } catch (err) {
      console.warn(`[kimi-desktop] getQuota failed: ${err.message}`);
      return null; // UI falls back to per-session usage only
    }
  });

  // M3's updater wires updateCheck / updateDownload / updateQuitAndInstall via
  // register(); fall back to graceful dev stubs when it is absent/broken.
  wireUpdater(broadcast);
  if (!updaterWired) {
    handle('updateCheck', () => ({ status: 'dev' }));
    handle('updateDownload', () => ({ status: 'dev' }));
    handle('updateQuitAndInstall', () => {
      throw new Error('updates are unavailable in this build');
    });
  }
  handle('getAppVersion', () => app.getVersion());

  handle('openExternal', async (url) => {
    // Security boundary: only http(s) URLs may leave the app.
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new Error(`invalid URL: ${String(url).slice(0, 100)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`blocked URL scheme: ${parsed.protocol}`);
    }
    await shell.openExternal(parsed.toString());
  });
}

module.exports = { registerIpc };
