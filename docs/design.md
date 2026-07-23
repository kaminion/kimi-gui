# Kimi Desktop — Design System

Apple-HIG, **dark-first charcoal-premium** (v3) design system for the Kimi
Desktop chat UI. Implemented in three stylesheets, loaded in this order
(no bundler, plain `<link>` tags):

1. `renderer/styles/base.css` — tokens, reset, focus rings, scrollbars
2. `renderer/styles/layout.css` — window chrome and view structure
3. `renderer/styles/components.css` — messages, markdown, buttons, modals, cards

UI copy is Korean (owned by the JS agents); the CSS itself contains no
user-visible strings.

## Theme model (v3): dark-first, inverted token layering

The product default is **dark on every OS** — the app renders dark unless
the user explicitly picks 라이트 in Settings. v1's layering (`:root` light +
`@media (prefers-color-scheme: dark)` overrides) could not express "dark
even on a light OS", so v2 **inverts** it (kept in v3):

- `:root` — **dark** charcoal-premium palette (base). Also covers
  `[data-theme="dark"]` and a missing `data-theme` attribute.
- `:root[data-theme="light"]` — the v1 Apple **light** palette, unchanged
  (explicit opt-in only).
- There is no `prefers-color-scheme` token block anymore: theme comes from
  `documentElement.dataset.theme`, which app.js sets from
  `localStorage 'kimi.theme'` before first paint (inline `<head>` script,
  no FOUC). `시스템` simply leaves the attribute unset → dark.

Token **names** are unchanged from v1 (other code depends on them); only
the dark values moved to the base layer. `color-scheme: dark|light` is set
on `:root` per theme so UA controls and scrollbars match. Component rules
that must differ per theme beyond tokens (hljs palette, modal backdrop)
use base = dark + `:root[data-theme="light"] …` overrides, mirroring the
token layering.

## Tokens (`base.css`)

Contract-fixed custom properties; v3 dark values are the base `:root`
values, light lives under `:root[data-theme="light"]`:

| Token | Dark (base, v3) | Light (`[data-theme="light"]`, v1) |
| --- | --- | --- |
| `--bg` | `#101013` | `#ffffff` |
| `--bg-secondary` | `#16161B` | `#f5f5f7` |
| `--sidebar-bg` | `rgba(20,20,25,.72)` | `rgba(246,246,248,.8)` |
| `--header-bg` | `rgba(16,16,19,.78)` | `rgba(255,255,255,.8)` |
| `--text` | `#ECECF1` | `#1d1d1f` |
| `--text-secondary` | `#A0A0AA` | `#6e6e73` |
| `--text-dim` | `#7C7C86` | `#86868b` |
| `--accent` | `#0a84ff` | `#007aff` |
| `--accent-text` | `#ffffff` | `#ffffff` |
| `--border` | `rgba(255,255,255,.07)` | `rgba(0,0,0,.10)` |
| `--danger` | `#ff453a` | `#ff3b30` |
| `--success` | `#30d158` | `#34c759` |
| `--warn` | `#ff9f0a` | `#ff9500` |
| `--code-bg` | `#1B1B21` | `#f5f5f7` |
| `--hover-bg` | `rgba(255,255,255,.05)` | `rgba(0,0,0,.04)` |
| `--active-bg` | `rgba(255,255,255,.09)` | `rgba(0,0,0,.07)` |
| `--accent-soft` | `rgba(10,132,255,.24)` | `rgba(0,122,255,.15)` |
| `--danger-soft` | `rgba(255,69,58,.16)` | `rgba(255,59,48,.10)` |
| `--selection-bg` | `rgba(10,132,255,.30)` | `rgba(0,122,255,.28)` |
| `--scrollbar-thumb` | `rgba(255,255,255,.18)` | `rgba(0,0,0,.20)` |
| `--surface-raised` | `#1B1B21` | `#ffffff` |
| `--shadow-card` | `0 1px 2px rgba(0,0,0,.4)` | `0 1px 2px rgba(0,0,0,.05), 0 4px 16px rgba(0,0,0,.05)` |
| `--shadow-modal` | `0 12px 40px rgba(0,0,0,.55)` | `0 12px 40px rgba(0,0,0,.18)` |
| `--radius-l` / `--radius-m` / `--radius-s` | `10px` / `8px` / `6px` | same |
| `--font-ui` | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", …` | same |
| `--font-mono` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, …` | same |

Charcoal premium (v3) = layered restraint: the base is a warm-neutral
`#101013` instead of true black, surfaces lift in visible steps
(`#16161B` → `#1B1B21`), 0.5px hairlines carry definition, shadows stay
near-invisible, **no gradients anywhere**, selection is the accent at 30%.
Nothing renders pure black, so dark detail is never crushed.

