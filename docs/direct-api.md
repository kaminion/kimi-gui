# Direct API — verified notes for the CLI-free engine (main/direct-client.js)

Ground truth for the "direct" engine: plain HTTPS against the managed
Anthropic-compatible endpoint, no `kimi` CLI involved. Everything below was
verified **live** with the user's OAuth token (2026-07-22). Tokens are never
logged.

## Endpoint & auth

```
POST https://api.kimi.com/coding/v1/messages
Authorization: Bearer <oauth access_token>     # ~/.kimi-code/credentials/kimi-code.json
anthropic-version: 2023-06-01
content-type: application/json
```

Standard Anthropic Messages body: `{model, max_tokens, stream, system,
messages, tools, thinking}`. `KIMI_CODE_BASE_URL` env overrides the base
(default `https://api.kimi.com/coding/v1`).

Token source: `main/auth.js` `getAccessToken()` (lazy, guarded require). When
auth.js is absent/unavailable, direct-client falls back to reading the
CLI-compatible credentials file **read-only** (and returns null when the token
is expired — refresh requires auth.js).

## Thinking effort — VERDICT (probed, 5 combos, all 2xx)

**Working shape: Anthropic `thinking` parameter.** Verified on `k3`:

| Request extra                              | Result                                    |
|--------------------------------------------|-------------------------------------------|
| (omitted)                                  | 200, thinks by default                    |
| `thinking:{type:'enabled',budget_tokens:N}`| 200, thinking + text blocks               |
| `thinking:{type:'disabled'}`               | 200, text only (no thinking)              |
| `effort:'low'` (top-level field)           | 200, but indistinguishable from baseline — **not used** |

App mapping (`EFFORT_BUDGETS` in direct-client.js):

- `off`  → `thinking:{type:'disabled'}`
- `low`  → `budget_tokens: 2048`
- `high` → `budget_tokens: 8192` (default)
- `max`  → `budget_tokens: 16384`

Constraints: `budget_tokens` must be `< max_tokens`; we always send
`max_tokens: 32768`, which the endpoint accepts. Thinking blocks arrive with a
`signature` field — it is stored in wire.jsonl and sent back in multi-turn
history (required by Anthropic for thinking+tool_use continuations).

## Models

`k3` (ctx 1048576), `kimi-for-coding` (262144), `kimi-for-coding-highspeed`
(262144). ⚠ The endpoint does **not** validate the model id: an unknown model
string returned HTTP 200 with a normal response (server-side fallback
observed). Don't rely on 404s for typos.

## SSE event map (`stream: true`)

One `event:` + `data: <json>` pair per SSE frame; stream ends after
`message_stop` (no `[DONE]` sentinel observed, but tolerated).

| SSE event             | data shape (relevant fields)                                             |
|-----------------------|--------------------------------------------------------------------------|
| `message_start`       | `{message:{usage:{input_tokens, cache_read_input_tokens?, cache_creation_input_tokens?}}}` |
| `content_block_start` | `{index, content_block:{type:'text'\|'thinking'\|'tool_use', id?, name?, input?}}` |
| `content_block_delta` | `{index, delta:{type:'text_delta',text}}` / `{type:'thinking_delta',thinking}` / `{type:'input_json_delta',partial_json}` / `{type:'signature_delta',signature}` |
| `content_block_stop`  | `{index}`                                                                |
| `message_delta`       | `{delta:{stop_reason}, usage:{output_tokens, ...}}`                       |
| `message_stop`        | `{}`                                                                     |
| `ping`                | keepalive, ignore                                                        |
| `error`               | `{error:{type,message}}` mid-stream failure                              |

- `tool_use` input arrives fragmented via `input_json_delta.partial_json` —
  accumulate the string, JSON.parse at `content_block_stop`.
- `stop_reason`: `end_turn` | `tool_use` | `max_tokens` (| `aborted` locally).
- Usage accounting: `input_tokens` from `message_start`,
  `output_tokens` from `message_delta`. Cache fields appear as
  `cache_read_input_tokens` / `cache_creation_input_tokens` when non-zero.

## Agentic loop (direct-client)

`messages` = full store history converted to Anthropic shape
(user/assistant blocks; `tool_result` blocks wrapped in a synthetic user
message after each assistant `tool_use`; orphaned calls from aborted turns get
an `is_error` placeholder result). Loop: request → execute `tool_use` blocks
(with `hooks.requireApproval`) → append results → re-request, ≤25 iterations.

## Error shapes (verified)

- **401**: HTTP 401, body
  `{"error":{"type":"authentication_error","message":"The API Key appears to be invalid…"},"type":"error"}`
  → `DirectApiError.code === 'auth'` (B3: surface re-login).
- **429 / quota**: not triggered during testing. Classified defensively:
  429 with quota/limit-ish message → `code:'quota'` (not retryable);
  otherwise `code:'rate_limit'` (retryable).
- **5xx / network**: `code:'api_error'` (retryable) / `code:'network'`.
- Mid-stream `error` SSE event → `code:'api_error'`, retryable.

## Limits observed / chosen

- `max_tokens` 32768 accepted (40000 also accepted in probe).
- Thinking budget must be < max_tokens; ≥1024 per Anthropic convention.
- K3 context 1048576 (some tiers 262144 — code defensively, we never send
  anywhere near it: history is unbounded on disk but a real session would hit
  429/quota long before; no client-side compaction yet).
- Tool caps (client-side): Bash 120s timeout + 1MB output, Read 2000 lines /
  4MB, Grep 200 hits (uses `rg --json` when available, JS fallback otherwise),
  Glob 500 results.

## Wire compatibility

Sessions live at `<storeRoot>/<session_id>/` with `state.json` +
`agents/main/wire.jsonl` in the CLI's exact line shapes (see header comments
in main/direct-store.js). `main/search.js` indexes them unchanged when its
scan root covers the store root (verified with `KIMI_CODE_HOME` pointing at a
temp home whose `sessions/wd_direct` was the store root — hits ranked and
message ids match `getMessages` replay exactly). Integration needed for
searching the production flat root: teach search.js an extra-roots parameter
(see B2 report).
