'use strict';

/**
 * auth.js — CLI-free Kimi OAuth for Kimi-GUI v3 (CONTRACT-V3, B1).
 *
 * RFC 8628 device authorization flow against https://auth.kimi.com, wire-
 * compatible with the Kimi Code CLI (`kimi login`) so the app and the CLI can
 * share one login. All requests are `application/x-www-form-urlencoded`
 * (the CLI uses postForm; JSON bodies are rejected by the server).
 *
 *   POST /api/oauth/device_authorization   {client_id}
 *     -> 200 {device_code, user_code, verification_uri,
 *             verification_uri_complete, expires_in, interval}
 *   POST /api/oauth/token                  {client_id, device_code,
 *                                           grant_type:'urn:ietf:params:oauth:grant-type:device_code'}
 *     -> 200 {access_token, refresh_token, expires_in, token_type, scope}
 *        or RFC 8628 errors: authorization_pending / slow_down /
 *        expired_token / access_denied / invalid_grant (HTTP 400)
 *   POST /api/oauth/token                  {client_id, grant_type:'refresh_token',
 *                                           refresh_token}
 *     -> 200 same token shape; 400 invalid_grant when the grant is dead
 *
 * client_id is the CLI's public device-flow client (KIMI_CODE_FLOW_CONFIG in
 * the CLI binary). NOTE: the literal string 'kimi-code-cli' is NOT a valid
 * client_id — the server answers 401 invalid_client. The registered id is
 * the UUID below.
 *
 * Credentials are stored CLI-compatible at
 *   <KIMI_CODE_HOME || ~/.kimi-code>/credentials/kimi-code.json
 *   {access_token, refresh_token, expires_at (unix SECONDS), token_type,
 *    scope, expires_in}
 * written atomically (tmp file + rename) with mode 0600. The CLI re-reads
 * this file on its own runs, so this module always re-reads before use and
 * never caches credentials.
 *
 * Never logs token values — only HTTP statuses and OAuth error codes.
 *
 * Exports (contract):
 *   getCredentials()  -> {access_token, refresh_token, expires_at, ...} | null  (sync)
 *   getAccessToken()  -> Promise<string|null>  auto-refreshes when the token
 *                        expires within 60s; concurrent calls share one refresh
 *   isLoggedIn()      -> bool (sync; non-empty access_token)
 *   startDeviceLogin()-> Promise<{userCode, verificationUrl, verificationUrlComplete}>
 *                        polling runs in background; completion is pushed to
 *                        onLoginDone callbacks as {status:'done'|'error'|'cancelled', code?, message?}
 *   onLoginDone(cb)   -> unsubscribe fn
 *   cancelLogin()     -> {ok}   stops the in-flight poll, fires {status:'cancelled'}
 *   logout()          -> {ok}   tombstones the creds file (empties both tokens)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_OAUTH_HOST = 'https://auth.kimi.com';
// Public device-flow client id, from KIMI_CODE_FLOW_CONFIG in the CLI binary.
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
// The server is only verified with the CLI's own UA; mimic it.
const USER_AGENT = 'kimi-code-cli/0.28.1';

const EXPIRY_SKEW_MS = 60 * 1000; // refresh when the token expires within 60s
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_POLL_INTERVAL_S = 5;
const DEFAULT_DEVICE_EXPIRES_S = 1800; // observed live value
const SLOW_DOWN_BACKOFF_S = 5; // RFC 8628 §3.5: add 5s on slow_down
const MAX_POLL_NET_ERRORS = 5; // consecutive network/5xx failures before giving up
const REFRESH_MAX_RETRIES = 3; // mirrors the CLI's refreshAccessToken

// ------------------------------------------------------------------ paths --

/** Kimi Code home directory (honors KIMI_CODE_HOME like the CLI does). */
function kimiHome() {
  const home = process.env.KIMI_CODE_HOME;
  return home && home.trim() ? home.trim() : path.join(os.homedir(), '.kimi-code');
}

function credentialsPath() {
  return path.join(kimiHome(), 'credentials', 'kimi-code.json');
}