### Added tokens (not in the contract, safe to use in JS-injected markup)

- Spacing scale on the 8pt grid: `--space-1:4px` (the sanctioned half-step),
  `--space-2:8px`, `--space-3:16px`, `--space-4:24px`, `--space-5:32px`,
  `--space-6:48px`.
- `--radius-xl: 12px` (user bubble, composer card, usage cards).
- `--surface-raised` — elevated surface for floating/raised layers
  (`.msg-user` bubble, composer card, `.modal`). `#1B1B21` in dark (lifts
  off the charcoal base), `#ffffff` in light (equals `--bg`). Use this
  instead of `--bg` for anything that floats.
- `--accent-soft`, `--hover-bg`, `--active-bg`, `--danger-soft` — translucent
  state fills that work over any background.
- `--selection-bg`, `--scrollbar-thumb`.
- `--shadow-card` (raised cards, user bubble, composer), `--shadow-modal`
  (dialogs).
- Motion curves (v3, from the emil-design-eng skill): `--ease-out:
  cubic-bezier(0.23, 1, 0.32, 1)` for enters/exits and micro-interactions,
  `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)` for on-screen movement.
  Never use `ease-in` for UI.
- Metrics: `--titlebar-h: 34px`, `--sidebar-w: 260px`.

## Type & rhythm

- 13px base UI font, line-height 1.4. Content text (`.md`, `#composer`) is
  **15px / 1.65** (v3 readability pass); `.msg-user` fallback text is 14px;
  metadata is 11–12px; code is **13px mono** with `12px 14px` padding.
- Heading scale in `.md` (v3, refined against the 15px body):
  21 / 18 / 16 / 15 / 13 / 13, weight 600, 16px top / 8px bottom margins.
- Paragraphs in `.md` get **12px** vertical spacing; other blocks keep 8px.
- Numbers that change live (usage values, context meter) use
  `font-variant-numeric: tabular-nums`.
- Vertical rhythm: **20px** between transcript blocks (message gap), 32px
  before a new user turn, 8px between consecutive tool rows. Transcript
  column is `max-width: 800px`, centered; usage grid is `max-width: 960px`.

## Layout decisions

- `#titlebar` is an in-flow 34px full-width drag strip with `padding-left: 78px`
  so the macOS traffic lights never cover sidebar content. Interactive elements
  inside it must re-add `-webkit-app-region: no-drag` (rule already present).
- `#sidebar` is translucent (`--sidebar-bg` + `backdrop-filter: saturate(180%)
  blur(20px)`) with a 0.5px right hairline. Session items: 8px radius,
  hover → `--hover-bg`, `.active` → `--active-bg`, `.busy` → pulsing accent dot
  via `::after` (keyframe `busy-pulse`), titles clamp to 2 lines.
- `#sidebar-header` (v2) is a flex row: `#new-chat-btn` flexes,
  `#search-open-btn` is a fixed ghost icon. `#sidebar-footer` appends
  `#settings-btn` after `#usage-nav-btn` + `#server-status`.
