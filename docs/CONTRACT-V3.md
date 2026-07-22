# CONTRACT V3 (binding, additive to ARCHITECTURE.md + CONTRACT-V2)

V3 pillars: (1) CLI-free direct mode — app logs in and chats WITHOUT the kimi CLI; (2) custom
session groups with drag & drop; (3) session rename/delete; (4) composer-level options
(model/swarm/thinking effort); (5) premium charcoal theme + readability; (6) daily usage stats;
(7) tooltip UX pass. V1+V2 contracts stay valid except where overridden.

## Verified facts (new)

- **Direct chat works CLI-free**: `POST https://api.kimi.com/coding/v1/messages` with
  `Authorization: Bearer <oauth access_token>`, `anthropic-version: 2023-06-01`, Anthropic Messages
  JSON → real streamed/non-streamed responses (thinking + text). Verified live with the user's token.
- **OAuth device flow** (RFC 8628): `POST https://auth.kimi.com/api/oauth/device_authorization`
  body `{client_id}` → `{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}`;
  poll `POST https://auth.kimi.com/api/oauth/token` `{grant_type:'urn:ietf:params:oauth:grant-type:device_code',
  device_code, client_id}` until tokens or `authorization_pending`/`slow_down`/`expired_token`;
  refresh: `{grant_type:'refresh_token', refresh_token, client_id}`.
  client_id for the CLI flow: `kimi-code-cli` (also seen: `kimi-code-web` — use `kimi-code-cli`).
- **Models** (managed, static): `k3` (ctx 1048576; some tiers 262144 — code defensively),
  `kimi-for-coding` (262144), `kimi-for-coding-highspeed` (262144).
- **Thinking effort**: K3 supports `low`/`high`/`max`; default high. Exact API parameter shape is
  NOT verified — direct-client agent must discover it (try Anthropic `thinking:{type:'enabled',
  budget_tokens:N}`, or an `effort` field; omit param if all fail) and record in docs/direct-api.md.
- **CLI engine extras**: session archive = `POST /api/v1/sessions/{id}:archive` (soft-delete; the
  list filter already hides archived). Session state file: `~/.kimi-code/sessions/<wd_*>/<sid>/state.json`
  `{title, isCustomTitle, ...}` — rename via profile POST if supported (discover), else patch this file.
- **wire.jsonl format** (see M2 notes in git history / docs): sessions at
  `~/.kimi-code/sessions/<wd_*>/<sid>/agents/main/wire.jsonl`; line types `metadata`,
  `context.append_message` `{message:{role,content:[{type:'text',text}],id,origin:{kind}}}`,
  `context.append_loop_event` `{event:{type:'step.begin'|'content.part'|'tool.call'|'tool.result',...}}`,
  plus `usage.record` lines (token accounting) — main/search.js already indexes this format.

## File ownership (v3)

```
main/auth.js, docs/oauth.md                                   -> B1
main/direct-store.js, main/direct-client.js, docs/direct-api.md -> B2
main/backend.js, main/main.js, main/ipc.js, main/preload.js,
  main/kimi-client.js (additive: renameSession/thinking if API exists),
  main/onboarding.js (v3: login = in-app device flow via auth.js) -> B3
main/usage-stats.js, renderer/js/usage.js                     -> B4
renderer/js/sidebar.js, renderer/js/app.js (additive only)    -> R1
renderer/js/chat-options.js, renderer/index.html (composer row ONLY),
  renderer/styles/settings.css (additive)                      -> R2
renderer/styles/base.css, layout.css, components.css, docs/design.md -> R3
renderer/js/onboarding.js                                      -> R4
NOBODY edits renderer/js/i18n.js (integration wave harvests new T() keys into tables)
```

## Interfaces (fixed)

### B1 main/auth.js
```js
getCredentials() -> { access_token, refresh_token, expires_at, ... } | null   // reads CLI-compatible file
getAccessToken() -> string | null   // auto-refresh via /api/oauth/token when expiring (<60s skew); atomic rewrite of ~/.kimi-code/credentials/kimi-code.json (KIMI_CODE_HOME honored)
isLoggedIn() -> bool
startDeviceLogin() -> { userCode, verificationUrl, verificationUrlComplete }   // begins polling in background
//   completion pushed via callback registered by B3: auth.onLoginDone(cb)
cancelLogin()
logout()   // tombstones the creds file (empty access_token) — used by settings later; expose but UI optional
```

