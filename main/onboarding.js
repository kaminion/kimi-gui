'use strict';

/**
 * onboarding.js — first-run onboarding for Kimi Desktop (CONTRACT-V3, B3).
 *
 * V3: the app works WITHOUT the Kimi Code CLI (default 'direct' engine), so
 * the gate is login-only and engine-independent:
 *
 *   getOnboardingState({ withVersion? } = {})
 *     -> { cliInstalled, cliPath, cliVersion, loggedIn, needsOnboarding }
 *        cliInstalled: resolveKimiPath() (./server-manager) succeeds.
 *        cliVersion:   first line of `kimi --version` (5s timeout, best-effort).
 *        loggedIn:     B1 ./auth.isLoggedIn() (falls back to reading
 *                      <KIMI_CODE_HOME|~/.kimi-code>/credentials/kimi-code.json
 *                      when the auth module is absent).
 *        needsOnboarding = !loggedIn   (engine-independent — CONTRACT-V3)
 *
 *   startLogin(send) -> { verificationUrl, userCode, verificationUrlComplete? }
 *     Delegates to B1 ./auth's OAuth device flow (RFC 8628, in-app — no CLI,
 *     no child process). auth.startDeviceLogin() begins background polling;
 *     completion arrives via auth.onLoginDone(cb) and is pushed as
 *       send({ type:'onboarding', phase:'login', status:'done'|'error', message? }).
 *     When a valid login already exists, the promise rejects with
 *     err.code === 'ALREADY_LOGGED_IN' and status 'done' is pushed (v2 shape).
 *
 *   cancelLogin() -> { ok }
 *     Cancels the in-flight device flow and pushes the terminal
 *     { phase:'login', status:'error', message:'cancelled' } immediately.
 *
 *   installCli(send) -> { ok, cliPath }
 *     Unchanged from v2 — downloads the official installer and runs it (bash
 *     on POSIX, PowerShell on Windows — never sudo). Only reachable from
 *     settings (engine section), not from the first-run gate.
 *
 * Never logs credential contents or tokens.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveKimiPath } = require('./server-manager');

const isWindows = process.platform === 'win32';

const INSTALL_SCRIPT_URL = isWindows
  ? 'https://code.kimi.com/kimi-code/install.ps1'
  : 'https://code.kimi.com/kimi-code/install.sh';
const MANUAL_INSTALL_URL = 'https://www.kimi.com/help/kimi-code/cli-getting-started';

const VERSION_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 30000;

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Kimi Code home directory (honors KIMI_CODE_HOME like the CLI does). */
function kimiHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

/** True when the credentials file exists with a non-empty access_token. */
function checkLoggedIn() {
  try {
    const file = path.join(kimiHome(), 'credentials', 'kimi-code.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed.access_token === 'string' && parsed.access_token.length > 0;
  } catch {
    return false;
  }
}

/** B1's auth module, lazy + guarded (parallel-swarm deliverable). */
let authMod = null;
function loadAuth() {
  if (authMod) return authMod;
  try {
    // eslint-disable-next-line global-require
    authMod = require('./auth');
  } catch {
    authMod = null;
  }
  return authMod;
}

function isLoggedIn() {
  const auth = loadAuth();
  try {
    if (auth && typeof auth.isLoggedIn === 'function') return !!auth.isLoggedIn();
  } catch {
    /* fall through to the file check */
  }
  return checkLoggedIn();
}

/** `kimi --version`, first output line; null on any failure (5s cap). */
function getCliVersion(cliPath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cliPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), VERSION_TIMEOUT_MS);
    child.stdout.on('data', (buf) => { out += buf.toString(); });
    child.on('error', () => done(null));
    child.on('exit', (code) => {
      if (code !== 0) return done(null);
      const line = out.replace(ANSI_RE, '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      done(line || null);
    });
  });
}

async function getOnboardingState({ withVersion = true } = {}) {
  let cliPath = null;
  try {
    cliPath = await resolveKimiPath();
  } catch {
    cliPath = null; // KIMI_CLI_NOT_FOUND or not executable
  }
  const cliVersion = cliPath && withVersion ? await getCliVersion(cliPath) : null;
  const loggedIn = isLoggedIn();
  return {
    cliInstalled: Boolean(cliPath),
    cliPath,
    cliVersion,
    loggedIn,
    needsOnboarding: !loggedIn, // engine-independent (CONTRACT-V3)
  };
}

// ------------------------------------------------------------- CLI install --

let installInFlight = false;