/** OAuth host — same env overrides as the CLI (KIMI_CODE_OAUTH_HOST / KIMI_OAUTH_HOST). */
function oauthHost() {
  const host = process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST;
  return (host && host.trim() ? host.trim() : DEFAULT_OAUTH_HOST).replace(/\/+$/, '');
}

// --------------------------------------------------------- credentials io --

/**
 * Read and parse the CLI-compatible credentials file.
 * @returns {object|null} parsed credentials, or null when missing/corrupt.
 */
function getCredentials() {
  let raw;
  try {
    raw = fs.readFileSync(credentialsPath(), 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function accessTokenOf(creds) {
  const token = creds && (creds.access_token ?? creds.accessToken);
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function refreshTokenOf(creds) {
  const token = creds && (creds.refresh_token ?? creds.refreshToken);
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/** True when the credentials file exists with a non-empty access_token. */
function isLoggedIn() {
  return accessTokenOf(getCredentials()) !== null;
}

/** expires_at in ms; the CLI stores unix seconds, tolerate ms defensively. */
function expiryMs(creds) {
  const raw = creds && (creds.expires_at ?? creds.expiresAt);
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}

/** True when the token is expired or expires within the 60s skew window. */
function isExpiring(creds) {
  const ms = expiryMs(creds);
  if (ms === null) return false; // no expiry recorded — assume usable
  return ms - EXPIRY_SKEW_MS <= Date.now();
}

/**
 * Atomically write the credentials file: tmp file + rename, mode 0600.
 * Keeps the file CLI-compatible (snake_case keys).
 */
function writeCredentialsAtomic(creds) {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic on POSIX and Windows (same volume)
}

/**
 * Build the stored record from a token endpoint response, preserving any
 * unknown fields already on disk (forward CLI-compat).
 */
function tokenRecordFromResponse(data, previous = {}) {
  const accessToken = data.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('OAuth token response missing access_token');
  }
  const expiresIn = Number(data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OAuth token response missing or invalid expires_in');
  }
  const record = { ...previous };
  record.access_token = accessToken;
  if (typeof data.refresh_token === 'string' && data.refresh_token.length > 0) {
    record.refresh_token = data.refresh_token; // rotation: always store the new one
  }
  record.expires_in = expiresIn;
  record.expires_at = Math.floor(Date.now() / 1000) + expiresIn; // unix seconds
  record.token_type = typeof data.token_type === 'string' ? data.token_type : (previous.token_type ?? 'Bearer');
  if (typeof data.scope === 'string') record.scope = data.scope;
  return record;
}

// ------------------------------------------------------------- http helper --

class OAuthError extends Error {}

/**
 * POST a form-encoded body to the OAuth host and parse the JSON response.
 * Never throws on HTTP errors — returns {status, data} like the CLI's postForm.
 */
async function postForm(url, params) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuthError(`OAuth request failed: ${err && err.message ? err.message : String(err)}`);
  }
  let data = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch {
    /* non-JSON error page — status alone decides handling */
  }
  return { status: response.status, data };
}

/** Short, token-free description of an OAuth error body. */
function errorDetail(status, data) {
  const code = typeof data.error === 'string' ? data.error : `http_${status}`;
  return code; // error_description may quote request data; the code is enough
}

// --------------------------------------------------------------- refresh --

/** In-flight refresh promise — concurrent getAccessToken() calls share it. */
let refreshPromise = null;

async function doRefresh() {
  const creds = getCredentials();
  const refreshToken = refreshTokenOf(creds);
  if (!refreshToken) return null;

  let lastErr = null;
  for (let attempt = 0; attempt < REFRESH_MAX_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(2 ** (attempt - 1) * 1000); // 1s, 2s
    let status, data;
    try {
      ({ status, data } = await postForm(`${oauthHost()}/api/oauth/token`, {
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }));
    } catch (err) {
      lastErr = err; // network/timeout — retry
      continue;
    }
    if (status === 200 && typeof data.access_token === 'string') {
      try {
        const record = tokenRecordFromResponse(data, getCredentials() ?? creds);
        writeCredentialsAtomic(record);
        return record.access_token;
      } catch (err) {
        console.warn('[auth] refresh: failed to persist tokens:', err.message);
        return null;
      }
    }
    if (status >= 500) {
      lastErr = new OAuthError(`refresh server error (HTTP ${status})`); // transient — retry
      continue;
    }
    // 4xx: the grant is dead (invalid_grant / 401 / 403) — retrying is pointless.
    console.warn('[auth] refresh rejected:', errorDetail(status, data));
    return null;
  }
  console.warn('[auth] refresh failed after retries:', lastErr ? lastErr.message : 'unknown');
  return null;
}

/**
 * Access token for API calls. Re-reads the credentials file on every call
 * (the CLI refreshes and rewrites it on its own runs). When the token expires
 * within 60s, performs a refresh_token grant and atomically rewrites the
 * file; concurrent callers share one in-flight refresh.
 * A tombstoned (logged-out) file is never resurrected: empty access_token
 * short-circuits to null.
 */
async function getAccessToken() {
  const creds = getCredentials();
  const token = accessTokenOf(creds);
  if (!token) return null; // missing or tombstoned
  if (!isExpiring(creds)) return token;
  if (!refreshTokenOf(creds)) return token; // nothing to refresh with — best effort

  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

// ----------------------------------------------------------- device login --

/** @type {Set<(result: {status:'done'|'error'|'cancelled', code?: string, message?: string}) => void>} */
const loginDoneCallbacks = new Set();

/** In-flight login attempt; superseded attempts are dropped via `generation`. */
let loginAttempt = null; // { generation: number, cancelled: boolean }
let loginGeneration = 0;

function notifyLoginDone(result) {
  for (const cb of [...loginDoneCallbacks]) {
    try {
      cb(result);
    } catch {
      /* a broken consumer must not kill the others */
    }
  }
}

/**
 * Register a completion callback for device logins. Persistent: fires for
 * every login attempt until unsubscribed. Returns the unsubscribe function.
 */
function onLoginDone(cb) {
  loginDoneCallbacks.add(cb);
  return () => loginDoneCallbacks.delete(cb);
}

// unref'd: a background poll must never hold the process/event loop open.
const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });

async function requestDeviceAuthorization() {
  const { status, data } = await postForm(`${oauthHost()}/api/oauth/device_authorization`, {
    client_id: CLIENT_ID,
  });
  if (status !== 200) {
    throw new OAuthError(`Device authorization failed (HTTP ${status}): ${errorDetail(status, data)}`);
  }
  if (
    typeof data.device_code !== 'string' ||
    typeof data.user_code !== 'string' ||
    data.device_code.length === 0 ||
    data.user_code.length === 0
  ) {
    throw new OAuthError('Device authorization response missing device_code/user_code');
  }
  const interval = Number(data.interval);
  const expiresIn = Number(data.expires_in);
  const complete =
    typeof data.verification_uri_complete === 'string' && data.verification_uri_complete.length > 0
      ? data.verification_uri_complete
      : '';
  const plain = typeof data.verification_uri === 'string' ? data.verification_uri : '';
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: plain || complete,
    verificationUrlComplete: complete || plain,
    interval: Number.isFinite(interval) && interval >= 0 ? interval : DEFAULT_POLL_INTERVAL_S,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_DEVICE_EXPIRES_S,
  };
}