### B2 main/direct-store.js + main/direct-client.js
Store root: `<app.getPath('userData')>/direct-sessions/<sid>/` with **wire-compatible** files:
`state.json` `{id,cwd,title,createdAt,updatedAt(ms),archived:false,isCustomTitle}` and
`agents/main/wire.jsonl` using the EXACT line shapes above (completed turns only, `msg_`-ids),
so main/search.js can index direct sessions by adding one more root.
Store API: `list() -> [summary{id,title,cwd,updatedAt,busy:false,engine:'direct'}]`,
`create({cwd,title?})`, `get(id)`, `getMessages(id) -> [REST-shaped messages newest-LAST]`,
`rename(id,title)` (sets isCustomTitle), `remove(id)`, `appendTurn(id, turnRecord)`,
`usageByDay(id?)` raw usage rows for B4.
Client: `runTurn({ store, sessionId, cwd, model, effort, prompt, signal, hooks })` —
POST /coding/v1/messages `stream:true` (SSE parse), messages = full history from store,
system prompt: concise coding-assistant prompt (English, ~15 lines, mentions tool etiquette);
tools: `Bash, Read, Write, Edit, Grep, Glob` (JSON-schema input, safe implementations:
Bash via child_process exec w/ 120s cap, cwd-scoped; fs tools via node:fs/path with path
resolution inside cwd; Grep/Glob may shell out to `rg` if present else naive fallback).
Agentic loop ≤25 iterations: collect tool_use blocks → for each, hooks.requireApproval(tool)
→ execute → append tool_result → continue. After final stop: store.appendTurn with the full
turn + usage. `hooks` = { onDelta(text), onThinking(text), onToolStart(tool), onToolEnd(tool,result),
requireApproval(tool) -> Promise<'approved'|'rejected'>, onUsage(usage) }.
Abort: AbortSignal → close SSE, mark turn aborted.

### B3 main/backend.js — engine facade (the ONLY module ipc.js talks to for session/chat methods)
```js
init({ app, send })                 // reads <userData>/settings.json {engine:'direct'|'cli'} default 'direct'
engine() -> 'direct'|'cli'
setEngine(e)                        // tears down CLI server if running; persists; renderer reloads after
getState()                          // v2 shape + { engine, cliInstalled }
listSessions() / createSession({cwd}) / getMessages(id) / getProfile(id)
sendPrompt(id, text) / steer(id,text) / abort(id)
respondApproval / answerQuestion    // direct engine: resolves pending tool approval
listModels()                        // direct: static list; cli: server models
setSessionModel(id, alias)          // direct: store flag; cli: profile POST
setSessionSwarm(id, on)             // cli ONLY — in direct mode the property must be ABSENT from preload result (UI hides pill)
setSessionEffort(id, effort)        // direct: store flag; cli: profile POST thinking field IF discovered (else no-op w/ log)
renameSession(id, title)            // direct: store; cli: profile POST {title} if supported else patch state.json
deleteSession(id)                   // direct: store.remove; cli: POST :archive
listTasks(id)                       // direct: [] ; cli: server
searchAll(q)                        // search.js over BOTH roots (~/.kimi-code/sessions + direct-sessions)
shutdown()
```
Direct engine emits the SAME push vocabulary the renderer already consumes
(`{type:'session', sessionId, event:{type:'assistant.delta'|'thinking.delta'|'turn.started'|
'turn.ended'|'session.work_changed'|'session.usage_updated', ...payload}}`,
`{type:'usage', sessionId, usage}` snake_case, approval via
`event:{type:'approval.requested', approval_id, tool_name, args...}` + resolved on respondApproval).
Onboarding v3: `needsOnboarding = !isLoggedIn()` (engine-independent); login = auth.js device flow
(same preload names onboardingStartLogin/onboardingCancelLogin, same {verificationUrl,userCode} shape);
onboardingInstallCli stays (settings 엔진 section uses it when engine==='cli' && !cliInstalled).

### B4 main/usage-stats.js
`getDailyUsage() -> { today: {input_tokens, output_tokens}, days: [{date:'YYYY-MM-DD', input_tokens, output_tokens} ×7] }`
Scan wire.jsonl `usage.record` lines across BOTH session roots (CLI + direct), aggregate per LOCAL day,
mtime-cached like search.js. Expose as preload `getDailyUsage()`.

## Renderer specs

### R1 sidebar custom groups + rename + delete (sidebar.js; app.js additive hooks only)
- Keep auto project groups. ADD custom groups section pinned ABOVE: header row '그룹' + '+' button
  (creates inline-editable name row, default '새 그룹'), each custom group = collapsible container
  accepting drops. Drag & drop: `.session-item[draggable]`; dragstart sets sessionId; custom group
  headers/containers are drop targets (dragover highlight `.drop-target`); drop assigns
  (`localStorage 'kimi.customGroups'` = `{groups:[{id,name,collapsed}], assign:{sessionId:groupId}}`);
  assigned sessions leave their project group; a '그룹 해제' drop zone appears at sidebar bottom while
  dragging (or drop back onto any project group area removes assignment).
