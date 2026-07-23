# Kimi Code `kimi web` Protocol — Verified Notes (kimi 0.28.1)

Ground truth for `main/kimi-client.js` and the renderer. Everything below was
verified **live** against `kimi web --no-open` (0.28.1) plus the official web
bundle (`docs/ref/webui-bundle.js`). Tokens are redacted. Specs:
`docs/ref/openapi.json` (REST), `docs/ref/asyncapi.json` (WS).

## 1. Server spawn & banner

```
kimi web --no-open --port <p>
```

stdout banner (note: the URL line is `Local:`, NOT `Kimi server:`):

```
  ▐█▛█▛█▌  Kimi server ready  0.28.1
  Local:    http://127.0.0.1:59071/#token=<TOKEN>
  Token:    <TOKEN>
```

- Parse with a regex like `(https?://[\d.]+):(\d+)/#token=(\S+)` — the port may
  be auto-incremented (+1 retry) when busy, so **always take the port from the
  URL**, never assume the requested one.
- The token is stable per machine (same token across server instances).

## 2. REST

Base `<url>/api/v1`. Auth header: `Authorization: Bearer <TOKEN>`
(missing/invalid → HTTP 401). The official client also sends
`X-Kimi-Client-Id/Name/Version/Ui-Mode` headers — optional, not required.

Envelope (success): `{"code":0,"msg":"success","data":...,"request_id":"..."}`.
Errors keep HTTP 200 (mostly) with `code != 0`, `data: null`, e.g.
`{"code":40001,"msg":"decision: Invalid option: expected one of \"approved\"|\"rejected\"|\"cancelled\"","data":null,...}`.

### Endpoints used by the app (verified shapes)

- `GET /healthz` → `data: {ok: true}`
- `GET /meta` → `{server_version, capabilities:{websocket,...}, server_id, started_at, ...}`
- `GET /auth` → `{ready, providers_count, default_model: "kimi-code/k3", managed_provider:{name, status}}`
- `GET /models` → `{items: [{provider, model, display_name, max_context_size, capabilities, ...}]}`
- `GET /sessions` → `{items: [Session]}`
- `POST /sessions` — body `{"metadata":{"cwd":"<dir>"}}` (optional `title`,
  `workspace_id`, `agent_config`). **⚠ `agent_config.model` in the create body
  is silently ignored** (session comes back with `model: ""` and the first turn
  fails `model.not_configured`). Set the model afterwards via
  `POST /sessions/{id}/profile` with `{"agent_config":{"model":"<id>"}}`
  (verified: `GET /sessions/{id}/status` then reports the model).
- `GET /sessions/{id}` → Session object:

```json
{
  "id": "session_2fec7d1c-…", "workspace_id": "wd_kimi-proto-test_…",
  "title": "Reply with exactly: PONG",
  "created_at": "…", "updated_at": "…",
  "busy": false, "main_turn_active": false,
  "pending_interaction": "none",           // none | approval | question
  "last_turn_reason": "completed",          // completed | failed | cancelled
  "archived": false, "last_prompt": "…",
  "metadata": {"cwd": "/tmp/kimi-proto-test"},
  "agent_config": {"model": ""},
  "usage": {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
            "cache_creation_tokens": 0, "total_cost_usd": 0,
            "context_tokens": 0, "context_limit": 0, "turn_count": 0},
  "permission_rules": [], "message_count": 0, "last_seq": 0
}
```

  **⚠ `usage`, `message_count`, `last_seq` stay `0` even after completed turns**
  (observed 0.28.1). Do NOT rely on them; use `GET /sessions/{id}/status`
  and WS events instead.
- `GET /sessions/{id}/status` → live state (**this one is accurate**):
  `{busy, model, thinking_level, permission, plan_mode, swarm_mode,
   context_tokens, max_context_tokens, context_usage}`
