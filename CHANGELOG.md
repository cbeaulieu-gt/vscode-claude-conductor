# Changelog

All notable changes to the Claude Conductor extension are documented here.

## [Unreleased]

### Added
- **Reattach Claude sessions on VS Code startup** (#43). Conductor now detects restored session tabs whose inner shell was replaced (after a system restart, ptyhost crash, or VS Code with persistent-session revival off) and dispatches `claude` into each tab automatically. Gated by the new `claudeConductor.relaunchOnStartup` setting (default `true`).
- First-activation consent toast when the official Claude Code extension (`Anthropic.claude-code`) is detected. Lets users opt out of reattach to avoid Conductor injecting keystrokes into the official extension's sessions.
- **`claudeConductor.debugLogging` setting** — when enabled, emits verbose structured `key=value` diagnostic lines to the "Claude Conductor" output channel for every session-lifecycle event: terminal tracking (`[track]`, `[track:pid]`), close-detection tier outcomes (`[close]`, `[close:tier1]`, `[close:tier2]`, `[close:tier3]`, `[close:tier3:no-pid]`), PID index mutations (`[pid:delete]`), and reconcile poll results (`[reconcile]`, `[reconcile:evict]`, `[reconcile:clean]`). Default off; intended for diagnosing missed editor-tab close events (refs #68 phase A).

### Fixed
- **Open in New Window no longer silently no-ops on the current window** — when the command is invoked on a session whose folder is already the active workspace, VS Code would receive the `vscode://` URI, route it back to the same window, and the user would perceive no change. The command now detects this case via a case-insensitive folder comparison, shows a dismissible info toast ("You're already in this project's window — focused the session instead."), and focuses the session tab instead of firing the URI. Fixes #66.

### Notes
- **Windows shell limitation**: the buffered-input clear-prefix used on the delay-fallback dispatch path uses Ctrl-C + Ctrl-U, which is interpreted as line-clear on POSIX shells and Windows PowerShell with PSReadLine (the default). On legacy cmd.exe and PowerShell-without-PSReadLine, the clear is a no-op — set `claudeConductor.relaunchOnStartup: false` if affected.
- **First launch after upgrade**: existing Claude tabs whose shells survived your last VS Code restart may receive a one-time stray `claude` keystroke (no stored PID baseline). Subsequent activations are race-free.
- **Day-1 collision with the official Claude Code extension**: if you install the official extension *after* Conductor's first activation, the consent toast won't retroactively fire. Set `claudeConductor.relaunchOnStartup: false` manually if needed.

## [1.3.0] — 2026-04-23

### Added
- **Vitest test infrastructure** — `npm test` / `npm run test:watch`, `test/mocks/vscode.ts` VS Code API mock, first regression test porting PR #35's manual test note. PR #50.
- **GitHub Actions CI workflow** — four parallel jobs (lint, typecheck, test, compile) on ubuntu-latest + Node 20, runs on every PR and push to main. README status badge added. PR #53.

### Changed (BREAKING)

All user-facing identifiers have been renamed from the `claudeSessions.*` namespace to `claudeConductor.*`. There are no backward-compatibility aliases — users must update any custom keybindings or settings that reference the old names.

**Command ID rename mapping:**

| Old | New |
|---|---|
| `claudeSessions.openSession` | `claudeConductor.openSession` |
| `claudeSessions.addFolder` | `claudeConductor.addFolder` |
| `claudeSessions.nextSession` | `claudeConductor.nextSession` |
| `claudeSessions.prevSession` | `claudeConductor.prevSession` |
| `claudeSessions.focusSession` | `claudeConductor.focusSession` |
| `claudeSessions.closeSession` | `claudeConductor.closeSession` |
| `claudeSessions.openInNewWindow` | `claudeConductor.openInNewWindow` |
| `claudeSessions.setupHooks` | `claudeConductor.setupHooks` |
| `claudeSessions.removeHooks` | `claudeConductor.removeHooks` |
| `claudeSessions.refreshTreeView` | `claudeConductor.refreshTreeView` |

**Config key rename mapping:**

| Old | New |
|---|---|
| `claudeSessions.claudeCommand` | `claudeConductor.claudeCommand` |
| `claudeSessions.reuseExistingTerminal` | `claudeConductor.reuseExistingTerminal` |
| `claudeSessions.enableNotifications` | `claudeConductor.enableNotifications` |
| `claudeSessions.extraFolders` | `claudeConductor.extraFolders` |
| `claudeSessions.launchDelayMs` | `claudeConductor.launchDelayMs` |

**Other renamed identifiers:**
- Activity Bar container ID: `claudeSessions` → `claudeConductor`
- View IDs: `claudeSessions.activeSessions` → `claudeConductor.activeSessions`, `claudeSessions.recentProjects` → `claudeConductor.recentProjects`
- Configuration section title: `Claude Sessions` → `Claude Conductor`
- Command palette prefixes: `Claude Sessions:` → `Claude Conductor:`

### Changed
- **Minimum VS Code version raised to 1.93.** This aligns `engines.vscode` with `@types/vscode` (required by `vsce publish`). Users on VS Code < 1.93 will no longer receive updates via the marketplace.

### Fixed
- **Shell init race condition** — `claude` is no longer sent to the terminal mid-profile-init. When VS Code shell integration is available (VS Code ≥ 1.93), the command is dispatched via `shellIntegration.executeCommand()` which waits for the shell prompt. On older VS Code or when shell integration is disabled, a configurable delay (`claudeConductor.launchDelayMs`, default 500 ms) is used instead. Fixes #40.
- **Idle notifications restored** — the sidebar bell icon and VS Code notification now correctly appear when a Claude session finishes and waits for input. The `Stop` hook deletes the state file; the extension was ignoring that deletion (`_onStateFileDeleted` was a no-op), so sessions stayed stuck in idle state indefinitely. The handler now looks up the session via a cached filename-to-path map and calls `setSessionIdle(folderPath, false)`, clearing both the tree-view icon and the idle set. A new **"Claude Conductor"** output channel logs state-file reads, dispatch decisions, and path-match results for easier diagnostics. Fixes #37.
- **Idle notification no longer spams on dismissal** — dismissing the idle notification (clicking × or elsewhere without choosing Focus) no longer causes it to re-appear every second. A new per-session "already notified" guard ensures the notification only re-fires when a session that has not yet been shown goes idle, so each idle episode produces exactly one notification. Fixes #39.
- **Idle notification no longer double-fires after dismissal** — after dismissing the idle dialog, a second identical dialog could occasionally appear a few seconds later when the deferred retry `setTimeout` fired even though the originally-idle session was already marked notified. The retry now re-verifies that at least one currently-idle session is still unnotified before re-firing, and `_showConsolidatedNotification` short-circuits when every idle path has already been notified this episode. Fixes #42.
- **Focus Session** button now moves keyboard focus into the terminal, not just reveals the tab. `Terminal.show(true)` in `focusSession()` was passing `preserveFocus=true`, which intentionally keeps focus elsewhere; changed to `false` so the terminal becomes active after the user clicks Focus. Fixes #32.
- Inline **Focus**, **Close**, and **Open in New Window** buttons in the Active Sessions tree view no longer throw `Cannot read properties of undefined`. Row-click and inline-button invocations pass different argument shapes (the `ActiveSession` data vs. the `TreeItem` wrapper); the command handlers now resolve both to the same session object before acting.
- F5 launch no longer fails with "extension already exists" when the marketplace copy of `cbeaulieu-gt.claude-conductor` is installed. `.vscode/launch.json` now passes `--disable-extension cbeaulieu-gt.claude-conductor` to the Extension Development Host so the installed copy is suppressed inside the dev host only.

### Notes
- **1.2.0 was skipped intentionally.** Starting with this release, the extension follows the VS Code marketplace odd/even minor convention — even minors (1.2.x, 1.4.x) are stable, odd minors (1.3.x, 1.5.x) are pre-release. 1.3.0 is the first release under this convention and ships via the pre-release channel; users without "Install Pre-Release Versions" enabled will stay on 1.1.5 until the next stable release.

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
