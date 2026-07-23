# Kimi-GUI — OAuth (CLI-free login, `main/auth.js`)

V3 lets the app talk to `https://api.kimi.com/coding/v1` **without the Kimi Code CLI**.
Login is an RFC 8628 **device authorization flow** against `https://auth.kimi.com`,
wire-compatible with `kimi login`, so the app and the CLI share one set of
credentials on disk. Everything below was verified live (2026-07-22) and against
the CLI binary's bundled sources (`KIMI_CODE_FLOW_CONFIG`, `postForm`,
`requestDeviceAuthorization`, `pollDeviceToken`, `refreshAccessToken`).

## Endpoints

Base host: `https://auth.kimi.com` (override: `KIMI_CODE_OAUTH_HOST`, then
`KIMI_OAUTH_HOST` — same env vars the CLI honors; used by tests with a mock).

**All requests are POST `application/x-www-form-urlencoded`** with
`Accept: application/json`. A JSON body is rejected (`400 invalid_request`).
The CLI identifies itself as `User-Agent: kimi-code-cli/<ver>`; auth.js mimics
that UA because the flow is only verified with it.

### 1. `POST /api/oauth/device_authorization`

Form body: `client_id=<CLIENT_ID>` (nothing else).

- `client_id` = **`17e5f671-d194-4dfb-9706-5516cb48c098`** — the CLI's public
  device-flow client (`KIMI_CODE_FLOW_CONFIG.clientId` in the binary).
  ⚠️ The literal string `kimi-code-cli` is **not** a valid client_id; the
  server answers `401 {"error":"invalid_client","error_description":"Client authentication failed"}`.

Response `200`:

```json
{
  "device_code": "<40 chars>",
  "user_code": "XXXX-XXXX",
  "verification_uri": "https://www.kimi.com/code/authorize_device",
  "verification_uri_complete": "https://www.kimi.com/code/authorize_device?user_code=<user_code>",
  "expires_in": 1800,
  "interval": 5
}
```

### 2. `POST /api/oauth/token` — device-code poll

Form body:

```
client_id=<CLIENT_ID>
device_code=<device_code>
grant_type=urn:ietf:params:oauth:grant-type:device_code
```

Poll every `interval` seconds (default 5) until a terminal state:

| Server response | Meaning | auth.js behavior |
| --- | --- | --- |
| `200 {access_token, refresh_token, expires_in, token_type, scope}` | user approved | persist tokens, fire `{status:'done'}` |
| `400 {"error":"authorization_pending","error_description":"Authorization …"}` | not yet approved | keep polling on same interval |
| `400 {"error":"slow_down"}` | polling too fast | interval += 5s (RFC 8628 §3.5) |
| `400 {"error":"expired_token"}` | device code expired | fire `{status:'error', code:'expired'}` |
| `400 {"error":"access_denied"}` | user denied | fire `{status:'error', code:'denied'}` |
| `400 {"error":"invalid_grant","error_description":"The provided authorization grant is invalid"}` | bogus/dead device code (verified live) | treated like `expired` — same remedy (re-login) |
| HTTP ≥ 500 or network failure | transient | retry; after 5 consecutive failures fire `{status:'error', code:'network'}` |

There is also a local deadline of `expires_in` (observed 1800s = 30 min) from
the device_authorization response.

### 3. `POST /api/oauth/token` — refresh grant

Form body:

```
client_id=<CLIENT_ID>
grant_type=refresh_token
refresh_token=<refresh_token>
```

- `200` → same token shape as the poll success. **The server rotates the
  refresh_token on every refresh** (verified live) — always persist the new one.
- `400 {"error":"invalid_grant", …}` → the grant is dead (revoked or already
  rotated by another client). auth.js returns `null`, does **not** retry, and
  leaves the file untouched.