- `GET /sessions/{id}/profile` → same Session shape (POST sets agent_config).
- `GET /sessions/{id}/messages` → `{items: [...], has_more}` — **items are
  NEWEST FIRST** (reverse for display). Query: `before_id`, `after_id`,
  `page_size` (≤100), `role`. Message:

```json
{
  "id": "msg_session_…_000002", "session_id": "…", "role": "assistant",
  "content": [
    {"type": "thinking", "thinking": "User says reply exactly PONG."},
    {"type": "text", "text": "PONG"}
  ],
  "created_at": "…"
}
```

  Roles: `user|assistant|tool|system`. Content part types: `text` (`text`),
  **`thinking` (`thinking`)** — present in practice though missing from the
  openapi oneOf — `tool_use` (`tool_call_id, tool_name, input`),
  `tool_result` (`tool_call_id, output, is_error`), `image` (`source`).
- `POST /sessions/{id}/prompts` — body `{"content":[{"type":"text","text":"…"}]}`
  (optional `model`, `thinking`, `permission_mode`, …) →
  `{prompt_id, user_message_id, status: "running"|"queued"|"blocked", content, created_at}`.
  While a turn is active the prompt is **queued** (FIFO).
- `GET /sessions/{id}/prompts` → `{active: {prompt_id,…}|null, queued: [...]}`.
- `POST /sessions/{id}/prompts:steer` — body `{"prompt_ids":["<queued id>"]}` →
  `{steered: true, prompt_ids}`; merges a **queued** prompt into the active
  turn. This is how you "steer" mid-turn: POST the text (it queues), then
  steer it. Server emits `prompt.steered`.
- `POST /sessions/{id}/prompts/{prompt_id}:abort` → `{aborted: true, at_seq}`
  (works for queued; returned `50001` when racing a running turn — prefer the
  session-level abort).
- Kimi-GUI keeps a CLI steering prompt queued for a four-second edit window
  before calling `prompts:steer`. Editing submits a replacement prompt and
  aborts the previous queued prompt only after the replacement succeeds.
  Deleting aborts the queued prompt. Opening the editor pauses promotion until
  the user saves or cancels.
- **`POST /sessions/{id}:abort`** body `{}` → `{aborted: true}` — **the
  reliable "stop" button** (verified mid-stream; see event sequence below).
  This is what the official UI falls back to.
- `GET /sessions/{id}/approvals` — **requires `?status=pending`** (else 40001) →
  `{items: [Approval]}`:

```json
{
  "approval_id": "tool_5CcpaladJt7GWMrPK8QQPD5g", "session_id": "…",
  "turn_id": 4, "tool_call_id": "tool_5Cc…", "tool_name": "Bash",
  "action": "Running: ls -la",
  "tool_input_display": {"kind": "command", "command": "ls -la",
                         "cwd": "/tmp/…", "language": "bash"},
  "created_at": "…", "expires_at": "…"   // +24h
}
```

- `POST /sessions/{id}/approvals/{approval_id}` — body
  `{"decision":"approved"|"rejected"|"cancelled"}` (enum verified via 40001
  error; optional `scope:"session"`, `feedback`, `selected_label`) →
  `{resolved: true, resolved_at}`. **Preload's `'approve'|'reject'` must be
  mapped to `'approved'|'rejected'`.**
- `GET /sessions/{id}/questions?status=pending` → `{items: [...]}`;
  `POST /sessions/{id}/questions/{tail}` body `{answers: {...}, method?, note?}`
  (see openapi for the answer kinds).
- `POST /shutdown` → `{ok: true}` (server exits).

## 3. WebSocket

Endpoint: `ws://127.0.0.1:<port>/api/v1/ws`.

**Auth: WebSocket subprotocol** — pass protocols `["kimi-code.bearer.<TOKEN>"]`
(found in the bundle: `` `${"kimi-code.bearer."}${token}` ``; verified live —
the server echoes it as the negotiated protocol). No query param, no first
message.

### Frame flow (verified)