- Session grouping: `.session-group` blocks (16px apart) headed by
  `.session-group-label` (11px/600, dim, flex row so a chevron fits).
  Collapse hook for sidebar.js: toggle `.collapsed` on the group — items
  hide and the label chevron (an inline `<svg>` or `.session-group-chevron`,
  right-pointing base glyph like `.tool-chevron`) rotates back from 90°
  (down, expanded) to 0° (right, collapsed).
- `#chat-header` is 48px, translucent with blur and a bottom hairline;
  `#chat-title` flexes and truncates. The v2 right cluster
  (`#model-label`, `#context-meter`, `#model-select`, `#swarm-toggle`,
  `#panel-toggle-btn`, `#abort-btn`) rides the header's 8px flex gap and
  never shrinks (`#chat-header > :not(#chat-title) { flex: none }`).
- `#composer-wrap` is a floating card: 12px radius, 0.5px border,
  `--surface-raised` fill (lifts off the charcoal base in dark), subtle
  `--shadow-card`, centered at `max-width: 800px` (matches the transcript
  column) with 16px bottom margin.
  `:focus-within` moves the accent ring to the card (textarea itself has no
  outline). The textarea auto-grows via JS and scrolls past `max-height: 160px`.
- `#usage-view` is a scrollable column: `#quota-cards` wraps a
  `.usage-section-title` plus `.usage-card-grid`
  (`repeat(auto-fit, minmax(220px, 1fr))` of `.usage-card`s); the
  `#session-usage` card below holds `.usage-row` label/value pairs and the
  `.usage-context` block.
- `[hidden]` carries `display: none !important` in the reset so toggling the
  attribute on `#chat-view` / `#usage-view` / `#abort-btn` always wins.

## v2 chrome: ghost-icon pills

`#model-select`, `#swarm-toggle` (chat header, both carry `.pill` in the DOM
contract and are restyled as ghosts by id), `#panel-toggle-btn` (chat
header), `#search-open-btn` (sidebar header), `#settings-btn` (sidebar
footer): transparent pills, 12px label text, 26px minimum hit area,
`border-radius: 999px`, hover → `--hover-bg` + `--text`, active →
`--active-bg`. Glyphs are 12px CSS masks tinted `currentColor`
(magnifier / gear / right-panel / node-graph), drawn via `::before`;
`#model-select` instead gets a trailing 10px chevron `::after` and a
180px max-width with ellipsis on a `<span>` label. If the markup ever uses
an inline `<svg>`, the CSS glyph hides via `:has(svg)` (same convention as
`#send-btn`). Swarm engaged state hooks (any works): `.on`, `.active`,
`[aria-pressed="true"]` → accent text on `--accent-soft`.

## v3 messages & readability

- `.msg-user` is now a **raised bubble**: `--surface-raised` fill, 12px
  radius (`--radius-xl`), `10px 14px` padding, 0.5px hairline all around
  with a **3px accent left border**, plus a near-invisible `--shadow-card`.
  It stays full-width inside the 800px transcript column.
- `.msg-thinking` keeps its v2 spec, which already matches v3: 13px, dim,
  italic, 2px left hairline, 3-line clamp until `.expanded`.
- Inline code chips use a border one step stronger than `--border`
  (`rgba(255,255,255,.12)` in dark; light keeps the v1 hairline) so they
  read clearly on both the base and raised surfaces.
- Fenced code blocks: 13px mono, `12px 14px` padding. The `.code-block`
  header bar is a distinct darker layer (`--bg-secondary` over `--code-bg`)
  with the language label left-aligned to the code padding; light theme
  keeps the v1 translucent wash.
- Tables are **hairline-only**: horizontal 0.5px row separators, no boxed
  grid; header row keeps the `--bg-secondary` fill.

## v8 file-change cards

File-mutating tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, and
`apply_patch`) render as first-class change cards in the assistant transcript
instead of being buried inside the generic tool log.

