'use strict';

/**
 * main.js — Electron main process entry point.
 *
 * Lifecycle (ARCHITECTURE.md + CONTRACT-V2/V3):
 *   single-instance lock -> create BrowserWindow (1100x720, min 840x560,
 *   hiddenInset + sidebar vibrancy on macOS, contextIsolation on, no
 *   nodeIntegration) -> load renderer/index.html -> backend.init({app, send})
 *   -> graceful backend.shutdown() on before-quit.
 *
 * V3 (CONTRACT-V3, B3): all backend wiring lives in ./backend — the engine
 * facade that routes session/chat calls to the CLI-free 'direct' engine or
 * the legacy 'cli' engine (kimi web server). This file owns only the window
 * and the app lifecycle. The renderer owns first-run routing (splash ->
 * onboarding when not logged in), so a failed engine launch is surfaced as a
 * status event only. `kimi:bootstrapRetry` re-runs the active engine's boot
 * once onboarding completes.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const backend = require('./backend');
const { registerIpc } = require('./ipc');

const isMac = process.platform === 'darwin';

/** @type {BrowserWindow | null} */
let mainWindow = null;
let isQuitting = false;

function broadcast(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('kimi:event', payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 840,
    minHeight: 560,
    ...(isMac ? { titleBarStyle: 'hiddenInset', vibrancy: 'sidebar' } : {}),
    backgroundColor: '#000000', // dark-first (true black)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Renderer must use window.kimi.openExternal; never open new windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // A (re)loaded renderer learns the current engine status immediately.
  mainWindow.webContents.on('did-finish-load', () => {
    backend.pushStatus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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
      backend,
      getWindow: () => mainWindow,
      broadcast,
    });
    createWindow();
    backend
      .init({ app, send: broadcast })
      .catch((err) => console.error(`[kimi-desktop] backend init failed: ${err.message}`));
    maybeAutoCheckUpdates();
  });

  // Single-window utility: closing the window quits the app (and the backend).
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    // Drop any dangling device-flow login from onboarding.
    try {
      // eslint-disable-next-line global-require
      require('./onboarding').cancelLogin();
    } catch {
      /* onboarding module absent */
    }
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();
    const shutdown = Promise.resolve()
      .then(() => backend.shutdown())
      .catch((err) => console.warn(`[kimi-desktop] backend shutdown failed: ${err.message}`));
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    Promise.race([shutdown, timeout]).finally(() => app.quit());
  });

  // Make Ctrl+C / kill during development also shut the backend down cleanly.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => app.quit());
  }
}