1. Server immediately sends `server_hello`:
   `{"type":"server_hello","timestamp":"…","payload":{"ws_connection_id":"conn_…","protocol_version":2,"heartbeat_ms":30000,"max_event_buffer_size":1000,"capabilities":{"event_batching":false,"compression":false}}}`
2. Client sends `client_hello` (optionally with initial subscriptions):
   `{"type":"client_hello","id":"h1","payload":{"client_id":"probe-1","subscriptions":["<sid>"],"cursors":{}}}`
   → ack: `{"type":"ack","id":"h1","code":0,"msg":"success","payload":{"accepted_subscriptions":["<sid>"],"resync_required":[],"cursors":{"<sid>":{"seq":93,"epoch":"ep_…"}}}}`
3. `subscribe` / `unsubscribe`:
   `{"type":"subscribe","id":"s1","payload":{"session_ids":["<sid>"]}}`
   → ack payload: `{"accepted":["<sid>"],"not_found":[],"resync_required":[],"cursors":{…}}`
4. Server heartbeats `{"type":"ping","timestamp":"…","payload":{"nonce":"…"}}` —
   reply `{"type":"pong","payload":{"nonce":"…"}}`.
5. `{"type":"abort","id":"…","payload":{"session_id","prompt_id"}}` exists in
   the spec but was **silently ignored** in live tests (no ack, no effect) —
   the official UI aborts over REST. Use REST.

### Event frames

There is **no `session_event` wrapper on the wire** — the frame `type` IS the
event type:

```json
{"type":"assistant.delta","seq":15,"session_id":"session_…",
 "timestamp":"…","payload":{…},"epoch":"ep_…","volatile":true,"offset":1}
```

- `seq`+`epoch` = resync cursor; `volatile: true` marks ephemeral deltas
  (`offset` orders deltas within the same `seq`).
- The payload **repeats `type`** and adds `agentId:"main"` + `sessionId`
  (camelCase) on most agent events.
- **Naming split**: "protocol" events carry an `event.` prefix
  (`event.session.work_changed`, `event.approval.requested`, …) while agent
  stream events do not (`turn.started`, `assistant.delta`, …). The official
  client strips a leading `event.`. **kimi-client normalizes by stripping
  `event.` and passes the rest through raw.**
- **⚠ Field casing is mixed**: frame fields + protocol-event payloads are
  snake_case (`session_id`, `main_turn_active`, `approval_id`, …) but
  agent-event payloads are camelCase (`turnId`, `agentId`, `sessionId`,
  `contextTokens`, `usage.inputCacheRead`, …). Code defensively.

### Verified event sequence — prompt "Reply with exactly: PONG" → "PONG"

```
session.meta.updated        {patch:{title, lastPrompt, isCustomTitle}}
event.session.work_changed  {busy:true, main_turn_active:true, pending_interaction:"none"}
turn.started                {turnId:1, origin:{kind:"user"}, prompt:"…"}
agent.status.updated        {phase:{kind:"running",turnId,step,stepId,since}}
agent.status.updated        {usage:{…}, contextTokens, maxContextTokens, model}
context.spliced             {start, deleteCount, messages:[…]}   // context mirror, ignore
turn.step.started           {turnId, step, stepId}
thinking.delta (volatile)   {turnId, delta:"User"}
agent.status.updated        {phase:{kind:"streaming", stream:"thinking", …}}
assistant.delta (volatile)  {turnId, delta:"P"}  / {delta:"ONG"}
agent.status.updated        {usage:{byModel:{…},currentTurn:{…},total:{…}}, contextTokens}
turn.step.completed         {turnId, step, stepId, finishReason:"end_turn",
                             usage:{inputOther, output, inputCacheRead, inputCacheCreation},
                             llmFirstTokenLatencyMs, …}
turn.ended                  {turnId, reason:"completed", durationMs}
event.session.work_changed  {busy:false, last_turn_reason:"completed"}
prompt.completed            {promptId, finishedAt, reason:"completed"}
```

