# Claude Conductor

Orchestrate multiple [Claude Code](https://docs.anthropic.com/claude-code) sessions across different projects as editor tabs in a single VS Code window.

[![VS Marketplace](https://badgen.net/vs-marketplace/v/cbeaulieu-gt.claude-conductor)](https://marketplace.visualstudio.com/items?itemName=cbeaulieu-gt.claude-conductor)
[![Installs](https://badgen.net/vs-marketplace/i/cbeaulieu-gt.claude-conductor)](https://marketplace.visualstudio.com/items?itemName=cbeaulieu-gt.claude-conductor)
[![Preview](https://img.shields.io/badge/status-preview-orange)](https://marketplace.visualstudio.com/items?itemName=cbeaulieu-gt.claude-conductor)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

## Why

Running Claude Code against several projects at once is painful in a plain terminal. This extension turns each session into a first-class editor tab with a persistent sidebar, quick-pick launcher, and idle notifications — so you can work across multiple codebases without losing track of which session needs your attention.

## Features

### Activity Bar Sidebar

A dedicated "Claude Sessions" panel with two sections:

- **Active Sessions** — currently running Claude terminals. Click to focus. A green terminal icon means the session is working; an orange bell means it's waiting for your input.
- **Recent Projects** — your VS Code recently opened folders plus any configured extras. Click to launch a new session.

### Quick-Pick Launcher

Press **`Ctrl+Shift+Alt+C`** (Mac: `Cmd+Shift+Alt+C`) to bring up a searchable list of projects. Active sessions appear first — selecting one focuses the tab. Selecting a folder launches a new session there.

### Terminal-as-Editor-Tab

Each Claude session opens in the **editor area** (not the bottom terminal panel), so you can tile them, pin them, and glance at multiple sessions at once like you would with code files.

### Idle Notifications

When Claude finishes work and is waiting for your next prompt, you get:

- A **bell icon** next to the session in the sidebar
- A **VS Code notification** with a "Focus" button that jumps to that session's tab

If multiple sessions are waiting simultaneously, you get a single consolidated notification that opens a quick-pick to choose which to focus.

Powered by [Claude Code hooks](https://docs.anthropic.com/claude-code/hooks) — the extension offers to install the hooks on first activation.

### Open in New Window (Deep Work)

Each active session has an "Open in New Window" button that launches a dedicated VS Code window scoped to that project, with Claude auto-starting. Good for focused deep-work sessions when you want the rest of VS Code out of the way.

### Terminal Link Provider

File paths in Claude's terminal output are clickable — open them directly in the editor without copy-pasting.

### Keyboard Navigation

- `Ctrl+Alt+]` — focus the next Claude session
- `Ctrl+Alt+[` — focus the previous Claude session

Cycles through Claude tabs only, not every terminal or editor tab.

## Getting Started

1. Install the extension
2. Make sure the `claude` CLI is on your PATH — see [Claude Code installation](https://docs.anthropic.com/claude-code)
3. When prompted, click **Allow** to install notification hooks (adds entries to `~/.claude/settings.json`)
4. Press **`Ctrl+Shift+Alt+C`** and pick a folder to launch your first session

## Configuration

| Setting | Default | Description |
|---|---|---|
| `claudeSessions.claudeCommand` | `"claude"` | CLI command to run in the terminal |
| `claudeSessions.reuseExistingTerminal` | `true` | Focus an existing session tab instead of opening a duplicate |
| `claudeSessions.enableNotifications` | `true` | Show notifications when a session is waiting for input |
| `claudeSessions.extraFolders` | `[]` | Additional folder paths to show in the launcher |

## Commands

Available from the command palette (`Ctrl+Shift+P`):

- `Claude Sessions: Launch Session`
- `Claude Sessions: Add Folder`
- `Claude Sessions: Next Session` / `Previous Session`
- `Claude Sessions: Setup Notification Hooks`
- `Claude Sessions: Remove Notification Hooks`

## How Idle Detection Works

When you allow notification hooks, the extension adds three entries to your `~/.claude/settings.json`:

| Hook | Fires when | Effect |
|---|---|---|
| `Notification` + `idle_prompt` | Claude has been waiting for input ~60s | Marks session idle, shows notification, bell icon |
| `UserPromptSubmit` | You submit a prompt | Marks session active, clears notification |
| `Stop` | Session ends | Cleans up state file |

The hooks write state files to `~/.claude/session-state/` which the extension watches. **Only your VS Code extension reads these files** — no data leaves your machine.

To remove the hooks at any time: run `Claude Sessions: Remove Notification Hooks` from the command palette.

## Requirements

- VS Code 1.85 or newer
- [Claude Code CLI](https://docs.anthropic.com/claude-code) installed and on PATH

## Known Limitations

- Session tracking only works within a single VS Code window (sessions in other windows aren't visible in the sidebar)
- The idle notification fires after Claude Code's built-in ~60-second idle threshold — not tunable from the extension
- VS Code terminal tabs cannot change color or flash after creation, so "attention" is communicated via sidebar bell icons and notifications rather than tab-level indicators

## Source

[github.com/cbeaulieu-gt/vscode-claude-conductor](https://github.com/cbeaulieu-gt/vscode-claude-conductor)

## License

MIT
