# kimi-gui

![version](https://img.shields.io/badge/version-0.4.0-blue)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)
![made with](https://img.shields.io/badge/made%20with-vanilla%20JS%20%28no%20bundler%29-yellow)

[GitHub](https://github.com/kaminion/kimi-gui) · [한국어](README.ko.md)

> [!NOTE]
> **kimi-gui is a community project, not an official MoonshotAI product.** It uses the same local APIs and credentials as the Kimi Code CLI.

kimi-gui is an open-source desktop GUI that lets you use [Kimi Code](https://www.kimi.com) without the terminal. It runs on macOS and Windows, is built with Electron and plain JavaScript (ES2022, no bundler), follows Apple Human Interface Guidelines with a charcoal dark theme (light optional), and defaults to an English UI with full Korean support.

![kimi-gui demo — new chat, streaming reply, agent panel, and usage view](docs/media/demo.gif)

## Getting Started

**Requirements**

- Node.js 20 or later
- macOS or Windows
- Internet connection (sign-in, model responses, update checks)
- A Kimi membership

**Run from source**

```bash
npm install
npm start
```

**Build installers**

```bash
npm run dist
```

Artifacts are written to `dist/`: DMG + ZIP on macOS, NSIS installer + portable build on Windows.

> [!IMPORTANT]
> On first run, kimi-gui shows a splash screen and starts a browser device login — no CLI required. Credentials are stored in `~/.kimi-code/credentials`, shared with the Kimi Code CLI, so you log in once for both.

## Key Features

### Two engines

kimi-gui ships with two interchangeable engines, switchable with one click in Settings (the app restarts):

| | Built-in engine (direct, default) | CLI agent mode |
| --- | --- | --- |
| Dependencies | None — runs entirely in the app | Kimi Code CLI (the app can install it for you) |
| Sign-in | In-app OAuth device flow (auth.kimi.com) | Shared CLI credentials |
| API | Direct to the Anthropic-compatible API (api.kimi.com/coding) | The full CLI via its local `kimi web` server |
| Tools | 6 local tools (Bash/Read/Write/Edit/Grep/Glob) with approval dialogs | The complete agent: swarm mode, sub-agents, plan mode |
| Thinking effort | off / low / high / max | Per CLI configuration |
| Sessions | Stored locally in a CLI-compatible wire format | CLI sessions |

### Unified conversations

CLI-era sessions appear next to built-in ones in a single sidebar — open, continue, rename, or delete any of them. Create custom groups and organize sessions with drag & drop; anything ungrouped stays in the Recent section. Press ⌘F (Ctrl+F on Windows) for full-text search across all sessions, with jump-to-message navigation.

### Agent work panel

A right-hand panel shows the agent's current state in real time: task list, recent tool activity, and changed files.

### Composer option pills

Pills below the composer adjust the per-session model, swarm toggle (CLI agent mode), and thinking effort (off/low/high/max) without opening Settings.

### Usage view

Today's token usage with a 7-day daily chart, weekly and 5-hour rolling quota bars, and per-session token and context-window stats.

### And more

- English/Korean UI (English by default)
- Charcoal dark theme, light optional
- Automatic update checks via GitHub Releases

## Architecture

The main-process **engine facade** (`main/backend.js`) routes every session/chat call to either the direct or the CLI engine; the selected engine is persisted in `<userData>/settings.json`. The preload script (`main/preload.js`) exposes a minimal `window.kimi` API via `contextBridge` — the renderer runs with `contextIsolation` on and no `nodeIntegration`.

Design and architecture contracts live in `docs/`:

- [ARCHITECTURE.md](ARCHITECTURE.md) — binding architecture contract
- [docs/protocol.md](docs/protocol.md) — `kimi web` REST + WebSocket protocol notes (CLI engine)
- [docs/oauth.md](docs/oauth.md) — device-flow login notes (built-in engine)
- [docs/direct-api.md](docs/direct-api.md) — Anthropic-compatible API notes (built-in engine)
- [docs/update.md](docs/update.md) — auto-update behavior and release process

## Development

```bash
npm install        # install dependencies
npm start          # run the app
npm run dist       # build installers into dist/
node --check main/backend.js   # syntax-check a file (per file; plain JS, no build step)
```

```
├── main/          # Electron main process (CommonJS): engine facade, auth,
│                  # direct client/store, CLI server manager, IPC, updater
├── renderer/      # UI (ES modules loaded via script tags): chat, sidebar,
│                  # settings, usage, search, i18n, styles
├── vendor/        # Bundled libraries (marked, highlight.js)
└── docs/          # Design/architecture contracts and protocol notes
```

## Known limitations

- **The built-in engine runs one turn at a time with 6 tools.** No swarm, sub-agents, or plan mode — use CLI agent mode for those.
- **Windows paths are untested.** NSIS/portable builds and the Windows CLI installer path have not been verified on a real Windows machine.
- **Dev builds are unsigned.** macOS shows a Gatekeeper warning, and auto-update installation can fail without code signing and notarization.
- **Some main-process error strings are Korean-only** (e.g. login progress, CLI install progress).
