'use strict';

/**
 * backend.js — v3 engine facade (CONTRACT-V3, B3).
 *
 * The ONLY module ipc.js talks to for session/chat methods. Routes every call
 * to one of two engines:
 *
 *   'direct' (default) — CLI-free: B2's ./direct-store (wire-compatible local
 *     sessions) + ./direct-client (Anthropic-compatible POST /coding/v1/messages
 *     agentic loop), login via B1's ./auth (OAuth device flow).
 *   'cli' — the v1/v2 path: spawn `kimi web` via ./server-manager + ./kimi-client.
 *
 * The active engine persists in <userData>/settings.json ({engine}).
 *
 * V4 (M1): in direct mode, legacy CLI sessions on disk
 * (<KIMI_CODE_HOME|~/.kimi-code>/sessions) merge into listSessions via
 * ./cli-sessions, and getMessages/sendPrompt/renameSession/deleteSession route
 * by where the id resolves (direct store first, else the CLI tree). A CLI
 * session continued in direct mode runs the normal direct runTurn against a
 * direct-store shim rooted at that session's workspace dir, so appended turns
 * stay wire-compatible and unknown state.json fields survive.
 *
 * V5: the merge is now bidirectional — switching engines must never hide chat
 * history. In CLI mode listSessions joins the daemon's sessions with the
 * direct-store sessions (engine:'direct', merged newest-first; a broken or
 * missing direct store degrades to daemon-only), and getMessages/getProfile
 * route to the local store when the id resolves there. sendPrompt/steer to a
 * direct-store session in CLI mode are REJECTED with a friendly error event +
 * thrown error (the daemon knows nothing about these local sessions — switch
 * back to the direct engine to continue them), while renameSession/
 * deleteSession stay allowed (purely local file ops).
 *
 * B1/B2 modules are parallel-swarm deliverables: every cross-module require is
 * lazy and guarded — a missing module degrades to a thrown
 * Error('engine unavailable...'), never a crash.
 *
 * Direct-engine push vocabulary (same shapes the renderer already consumes):
 *   {type:'session', sessionId, event:{type:'turn.started'|'turn.ended'|
 *     'assistant.delta'|'thinking.delta'|'tool.call.started'|'tool.result'|
 *     'session.work_changed'|'session.usage_updated'|'approval.requested'|
 *     'approval.resolved'|'error', ...snake_case payload}}
 *   {type:'usage', sessionId, usage:{input_tokens, output_tokens,
 *     cache_read_tokens, cache_creation_tokens, context_tokens, context_limit}}
 *   {type:'status', ready, error?}
 *
 * One active turn per session: concurrent sendPrompt/steer rejects with a
 * friendly error event + a rejected promise. respondApproval resolves the
 * pending tool approval; abort interrupts the turn via AbortController.
 *
 * Never logs tokens or credential contents.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { resolveKimiPath } = require('./server-manager');

// ---------------------------------------------------------------------------
// Static direct-engine facts (CONTRACT-V3 "Verified facts")
// ---------------------------------------------------------------------------

const DIRECT_MODELS = [
  { alias: 'k3', model: 'k3', displayName: 'K3', contextLimit: 1048576 },
  { alias: 'kimi-for-coding', model: 'kimi-for-coding', displayName: 'Kimi for Coding', contextLimit: 262144 },
  { alias: 'kimi-for-coding-highspeed', model: 'kimi-for-coding-highspeed', displayName: 'Kimi for Coding — Highspeed', contextLimit: 262144 },
];
const DEFAULT_DIRECT_MODEL = 'k3';
const DIRECT_EFFORTS = new Set(['off', 'low', 'high', 'max']);
const DEFAULT_DIRECT_EFFORT = 'high';

const BUSY_ERROR = '이전 응답이 아직 생성 중입니다. 잠시 후 다시 시도해 주세요.';
// V5: sending to a direct-store session while the cli engine is active.
const DIRECT_SESSION_REJECT =
  '이 내장 엔진 세션은 설정에서 내장 엔진으로 전환해야 이어갈 수 있습니다.';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let appRef = null;
let sendRef = () => {};
let settingsFile = null;
let currentEngine = 'direct';
let initialized = false;

// cli engine state (a single KimiClient, like v1/v2 main.js held).
const cli = {
  client: null,
  child: null,
  ready: false,
  error: null,
  version: null,
  defaultModel: null,
};
let cliLaunchPromise = null;
let isShuttingDown = false;

// direct engine state: sessionId -> { controller, turnId, contextLimit, approvals: Map<approvalId, resolve> }
const activeTurns = new Map();
// Successful direct-module requires are cached; failures are retried on each
// call (B1/B2 may land later in a dev checkout).
const directMods = { storeMod: null, store: null, client: null, auth: null };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function iso(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/** ms epoch of an ISO timestamp (0 when missing/unparseable) for sort merges. */
function isoToMs(value) {
  const n = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(n) ? n : 0;
}

/** Push a payload to the renderer; never throws (window may be gone). */
function emit(payload) {
  try {
    sendRef(payload);
  } catch {
    /* renderer gone mid-turn */
  }
}

