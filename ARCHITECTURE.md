# Kimi-GUI — Architecture Contract (binding)

Desktop GUI with a built-in direct engine and an optional **Kimi Code CLI** agent mode
(`kimi`, v0.28.1+). In CLI mode the app spawns `kimi web --no-open` (local REST +
WebSocket server); both engines render through the same Apple-HIG chat UI
(Claude-Code-like transcript), session list, approvals, and usage view.
Cross-platform: macOS + Windows. Plain JS (ES2022), Electron, **no bundler, no TypeScript**.

## Module boundaries

```
main/main.js                  Electron lifecycle and BrowserWindow policy
main/ipc.js + main/preload.js Narrow, allow-listed renderer bridge
main/backend.js               Engine-neutral session and turn orchestration
main/direct-*.js              Built-in engine transport and local persistence
main/kimi-client.js           Kimi CLI REST/WebSocket client
main/steer-queue.js           Shared edit-window policy and direct steer queue
main/auth.js + main/quota.js  Credentials, sign-in, and account quota
renderer/js/app.js            Renderer store and cross-view coordination
renderer/js/chat.js           Transcript, streaming, and composer behavior
renderer/js/panel.js          Single tabbed right-side inspector
renderer/js/*.js              Feature modules exposed through window globals
renderer/styles/*.css         Shared tokens, layout, and component styles
test/*.test.js                Main-process state and protocol regressions
```

`main/backend.js` is the only session/chat dependency of `main/ipc.js`.
Renderer modules never import Node APIs and communicate only through
`window.kimi`, which `main/preload.js` publishes with `contextBridge`.
Time-sensitive steer state belongs in `main/steer-queue.js` or
`main/kimi-client.js`; orchestration code consumes those APIs rather than
mutating queue records directly.

## Backend facts (verified live against kimi 0.28.1)

- Spawn: `kimi web --no-open --port <p>`. Stdout prints a banner line:
  `Kimi server: http://127.0.0.1:<p>/#token=<TOKEN>` — parse URL + token from it (port auto-retries +1).
- REST base: `<url>/api/v1`, header `Authorization: Bearer <TOKEN>`.
  Response envelope: `{ "code": 0, "msg": "success", "data": ... }`.
- Key REST endpoints (see `docs/ref/openapi.json` for full schemas):
  - `GET /healthz`, `GET /meta`, `GET /auth`
  - `GET /sessions`, `POST /sessions` (body includes `cwd`, optional `model`)
  - `GET /sessions/{id}`, `GET /sessions/{id}/profile` (profile has `usage`:
    `{input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost_usd, context_tokens, context_limit, turn_count}`)
  - `GET /sessions/{id}/messages`, `POST /sessions/{id}/prompts` (body: prompt text),
    `POST /sessions/{id}/prompts:steer`
  - `GET /sessions/{id}/approvals`, `POST /sessions/{id}/approvals/{approval_id}` (decision)
  - `GET /sessions/{id}/questions`, `POST /sessions/{id}/questions/{tail}`
- WebSocket: `/api/v1/ws` (see `docs/ref/asyncapi.json`; 28 message types).
  Flow: connect (auth via token — verify exact mechanism in `docs/ref/webui-bundle.js`,
  grep for `ws`/`token`), send `client_hello`, receive `server_hello`, then `subscribe`
  to a session id; server pushes `session_event` messages.
  Known server event types (snake_case payloads):
  `session.created`, `session.updated`, `session.deleted`, `session.status_changed`,
  `session.usage_updated`, `session.history_compacted`, `message.created`, `message.updated`,
  `turn.step.completed`, plus approval/question events. `abort` is a WS client message.
- Ground truth for payload shapes: `docs/ref/webui-bundle.js` (minified official web UI, grep it)
  and live testing: spawn your own server on a UNIQUE port in 59010–59099, curl it, kill it after.
- **All server payloads are snake_case.** Code defensively (`?? 0`, optional chaining).

## main/kimi-client.js interface (names fixed; internals per protocol findings)