/**
 * Background poll loop for one login attempt. Terminal outcomes are pushed
 * via onLoginDone; the loop never throws.
 */
async function pollDeviceToken(attempt, auth) {
  let intervalS = auth.interval;
  const deadline = Date.now() + auth.expiresIn * 1000;
  let netErrors = 0;

  // Terminal outcome: drop the attempt (so a later cancelLogin is a no-op),
  // then notify.
  const finish = (result) => {
    if (loginAttempt === attempt) loginAttempt = null;
    notifyLoginDone(result);
  };

  for (;;) {
    await sleep(intervalS * 1000);
    if (loginAttempt !== attempt || attempt.cancelled) return;
    if (Date.now() >= deadline) {
      finish({ status: 'error', code: 'expired', message: '로그인 코드가 만료되었습니다. 다시 시도해 주세요.' });
      return;
    }

    let status, data;
    try {
      ({ status, data } = await postForm(`${oauthHost()}/api/oauth/token`, {
        client_id: CLIENT_ID,
        device_code: auth.deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }));
    } catch (err) {
      netErrors += 1;
      if (netErrors >= MAX_POLL_NET_ERRORS) {
        finish({ status: 'error', code: 'network', message: `네트워크 오류로 로그인에 실패했습니다: ${err.message}` });
        return;
      }
      continue; // transient — keep polling on the same interval
    }
    if (loginAttempt !== attempt || attempt.cancelled) return;
    netErrors = 0;

    if (status === 200 && typeof data.access_token === 'string') {
      try {
        writeCredentialsAtomic(tokenRecordFromResponse(data, getCredentials() ?? {}));
      } catch (err) {
        finish({ status: 'error', code: 'storage', message: `인증 정보를 저장하지 못했습니다: ${err.message}` });
        return;
      }
      finish({ status: 'done' });
      return;
    }

    if (status >= 500) {
      netErrors += 1;
      if (netErrors >= MAX_POLL_NET_ERRORS) {
        finish({ status: 'error', code: 'network', message: `인증 서버 오류 (HTTP ${status})` });
        return;
      }
      continue;
    }

    const errorCode = typeof data.error === 'string' ? data.error : 'unknown_error';
    switch (errorCode) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalS += SLOW_DOWN_BACKOFF_S;
        continue;
      case 'expired_token':
      case 'invalid_grant': // device code died server-side — same user remedy
        finish({ status: 'error', code: 'expired', message: '로그인 코드가 만료되었습니다. 다시 시도해 주세요.' });
        return;
      case 'access_denied':
        finish({ status: 'error', code: 'denied', message: '로그인이 거부되었습니다.' });
        return;
      default:
        finish({ status: 'error', code: errorCode, message: `로그인에 실패했습니다: ${errorCode}` });
        return;
    }
  }
}

