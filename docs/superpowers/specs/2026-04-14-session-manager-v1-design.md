# Claude Session Manager v1.0 — Design Spec

## Overview

A VS Code extension for managing multiple Claude Code CLI sessions across different projects. Each session runs in a terminal promoted to an editor tab, giving users a tab-per-project workflow for monitoring and switching between concurrent Claude sessions.

## Problem

The previous version (v0.1) scanned `~/.claude/projects/` and attempted to decode folder names back to real filesystem paths. The encoding is lossy — spaces, dots, and underscores all collapse to hyphens — causing ~70% of folders to fail decoding. The extension needs a reliable folder source and richer session management UX.

## Design Decisions

- **Drop `~/.claude/projects` scanning entirely.** The encoding is fundamentally ambiguous and cannot be reliably decoded. No fallback, no partial decode.
- **Use VS Code recent folders as the primary folder source.** Accessed via `_workbench.getRecentlyOpened()` internal command. Returns resolved URIs — no decoding needed. Covers virtually all real usage since users open projects in VS Code before launching Claude.
- **Keep terminal-based launch.** The Claude Code VS Code extension commands (`claude-vscode.editor.open` etc.) don't accept a folder argument — they always scope to the current workspace. Terminal with `cwd` is the only way to target a different folder without switching workspaces.
- **Promote terminals to editor tabs.** Each Claude session opens as an editor tab (via `workbench.action.terminal.moveToEditor`) rather than living in the bottom terminal panel. This gives each session visual parity with code files and supports the tab-per-project mental model.

## Components

### 1. Activity Bar + Sidebar Tree View

A dedicated "Claude Sessions" panel registered in the activity bar with a sparkle icon.

**Tree structure — two sections:**

- **Active Sessions** — currently running Claude terminal tabs
  - Each item shows: folder name, running duration, green status indicator
  - Click: focus the session's editor tab
  - Right-click context menu: Focus, Close
- **Recent Projects** — folders from VS Code recents + `extraFolders` config
  - Each item shows: folder name, parent directory path
  - Click or inline play-button: launch a new session
  - Folders that already have an active session are excluded from this section (they appear in Active Sessions instead)

**Data flow:**
- On activation and on terminal open/close events, refresh both sections
- Active sessions detected by matching terminal name pattern `claude · *` or `cwd`
- Recent folders fetched from `_workbench.getRecentlyOpened()`, filtered to folders only (exclude workspaces and files)

### 2. Quick-Pick Launcher

Keyboard shortcut `Ctrl+Shift+Alt+C` (Mac: `Cmd+Shift+Alt+C`) opens a quick-pick.

**Sort order:**
1. Active sessions — marked with terminal icon, selecting focuses existing tab
2. Recent folders — VS Code recency order
3. Extra folders — labeled "configured"

**Behavior:**
- Selecting an active session focuses its editor tab
- Selecting a folder launches a new session (or focuses existing if `reuseExistingTerminal` is on)

### 3. Terminal-as-Editor-Tab Launch

When a session is launched:

1. Create a named terminal: `claude · <folder-name>`
   - `cwd`: selected folder path
   - `iconPath`: sparkle ThemeIcon
   - `color`: `terminal.ansiGreen`
2. Move terminal to editor area via `workbench.action.terminal.moveToEditor`
3. Auto-send the configured `claudeCommand` (default: `"claude"`)

If `reuseExistingTerminal` is enabled and a terminal matching the folder already exists, just focus it.

### 4. Status Bar

A status bar item on the left side:

- Shows `⚡ N sessions` when N > 0
- Hidden when no active sessions
- Click opens the quick-pick launcher

Updates reactively on terminal open/close events.

### 5. Active Session Detection

Terminals are identified as Claude sessions by:
- Name matching pattern `claude · *` (primary — our naming convention)
- `creationOptions.cwd` matching a known folder path (fallback)

The extension listens to:
- `window.onDidOpenTerminal` — add to active sessions
- `window.onDidCloseTerminal` — remove from active sessions

Limitation: only detects sessions in the current VS Code window.

### 6. Terminal Link Provider

Register a `TerminalLinkProvider` that:
- Matches file paths in Claude's terminal output (e.g., `src/components/App.tsx`, `C:\Users\chris\project\file.ts`)
- On click, opens the file in the editor via `vscode.window.showTextDocument`

This makes Claude's file references directly clickable.

### 7. Keyboard Navigation

Two additional keybindings:
- **Next Claude Session** — cycles forward through Claude terminal tabs only
- **Previous Claude Session** — cycles backward

Implementation: filter `window.terminals` to those matching the Claude name pattern, maintain an index, and focus the next/previous one.

## Configuration

```json
{
  "claudeSessions.claudeCommand": {
    "type": "string",
    "default": "claude",
    "description": "The Claude Code CLI command to run"
  },
  "claudeSessions.reuseExistingTerminal": {
    "type": "boolean",
    "default": true,
    "description": "Focus existing session tab instead of opening a duplicate"
  },
  "claudeSessions.extraFolders": {
    "type": "array",
    "items": { "type": "string" },
    "default": [],
    "description": "Additional folder paths to show in the session launcher"
  }
}
```

**Removed from v0.1:**
- `claudeProjectsDir` — no longer scan `~/.claude/projects`

**Renamed config prefix** from `claudeFolderSessions` to `claudeSessions` (shorter, reflects the expanded scope).

## Extension Activation

- `onStartupFinished` — to populate the sidebar tree view on launch
- Terminal event listeners registered immediately to track session lifecycle

## Commands

| Command ID | Title | Keybinding |
|---|---|---|
| `claudeSessions.openSession` | Claude Sessions: Launch Session | `Ctrl+Shift+Alt+C` |
| `claudeSessions.addFolder` | Claude Sessions: Add Folder | — |
| `claudeSessions.nextSession` | Claude Sessions: Next Session | `Ctrl+Alt+]` |
| `claudeSessions.prevSession` | Claude Sessions: Previous Session | `Ctrl+Alt+[` |
| `claudeSessions.focusSession` | Claude Sessions: Focus Session | — (tree view click) |
| `claudeSessions.closeSession` | Claude Sessions: Close Session | — (context menu) |

## File Structure

```
vscode-claude-sessions/
├── src/
│   ├── extension.ts          # Activation, command registration
│   ├── sessionManager.ts     # Core session tracking, terminal lifecycle
│   ├── folderSource.ts       # VS Code recents + extraFolders fetching
│   ├── treeView.ts           # Sidebar tree data provider
│   ├── quickPick.ts          # Quick-pick launcher
│   ├── statusBar.ts          # Status bar item
│   ├── terminalLinks.ts      # Terminal link provider
│   └── config.ts             # Configuration helpers
├── package.json
├── tsconfig.json
└── .vscodeignore
```

## Out of Scope

- Sending prompts or interacting with Claude sessions programmatically
- Reading session history or conversation data
- Multi-window session tracking
- Workspace/multi-root folder support in tree view