```js
class KimiClient extends EventEmitter {
  constructor({ baseUrl, token })
  static async launch({ kimiPath?, port? }) // spawn server, parse banner -> { client, child, baseUrl, token }
  request(method, path, body?)              // fetch wrapper, unwraps envelope, throws on code!=0
  healthz(); meta(); auth();
  listSessions(); createSession({ cwd, model? }); getSession(id); getProfile(id);
  getMessages(id); sendPrompt(id, text); steer(id, text);
  holdSteer(id, promptId); resumeSteer(id, promptId);
  updateSteer(id, promptId, text); deleteSteer(id, promptId); abort(id);
  listApprovals(id); respondApproval(id, approvalId, decision);
  listQuestions(id); answerQuestion(id, tail, body);
  connect();              // open WS, client_hello, auto resubscribe
  subscribeSession(id); unsubscribeSession(id);
  shutdown();             // POST /shutdown, kill child
}
// Emits: 'event' ({sessionId, event}), 'usage' ({sessionId, usage}), 'status' ({ready, error?})
```

## main/quota.js interface

`async function getQuota({ token? }) -> { weeklyUsed, weeklyLimit, window5hUsed, window5hLimit, extraBalance?, resetsAt? } | null`
Best-effort account quota from the managed backend (`https://api.kimi.com/coding/v1`, OAuth creds
under `~/.kimi-code/oauth`). Never log secrets. Return `null` when undiscoverable — UI then shows
per-session usage only.

## Preload API (`window.kimi`, contextBridge, no nodeIntegration)

```
getState() -> { ready, version, defaultModel, error? }
listSessions() -> [ { id, title, cwd, updatedAt, busy, usage? } ]
createSession({ cwd }) -> session
pickDirectory(defaultPath?) -> string | null        // native open dialog
getGitInfo(cwd) -> { isRepository, current, branches[] }
checkoutGitBranch(cwd, branch) -> { current, branches[], changed }
getMessages(sessionId) -> [message]
getProfile(sessionId) -> profile        // includes usage
sendPrompt(sessionId, text)
steer(sessionId, text)
holdSteer(sessionId, promptId)
resumeSteer(sessionId, promptId)
updateSteer(sessionId, promptId, text)
deleteSteer(sessionId, promptId)
abort(sessionId)
respondApproval(sessionId, approvalId, decision)   // decision: 'approve' | 'reject' (verify in protocol.md)
answerQuestion(sessionId, tail, body)
getQuota() -> quota | null
openExternal(url)
onEvent(cb) -> unsubscribe              // receives ALL push events:
//   { type:'status', ready, error? }
//   { type:'session', event }          // raw session_event passthrough (snake_case)
//   { type:'usage', sessionId, usage }
```

IPC: `ipcMain.handle` for request/response channels `kimi:<name>`; push via `webContents.send('kimi:event', payload)`.

## Renderer DOM contract (index.html — ids are fixed)

```html
<body>
  <div id="titlebar"></div>                 <!-- -webkit-app-region: drag; padding-left:78px on mac -->
  <div id="app">
    <aside id="sidebar">
      <div id="sidebar-header"><button id="new-chat-btn"></button></div>
      <nav id="session-list"></nav>         <!-- .session-item(.active)(.busy) > .session-title + .session-meta -->
      <div id="sidebar-footer">
        <button id="usage-nav-btn"></button>
        <span id="server-status"></span>    <!-- .ok | .err -->
      </div>
    </aside>
    <main id="main">
      <section id="chat-view">
        <header id="chat-header">
          <div id="chat-title-group">
            <span id="chat-section-label"></span><span id="chat-title"></span>
          </div>
          <span id="model-label"></span><button id="panel-toggle-btn"></button>
        </header>
        <div id="transcript"></div>
        <div id="composer-wrap">
          <div id="draft-context" hidden>
            <button id="draft-directory-btn"></button>
            <select id="draft-branch-select" disabled></select>
          </div>
          <div id="composer-change-status" hidden>
            <button id="changes-summary-btn" hidden></button>
          </div>
          <textarea id="composer" rows="1"></textarea>
          <button id="composer-abort-btn" hidden></button>
          <button id="send-btn"></button>
          <div id="composer-options">
            <button id="model-select"></button>
            <button id="swarm-toggle"></button>
            <button id="effort-select"></button>
            <span id="branch-indicator"></span>
            <span id="context-meter"></span>
          </div>
        </div>
      </section>
      <section id="usage-view" hidden>
        <div id="quota-cards"></div>        <!-- .usage-card > .usage-card-title + .usage-card-value + .progress-bar -->
        <div id="session-usage"></div>
      </section>
    </main>
    <aside id="panel" hidden>
      <div id="panel-tabs" role="tablist"></div>
      <div id="panel-work" role="tabpanel"></div>
      <div id="panel-changes" role="tabpanel" hidden></div>
    </aside>
  </div>
  <div id="modal-root"></div>               <!-- approvals/questions: .modal-backdrop > .modal -->
</body>
```