/** Download the official installer script to a temp file and return its path. */
async function downloadInstaller() {
  const res = await fetch(INSTALL_SCRIPT_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`installer download failed: HTTP ${res.status}`);
  const body = await res.text();
  if (!body || !body.trim()) throw new Error('installer download was empty');
  const scriptPath = path.join(
    os.tmpdir(),
    `kimi-code-install-${process.pid}${isWindows ? '.ps1' : '.sh'}`,
  );
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

/**
 * Run the official CLI installer and stream its output as progress events.
 * The installer itself needs no sudo: it drops a native binary into
 * ~/.kimi-code/bin and (by default) adds it to the user PATH.
 */
async function installCli(send) {
  if (installInFlight) throw new Error('CLI install is already in progress');
  installInFlight = true;
  const progress = (step, message) => {
    try {
      send({ type: 'onboarding', phase: 'install', step, message });
    } catch {
      /* renderer may be gone mid-install */
    }
  };

  let scriptPath = null;
  try {
    progress('download_script', '설치 스크립트를 다운로드하는 중…');
    scriptPath = await downloadInstaller();

    progress('run_installer', 'Kimi Code CLI를 설치하는 중…');
    const child = isWindows
      ? spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        )
      : spawn('bash', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrTail = '';
    const onLine = (line, isErr) => {
      const clean = line.replace(ANSI_RE, '').trim();
      if (!clean) return;
      if (isErr) stderrTail = `${stderrTail}${clean}\n`.slice(-2000);
      progress('run_installer', clean);
    };
    const pipeLines = (stream, isErr) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          onLine(buf.slice(0, idx), isErr);
          buf = buf.slice(idx + 1);
        }
      });
      stream.on('end', () => onLine(buf, isErr));
    };
    pipeLines(child.stdout, false);
    pipeLines(child.stderr, true);

    // 'close' (not 'exit'): fires only after stdio flushed, so stderrTail is complete.
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? -1));
    });
    if (exitCode !== 0) {
      const tail = stderrTail.trim();
      throw new Error(
        `CLI installer exited with code ${exitCode}${tail ? `: ${tail}` : ''}. ` +
          `수동 설치: ${MANUAL_INSTALL_URL}`,
      );
    }

    progress('verify', '설치를 확인하는 중…');
    const cliPath = await resolveKimiPath(); // throws KIMI_CLI_NOT_FOUND
    progress('done', '설치가 완료되었습니다.');
    return { ok: true, cliPath };
  } catch (err) {
    progress('error', err.message);
    if (err.code !== 'KIMI_CLI_NOT_FOUND') {
      err.message = `${err.message} (수동 설치 안내: ${MANUAL_INSTALL_URL})`;
    }
    throw err;
  } finally {
    installInFlight = false;
    if (scriptPath) {
      try { fs.unlinkSync(scriptPath); } catch { /* temp file may be gone */ }
    }
  }
}

// ----------------------------------------------------------------- login ----
// V3: in-app OAuth device flow via B1's ./auth (no `kimi login` child).

let loginPush = null;      // send() of the in-flight attempt, for instant cancel feedback
let loginNotified = false; // a terminal status was already pushed
let loginHookAuth = null;  // auth instance the onLoginDone hook is bound to

/** Register auth.onLoginDone once; forwards completion to the active attempt. */
function ensureLoginHook(auth) {
  if (loginHookAuth === auth || typeof auth.onLoginDone !== 'function') return;
  loginHookAuth = auth;
  auth.onLoginDone((result) => {
    if (loginNotified || !loginPush) return;
    loginNotified = true;
    const r = result && typeof result === 'object' ? result : {};
    const failed = r.error || r.ok === false || r.success === false;
    if (failed) {
      const message = typeof r.error === 'string' ? r.error : (r.message ?? 'login failed');
      loginPush({ status: 'error', message });
    } else {
      loginPush({ status: 'done' });
    }
  });
}

/**
 * Start the OAuth device flow. Resolves with {verificationUrl, userCode};
 * completion is reported via push events (see header comment).
 */
async function startLogin(send) {
  const auth = loadAuth();
  if (!auth || typeof auth.startDeviceLogin !== 'function') {
    throw new Error('login is unavailable (main/auth.js not installed)');
  }
  cancelLogin(); // drop any dangling attempt before starting a new one
  const push = (payload) => {
    try {
      send({ type: 'onboarding', phase: 'login', ...payload });
    } catch {
      /* renderer may be gone */
    }
  };

  loginNotified = false;
  loginPush = push;
  ensureLoginHook(auth);

  if (isLoggedIn()) {
    loginNotified = true;
    push({ status: 'done' });
    const err = new Error('already logged in');
    err.code = 'ALREADY_LOGGED_IN';
    throw err;
  }

  const flow = await auth.startDeviceLogin();
  const f = flow && typeof flow === 'object' ? flow : {};
  const verificationUrl = f.verificationUrl ?? f.verificationUri ?? f.verification_uri ?? '';
  const userCode = f.userCode ?? f.user_code ?? '';
  const verificationUrlComplete =
    f.verificationUrlComplete ?? f.verificationUriComplete ?? f.verification_uri_complete ?? undefined;
  if (!verificationUrl || !userCode) {
    throw new Error('device flow did not return a verification URL and user code');
  }
  return { verificationUrl, userCode, ...(verificationUrlComplete ? { verificationUrlComplete } : {}) };
}

/**
 * Cancel the in-flight device flow. Pushes the terminal
 * {phase:'login', status:'error', message:'cancelled'} immediately.
 */
function cancelLogin() {
  const auth = loadAuth();
  let cancelled = false;
  try {
    if (auth && typeof auth.cancelLogin === 'function') {
      auth.cancelLogin();
      cancelled = true;
    }
  } catch {
    /* auth module may be absent */
  }
  if (loginPush && !loginNotified) {
    loginNotified = true;
    loginPush({ status: 'error', message: 'cancelled' });
    cancelled = true;
  }
  return { ok: cancelled };
}

module.exports = {
  getOnboardingState,
  installCli,
  startLogin,
  cancelLogin,
  // Exported for tests / other main modules:
  checkLoggedIn,
  isLoggedIn,
  kimiHome,
};