- Each changed file gets its own `.msg-change` card with a localized action,
  full path tooltip, and `+N` / `-N` line counts.
- Opening a card reveals a line-level diff with old/new number gutters,
  restrained success/danger fills, collapsed unchanged runs, and a bounded
  scroll area for large writes.
- Multi-file `apply_patch` calls become a `.msg-change-set`; the first file is
  open by default and the remaining file summaries stay visible.
- Running and failed edits use the same state model as tool rows. Failures keep
  the attempted diff visible and append the tool error below it.
- Change cards live outside `.msg-process`, so applied edits remain visible even
  after the thinking disclosure collapses.
- The component uses the existing dark-first tokens and has an explicit
  narrow-window layout at 640px.
- `#changes-summary-btn` appears in the composer options row when the active
  session has recorded edits. It reports the unique file count plus cumulative
  added/deleted line totals.
- The right side uses one persistent `#panel` with `Activity` and `Changes`
  tabs; it never creates or stacks a second inspector. Clicking the composer
  summary opens the existing panel and selects its `Changes` tab.
- The Changes tab badge reports the current unique file count. Its body groups
  repeated edits by file, keeps per-file statistics, and switches the diff
  detail without leaving the conversation. The Activity tab keeps run status,
  tasks, recent tools, and touched-file chips in the same panel.
- The selected tab remains active while the panel is closed and reopened.
  Arrow keys plus Home/End switch tabs for keyboard users.
- Change summaries are rebuilt from message history on every session load;
  failed mutations are excluded and in-progress tools are layered in until the
  authoritative history resync arrives.

## Motion (v3) — applied emil-design-eng / review-animations rules

Source: `github.com/emilkowalski/skills` (cloned to `/tmp/emil-skills`),
skills `emil-design-eng` (philosophy + decision framework) and
`review-animations` (ten non-negotiable standards + STANDARDS.md values).
Rules applied to `base/layout/components.css`:

1. **Enters use ease-out, never ease-in** — all entry motion
   (`.modal-backdrop`, `.modal`, chevrons) runs on the custom strong curve
   `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`.
2. **Micro-interactions stay 150–250ms** — modal 150/180ms, chevrons 150ms,
   press feedback 160ms, progress fill 250ms.
3. **Animate transform + opacity only** — one documented exception:
   `.progress-fill` transitions `width` because usage.js sets the width
   inline (a transform could not track it); it fires once per data load on
   4px tracks, so the cost is negligible. Same situation exists in
   onboarding.css (not owned here).
4. **No bounce on modals** — `.modal` enters with a 1.03 → 1 settle
   (opacity + scale), no overshoot; modals keep `transform-origin: center`
   (they are exempt from the trigger-origin rule).
5. **Buttons must feel responsive** — `.btn`, `.btn-primary`, `#send-btn`
   get `transform: scale(0.97)` (0.93 for the round send button) on
   `:active` with a 160ms ease-out transition. The 26px ghost pills keep
   their instant background swap instead (pressed tens of times a day —
   reduced-motion category).
6. **Spinners/pulses are constant motion and stay as-is** — `tool-spin`
   (linear), `busy-pulse` (symmetric breathing, opacity+scale), both
   GPU-only properties.
7. **`prefers-reduced-motion`** still collapses all animation via the
   base.css media query.

Audit of files owned by other agents (reported, not edited):
`onboarding.css` animates `width` on its progress fill (same exception as
above) and runs 0.35–0.6s splash/card transitions — justified as
first-run "delight" motion on a strong ease-out curve, but over the 300ms
UI budget; its indeterminate bar uses `ease-in-out` where constant motion
should be `linear`. `search.css` is exemplary (160ms palette enter on a
strong curve, transform+opacity); its 1.2s `search-highlight-flash`
animates `background-color`/`box-shadow` (paint properties) — a minor
perf note, acceptable for a one-shot attention flash. `panel.css` pulses
are opacity-only, compliant. `settings.css` has no animation at all.