function emitSession(sessionId, event) {
  emit({ type: 'session', sessionId, event });
}

function kimiHome() {
  const home = process.env.KIMI_CODE_HOME;
  return home && home.trim() ? home.trim() : path.join(os.homedir(), '.kimi-code');
}

/** Credentials-file login check (fallback when B1's auth module is absent). */
function checkLoggedInFile() {
  try {
    const file = path.join(kimiHome(), 'credentials', 'kimi-code.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed.access_token === 'string' && parsed.access_token.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Settings persistence (<userData>/settings.json, read-modify-write)
// ---------------------------------------------------------------------------

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const tmp = `${settingsFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, settingsFile);
  } catch (err) {
    console.warn(`[backend] failed to persist settings: ${err.message}`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Lazy cross-module loads (B1 ./auth, B2 ./direct-store + ./direct-client)
// ---------------------------------------------------------------------------

function loadAuth() {
  if (directMods.auth) return directMods.auth;
  try {
    // eslint-disable-next-line global-require
    directMods.auth = require('./auth');
  } catch {
    directMods.auth = null;
  }
  return directMods.auth;
}

// V4 (M1): legacy CLI sessions on disk. Same lazy guarded pattern — a missing
// module degrades to "no CLI sessions merged", never a crash.
let cliSessionsMod = null;
function loadCliSessions() {
  if (cliSessionsMod) return cliSessionsMod;
  try {
    // eslint-disable-next-line global-require
    cliSessionsMod = require('./cli-sessions');
  } catch {
    cliSessionsMod = null;
  }
  return cliSessionsMod;
}

function loadDirect() {
  try {
    if (!directMods.storeMod) {
      // eslint-disable-next-line global-require
      directMods.storeMod = require('./direct-store');
    }
    if (!directMods.client) {
      // eslint-disable-next-line global-require
      directMods.client = require('./direct-client');
    }
  } catch {
    return null;
  }
  const { storeMod, client } = directMods;
  if (!storeMod || !client) return null;
  // B2 ships either a createStore({root}) factory (real) or the contract's
  // module-level API (older stub shape) — accept both.
  if (!directMods.store) {
    try {
      if (typeof storeMod.createStore === 'function') {
        directMods.store = storeMod.createStore({ root: directRoot() });
      } else if (typeof storeMod.list === 'function') {
        directMods.store = storeMod;
        if (typeof storeMod.init === 'function') storeMod.init({ root: directRoot() });
      }
    } catch (err) {
      console.warn(`[backend] direct-store setup failed: ${err.message}`);
      directMods.store = null;
    }
  }
  return directMods.store ? directMods : null;
}

function requireDirect() {
  const d = loadDirect();
  if (!d) {
    throw new Error('engine unavailable: direct modules (main/direct-store.js, main/direct-client.js) not installed');
  }
  return d;
}

function directRoot() {
  return path.join(appRef.getPath('userData'), 'direct-sessions');
}

function isLoggedIn() {
  const auth = loadAuth();
  try {
    if (auth && typeof auth.isLoggedIn === 'function') return !!auth.isLoggedIn();
  } catch {
    /* fall through to the file check */
  }
  return checkLoggedInFile();
}

async function isCliInstalled() {
  try {
    await resolveKimiPath();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

function engine() {
  return currentEngine;
}

function currentStatus() {
  if (currentEngine === 'cli') {
    return { ready: cli.ready, ...(cli.error ? { error: cli.error } : {}) };
  }
  return { ready: loadDirect() != null };
}

function pushStatus() {
  emit({ type: 'status', ...currentStatus() });
}

async function init({ app, send } = {}) {
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('backend.init requires { app } (Electron app or compatible stub)');
  }
  appRef = app;
  sendRef = typeof send === 'function' ? send : () => {};
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const settings = readSettings();
  currentEngine = settings.engine === 'cli' ? 'cli' : 'direct';
  initialized = true;
  // Same as v2: a CLI-engine boot kicks the server launch immediately; failure
  // is surfaced as a status event only (renderer routes to onboarding).
  if (currentEngine === 'cli') {
    ensureCliLaunched().catch(() => { /* error already recorded in cli state */ });
  }
}

/**
 * Switch engines. Persists {engine}; leaving 'cli' shuts the kimi server
 * down, entering 'cli' spins it up. The renderer reloads afterwards.
 */
async function setEngine(next) {
  const target = next === 'cli' ? 'cli' : 'direct';
  if (!initialized) throw new Error('backend is not initialized');
  if (target === currentEngine) return { engine: currentEngine };
  const previous = currentEngine;
  currentEngine = target;
  writeSettings({ engine: target });
  if (previous === 'cli') await shutdownCli();
  if (target === 'cli') {
    ensureCliLaunched().catch(() => { /* surfaced via status */ });
  }
  pushStatus();
  return { engine: currentEngine };
}

/** bootstrapRetry: re-init the active engine after onboarding completes. */
async function retry() {
  if (currentEngine !== 'cli') return; // direct has no process to relaunch
  await shutdownCli();
  await ensureCliLaunched();
}

async function shutdown() {
  isShuttingDown = true;
  // Interrupt every in-flight direct turn.
  for (const [sessionId, turn] of activeTurns) {
    for (const resolve of turn.approvals.values()) {
      try { resolve('rejected'); } catch { /* settled */ }
    }
    turn.approvals.clear();
    try { turn.controller.abort(); } catch { /* ignore */ }
    activeTurns.delete(sessionId);
  }
  await shutdownCli();
}

// ---------------------------------------------------------------------------
// CLI engine branch (the v1/v2 KimiClient path, moved out of main.js)
// ---------------------------------------------------------------------------

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

function ensureCliLaunched() {
  if (cli.client && cli.ready) return Promise.resolve();
  if (cliLaunchPromise) return cliLaunchPromise;
  cliLaunchPromise = doLaunchCli().finally(() => {
    cliLaunchPromise = null;
  });
  return cliLaunchPromise;
}

async function doLaunchCli() {
  await shutdownCli();
  try {
    const { KimiClient } = loadKimiClient();
    // Resolve the binary explicitly (env KIMI_CLI_PATH -> PATH lookup ->
    // ~/.kimi-code/bin) so a CLI installed by onboarding is found even when
    // the app was launched from Finder with a minimal PATH.
    const kimiPath = await resolveKimiPath();
    const { client, child } = await KimiClient.launch({ kimiPath });
    cli.client = client;
    cli.child = child;
    cli.error = null;
    wireCliEvents(client, child);
    console.log('[backend] cli engine ready');

    // Open the event WebSocket and subscribe to all known sessions so live
    // traffic flows even for sessions the renderer has not selected yet.
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
      cli.version = (meta && meta.server_version) ?? null;
    } catch {
      cli.version = null;
    }
    try {
      const auth = await client.auth();
      cli.defaultModel = (auth && auth.default_model) ?? null;
    } catch {
      cli.defaultModel = null;
    }
    cli.ready = true;
    pushStatus();
  } catch (err) {
    cli.ready = false;
    cli.error = err.message;
    console.error(`[backend] cli engine launch failed: ${err.message}`);
    pushStatus();
  }
}

function wireCliEvents(client, child) {
  const safe = (fn) => (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error(`[backend] cli event forwarding failed: ${err.message}`);
    }
  };
  client.on('event', safe(({ sessionId, event } = {}) => emitSession(sessionId, event)));
  client.on('usage', safe(({ sessionId, usage } = {}) => emit({ type: 'usage', sessionId, usage })));
  client.on(
    'status',
    safe(({ ready, error } = {}) => {
      if (client !== cli.client) return; // superseded
      cli.ready = !!ready;
      cli.error = error ?? null;
      pushStatus();
    }),
  );
  if (child) {
    child.once('exit', (code, signal) => {
      if (isShuttingDown || client !== cli.client) return;
      cli.ready = false;
      cli.client = null;
      cli.child = null;
      cli.error = `kimi server exited unexpectedly (code ${code}, signal ${signal})`;
      pushStatus();
    });
  }
}

async function shutdownCli() {
  const client = cli.client;
  cli.client = null;
  cli.child = null;
  cli.ready = false;
  if (!client) return;
  try {
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    await Promise.race([client.shutdown(), timeout]);
  } catch (err) {
    console.warn(`[backend] cli shutdown failed: ${err.message}`);
  }
}

function requireCli() {
  if (!cli.client) {
    throw new Error(cli.error || 'engine unavailable: kimi server is not running (cli engine not ready)');
  }
  return cli.client;
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

async function getState() {
  const [cliInstalled, loggedIn] = await Promise.all([isCliInstalled(), Promise.resolve(isLoggedIn())]);
  return {
    ...currentStatus(),
    version: currentEngine === 'cli' ? cli.version : null,
    defaultModel: currentEngine === 'cli' ? cli.defaultModel : DEFAULT_DIRECT_MODEL,
    engine: currentEngine,
    cliInstalled,
    loggedIn,
    needsOnboarding: !loggedIn, // engine-independent (CONTRACT-V3)
  };
}

/** What the preload conditionally exposes (sync, for the capabilities channel). */
function capabilities() {
  return {
    engine: currentEngine,
    has: {
      // Swarm is cli-only: in direct mode the property must be ABSENT from the
      // preload result so the UI hides the pill.
      setSessionSwarm: currentEngine === 'cli',
      // Verified live: cli accepts agent_config.thinking; direct stores a flag.
      setSessionEffort: true,
      renameSession: true,
      deleteSession: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Sessions — list / create / read
// ---------------------------------------------------------------------------

function normalizeCliSession(s) {
  return {
    id: s.id,
    title: typeof s.title === 'string' ? s.title : '',
    cwd: s.metadata?.cwd ?? s.cwd ?? '',
    updatedAt: s.updated_at ?? s.updatedAt ?? null,
    busy: !!(s.busy ?? s.main_turn_active),
    usage: s.usage ?? null,
    model: s.agent_config?.model || null,
    effort: s.agent_config?.thinking || null,
    engine: 'cli',
  };
}

/**
 * V4 (M1, direct mode): resolve where a session id lives. The direct store
 * wins; otherwise the id is looked up in the legacy CLI tree and a direct-store
 * shim rooted at that session's workspace dir is returned (same get/getMessages/
 * appendTurn/setConfig/usageByDay surface, unknown state.json fields preserved).
 * Returns { store, origin: 'direct'|'cli' } or null when the id resolves nowhere.
 */
async function resolveDirectSessionStore(sessionId) {
  const d = requireDirect();
  try {
    const s = await Promise.resolve(d.store.get(sessionId));
    if (s && typeof s === 'object') return { store: d.store, origin: 'direct' };
  } catch {
    /* fall through to the CLI lookup */
  }
  const cliSessions = loadCliSessions();
  if (cliSessions && typeof cliSessions.storeFor === 'function') {
    try {
      const shim = await Promise.resolve(cliSessions.storeFor(sessionId));
      if (shim) return { store: shim, origin: 'cli' };
    } catch {
      /* unresolved */
    }
  }
  return null;
}

/**
 * V5 (cli mode): resolve an id against the DIRECT STORE ONLY — never the
 * legacy CLI tree, whose sessions belong to the daemon in cli mode. Returns
 * { store } or null. Guarded: missing/broken direct modules resolve to null.
 */
async function resolveDirectStoreOnly(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  let d = null;
  try {
    d = loadDirect();
  } catch {
    return null;
  }
  if (!d) return null;
  try {
    const s = await Promise.resolve(d.store.get(sessionId));
    if (s && typeof s === 'object') return { store: d.store };
  } catch {
    /* not a direct-store session */
  }
  return null;
}

/**
 * V5 (cli mode): direct-store sessions in the same normalized shape the
 * direct branch emits (engine:'direct', idle). Guarded — any failure yields
 * [] so listSessions degrades to the daemon-only list.
 */
async function listDirectStoreSessions() {
  let d = null;
  try {
    d = loadDirect();
  } catch {
    return [];
  }
  if (!d) return [];
  try {
    const items = await Promise.resolve(d.store.list());
    return (Array.isArray(items) ? items : [])
      .filter((s) => s && typeof s.id === 'string')
      .map((s) => ({
        id: s.id,
        title: typeof s.title === 'string' ? s.title : '',
        cwd: s.cwd ?? '',
        updatedAt: s.updatedAt ?? null,
        busy: activeTurns.has(s.id),
        usage: s.usage ?? null,
        model: s.model ?? null,
        effort: s.effort ?? null,
        engine: 'direct',
      }));
  } catch (err) {
    console.warn(`[backend] direct-store session listing failed (cli engine): ${err.message}`);
    return [];
  }
}

async function listSessions() {
  if (currentEngine === 'cli') {
    const items = await requireCli().listSessions();
    const cliItems = (Array.isArray(items) ? items : [])
      .filter((s) => s && typeof s.id === 'string' && !s.archived)
      .map(normalizeCliSession);
    // V5: direct-store sessions merge into the cli list too (dedupe by id,
    // direct wins; combined list sorted newest-first) so switching engines
    // never hides local chat history.
    const directItems = await listDirectStoreSessions();
    const directIds = new Set(directItems.map((s) => s.id));
    const merged = directItems.concat(cliItems.filter((s) => !directIds.has(s.id)));
    merged.sort((a, b) => isoToMs(b.updatedAt) - isoToMs(a.updatedAt));
    return merged;
  }
  const d = requireDirect();
  const items = await Promise.resolve(d.store.list());
  const directItems = (Array.isArray(items) ? items : [])
    .filter((s) => s && typeof s.id === 'string')
    .map((s) => ({
      id: s.id,
      title: typeof s.title === 'string' ? s.title : '',
      cwd: s.cwd ?? '',
      updatedAt: s.updatedAt ?? null,
      busy: activeTurns.has(s.id) || !!s.busy,
      usage: s.usage ?? null,
      model: s.model ?? null,
      effort: s.effort ?? null,
      engine: 'direct',
    }));
  // V4 (M1): legacy CLI sessions merge into the same list — dedupe by id
  // (direct wins), combined list sorted newest-first by updatedAt. A missing
  // ~/.kimi-code or cli-sessions module just yields no extra items.
  let cliItems = [];
  const cliSessions = loadCliSessions();
  if (cliSessions && typeof cliSessions.list === 'function') {
    try {
      const legacy = await Promise.resolve(cliSessions.list());
      cliItems = (Array.isArray(legacy) ? legacy : [])
        .filter((s) => s && typeof s.id === 'string')
        .map((s) => ({
          id: s.id,
          title: typeof s.title === 'string' ? s.title : '',
          cwd: s.cwd ?? '',
          updatedAt: s.updatedAt ?? null,
          busy: activeTurns.has(s.id),
          usage: null,
          model: s.model ?? null,
          effort: s.effort ?? null,
          engine: 'cli',
        }));
    } catch (err) {
      console.warn(`[backend] cli session listing failed: ${err.message}`);
    }
  }
  const directIds = new Set(directItems.map((s) => s.id));
  const merged = directItems.concat(cliItems.filter((s) => !directIds.has(s.id)));
  merged.sort((a, b) => isoToMs(b.updatedAt) - isoToMs(a.updatedAt));
  return merged;
}

async function createSession({ cwd } = {}) {
  if (currentEngine === 'cli') {
    const client = requireCli();
    const session = await client.createSession({ cwd });
    // Stream the new session's events from the start (first turn included).
    if (session && typeof session.id === 'string') client.subscribeSession(session.id);
    return session;
  }
  const d = requireDirect();
  const session = await Promise.resolve(d.store.create({ cwd }));
  return { engine: 'direct', ...session };
}

async function getMessages(sessionId) {
  if (currentEngine === 'cli') {
    // V5: a direct-store id reads from the local store (plain files — this
    // keeps working even when the daemon is down).
    const resolved = await resolveDirectStoreOnly(sessionId);
    if (resolved) return Promise.resolve(resolved.store.getMessages(sessionId));
    const client = requireCli();
    // Viewing a session subscribes it to the WS event stream (idempotent).
    if (typeof sessionId === 'string' && sessionId) client.subscribeSession(sessionId);
    return client.getMessages(sessionId);
  }
  const d = requireDirect();
  // V4: route by where the id resolves (direct store first, else CLI tree).
  // Unresolved ids fall back to the direct store, which returns [] for missing.
  const resolved = await resolveDirectSessionStore(sessionId);
  const store = resolved ? resolved.store : d.store;
  return Promise.resolve(store.getMessages(sessionId));
}

function contextLimitFor(model) {
  const found = DIRECT_MODELS.find((m) => m.model === model);
  return found ? found.contextLimit : 262144; // defensive: some k3 tiers are 256k
}

/** Sum raw store usage rows defensively (B2 owns the row shape). */
function sumUsageRows(rows) {
  let input = 0;
  let output = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    input += num(r.input_tokens ?? r.input ?? r.prompt_tokens);
    output += num(r.output_tokens ?? r.output ?? r.completion_tokens);
  }
  return { input, output, turns: Array.isArray(rows) ? rows.length : 0 };
}

/**
 * Synthesized REST-shaped profile for a store-backed session. Shared by the
 * direct branch and by V5 cli-mode direct sessions so the context meter never
 * errors regardless of the active engine.
 */
async function synthesizeProfile(store, sessionId) {
  const s = await Promise.resolve(store.get(sessionId));
  if (!s || typeof s !== 'object') throw new Error(`session not found: ${sessionId}`);
  const model = s.model || DEFAULT_DIRECT_MODEL;
  let totals = { input: 0, output: 0, turns: 0 };
  try {
    totals = sumUsageRows(await Promise.resolve(store.usageByDay(sessionId)));
  } catch {
    /* usage is best-effort */
  }
  const contextTokens = totals.input + totals.output;
  return {
    id: sessionId,
    title: typeof s.title === 'string' ? s.title : '',
    created_at: iso(s.createdAt),
    updated_at: iso(s.updatedAt),
    busy: activeTurns.has(sessionId),
    archived: false,
    metadata: { cwd: s.cwd ?? '' },
    agent_config: { model, thinking: s.effort || DEFAULT_DIRECT_EFFORT },
    usage: {
      input_tokens: totals.input,
      output_tokens: totals.output,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: contextTokens,
      context_limit: contextLimitFor(model),
      turn_count: num(s.turnCount) || totals.turns,
    },
    engine: 'direct',
  };
}

async function getProfile(sessionId) {
  if (currentEngine === 'cli') {
    // V5: a direct-store session gets the same synthesized profile as in
    // direct mode; every other id belongs to the daemon.
    const resolved = await resolveDirectStoreOnly(sessionId);
    if (resolved) return synthesizeProfile(resolved.store, sessionId);
    return requireCli().getProfile(sessionId);
  }
  const d = requireDirect();
  // V4: route by id resolution so a CLI-origin session opened in direct mode
  // still yields a profile (shim store reads the same state.json + wire.jsonl).
  const resolved = await resolveDirectSessionStore(sessionId);
  const store = resolved ? resolved.store : d.store;
  return synthesizeProfile(store, sessionId);
}

// ---------------------------------------------------------------------------
// Direct engine — turn execution
// ---------------------------------------------------------------------------

function modelContextLimit(session) {
  return contextLimitFor(session && session.model ? session.model : DEFAULT_DIRECT_MODEL);
}

/** Map B2's (Anthropic-shaped) usage to the snake_case push vocabulary. */
function pushDirectUsage(sessionId, raw, contextLimit) {
  const u = raw && typeof raw === 'object' ? raw : {};
  const input = num(u.input_tokens ?? u.input ?? u.prompt_tokens);
  const output = num(u.output_tokens ?? u.output ?? u.completion_tokens);
  const cacheRead = num(u.cache_read_tokens ?? u.cache_read_input_tokens);
  const cacheCreation = num(u.cache_creation_tokens ?? u.cache_creation_input_tokens);
  const usage = {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    // Per-turn input is the closest proxy for how full the context window is.
    context_tokens: input + cacheRead + cacheCreation,
    context_limit: contextLimit ?? 0,
  };
  emit({ type: 'usage', sessionId, usage });
  emitSession(sessionId, { type: 'session.usage_updated', ...usage });
}

function requestDirectApproval(sessionId, turn, tool) {
  const approvalId = `appr_${randomUUID()}`;
  const t = tool && typeof tool === 'object' ? tool : {};
  const toolName = t.name ?? t.tool_name ?? 'tool';
  return new Promise((resolve) => {
    turn.approvals.set(approvalId, resolve);
    emitSession(sessionId, {
      type: 'approval.requested',
      approval_id: approvalId,
      session_id: sessionId,
      tool_call_id: t.id ?? t.tool_call_id ?? approvalId,
      tool_name: toolName,
      action: t.action ?? toolName,
      tool_input_display: t.input ?? t.args ?? null,
      created_at: new Date().toISOString(),
    });
  });
}

async function directSendPrompt(sessionId, text) {
  const d = requireDirect();
  if (activeTurns.has(sessionId)) {
    // One active turn per session: reject concurrent sends with a friendly
    // error event (and a rejected promise for the IPC caller).
    emitSession(sessionId, { type: 'error', message: BUSY_ERROR });
    throw new Error(BUSY_ERROR);
  }
  // V4: a CLI-origin session continues in direct mode via the shim store over
  // its workspace dir (runTurn appends through store.appendTurn, which keeps
  // the wire format and every unknown state.json field intact).
  let store = d.store;
  let session = await Promise.resolve(store.get(sessionId));
  if (!session || typeof session !== 'object') {
    const resolved = await resolveDirectSessionStore(sessionId);
    if (resolved) {
      store = resolved.store;
      session = await Promise.resolve(store.get(sessionId));
    }
  }
  if (!session || typeof session !== 'object') {
    throw new Error(`session not found: ${sessionId}`);
  }

  const controller = new AbortController();
  const turnId = `turn_${randomUUID()}`;
  const turn = {
    controller,
    turnId,
    contextLimit: modelContextLimit(session),
    approvals: new Map(),
  };
  activeTurns.set(sessionId, turn);

  emitSession(sessionId, { type: 'turn.started', turn_id: turnId });
  emitSession(sessionId, { type: 'session.work_changed', busy: true, main_turn_active: true });

  const hooks = {
    onDelta: (delta) => {
      if (typeof delta === 'string' && delta) {
        emitSession(sessionId, { type: 'assistant.delta', turn_id: turnId, delta });
      }
    },
    onThinking: (delta) => {
      if (typeof delta === 'string' && delta) {
        emitSession(sessionId, { type: 'thinking.delta', turn_id: turnId, delta });
      }
    },
    onToolStart: (tool) => {
      const t = tool && typeof tool === 'object' ? tool : {};
      emitSession(sessionId, {
        type: 'tool.call.started',
        tool_call_id: t.id ?? t.tool_call_id ?? `tool_${randomUUID()}`,
        tool_name: t.name ?? t.tool_name ?? 'tool',
        args: t.input ?? t.args ?? null,
      });
    },
    onToolEnd: (tool, result) => {
      const t = tool && typeof tool === 'object' ? tool : {};
      const r = result && typeof result === 'object' ? result : {};
      emitSession(sessionId, {
        type: 'tool.result',
        tool_call_id: t.id ?? t.tool_call_id ?? '',
        is_error: !!(r.is_error ?? r.isError),
      });
    },
    requireApproval: (tool) => requestDirectApproval(sessionId, turn, tool),
    onUsage: (usage) => pushDirectUsage(sessionId, usage, turn.contextLimit),
  };

  // The turn runs async; sendPrompt returns immediately. runTurn persists the
  // completed turn via store.appendTurn itself (CONTRACT-V3 B2).
  (async () => {
    let reason = 'completed';
    try {
      await d.client.runTurn({
        store,
        sessionId,
        cwd: session.cwd,
        model: session.model || DEFAULT_DIRECT_MODEL,
        effort: session.effort || DEFAULT_DIRECT_EFFORT,
        prompt: String(text),
        signal: controller.signal,
        hooks,
      });
      if (controller.signal.aborted) reason = 'aborted';
    } catch (err) {
      reason = controller.signal.aborted ? 'aborted' : 'failed';
      if (reason === 'failed') {
        console.error(`[backend] direct turn failed: ${err.message}`);
        emitSession(sessionId, { type: 'error', message: err.message });
      }
    } finally {
      // Resolve any dangling approvals so runTurn can unwind, then unlock.
      for (const resolve of turn.approvals.values()) {
        try { resolve('rejected'); } catch { /* already settled */ }
      }
      turn.approvals.clear();
      activeTurns.delete(sessionId);
      emitSession(sessionId, { type: 'turn.ended', turn_id: turnId, reason });
      emitSession(sessionId, {
        type: 'session.work_changed',
        busy: false,
        main_turn_active: false,
        last_turn_reason: reason,
      });
    }
  })();

  return { prompt_id: `prompt_${randomUUID()}`, turn_id: turnId, status: 'started' };
}

// ---------------------------------------------------------------------------
// Sessions — prompt / steer / abort / approvals / questions
// ---------------------------------------------------------------------------

/**
 * V5 (cli mode): a direct-store session cannot continue under the cli engine
 * (the daemon knows nothing about these local sessions — attempting a daemon
 * injection would just 404 or pollute the daemon's tree). Rejects with the
 * friendly error event + a thrown error. Checked BEFORE requireCli() so the
 * rejection works even when the daemon is down.
 */
async function rejectIfDirectSession(sessionId) {
  if (await resolveDirectStoreOnly(sessionId)) {
    emitSession(sessionId, { type: 'error', message: DIRECT_SESSION_REJECT });
    throw new Error(DIRECT_SESSION_REJECT);
  }
}

async function sendPrompt(sessionId, text) {
  if (currentEngine === 'cli') {
    await rejectIfDirectSession(sessionId);
    return requireCli().sendPrompt(sessionId, text);
  }
  return directSendPrompt(sessionId, text);
}

async function steer(sessionId, text) {
  if (currentEngine === 'cli') {
    await rejectIfDirectSession(sessionId);
    return requireCli().steer(sessionId, text);
  }
  if (activeTurns.has(sessionId)) {
    const message = '실행 중에는 스티어할 수 없습니다. 응답이 끝난 후 다시 시도해 주세요.';
    emitSession(sessionId, { type: 'error', message });
    throw new Error(message);
  }
  return directSendPrompt(sessionId, text);
}

/** Interrupt a direct-engine turn (no-op when idle); true when one was active. */
function abortDirectTurn(sessionId) {
  const turn = activeTurns.get(sessionId);
  if (!turn) return false;
  for (const resolve of turn.approvals.values()) {
    try { resolve('rejected'); } catch { /* already settled */ }
  }
  turn.approvals.clear();
  try { turn.controller.abort(); } catch { /* ignore */ }
  return true;
}

async function abort(sessionId) {
  if (currentEngine === 'cli') return requireCli().abort(sessionId);
  return { ok: abortDirectTurn(sessionId) };
}

async function respondApproval(sessionId, approvalId, decision) {
  if (currentEngine === 'cli') return requireCli().respondApproval(sessionId, approvalId, decision);
  const turn = activeTurns.get(sessionId);
  const resolve = turn ? turn.approvals.get(approvalId) : null;
  if (!resolve) throw new Error('approval not found (already resolved or the turn has ended)');
  turn.approvals.delete(approvalId);
  const map = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' };
  const wire = map[decision] ?? decision;
  // B2's requireApproval promise settles to 'approved' | 'rejected'.
  resolve(wire === 'approved' ? 'approved' : 'rejected');
  emitSession(sessionId, { type: 'approval.resolved', approval_id: approvalId, decision: wire });
  return { ok: true };
}

async function answerQuestion(sessionId, tail, body) {
  if (currentEngine === 'cli') return requireCli().answerQuestion(sessionId, tail, body);
  throw new Error('questions are not supported by the direct engine');
}

// ---------------------------------------------------------------------------
// Sessions — options / rename / delete / tasks
// ---------------------------------------------------------------------------

async function listModels() {
  if (currentEngine === 'cli') {
    const items = await requireCli().listModels();
    // Normalized per contract: `alias` is the model id itself (both what
    // setSessionModel sends and what getState().defaultModel contains).
    return (Array.isArray(items) ? items : [])
      .filter((it) => it && typeof it.model === 'string' && it.model.length > 0)
      .map((it) => ({
        alias: it.model,
        model: it.model,
        displayName: typeof it.display_name === 'string' ? it.display_name : it.model,
      }));
  }
  return DIRECT_MODELS.map((m) => ({ alias: m.alias, model: m.model, displayName: m.displayName }));
}

/**
 * Persist a flag on a direct session. Prefers B2's setConfig (or update);
 * otherwise patches the session's state.json directly (its layout is fixed by
 * CONTRACT-V3) AND any live object the store hands out (stores that cache
 * get() results in memory).
 */
async function patchDirectSession(store, sessionId, patch) {
  if (typeof store.setConfig === 'function') {
    await Promise.resolve(store.setConfig(sessionId, patch));
    return;
  }
  if (typeof store.update === 'function') {
    await Promise.resolve(store.update(sessionId, patch));
    return;
  }
  const file = path.join(directRoot(), sessionId, 'state.json');
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* state.json may not exist yet */
  }
  if (state && typeof state === 'object') {
    Object.assign(state, patch);
    state.updatedAt = Date.now();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }
  try {
    const live = await Promise.resolve(store.get(sessionId));
    if (live && typeof live === 'object') {
      Object.assign(live, patch);
    } else if (!state) {
      throw new Error(`session not found: ${sessionId}`);
    }
  } catch (err) {
    if (!state) throw err; // neither file nor live object: the session is gone
  }
}

async function setSessionModel(sessionId, model) {
  if (currentEngine === 'cli') return requireCli().setSessionModel(sessionId, model);
  const d = requireDirect();
  const alias = String(model ?? '');
  if (!DIRECT_MODELS.some((m) => m.model === alias)) {
    throw new Error(`unknown direct model: ${alias}`);
  }
  // V4: route by id resolution — a CLI-origin session's state.json gets the
  // same {model} flag through the shim store's setConfig (unknown fields kept).
  const resolved = await resolveDirectSessionStore(sessionId);
  if (!resolved) throw new Error(`session not found: ${sessionId}`);
  await patchDirectSession(resolved.store, sessionId, { model: alias });
  return { ok: true };
}

async function setSessionSwarm(sessionId, enabled) {
  if (currentEngine === 'cli') return requireCli().setSessionSwarm(sessionId, enabled);
  // Preload omits setSessionSwarm in direct mode (UI hides the pill).
  throw new Error('swarm mode is only available with the cli engine');
}

async function setSessionEffort(sessionId, effort) {
  const value = String(effort ?? '');
  if (!DIRECT_EFFORTS.has(value)) throw new Error(`unknown thinking effort: ${value}`);
  if (currentEngine === 'cli') {
    // Verified live: POST /sessions/{id}/profile {agent_config:{thinking}} and
    // GET /sessions/{id}/status reflects it as thinking_level.
    return requireCli().setSessionThinking(sessionId, value);
  }
  const d = requireDirect();
  // V4: route by id resolution (same shim-store path as setSessionModel).
  const resolved = await resolveDirectSessionStore(sessionId);
  if (!resolved) throw new Error(`session not found: ${sessionId}`);
  await patchDirectSession(resolved.store, sessionId, { effort: value });
  return { ok: true };
}

async function renameSession(sessionId, title) {
  const clean = String(title ?? '').trim();
  if (!clean) throw new Error('title must not be empty');
  if (currentEngine === 'cli') {
    // V5: renaming a direct-store session is a local file op — allowed.
    const resolved = await resolveDirectStoreOnly(sessionId);
    if (resolved) return Promise.resolve(resolved.store.rename(sessionId, clean));
    // Verified live: POST /sessions/{id}/profile {title} renames (list +
    // state.json reflect it, isCustomTitle is set server-side).
    return requireCli().renameSession(sessionId, clean);
  }
  const d = requireDirect();
  // V4: route by id resolution — CLI-origin sessions are renamed in place via
  // cli-sessions (read-modify-write, isCustomTitle=true, unknown fields kept).
  const resolved = await resolveDirectSessionStore(sessionId);
  if (resolved && resolved.origin === 'cli') {
    const cliSessions = loadCliSessions();
    return Promise.resolve(cliSessions.rename(sessionId, clean));
  }
  return Promise.resolve(d.store.rename(sessionId, clean));
}

async function deleteSession(sessionId) {
  if (currentEngine === 'cli') {
    // V5: deleting a direct-store session is a local file op — allowed
    // (interrupt a locally-active turn first, same as the direct branch).
    const resolved = await resolveDirectStoreOnly(sessionId);
    if (resolved) {
      abortDirectTurn(sessionId);
      return Promise.resolve(resolved.store.remove(sessionId));
    }
    const client = requireCli();
    try { client.unsubscribeSession(sessionId); } catch { /* ignore */ }
    // Soft-delete: POST /sessions/{id}:archive (verified live); the list
    // filter already hides archived sessions.
    return client.archiveSession(sessionId);
  }
  const d = requireDirect();
  await abort(sessionId); // no-op when idle
  // V4: deleting a CLI-origin session = archive on disk (never rm the CLI's
  // transcript); direct-native sessions are removed as before.
  const resolved = await resolveDirectSessionStore(sessionId);
  if (resolved && resolved.origin === 'cli') {
    const cliSessions = loadCliSessions();
    return Promise.resolve(cliSessions.archive(sessionId));
  }
  return Promise.resolve(d.store.remove(sessionId));
}

async function listTasks(sessionId) {
  if (currentEngine === 'cli') return requireCli().listTasks(sessionId);
  return []; // direct engine has no background-task API
}

// ---------------------------------------------------------------------------
// Search (both session roots)
// ---------------------------------------------------------------------------

let searchMod = null;
function loadSearch() {
  if (searchMod) return searchMod;
  try {
    // eslint-disable-next-line global-require
    searchMod = require('./search');
  } catch {
    searchMod = null;
  }
  return searchMod;
}

async function searchAll(query, limit) {
  const search = loadSearch();
  if (!search || typeof search.searchAll !== 'function') {
    throw new Error('search is unavailable (main/search.js not installed)');
  }
  const n = Number.isInteger(limit) && limit > 0 ? limit : 50;
  // Covers BOTH roots: ~/.kimi-code/sessions (cli) + <userData>/direct-sessions.
  return search.searchAll(String(query ?? ''), n, { extraRoots: [directRoot()] });
}

// ---------------------------------------------------------------------------

module.exports = {
  init,
  engine,
  setEngine,
  retry,
  shutdown,
  getState,
  currentStatus,
  pushStatus,
  capabilities,
  listSessions,
  createSession,
  getMessages,
  getProfile,
  sendPrompt,
  steer,
  abort,
  respondApproval,
  answerQuestion,
  listModels,
  setSessionModel,
  setSessionSwarm,
  setSessionEffort,
  renameSession,
  deleteSession,
  listTasks,
  searchAll,
  // Exposed for main.js's did-finish-load hook and tests:
  ensureCliLaunched,
  DIRECT_MODELS,
};
