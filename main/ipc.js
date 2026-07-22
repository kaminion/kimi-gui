'use strict';

/**
 * ipc.js — registers every `kimi:<name>` ipcMain.handle backing the window.kimi
 * preload API, plus push-event forwarding from KimiClient to the renderer via
 * webContents.send('kimi:event', payload).
 *
 * registerIpc({
 *   getClient,    // () => KimiClient | null (null until the server is up / after failure)
 *   getAppState,  // () => ({ ready, version, defaultModel, error? })
 *   getToken,     // () => string | null   (server bearer token; never logged)
 *   getWindow,    // () => BrowserWindow | null
 *   broadcast,    // (payload) => void     (already targets the main window)
 *   retryBackend, // () => Promise<state>  (re-run the KimiClient launch after onboarding)
 * })
 *
 * wireClientEvents(client, broadcast) attaches 'event'/'usage'/'status'
 * forwarding to a freshly launched client.
 *
 * V2 (CONTRACT-V2): onboarding (CLI install + login) backed by ./onboarding,
 * listModels/setSessionModel/setSessionSwarm/listTasks on the client, and
 * lazy cross-agent modules: ./search (M2 — searchAll) and ./updater (M3 —
 * register({ipcMain, send}) wiring kimi:updateCheck / kimi:updateQuitAndInstall).
 * Missing lazy modules degrade to a thrown Error (search/onboarding) or a
 * graceful {status:'dev'} fallback (updates) — never a crash.
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

// ./quota and ./onboarding ship with the app; ./search (M2) and ./updater (M3)
// may not exist yet — all four are lazy so this file loads regardless.
const loadQuota = lazyLoader('./quota');
const loadOnboarding = lazyLoader('./onboarding');
const loadSearch = lazyLoader('./search');
const loadUpdater = lazyLoader('./updater');

function requireClient(getClient) {
  const client = getClient();
  if (!client) {
    throw new Error('kimi server is not running (backend not ready)');
  }
  return client;
}

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

function registerIpc({ getClient, getAppState, getToken, getWindow, broadcast, retryBackend }) {
  const handle = (name, fn) => {
    ipcMain.handle(`kimi:${name}`, (_event, ...args) => fn(...args));
  };

  // getState shape: backend state + onboarding flags (shared by bootstrapRetry).
  const buildState = async () => {
    const appState = getAppState();
    const onboarding = loadOnboarding();
    if (!onboarding) return appState;
    try {
      // Cheap variant: no `kimi --version` spawn on every getState call.
      const ob = await onboarding.getOnboardingState({ withVersion: false });
      return {
        ...appState,
        cliInstalled: ob.cliInstalled,
        loggedIn: ob.loggedIn,
        needsOnboarding: ob.needsOnboarding,
      };
    } catch (err) {
      console.warn(`[kimi-desktop] onboarding state in getState failed: ${err.message}`);
      return appState;
    }
  };

  handle('getState', buildState);

  // --- Onboarding (splash/first-run): CLI install + Kimi login -------------

  handle('onboardingGetState', () => requireOnboarding().getOnboardingState());

  // Progress is pushed as {type:'onboarding', phase:'install', step, message}.
  handle('onboardingInstallCli', () => requireOnboarding().installCli(broadcast));

  // Resolves {verificationUrl, userCode}; completion pushed as
  // {type:'onboarding', phase:'login', status:'done'|'error', message?}.
  handle('onboardingStartLogin', () => requireOnboarding().startLogin(broadcast));

  handle('onboardingCancelLogin', () => requireOnboarding().cancelLogin());

  // Re-run the backend launch once onboarding finished (first launch may have
  // failed with no CLI installed). Returns the fresh state (getState shape).
  handle('bootstrapRetry', async () => {
    if (typeof retryBackend !== 'function') throw new Error('backend retry is unavailable');
    await retryBackend();
    return buildState();
  });

  // --- Sessions / chat options ---------------------------------------------

  // GET /sessions items are snake_case wire objects ({updated_at,
  // metadata:{cwd}, agent_config:{model}, ...}); the preload contract is
  // camelCase: [{ id, title, cwd, updatedAt, busy, usage? }] (+ model).
  handle('listSessions', async () => {
    const items = await requireClient(getClient).listSessions();
    return (Array.isArray(items) ? items : [])
      .filter((s) => s && typeof s.id === 'string' && !s.archived)
      .map((s) => ({
        id: s.id,
        title: typeof s.title === 'string' ? s.title : '',
        cwd: s.metadata?.cwd ?? s.cwd ?? '',
        updatedAt: s.updated_at ?? s.updatedAt ?? null,
        busy: !!(s.busy ?? s.main_turn_active),
        usage: s.usage ?? null,
        model: s.agent_config?.model || null,
      }));
  });

  handle('createSession', async ({ cwd } = {}) => {
    const client = requireClient(getClient);
    const session = await client.createSession({ cwd });
    // Stream the new session's events from the start (first turn included).
    if (session && typeof session.id === 'string') client.subscribeSession(session.id);
    return session;
  });

  handle('pickDirectory', async () => {
    const options = {
      title: '작업 폴더 선택', // pick a working directory for the new session
      properties: ['openDirectory', 'createDirectory'],
    };
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  handle('getMessages', (sessionId) => {
    const client = requireClient(getClient);
    // Viewing a session subscribes it to the WS event stream (idempotent).
    if (typeof sessionId === 'string' && sessionId) client.subscribeSession(sessionId);
    return client.getMessages(sessionId);
  });

  handle('getProfile', (sessionId) => requireClient(getClient).getProfile(sessionId));

  handle('sendPrompt', (sessionId, text) => requireClient(getClient).sendPrompt(sessionId, text));

  handle('steer', (sessionId, text) => requireClient(getClient).steer(sessionId, text));

  handle('abort', (sessionId) => requireClient(getClient).abort(sessionId));

  handle('respondApproval', (sessionId, approvalId, decision) =>
    requireClient(getClient).respondApproval(sessionId, approvalId, decision),
  );

  handle('answerQuestion', (sessionId, tail, body) =>
    requireClient(getClient).answerQuestion(sessionId, tail, body),
  );

  // GET /api/v1/models item (verified live):
  //   {provider, model, display_name, max_context_size, capabilities}
  // Normalized per contract: `alias` is the model id itself — it is both the
  // value setSessionModel() sends and what getState().defaultModel contains,
  // so renderer checkmarks/labels stay consistent. displayName is additive.
  handle('listModels', async () => {
    const items = await requireClient(getClient).listModels();
    return (Array.isArray(items) ? items : [])
      .filter((it) => it && typeof it.model === 'string' && it.model.length > 0)
      .map((it) => ({
        alias: it.model,
        model: it.model,
        displayName: typeof it.display_name === 'string' ? it.display_name : it.model,
      }));
  });

  handle('setSessionModel', (sessionId, model) =>
    requireClient(getClient).setSessionModel(sessionId, model),
  );

  // Swarm mode IS settable per session (verified live: POST profile
  // {agent_config:{swarm_mode}} -> GET /status.swarm_mode), so it is exposed.
  handle('setSessionSwarm', (sessionId, enabled) =>
    requireClient(getClient).setSessionSwarm(sessionId, enabled),
  );

  handle('listTasks', (sessionId) => requireClient(getClient).listTasks(sessionId));

  // --- Cross-agent lazy modules --------------------------------------------

  handle('searchAll', (query, limit) => {
    const search = loadSearch();
    if (!search || typeof search.searchAll !== 'function') {
      throw new Error('search is unavailable (main/search.js not installed)');
    }
    const n = Number.isInteger(limit) && limit > 0 ? limit : 50;
    return search.searchAll(String(query ?? ''), n);
  });

  handle('getQuota', async () => {
    const quota = loadQuota();
    if (!quota || typeof quota.getQuota !== 'function') return null;
    try {
      // Do NOT pass getToken(): that is the local daemon's WS bearer, not an
      // OAuth access token — the quota API rejects it (401 → null). quota.js
      // reads the OAuth credentials from ~/.kimi-code/credentials itself.
      return await quota.getQuota({});
    } catch (err) {
      console.warn(`[kimi-desktop] getQuota failed: ${err.message}`);
      return null; // UI falls back to per-session usage only
    }
  });

  // M3's updater wires kimi:updateCheck / kimi:updateQuitAndInstall itself via
  // register(); fall back to graceful dev stubs when it is absent/broken.
  wireUpdater(broadcast);
  if (!updaterWired) {
    handle('updateCheck', () => ({ status: 'dev' }));
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

/** Forward KimiClient emissions to the renderer as kimi:event payloads. */
function wireClientEvents(client, broadcast) {
  const safe = (fn) => (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error(`[kimi-desktop] event forwarding failed: ${err.message}`);
    }
  };
  client.on(
    'event',
    safe(({ sessionId, event } = {}) => broadcast({ type: 'session', sessionId, event })),
  );
  client.on(
    'usage',
    safe(({ sessionId, usage } = {}) => broadcast({ type: 'usage', sessionId, usage })),
  );
  client.on(
    'status',
    safe(({ ready, error } = {}) => broadcast({ type: 'status', ready, ...(error ? { error } : {}) })),
  );
}

module.exports = { registerIpc, wireClientEvents };
