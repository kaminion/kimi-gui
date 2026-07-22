'use strict';

/**
 * main.js — Electron main process entry point.
 *
 * Lifecycle (per ARCHITECTURE.md + CONTRACT-V2):
 *   single-instance lock -> create BrowserWindow (1100x720, min 840x560,
 *   hiddenInset + sidebar vibrancy on macOS, contextIsolation on, no
 *   nodeIntegration) -> load renderer/index.html -> KimiClient.launch() ->
 *   wire IPC + event forwarding -> graceful shutdown on before-quit.
 *
 * V2: the renderer owns first-run routing (splash -> onboarding when the CLI
 * or login is missing), so a failed backend launch is surfaced as a status
 * event only — v1's full-screen fatal error page is gone. `kimi:bootstrapRetry`
 * (retryBackend below) re-runs the launch once onboarding completes.
 * main/kimi-client.js is provided by another agent; the require is lazy so
 * this file loads (and syntax-checks) even while that file is absent.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const { registerIpc, wireClientEvents } = require('./ipc');
const { resolveKimiPath } = require('./server-manager');

const isMac = process.platform === 'darwin';

/** @type {BrowserWindow | null} */
let mainWindow = null;
let isQuitting = false;

// Backend state mirrored for kimi:getState and status pushes.
const state = {
  client: null,
  token: null,
  ready: false,
  version: null,
  defaultModel: null,
  error: null,
};

// Lazy: another agent owns main/kimi-client.js.
function loadKimiClient() {
  try {
    // eslint-disable-next-line global-require
    return require('./kimi-client');
  } catch (err) {
    const wrapped = new Error(`failed to load main/kimi-client.js: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

function broadcast(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('kimi:event', payload);
  }
}

function getAppState() {
  return {
    ready: state.ready,
    version: state.version,
    defaultModel: state.defaultModel,
    ...(state.error ? { error: state.error } : {}),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 840,
    minHeight: 560,
    ...(isMac ? { titleBarStyle: 'hiddenInset', vibrancy: 'sidebar' } : {}),
    backgroundColor: '#000000', // v2 is dark-first (true black)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Renderer must use window.kimi.openExternal; never open new windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // A (re)loaded renderer learns the current backend status immediately.
  mainWindow.webContents.on('did-finish-load', () => {
    broadcast({ type: 'status', ready: state.ready, ...(state.error ? { error: state.error } : {}) });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// Guard against concurrent launches (initial launch vs. kimi:bootstrapRetry).
let launchPromise = null;

function launchBackend() {
  if (launchPromise) return launchPromise;
  launchPromise = doLaunchBackend().finally(() => {
    launchPromise = null;
  });
  return launchPromise;
}

async function doLaunchBackend() {
  let client;
  let child;
  let token;
  let baseUrl;
  try {
    const { KimiClient } = loadKimiClient(); // module exports { KimiClient, KimiApiError }
    // Resolve the binary explicitly (env KIMI_CLI_PATH -> PATH lookup ->
    // ~/.kimi-code/bin) so a CLI installed by onboarding is found even when
    // the app was launched from Finder with a minimal PATH.
    const kimiPath = await resolveKimiPath();
    ({ client, child, baseUrl, token } = await KimiClient.launch({ kimiPath }));
  } catch (err) {
    state.ready = false;
    state.error = err.message;
    console.error(`[kimi-desktop] backend launch failed: ${state.error}`);
    // No fatal page in v2: the renderer routes to onboarding / surfaces this.
    broadcast({ type: 'status', ready: false, error: state.error });
    return;
  }

  state.client = client;
  state.token = token;
  state.ready = true;
  state.error = null;
  wireClientEvents(client, broadcast);
  console.log(`[kimi-desktop] backend ready at ${baseUrl}`);

  // Open the event WebSocket and subscribe to all known sessions so live
  // traffic (streaming deltas, busy flips, approvals, usage) flows even for
  // sessions the renderer has not selected yet. Selection/creation paths
  // (ipc.js getMessages/createSession) subscribe idempotently on top of this.
  client.connect();
  client
    .listSessions()
    .then((items) => {
      for (const s of Array.isArray(items) ? items : []) {
        if (s && typeof s.id === 'string') client.subscribeSession(s.id);
      }
    })
    .catch(() => { /* best-effort; selection paths subscribe lazily */ });

  // Best-effort metadata for getState(); failures must not break the launch.
  try {
    const meta = await client.meta();
    state.version = (meta && meta.server_version) ?? null;
  } catch {
    state.version = null;
  }
  try {
    const auth = await client.auth();
    state.defaultModel = (auth && auth.default_model) ?? null;
  } catch {
    state.defaultModel = null;
  }
  broadcast({ type: 'status', ready: true });

  // If the server process dies on its own, surface it as a status error.
  if (child) {
    child.once('exit', (code, signal) => {
      if (isQuitting) return;
      if (state.client !== client) return; // superseded by a bootstrapRetry re-launch
      state.ready = false;
      state.client = null;
      state.token = null;
      state.error = `kimi server exited unexpectedly (code ${code}, signal ${signal})`;
      broadcast({ type: 'status', ready: false, error: state.error });
    });
  }
}

/**
 * kimi:bootstrapRetry — re-run the backend launch after onboarding completes
 * (the first launch may have failed with no CLI installed). Shuts down any
 * previous client, then launches fresh and re-wires event forwarding.
 * Returns the fresh app state.
 */
async function retryBackend() {
  const previous = state.client;
  state.client = null;
  state.token = null;
  state.ready = false;
  state.error = null;
  if (previous) {
    try {
      await previous.shutdown();
    } catch (err) {
      console.warn(`[kimi-desktop] previous client shutdown failed: ${err.message}`);
    }
  }
  await launchBackend();
  return getAppState();
}

/**
 * Single silent update-check on launch, packaged builds only. The updater is
 * M3's module: ipc.js already calls its register({ipcMain, send}) when present
 * (which per contract performs the launch check); if it also exports
 * checkSilently({ send }) we call that instead — both paths are guarded so a
 * missing/broken module is a no-op, never a crash.
 */
function maybeAutoCheckUpdates() {
  if (!app.isPackaged) return;
  try {
    // eslint-disable-next-line global-require
    const updater = require('./updater');
    if (updater && typeof updater.checkSilently === 'function') {
      updater.checkSilently({ send: broadcast });
    }
  } catch (err) {
    console.warn(`[kimi-desktop] silent update check skipped: ${err.message}`);
  }
}

// --- App lifecycle -------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc({
      getClient: () => state.client,
      getAppState,
      getToken: () => state.token,
      getWindow: () => mainWindow,
      broadcast,
      retryBackend,
    });
    createWindow();
    launchBackend();
    maybeAutoCheckUpdates();
  });

  // Single-window utility: closing the window quits the app (and the server).
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    // Drop any dangling `kimi login` child from onboarding.
    try {
      // eslint-disable-next-line global-require
      require('./onboarding').cancelLogin();
    } catch {
      /* onboarding module absent */
    }
    if (isQuitting || !state.client) return;
    isQuitting = true;
    event.preventDefault();
    const shutdown = Promise.resolve()
      .then(() => state.client.shutdown())
      .catch((err) => console.warn(`[kimi-desktop] client shutdown failed: ${err.message}`));
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    Promise.race([shutdown, timeout]).finally(() => app.quit());
  });

  // Make Ctrl+C / kill during development also shut the server down cleanly.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => app.quit());
  }
}