## Message rendering (Claude-Code-like transcript, chat.js)

- Full-width transcript (NOT left/right bubbles). User message: accent-left-border block with
  secondary bg. Assistant: markdown body (`.md`). Thinking: dim italic `.msg-thinking` (collapsible).
- Tool call row `.msg-tool`: header (chevron + mono tool name + one-line summary), body
  (collapsed by default, mono, truncated); states `.running` (spinner) / `.done` / `.error`.
- Streaming: update the in-progress assistant block in place; auto-scroll unless user scrolled up.
- `window.marked` + `window.hljs` globals are provided via `vendor/` script tags in index.html
  (loaded BEFORE js modules). markdown.js: GitHub-style sanitation (no raw HTML), code blocks
  highlighted, with a fixed `.code-header` toolbar above the scrollable code surface. The
  language label stays left-aligned and the copy action stays in the top-right corner.

## Styling

CSS custom props on `:root` (light) + `@media (prefers-color-scheme: dark)` overrides:
`--bg, --bg-secondary, --sidebar-bg, --text, --text-secondary, --text-dim, --accent,
--accent-text, --border, --danger, --success, --warn, --code-bg, --radius-l:10px, --radius-m:8px,
--radius-s:6px, --font-ui (-apple-system stack), --font-mono (SF Mono stack)`.
Apple HIG: 13px base UI font, 8pt spacing grid, sidebar translucent (rgba, backdrop-filter blur),
accent `#007AFF` light / `#0A84FF` dark, system-gray palette, subtle 0.5px borders, no heavy shadows.
UI copy language: English by default with a complete Korean locale.

## App state / wiring (app.js owns the store; other modules read via `window.App`)

`window.App = { state, selectSession(id), startNewChat(), sendPrompt(text), abort(), showView('chat'|'usage'), refreshSessions() }`
app.js: boot (getState → listSessions → select most recent), global onEvent dispatch:
- 'status' → #server-status; 'session' → chat.applyEvent + sidebar refresh; 'usage' → context meter + usage view.

## Process/lifecycle (main.js)

- Branding is a cross-file contract: `main/branding.js` owns the runtime name
  and AppUserModelID; `package.json`, `electron-builder.yml`, and the renderer
  title must match it. Windows additionally fixes `executableName`, shortcut
  name, and uninstall display name to `Kimi-GUI`.
- Single instance lock. Window: 1100x720 min 840x560, `titleBarStyle: 'hiddenInset'` + `vibrancy: 'sidebar'` (mac only),
  `backgroundColor` matches theme.
- On ready in CLI mode: `KimiClient.launch()` (find kimi: env `KIMI_CLI_PATH` → `which/where kimi` →
  `~/.kimi-code/bin/kimi[.exe]`) and retry once on another port. Renderer boot waits for this result.
- Do not equate the launcher PID with server lifetime. Windows launchers may print the ready banner,
  detach the HTTP daemon, and exit with code `0`; probe `/healthz` before treating an exit as failure.
- If the CLI is missing or its daemon is unreachable, persist and start the built-in direct engine.
  The fatal boot page is reserved for the unlikely case where neither engine is available.
- After a normal direct-engine boot, offer CLI agent mode in one optional dialog. Show `Connect`
  when the CLI is installed and `Install` when it is absent; installation completion changes the
  same dialog to `Connect`. A renderer-local "do not show again" preference suppresses future
  offers. Never show the offer during the same boot that automatically fell back from a failed CLI.
- `before-quit`: client.shutdown(). All server stdout → `console` (prefix `[kimi-server]`).