/**
 * Begin an RFC 8628 device login. Resolves with the user-facing code and
 * verification URLs; token polling continues in the background and its
 * completion is pushed to onLoginDone callbacks. Supersedes any in-flight
 * attempt silently.
 */
async function startDeviceLogin() {
  cancelLogin({ silent: true });
  const auth = await requestDeviceAuthorization();
  const attempt = { generation: ++loginGeneration, cancelled: false };
  loginAttempt = attempt;
  pollDeviceToken(attempt, auth).catch((err) => {
    // Defensive: the loop is designed not to throw, but never leak a rejection.
    console.warn('[auth] device poll crashed:', err && err.message);
    if (loginAttempt === attempt) loginAttempt = null;
    notifyLoginDone({ status: 'error', code: 'unknown', message: '로그인 처리 중 오류가 발생했습니다.' });
  });
  return {
    userCode: auth.userCode,
    verificationUrl: auth.verificationUrl,
    verificationUrlComplete: auth.verificationUrlComplete,
  };
}

/**
 * Stop the in-flight device login. Fires {status:'cancelled'} unless silent.
 * @returns {{ok: boolean}} ok=false when no login was in flight.
 */
function cancelLogin({ silent = false } = {}) {
  const attempt = loginAttempt;
  loginAttempt = null;
  if (!attempt) return { ok: false };
  attempt.cancelled = true;
  if (!silent) notifyLoginDone({ status: 'cancelled', message: '로그인이 취소되었습니다.' });
  return { ok: true };
}

/**
 * Tombstone the credentials file: empties BOTH tokens (keeping the file's
 * other fields for shape compatibility) so isLoggedIn()/quota/search see a
 * logged-out state and getAccessToken() can never resurrect the session.
 * No-op success when there is no credentials file.
 */
function logout() {
  cancelLogin({ silent: true });
  const creds = getCredentials();
  if (!creds) return { ok: true };
  writeCredentialsAtomic({ ...creds, access_token: '', refresh_token: '' });
  return { ok: true };
}

module.exports = {
  getCredentials,
  getAccessToken,
  isLoggedIn,
  startDeviceLogin,
  onLoginDone,
  cancelLogin,
  logout,
  // Exported for tests / other main modules:
  kimiHome,
  credentialsPath,
};
