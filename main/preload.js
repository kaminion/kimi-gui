'use strict';

/**
 * preload.js — exposes the minimal, fixed `window.kimi` API to the renderer.
 * contextIsolation is on and nodeIntegration is off; this is the only bridge.
 *
 * Request/response channels: `kimi:<name>` via ipcRenderer.invoke.
 * Server push events: main sends `kimi:event`; onEvent(cb) subscribes and
 * returns an unsubscribe function.
 *
 * V3 additions (CONTRACT-V3): renameSession, deleteSession, setSessionEffort,
 * setEngine, getDailyUsage. Engine-conditional methods: the preload asks main
 * synchronously (kimi:capabilitiesSync) which engine is active and OMITS
 * engine-specific properties — setSessionSwarm exists only under the 'cli'
 * engine (the UI hides the pill when the property is absent). getState() now
 * also carries { engine, cliInstalled, loggedIn, needsOnboarding }.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (name, ...args) => ipcRenderer.invoke(`kimi:${name}`, ...args);

// Engine capabilities, queried once at preload time (the renderer reloads
// after an engine switch, so this is never stale). On any failure, expose
// everything — v1/v2 behavior, and main + preload always ship together.
let caps = null;
try {
  caps = ipcRenderer.sendSync('kimi:capabilitiesSync');
} catch {
  caps = null;
}
const exposes = (name) => {
  if (!caps || typeof caps !== 'object' || !caps.has || typeof caps.has !== 'object') return true;
  return caps.has[name] !== false;
};

const api = {
  // { ready, version, defaultModel, error?, engine, cliInstalled, loggedIn, needsOnboarding }
  getState: () => invoke('getState'),
  listSessions: () => invoke('listSessions'),
  createSession: ({ cwd } = {}) => invoke('createSession', { cwd }),
  // Native directory picker -> absolute path string | null
  pickDirectory: (defaultPath) => invoke('pickDirectory', defaultPath),
  // New-chat workspace controls.
  getGitInfo: (cwd) => invoke('getGitInfo', cwd),
  checkoutGitBranch: (cwd, branch) => invoke('checkoutGitBranch', cwd, branch),
  getMessages: (sessionId) => invoke('getMessages', sessionId),
  getProfile: (sessionId) => invoke('getProfile', sessionId),
  sendPrompt: (sessionId, text) => invoke('sendPrompt', sessionId, text),
  steer: (sessionId, text) => invoke('steer', sessionId, text),
  abort: (sessionId) => invoke('abort', sessionId),
  // decision: 'approve' | 'reject'
  respondApproval: (sessionId, approvalId, decision) =>
    invoke('respondApproval', sessionId, approvalId, decision),
  answerQuestion: (sessionId, tail, body) => invoke('answerQuestion', sessionId, tail, body),
  getQuota: () => invoke('getQuota'),
  openExternal: (url) => invoke('openExternal', url),
  // Window controls for the menu-less build: 'close' | 'minimize' | 'hide'
  windowAction: (action) => invoke('windowAction', action),
  // Tombstone the shared OAuth credentials (relogin required afterwards)
  logout: () => invoke('logout'),

  // --- Onboarding ------------------------------------------------------------
  // { cliInstalled, cliPath, cliVersion, loggedIn, needsOnboarding }
  onboardingGetState: () => invoke('onboardingGetState'),
  // -> { ok, cliPath }; progress pushed as {type:'onboarding', phase:'install', step, message}
  onboardingInstallCli: () => invoke('onboardingInstallCli'),
  // -> { verificationUrl, userCode }; completion pushed as
  // {type:'onboarding', phase:'login', status:'done'|'error', message?}
  onboardingStartLogin: () => invoke('onboardingStartLogin'),
  onboardingCancelLogin: () => invoke('onboardingCancelLogin'),
  // Re-init the active engine after onboarding; returns the fresh getState().
  bootstrapRetry: () => invoke('bootstrapRetry'),

  // --- Engine (v3) ------------------------------------------------------------
  // Switch engines ('direct' | 'cli'); persists; returns the fresh getState().
  // The renderer reloads afterwards so this preload re-evaluates capabilities.
  setEngine: (engineName) => invoke('setEngine', engineName),

  // --- Chat options / agent work ----------------------------------------------
  // -> [{ alias, model, displayName }] — `alias` is the model id (pass it to
  // setSessionModel; it matches getState().defaultModel).
  listModels: () => invoke('listModels'),
  setSessionModel: (sessionId, modelAlias) => invoke('setSessionModel', sessionId, modelAlias),
  // -> [{ id, session_id, kind, description, status, command?, created_at, ... }]
  listTasks: (sessionId) => invoke('listTasks', sessionId),

  // --- Session rename / delete (v3) -------------------------------------------
  renameSession: (sessionId, title) => invoke('renameSession', sessionId, title),
  deleteSession: (sessionId) => invoke('deleteSession', sessionId),

  // --- Content search (both session roots) -------------------------------------
  // -> [{ sessionId, sessionTitle, cwd, messageId, role, snippet, createdAt }]
  searchAll: (query, limit) => invoke('searchAll', query, limit),

  // --- Daily usage stats (v3, B4 backend) --------------------------------------
  // -> { today:{input_tokens,output_tokens}, days:[{date,input_tokens,output_tokens} ×7] }
  getDailyUsage: () => invoke('getDailyUsage'),

  // --- Auto-update (M3 backend) -------------------------------------------------
  // -> { status:'dev'|'checking'|'available'|'downloading'|'downloaded'|'none'|'error', ... }
  updateCheck: () => invoke('updateCheck'),
  updateDownload: () => invoke('updateDownload'),
  updateQuitAndInstall: () => invoke('updateQuitAndInstall'),
  getAppVersion: () => invoke('getAppVersion'),

  /**
   * Subscribe to ALL push events:
   *   { type: 'status', ready, error? }
   *   { type: 'session', sessionId, event }   // session event passthrough (snake_case)
   *   { type: 'usage', sessionId, usage }
   *   { type: 'onboarding', phase:'install'|'login', step?, message?, status? }
   *   { type: 'update', status, version?, message? }
   * Returns an unsubscribe function.
   */
  onEvent: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('window.kimi.onEvent expects a callback function');
    }
    const listener = (_ipcEvent, payload) => callback(payload);
    ipcRenderer.on('kimi:event', listener);
    return () => {
      ipcRenderer.removeListener('kimi:event', listener);
    };
  },
};

// Engine-conditional methods (CONTRACT-V3): the property must be ABSENT when
// the active engine lacks the capability so `typeof window.kimi.x ===
// 'function'` feature-checks in the renderer hide the corresponding UI.
if (exposes('setSessionSwarm')) {
  // Swarm mode is settable per session (cli engine only; verified: profile
  // agent_config.swarm_mode).
  api.setSessionSwarm = (sessionId, enabled) => invoke('setSessionSwarm', sessionId, enabled);
}
if (exposes('setSessionEffort')) {
  // Thinking effort per session: 'off' | 'low' | 'high' | 'max'.
  api.setSessionEffort = (sessionId, effort) => invoke('setSessionEffort', sessionId, effort);
}

contextBridge.exposeInMainWorld('kimi', api);
