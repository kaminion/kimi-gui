# CONTRACT V4 (binding, additive)

> Historical note: V4 introduced the lowercase npm/repository identifier
> `kimi-gui`. The current user-facing product name is **Kimi-GUI**.

V4 items: app rename to **Kimi-GUI**; unified session list (direct mode also shows legacy CLI
sessions); sidebar = custom groups + single '최근 내역' section; daily section shows limits;
panel close fix; swarm configurability; device-login must open `verification_uri_complete`.

## Verified facts
- `/usages` API has NO daily window — only weekly + 300-min window + `parallel.limit`. Daily
  "한도" UI therefore shows the applicable live limits (주간/5시간) next to today's tokens.
- Panel close bug: `#panel-close-btn` wired TWICE (app.js:433 `Panel.toggle()` + panel.js:470
  `setOpen(false)`) → close then reopen. Fix = remove app.js's wiring, keep panel.js's.
- Login bug: onboarding.js:309 / settings.js:424 use `res.verificationUrl` (bare) — the device
  page REQUIRES `?user_code=`. B3's startLogin already returns `verificationUrlComplete`
  (pass-through from main/auth.js). Fix = prefer `verificationUrlComplete ?? verificationUrl`
  in BOTH files.
- CLI session dirs: `~/.kimi-code/sessions/<wd_*>/<sid>/state.json` `{id,cwd,title,lastPrompt,
  createdAt,updatedAt(ms),archived,isCustomTitle}` + `agents/main/wire.jsonl` (same format the
  direct store writes — main/direct-store.js, main/search.js already parse it).

## Ownership
```
main/backend.js (additive), main/cli-sessions.js (NEW), package.json, electron-builder.yml, README.md -> M1
renderer/js/sidebar.js, renderer/styles/layout.css (additive end-block)                            -> R1
renderer/js/app.js, renderer/js/onboarding.js, renderer/js/settings.js,
renderer/js/chat-options.js, renderer/js/usage.js, renderer/index.html (title only)              -> R2
NOBODY touches renderer/js/i18n.js (integration harvests).
```

## M1 — unified sessions + rename
- NEW main/cli-sessions.js: read adapter over `~/.kimi-code/sessions` (KIMI_CODE_HOME honored):
  `list() -> [{id,title,cwd,updatedAt(ISO),busy:false,engine:'cli',model?,effort:null}]` (skip
  archived; title fallback lastPrompt→'새 대화'; ms→ISO), `getMessages(id)` (wire.jsonl →
  REST-shaped newest-LAST — reuse the parsing approach of main/direct-store.js; share code via
  require if it exports a converter, else implement minimal), `rename(id,title)` (read-modify-write
  state.json preserving unknown fields, isCustomTitle=true), `archive(id)` (archived=true),
  `appendTurnCompat(id, turnRecord)` — appends a direct-engine turn to an existing CLI session's
  wire.jsonl + bumps state.json updatedAt/lastPrompt (PRESERVE all other fields).
- backend.js (additive): direct engine paths now merge — listSessions = direct store + cli-sessions
  (dedupe by id, direct wins), getMessages/sendPrompt/renameSession/deleteSession route by where
  the id resolves (direct first, else cli-sessions); sendPrompt to a cli session in direct mode =
  direct runTurn with a store shim over that session dir (direct-store createStore({root}) pointed
  at `<wd_*>/<sid>` parent? choose the cleanest shim; MUST NOT create duplicate state fields).
  deleteSession(cli) = archive. Capabilities unchanged. cli engine behavior untouched.
- Rename app: package.json `{name:'kimi-gui', version:'0.4.0'}`; electron-builder.yml
  `productName: "Kimi-GUI"`, `appId: com.kimi.gui`; README.md: use **Kimi-GUI**
  for the display name. npm lockfile name field: run
  `npm install --package-lock-only` to sync.

## R1 — sidebar '최근 내역'
- Replace project grouping: sections = custom groups (unchanged: create/rename/delete/collapse,
  DnD assignment, 그룹 해제 zone) + ONE '최근 내역' section listing ALL unassigned sessions
  (both engines, engine badge NOT needed) sorted by updatedAt desc. Remove project-group code +
  `kimi.sidebarCollapsed` usage for project groups (custom-group collapse persists in
  'kimi.customGroups' as today). Item meta keeps relative time + cwd basename. Keep
  rename/delete/DnD/active/busy/keyboard behaviors and every existing class hook used by CSS.
- '최근 내역' header label via T('sidebar.recent','최근 내역'); count badge optional.

## R2 — fixes bundle
- app.js: DELETE the `#panel-close-btn` listener (double-wiring bug); keep `#panel-toggle-btn`.
  ADDITIVE: after createSession in cli engine, apply swarm default: if
  `localStorage['kimi.defaultSwarm']==='1' && getState().engine==='cli'` → kimi.setSessionSwarm(id,true).
- onboarding.js + settings.js: prefer `verificationUrlComplete ?? verificationUrl` everywhere the
  verify link is opened/rendered (dataset.url, openExternal, and the settings re-login path).
- settings.js: 모델 section adds a '스웜 기본값' toggle row (localStorage kimi.defaultSwarm,
  caption '새 대화에 적용 · CLI 에이전트 모드 전용'); 계정 section unchanged.
- chat-options.js: when `typeof window.kimi.setSessionSwarm !== 'function'` (direct engine),
  RENDER the swarm pill anyway but disabled (`.disabled`, aria-disabled, click no-op) with title
  T('options.swarm.unavailable','스웜은 CLI 에이전트 모드에서 사용할 수 있습니다'); when available,
  existing behavior. Also reflect default-on state for fresh sessions in cli mode (read
  kimi.defaultSwarm when no per-session value).
- usage.js: in the daily section add a '한도' sub-block (below today numbers, above chart):
  two progress rows — 주간 한도 (used/limit %, bar) and 5시간 한도 — from getQuota(); quota null →
  subtle '한도 정보를 불러올 수 없습니다' line; tooltips via T(). Styles: additive end-block in
  renderer/styles/components.css comment /* usage v4 */ (R3 file — append ONLY).
- index.html: `<title>` → `Kimi-GUI` (only that line).

## Integration wave (after swarm)
Harvest T keys → i18n.js; CDP E2E: legacy CLI sessions visible+openable+continuable in direct
mode, recent section, panel close, login URL contains user_code (temp home, cancel), usage limit
rows, swarm disabled pill + default-on in cli engine, window title Kimi-GUI; screenshots; commit.