- Custom group context: double-click name → inline rename; hover '×' → delete group (sessions return
  to project groups, confirm modal via Approvals-free simple confirm dialog — reuse `.modal` styles).
- Session rename: hover pencil (or double-click title) → inline input → `kimi.renameSession` →
  re-render; session delete: hover trash → confirm modal ('이 대화를 삭제할까요? 복구할 수 없습니다.') →
  `kimi.deleteSession` → if active, switch to most recent remaining.
- Persist collapsed state of custom groups inside the same localStorage object.

### R2 composer options row + tooltips (chat-options.js, index.html composer block only, settings.css additive)
- Move #model-select + #swarm-toggle OUT of #chat-header INTO a new row inside #composer-wrap:
  `<div id="composer-options">` BELOW the textarea, left-aligned pills, plus NEW `#effort-select` pill.
  chat-options.js re-binds to new location (header cluster keeps #panel-toggle-btn/#abort-btn only).
- #effort-select: cycles 끄기/낮음/높음/최대 (off/low/high/max, default 높음) per session
  (localStorage kimi.sessionEffort.<sid> + kimi.setSessionEffort); label shows current level;
  dropdown style identical to model dropdown. Hide pill when backend lacks setSessionEffort.
- TOOLTIP AUDIT: every icon/pill button and metric gets informative `title` (+ matching data-i18n-title):
  context meter ('컨텍스트 사용량 — 현재 대화가 모델에 전달하는 토큰 비율'), quota cards
  (주간: '매주 갱신되는 구독 할당량', 5시간: '단기 요청 속도 제한 윈도우'), model pill, effort pill
  ('사고 수준 — 높을수록 깊이 추론, 느릴 수 있음'), swarm ('병렬 서브에이전트 실행'), panel toggle,
  usage rows. Implement missing ones in the owning files (chat-options.js/settings.css additive here;
  context meter/quota titles: coordinate by ALSO editing app.js/usage.js additively — allowed for R2).

### R3 theme v3 (base/layout/components.css) — premium charcoal, readability, emilkowalski rules
- FIRST: `git clone --depth 1 https://github.com/emilkowalski/skills /tmp/emil-skills` and READ
  skills/emil-design-eng (or similar) + review-animations; extract applicable rules and cite them in
  docs/design.md (short 'applied rules' list).
- Palette (dark base, token names unchanged): --bg #101013, --bg-secondary #16161B,
  --sidebar-bg rgba(20,20,25,.72), --header-bg rgba(16,16,19,.78), --surface-raised #1B1B21,
  --code-bg #1B1B21, --text #ECECF1, --text-secondary #A0A0AA, --text-dim #7C7C86,
  --border rgba(255,255,255,.07), --hover-bg rgba(255,255,255,.05), --active-bg rgba(255,255,255,.09);
  accent stays; light theme = v1 values (retune only if broken by new structure).
- Depth via layering (raised surfaces + hairlines + very subtle shadow), NO gradients.
- Readability: .md 15px/1.65, transcript max-width 800px, paragraph spacing 12px, headings rhythm,
  inline code bg contrast up, code block padding 12px 14px + 13px mono, tables hairline,
  .msg-user = raised bubble (surface-raised, radius 12px, padding 10px 14px, accent 3px left border),
  message gap 20px, thinking 13px dim italic with left hairline.
- Animations per skill rules: enter = ease-out only, 150–250ms micro-interactions, transform+opacity
  only, no bounce on modals; audit existing keyframes (spinner ok) and FIX any ease-in enters.
- Keep every existing selector working (R1/R2/B4 add classes — coordinate via their reports next wave).

### R4 onboarding v3 (onboarding.js only)
- Remove the CLI-install STEP from the gate: flow = splash → (needsOnboarding = not logged in) →
  login card only. Copy update: 'Kimi에 로그인' / '브라우저에서 인증 코드를 입력하면 바로 시작할 수
  있습니다' (CLI 언급 제거 — 앱은 이제 CLI 없이 동작). Keep all defensive paths; onboardingInstallCli
  remains reachable only from settings (engine section), not here.

## Integration wave (after swarm) harvests: new T() keys → i18n.js ko+en tables; full CDP E2E in BOTH
engines (direct: login state, PONG round trip, tool approval (Bash ls), effort switch; cli: regression);
screenshots; then proofread-lite + README update.
