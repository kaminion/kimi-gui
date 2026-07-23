# Kimi Code and Kimi CLI, Made Easier

**One Kimi login. Two ways to work. One focused desktop app.**

[kimi-gui](https://github.com/kaminion/kimi-gui) is an open-source desktop
interface for Kimi Code and Kimi Code CLI. It is designed for people who want
the power of an AI coding agent without spending their day managing terminal
windows, remembering commands, or guessing what the agent changed.

With kimi-gui, you can start with a simple built-in experience and move to the
full Kimi CLI agent workflow when you need more advanced capabilities. Your
conversations, project context, agent activity, file changes, and usage stay
visible in one place.

> kimi-gui is an independent community project. It is not an official
> Moonshot AI product.

## Start with one Kimi login

Open the app, select **Log in**, and complete Kimi's verification in your
browser. The built-in engine is ready without installing or configuring Kimi
Code CLI.

The same local Kimi credentials can be shared with the CLI, so you do not have
to maintain a separate account setup when you decide to use CLI Agent mode.

![A simple first-launch screen with one Log in to Kimi button](https://raw.githubusercontent.com/kaminion/kimi-gui/main/docs/media/kimi-login.png)

## Choose the experience that fits the task

You do not need the most advanced agent workflow for every job. kimi-gui gives
you a practical choice:

| If you want to… | Choose |
| --- | --- |
| Sign in and start quickly, without installing the CLI | **Built-in engine** |
| Chat, edit files with approvals, and control model and thinking effort | **Built-in engine** |
| Use the full Kimi CLI toolset and continue CLI sessions | **CLI Agent mode** |
| Use Plan mode, sub-agents, or Swarm for larger tasks | **CLI Agent mode** |

When the CLI is not installed, the app can guide you through installation.
When it is available, you can connect it instead. You can also keep the
built-in engine and switch later from Settings.

The connection dialog explains what becomes available before you switch:
Swarm and sub-agents, Plan mode, the full CLI toolset, and continuity with
sessions created by Kimi Code CLI.

![The CLI Agent mode dialog explains the advanced capabilities available after connecting](https://raw.githubusercontent.com/kaminion/kimi-gui/main/docs/media/release-0.6.1-cli-capabilities.png)

## Start in the right project and branch

Before sending the first message, choose the project directory and an existing
local Git branch. The app remembers your most recent project, which makes
returning to daily work faster.

This keeps the important context visible before Kimi begins. You are less
likely to start a task in the wrong folder or discover too late that you were
working on the wrong branch.

![A new conversation with project and Git branch controls above the prompt](https://raw.githubusercontent.com/kaminion/kimi-gui/main/docs/media/release-0.6.0-new-chat.png)

## Stay in control while Kimi is working

An agent run does not have to be an all-or-nothing operation. The prompt remains
available while work is in progress, so you can send an adjustment without
stopping the entire run.

That is useful when you notice a missing requirement, want Kimi to preserve a
particular file, or need to narrow the scope before more changes are made. Each
adjustment appears in the conversation as a visible queued item, giving you a
chance to edit or delete it before Kimi picks it up. A separate stop control
remains available when you really do want to end the run.

![An active conversation with a queued work adjustment that can be edited or deleted](https://raw.githubusercontent.com/kaminion/kimi-gui/main/docs/media/release-0.6.1-queued-steer.png)

## Review the result without hunting through the repository

When Kimi edits code or documentation, kimi-gui shows change cards directly in
the conversation. You can see which files changed, inspect added and deleted
lines, and open the shared **Changes** panel for a focused review.

The same right-side panel also provides agent activity, so you can understand
both what the agent is doing and what it has changed without stacking multiple
inspectors.

![The Changes tab showing changed files and a per-file diff beside the conversation](https://raw.githubusercontent.com/kaminion/kimi-gui/main/docs/media/release-0.6.0-changes-panel.png)

## A desktop workspace, not just a chat window

kimi-gui brings the parts of an everyday coding-agent workflow together:

- Built-in and CLI conversations in one searchable sidebar
- Per-conversation model and thinking controls
- Project directory and Git branch selection
- Live thinking, responses, tool activity, and context usage
- Approval dialogs for local tools in built-in mode
- Plan mode, sub-agents, and Swarm in CLI Agent mode
- Inline file-change cards and a tabbed review panel
- Daily and rolling usage visibility
- English and Korean interfaces with dark and light themes

The result is a gentler starting point for new Kimi Code users and a more
visible, organized workspace for experienced Kimi CLI users.

## Who is it for?

kimi-gui is a good fit if:

- You want to try Kimi Code without first learning a CLI workflow.
- You already use Kimi CLI but want a visual home for sessions and changes.
- You switch between quick edits and larger multi-agent tasks.
- You want project, branch, context, usage, and file changes visible while you
  work.
- You prefer native desktop controls for folders, approvals, updates, and
  settings.

## Try kimi-gui

Requirements:

- macOS or Windows
- Node.js 20 or later when running from source
- A Kimi membership

Run it from source:

```sh
git clone https://github.com/kaminion/kimi-gui.git
cd kimi-gui
npm install
npm start
```

Installers and portable builds are available from
[GitHub Releases](https://github.com/kaminion/kimi-gui/releases).

**Use Kimi Code for a quick desktop conversation. Connect Kimi CLI when the
task needs the full agent workflow. Keep both experiences in one place.**