- 5xx / network errors are retried up to 3 attempts with 1s/2s backoff
  (mirrors the CLI's `refreshAccessToken`: 3 attempts, `2^attempt` seconds).

## Credentials file (CLI-compatible)

Path: `<KIMI_CODE_HOME || ~/.kimi-code>/credentials/kimi-code.json` — the same
file the CLI reads and rewrites, so app and CLI share the login.

```json
{
  "access_token": "<JWT, ~677 chars>",
  "refresh_token": "<~678 chars>",
  "expires_at": 1784701537,
  "scope": "<scope string>",
  "token_type": "Bearer",
  "expires_in": 900
}
```

- `expires_at` is **unix SECONDS** (= `now + expires_in` at grant time);
  observed token lifetime is 900s (15 min) — short, so refresh is routine.
- Writes are **atomic**: `<file>.<pid>.tmp` then `rename(2)` over the target,
  file mode `0600` (matches the CLI's own file).
- auth.js never caches credentials — the CLI may refresh/rewrite the file at
  any time, so every `getCredentials()` / `getAccessToken()` re-reads it.
- **Rotation safety**: because refresh rotates the refresh_token, two clients
  refreshing the same stored token race — the loser's grant dies with
  `invalid_grant`. auth.js minimizes the window by re-reading immediately
  before use, and on the next call picks up whichever newer tokens won.
  Never hold onto a refresh_token long-term; never copy the file except for
  tests (and then treat the copy as a live credential).
- **Logout** tombstones the file: `access_token: ''` **and**
  `refresh_token: ''` (other fields kept for shape compatibility). Emptying
  only the access token would let `getAccessToken()` resurrect the session
  via the refresh grant. A tombstoned file is never refreshed.

## `main/auth.js` API

```js
const auth = require('./auth');

auth.getCredentials()  // -> {access_token, refresh_token, expires_at, ...} | null  (sync)
await auth.getAccessToken() // -> string | null
                       // re-reads the file; if the token expires within 60s,
                       // runs ONE shared refresh (mutex: concurrent callers
                       // join the same in-flight grant) and atomically rewrites
                       // the file. null when logged out / grant dead.
auth.isLoggedIn()      // -> bool (sync; non-empty access_token)

const info = await auth.startDeviceLogin();
// -> {userCode, verificationUrl, verificationUrlComplete}
// Polling runs in the background; completion is pushed to callbacks:
const off = auth.onLoginDone(({ status, code, message }) => { ... });
//   {status:'done'}
//   {status:'error', code:'expired'|'denied'|'network'|'storage'|..., message}
//   {status:'cancelled', message}
// `code` is a machine key (localize via T()); `message` is a Korean fallback.
// Persistent registration; call the returned fn to unsubscribe.
auth.cancelLogin()     // -> {ok}  stops polling, fires {status:'cancelled'};
                       // {ok:false} when no login was in flight
auth.logout()          // -> {ok}  tombstones the creds file (see above)

// also exported (tests / other main modules): kimiHome(), credentialsPath()
```

`startDeviceLogin()` rejects only when the device_authorization call itself
fails (HTTP ≠ 200 or malformed body) — the caller surfaces that immediately;
everything after is delivered via `onLoginDone`.

## Testing notes (rotation safety!)

- **Never** point tests at the real `~/.kimi-code`: set `KIMI_CODE_HOME` to a
  temp dir and `KIMI_CODE_OAUTH_HOST` to a mock server (see
  `/tmp/auth-harness.js` from the v3 build — 52 assertions: happy path,
  pending→success, slow_down +5s backoff, expired_token, invalid_grant,
  refresh rotation + mutex, 5xx retry, atomic write/mode 0600, cancel,
  logout tombstone, corrupt file).
- Testing refresh with a **copied real refresh_token rotates it server-side**.
  If such a test succeeds, immediately write the fresh tokens back into the
  real credentials file (strictly newer — keeps the CLI logged in); if it
  fails or the real file changed in the meantime, leave it untouched. This
  exact procedure was run live for the v3 build: refresh OK, rotation
  confirmed, real file updated atomically, then validated with a live
  `GET /coding/v1/usages` (quota.js).
- Never print or log token values — redact to lengths/prefixes in docs,
  logs, and test output.