## Component DOM hooks (for chat/shell agents)

The contract fixes the outer classes; these inner hooks are what the CSS
expects (reconcile here if your markup differs):

```html
<!-- Tool row; toggle .expanded on click; state class is running|done|error -->
<div class="msg-tool running">
  <div class="msg-tool-header">
    <span class="tool-status"></span>   <!-- glyph via CSS mask, keep empty -->
    <span class="tool-chevron"></span>  <!-- glyph via CSS mask, keep empty -->
    <span class="tool-name">Bash</span>
    <span class="tool-summary">ls -la</span>
  </div>
  <div class="msg-tool-body">…mono output…</div>
</div>

<!-- Thinking; 3-line clamp until .expanded -->
<div class="msg-thinking"><div class="msg-thinking-body">…</div></div>

<!-- Code block emitted by markdown.js (bare .md > pre is also styled) -->
<div class="code-block">
  <div class="code-block-header">
    <span class="code-lang">python</span>
    <button class="code-copy-btn">복사</button>
  </div>
  <pre><code class="hljs language-python">…</code></pre>
</div>

<!-- Approval / question modal inside #modal-root -->
<div class="modal-backdrop">
  <div class="modal">
    <div class="modal-title">…</div>
    <div class="modal-body">… <pre>…command…</pre> <input type="text"> …</div>
    <div class="modal-actions">
      <button class="btn">거절</button>
      <button class="btn-primary">승인</button>
    </div>
  </div>
</div>

<!-- Usage card (contract-fixed children) + optional .usage-card-caption line -->
<div class="usage-card">
  <div class="usage-card-title">주간 사용량</div>
  <div class="usage-card-value">42%</div>
  <div class="progress-bar"><div class="progress-fill" style="width:42%"></div></div>
</div>
```

Notes:

- `.progress-bar` styles its first child as the fill even without
  `.progress-fill`, so `<div class="progress-bar"><div style="width:42%">`
  works. Optional modifiers `.warn` / `.crit` recolor the fill.
- `#model-label` / `#context-meter` carry the pill look directly by id, so no
  extra class is needed; `.badge` / `.pill` exist for anything else.
- A minimal Xcode-ish `.hljs` token theme (dark base + light override) ships
  in `components.css`, so no vendor highlight theme CSS is required. It does
  not collide with a vendor theme if the shell agent decides to link one anyway.
- `#send-btn` draws its arrow via CSS mask — leave the button empty in HTML.
  If an inline `<svg>` is ever added, the CSS arrow hides via `:has(svg)`.
- All glyphs (chevron, status check/x, spinner, send arrow, v2 chrome icons)
  are CSS masks or borders — no emoji, no image assets, all tint via tokens.
- Buttons use `cursor: default` per macOS convention (no hand cursor).
- `prefers-reduced-motion` collapses all animations/transitions.
- `#boot-error` keeps its inline styles in index.html (renders even if CSS
  fails; app.js toggles `style.display`); `components.css` mirrors the same
  look via tokens so the layer stays themed if the inline styles are dropped.

## Icon

`assets/icon.svg` is the source: a black rounded square (rx=229) with a white
terminal chevron and an accent-blue (`#0A84FF`) block cursor.
`assets/icon.png` (1024×1024) is rendered from the same geometry by
`assets/make_icon.py` (Pillow, 4× supersampling + LANCZOS) — re-run
`python3 assets/make_icon.py` after editing the SVG.

## Cross-platform

- Font stack falls back to Segoe UI / Malgun Gothic on Windows; translucent
  surfaces degrade gracefully without vibrancy (they sit over `--bg`).
- Scrollbars: 8px `::-webkit-scrollbar` with rounded thumb, transparent track
  (plus `scrollbar-width: thin` and `color-scheme` for completeness).
- All borders are 0.5–1px token-based hairlines; everything interactive has
  `:hover` / `:active` states and `:focus-visible` gets a 2px accent ring.