Failed turn: `turn.step.interrupted {reason:"error", message}` →
`turn.ended {reason:"failed", error:{code:"model.not_configured", message, retryable}}`
→ `error` frame (with `session_id`, payload `{code, message, retryable}`) →
`prompt.completed {reason:"failed"}`.

### Verified event sequence — abort (REST `POST :abort` mid-stream)

```
turn.step.interrupted       {turnId, step, reason:"aborted"}
turn.ended                  {turnId, reason:"cancelled", durationMs}
event.session.work_changed  {busy:false, last_turn_reason:"cancelled"}
prompt.aborted              {promptId, abortedAt}
```

### Verified event sequence — approval (permission mode `manual`)

```
permission.approval.requested  {turnId, toolCallId, toolName:"Bash",
                                action:"Running: ls -la",
                                display:{kind:"command",command,cwd,language},
                                toolInput:{command:"ls -la"}}   // camelCase
event.session.work_changed     {pending_interaction:"approval"}
event.approval.requested       {approval_id, session_id, turn_id, tool_call_id,
                                tool_name, action, tool_input_display,
                                created_at, expires_at}          // snake_case
-- POST decision {"decision":"approved"} → {resolved:true} --
event.approval.resolved        {approval_id, decision:"approved", resolved_at}
permission.approval.resolved   {…camelCase mirror…}
tool.call.started              {turnId, toolCallId, name, args:{…}, description, display}
tool.progress (volatile)       {toolCallId, update:{kind:"stdout", text:"…"}}
tool.result                    {toolCallId, output:"…", is_error? …}
turn.step.completed → turn.step.started (next step) → … → prompt.completed
```

### Steer (verified)

POST prompt while busy → `status:"queued"`; POST `prompts:steer` →
`prompt.steered {activePromptId, promptIds, content:[…]}` — merged into the
active turn. Kimi-GUI delays the second call for four seconds so a queued
adjustment can be edited or deleted first.

### Tool-call event shapes (verified)

- `tool.call.delta` (volatile): `{turnId, toolCallId, name, argumentsPart}` — streamed args.
- `tool.call.started`: `{turnId, toolCallId, name, args, description, display}`.
- `tool.progress` (volatile): `{turnId, toolCallId, update:{kind:"stdout", text}}`.
- `tool.result`: `{turnId, toolCallId, output, …}`.

### Usage payloads

WS (`agent.status.updated`, `turn.step.completed`) usage is **camelCase**:
`{inputOther, output, inputCacheRead, inputCacheCreation}` (+ `byModel`,
`currentTurn`, `total` on `agent.status.updated`). REST `usage` is snake_case.
kimi-client normalizes WS usage → REST shape before emitting `'usage'`.

### Events observed live (0.28.1)

`server_hello, ack, ping, session.meta.updated, event.session.work_changed,
turn.started, turn.step.started, turn.step.completed, turn.step.interrupted,
turn.ended, agent.status.updated, thinking.delta, assistant.delta,
tool.call.delta, tool.call.started, tool.progress, tool.result,
context.spliced, permission.approval.requested/resolved,
event.approval.requested/resolved, prompt.completed, prompt.aborted,
prompt.steered, error`.
`message.created/message.updated/session.usage_updated` exist in the spec but
were **not** emitted in these flows — streaming happens via `*.delta` events;
history via REST.

## 4. Error codes seen

`0` success · `40001` validation · `401` HTTP (no token) · `40402` prompt not
found · `40903` tolerated by the official client on prompt abort (likely
already-completed) · `50001` internal (seen aborting a running prompt via REST
prompt-abort; use session `:abort`).

## 5. Notes for kimi-client

- Reconnect: resend `client_hello` with all current subscriptions + last
  cursors `{sid:{seq,epoch}}`; server acks with `resync_required` list.
- `resync_required` frame: `{session_id, reason, current_seq, epoch}` →
  refetch messages.
- Always defensively read fields (`?? 0`, optional chaining) — casing varies
  and fields are frequently absent (e.g. `usage` on early `agent.status.updated`).
