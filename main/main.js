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

const { app, BrowserWindow, Menu, nativeImage } = require('electron');
const path = require('node:path');

// Brand: menu bar / Dock label in dev; packaged builds use productName + icns/ico.
app.setName('kimi-gui');
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png');

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
    icon: APP_ICON, // window/taskbar icon (win/linux; mac uses icns via builder)
    ...(isMac ? { titleBarStyle: 'hiddenInset', vibrancy: 'sidebar' } : {}),
    backgroundColor: '#000000', // dark-first (true black)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // End users get no DevTools: block its keyboard shortcuts (the default
  // Electron menu's View > Toggle Developer Tools is removed in installAppMenu).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    if ((input.meta && input.alt && key === 'i') || (input.control && input.shift && key === 'i') || key === 'f12') {
      event.preventDefault();
    }
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

/** Minimal branded menu — replaces Electron's default (which exposes View > Toggle Developer Tools). */
function installAppMenu() {
  if (isMac) {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'kimi-gui',
          submenu: [
            { role: 'about', label: 'About kimi-gui' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit', label: 'Quit kimi-gui' },
          ],
        },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ])
    );
  } else {
    // win/linux: the default menu bar exposes DevTools — drop it entirely.
    Menu.setApplicationMenu(null);
  }
}

  app.whenReady().then(() => {
    // Dev mode shows the Electron dock icon by default — use ours (packaged mac uses the icns).
    if (isMac) app.dock?.setIcon(nativeImage.createFromPath(APP_ICON));
    installAppMenu();
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
