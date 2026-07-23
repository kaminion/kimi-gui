'use strict';

/**
 * main/updater.js — auto-update via electron-updater (CONTRACT-V2 §Auto-update).
 *
 * register({ ipcMain, send }) wires:
 *   ipcMain.handle('kimi:updateCheck')          — manual check (settings UI)
 *   ipcMain.handle('kimi:updateDownload')       — download after user consent
 *   ipcMain.handle('kimi:updateQuitAndInstall') — restart into a downloaded update
 * and forwards autoUpdater events as push payloads on the 'kimi:event' channel:
 *   send({ type: 'update', status, version?, percent?, message? })
 *
 * Contract statuses: 'dev' | 'checking' | 'available' | 'downloading' |
 * 'downloaded' | 'none' | 'error'.
 *
 * Graceful degradation is the contract: dev builds (!app.isPackaged), a
 * missing/broken electron-updater install, and packaged builds without an
 * embedded publish config all resolve to { status: 'dev' } — nothing in this
 * module may ever throw into the main process.
 */

const { app } = require('electron');

// Lazy: electron-updater is required on demand so a missing dependency can
// never crash main. The require itself is cheap; the autoUpdater getter is
// what instantiates the platform updater (and may throw without a real app).
let autoUpdater = null;
let updaterUnavailable = false;
function loadAutoUpdater() {
  if (autoUpdater || updaterUnavailable) return autoUpdater;
  try {
    // eslint-disable-next-line global-require
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    updaterUnavailable = true;
    autoUpdater = null;
    console.warn(`[Kimi-GUI] electron-updater unavailable: ${err && err.message ? err.message : err}`);
  }
  return autoUpdater;
}

/** Latest known state; kimi:updateCheck resolves a snapshot of it. */
const current = { status: 'none', version: null, message: null };
let updateReady = false; // an update finished downloading and can be installed
let checkInFlight = null; // Promise of a running check (manual + silent share it)
let downloadInFlight = null; // Promise of the user-approved download

function truncate(value, max = 300) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function snapshot() {
  const result = { status: current.status };
  if (current.version) result.version = current.version;
  if (typeof current.percent === 'number') result.percent = current.percent;
  if (current.message) result.message = current.message;
  return result;
}

/** Merge an event into `current` and push it to the renderer. Never throws. */
function report(send, { status, version = null, percent, message = null }) {
  current.status = status;
  if (version) current.version = version;
  current.percent = typeof percent === 'number' ? percent : null;
  current.message = message;
  if (status === 'checking') updateReady = false; // superseded by the new check
  if (status === 'downloaded') updateReady = true;

  const payload = { type: 'update', status };
  if (current.version) payload.version = current.version;
  if (typeof percent === 'number') payload.percent = percent;
  if (message) payload.message = message;
  try {
    send(payload);
  } catch (err) {
    console.warn(`[Kimi-GUI] update event push failed: ${err && err.message ? err.message : err}`);
  }
}

/** Packaged build without an embedded app-update.yml counts as "unconfigured". */
function isUnconfiguredError(err) {
  return Boolean(
    err && err.code === 'ENOENT' && /app-update\.yml/.test(String(err.message ?? '')),
  );
}

async function runCheck(send) {
  const updater = loadAutoUpdater();
  if (!updater || !app.isPackaged) return { status: 'dev' };
  if (checkInFlight) {
    const result = { status: 'checking' };
    if (current.version) result.version = current.version;
    return result;
  }

  report(send, { status: 'checking' });
  checkInFlight = updater
    .checkForUpdates()
    .then(() => snapshot())
    .catch((err) => {
      if (isUnconfiguredError(err)) return { status: 'dev' };
      const message = truncate(err && err.message ? err.message : err);
      console.warn(`[Kimi-GUI] update check failed: ${message}`);
      report(send, { status: 'error', message });
      return snapshot();
    })
    .finally(() => {
      checkInFlight = null;
    });
  return checkInFlight;
}

async function quitAndInstall() {
  const updater = loadAutoUpdater();
  if (!updater || !app.isPackaged) return { status: 'dev' };
  if (!updateReady) return snapshot();
  // Reply first: quitting right away would drop the IPC response. Run the app
  // again after install (isSilent=false, isForceRunAfter=true).
  setTimeout(() => {
    try {
      updater.quitAndInstall(false, true);
    } catch (err) {
      console.warn(`[Kimi-GUI] quitAndInstall failed: ${err && err.message ? err.message : err}`);
    }
  }, 100);
  const result = { status: 'downloaded' };
  if (current.version) result.version = current.version;
  return result;
}

async function downloadUpdate(send) {
  const updater = loadAutoUpdater();
  if (!updater || !app.isPackaged) return { status: 'dev' };
  if (updateReady) return snapshot();
  if (downloadInFlight) return downloadInFlight;
  if (current.status !== 'available' && current.status !== 'downloading') return snapshot();

  report(send, {
    status: 'downloading',
    version: current.version,
    percent: typeof current.percent === 'number' ? current.percent : 0,
  });
  downloadInFlight = updater
    .downloadUpdate()
    .then(() => snapshot())
    .catch((err) => {
      const message = truncate(err && err.message ? err.message : err);
      console.warn(`[Kimi-GUI] update download failed: ${message}`);
      report(send, { status: 'error', version: current.version, message });
      return snapshot();
    })
    .finally(() => {
      downloadInFlight = null;
    });
  return downloadInFlight;
}

function register({ ipcMain, send } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    console.error('[Kimi-GUI] updater.register: ipcMain missing — update IPC not wired');
    return;
  }
  const safeSend = typeof send === 'function' ? send : () => {};

  ipcMain.handle('kimi:updateCheck', () => runCheck(safeSend));
  ipcMain.handle('kimi:updateDownload', () => downloadUpdate(safeSend));
  ipcMain.handle('kimi:updateQuitAndInstall', () => quitAndInstall());

  const updater = loadAutoUpdater();
  if (!updater || !app.isPackaged) return; // dev builds: IPC stubs only

  // A release is never downloaded until the renderer's update dialog records
  // an explicit user choice and calls kimi:updateDownload.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true; // already the default; be explicit

  updater.on('checking-for-update', () => report(safeSend, { status: 'checking' }));
  updater.on('update-available', (info) =>
    report(safeSend, { status: 'available', version: info && info.version }),
  );
  updater.on('update-not-available', (info) =>
    report(safeSend, { status: 'none', version: info && info.version }),
  );
  updater.on('download-progress', (progress) => {
    const raw = progress && typeof progress.percent === 'number' ? progress.percent : 0;
    report(safeSend, {
      status: 'downloading',
      version: current.version,
      percent: Math.round(raw * 10) / 10,
    });
  });
  updater.on('update-downloaded', (info) =>
    report(safeSend, { status: 'downloaded', version: info && info.version }),
  );
  updater.on('error', (err) =>
    report(safeSend, {
      status: 'error',
      message: truncate(err && err.message ? err.message : err),
    }),
  );

  // One silent check shortly after launch (packaged only); further checks are
  // manual via the settings UI. unref so the timer never keeps main alive.
  const timer = setTimeout(() => {
    runCheck(safeSend).catch(() => {});
  }, 10_000);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { register };
