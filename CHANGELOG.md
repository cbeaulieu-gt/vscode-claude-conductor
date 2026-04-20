# Changelog

All notable changes to the Claude Conductor extension are documented here.

## [Unreleased]

### Fixed
- Inline **Focus**, **Close**, and **Open in New Window** buttons in the Active Sessions tree view no longer throw `Cannot read properties of undefined`. Row-click and inline-button invocations pass different argument shapes (the `ActiveSession` data vs. the `TreeItem` wrapper); the command handlers now resolve both to the same session object before acting.

### Fixed
- F5 launch no longer fails with "extension already exists" when the marketplace copy of `cbeaulieu-gt.claude-conductor` is installed. `.vscode/launch.json` now passes `--disable-extension cbeaulieu-gt.claude-conductor` to the Extension Development Host so the installed copy is suppressed inside the dev host only.

### Added
- `.vscode/launch.json` and `tasks.json` so contributors can press **F5** to run the extension in a development host (no VSIX build required for iteration)

## [1.1.5] — 2026-04-19

### Fixed
- README marketplace badges now render (shields.io had retired the `visual-studio-marketplace/*` endpoints; switched to badgen.net for live badges and shields.io static badges for Preview/License)

## [1.1.3] — 2026-04-19

### Changed
- Rebranded from "Claude Session Manager" to **Claude Conductor** (marketplace name collision with two existing extensions)
- Extension now shows a "Preview" badge on the marketplace reflecting its pre-release status
- Repository renamed: `vscode-claude-sessions` → `vscode-claude-conductor`

## [1.1.1] — 2026-04-14

### Added
- **Open in New Window** — URI-handler based "deep work" mode that launches a session in a dedicated VS Code window
- **Idle notifications** — bell icon in the sidebar and a VS Code notification when a session is waiting for input, via Claude Code hooks (`Notification/idle_prompt`, `UserPromptSubmit`, `Stop`)
- **First-activation setup** — extension prompts to install hooks in `~/.claude/settings.json`
- **Manual commands** — `Claude Sessions: Setup Notification Hooks` and `Claude Sessions: Remove Notification Hooks`
- **Configuration** — `claudeSessions.enableNotifications` (boolean, default `true`)

### Fixed
- Active Sessions tree view now updates when a session tab is closed (terminal reference changes after `moveToEditor`, so fall back to name-based matching)
- State file changes detected within 2 seconds via polling fallback (VS Code's `FileSystemWatcher` is unreliable for non-workspace directories on Windows)
- Notifications consolidated to a single popup when multiple sessions go idle simultaneously — avoids VS Code stacking bugs where clicking "Focus" resolved the wrong promise
- Hooks persist across VS Code restarts (no longer removed on `deactivate` since VS Code calls it on every window close)
- Hook setup prompt delayed by 3 seconds so it isn't buried by startup notifications

## [1.0.0] — 2026-04-14

Initial release.

### Added
- **Activity bar + sidebar tree view** — "Claude Sessions" panel with Active Sessions and Recent Projects sections
- **Quick-pick launcher** (`Ctrl+Shift+Alt+C` / `Cmd+Shift+Alt+C`) — active sessions first, then VS Code recent folders, then configured extras
- **Terminal-as-editor-tab** — each Claude session opens as a tab, not in the terminal panel
- **Status bar indicator** — `⚡ N sessions` when sessions are active
- **Terminal link provider** — file paths in Claude's terminal output are clickable
- **Keyboard navigation** — `Ctrl+Alt+]` / `Ctrl+Alt+[` to cycle between Claude sessions
- **Configuration** — `claudeSessions.claudeCommand`, `claudeSessions.reuseExistingTerminal`, `claudeSessions.extraFolders`
