# Design — Reattach Claude sessions on VS Code startup (#43)

**Issue**: [#43](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/43)
**Date**: 2026-04-27
**Status**: Approved — ready for implementation planning

---

## Problem

When VS Code restarts (close → reopen, or in some configurations after a ptyhost crash or system restart), terminal **tab envelopes** are restored — name, position, icon, and `creationOptions.cwd` survive — but the inner shell process is sometimes replaced with a fresh one. In that case, a Claude Conductor tab labelled `claude · my-project` reopens with a bare prompt and no `claude` running. The user has to remember which tabs need re-launching and type `claude` manually into each.

Claude Conductor already detects these tabs (`SessionManager` constructor iterates `vscode.window.terminals` and calls `_trackIfClaudeSession`). The missing piece is **dispatching `claude` into the restored tab when its shell is fresh**, without firing into a tab whose shell survived (where `claude` is still running and dispatch would inject the literal text `"claude"` as user input).

## Goals

1. After VS Code restart, Claude tabs whose shells were replaced come back to a working `claude` session automatically — no user action required.
2. Tabs whose shells *survived* (the common case under default persistent-session settings) are left untouched.
3. Tabs whose `cwd` no longer exists on disk are cleaned up (disposed) with a one-time toast, rather than left as silently-broken bare prompts.

## Non-goals

- **Restoring Claude's in-conversation memory.** That's an Anthropic-side property of Claude Code itself; this design only restores the *session* (a running `claude` process), not its prior context.
- **Replacing VS Code's terminal model with a custom PTY.** That's [#44](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/44). This design works inside VS Code's terminal API.
- **Adopting externally-launched `claude · *` sessions.** That's [#33](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/33). This design's PID-record approach is forward-compatible — externally-launched terminals will get tracked and PID-recorded the same way once #33 picks them up.
- **Changing close-detection.** That's [#68](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/68). PID records and close-detection records are decoupled and don't interact.

## Architecture

A single new "reattach pass" runs at the end of `SessionManager`'s constructor, after the existing tracking loop. For each tracked Claude terminal, an async per-session routine compares the terminal's *current* shell PID against a previously-stored PID for the same folder path. The comparison decides whether to dispatch `claude`:

| Current PID vs stored PID | Meaning | Action |
|---|---|---|
| Match | Shell process survived across the activation boundary; `claude` is most likely still running | **Skip dispatch** |
| Differ | Shell was replaced; `claude` is gone | **Dispatch `claude`** (existing 3-tier `_dispatchClaudeCommand`) |
| No stored PID | First activation post-install, or after `workspaceState` was wiped | **Dispatch `claude`** (Option A — see *Decisions* below) |
| `processId` resolves to `undefined` or rejects | We can't reason about the shell state | **Skip dispatch** (conservative — better a bare prompt than a stray `"claude"` injected into an active session) |

`workspaceState` is the persistence layer for the PID record. The record is keyed on lower-cased normalized folder path, mirroring the existing case-insensitive `_findSessionByFolder` convention.

## Code surfaces

| File | Change |
|---|---|
| `src/sessionManager.ts` | Constructor takes a new `workspaceState: vscode.Memento` arg. New private methods `_reattachRestoredSessions()`, `_persistSessionPid(folderPath, pid)`, `_clearSessionPid(folderPath)`. `_dispatchClaudeCommand` is reused as-is — no need to make it public. |
| `src/extension.ts` | Pass `context.workspaceState` to `new SessionManager(...)`. One-line change to the existing constructor call. |
| `package.json` | No new settings (unconditional behavior — see *Decisions*). |
| `test/reattachOnStartup.test.ts` | New file covering the scenarios in *Test coverage* below. |
| `CHANGELOG.md` | Note the one-time stray-`claude` cost on first activation post-upgrade for users with surviving shells (see *Rollout*). |

### Why a method on `SessionManager` and not a top-level activation step

Keeps the lifecycle-management logic colocated with the terminal-tracking logic that already lives in `SessionManager`. The class already owns the `_sessions` map, the `_pidToTerminal` map, and the close-detection state machine. Adding the reattach pass to the same surface keeps the abstraction boundary clean: any future redesign (e.g., #44's PTY wrapper) replaces this entire surface as a unit, rather than scattering startup logic across `extension.ts`.

### Why a single batch pass at the end of the constructor, not inline in `_trackIfClaudeSession`

`_trackIfClaudeSession` runs synchronously and is also called from `onDidOpenTerminal` during normal use. We don't want every newly-opened terminal to trigger reattach logic — only the snapshot of restored tabs at activation time. A separate explicit pass distinguishes "I just saw a terminal appear during normal use, don't reattach it" from "I'm enumerating restored tabs at activation, decide whether to reattach each one."

## Lifecycle

### Activation order

1. Existing constructor loop iterates `vscode.window.terminals` and calls `_trackIfClaudeSession` on each — same as today.
2. **NEW**: After that loop, `_reattachRestoredSessions()` is invoked. It iterates `_sessions.values()` and for each entry kicks off an async per-session reattach routine. All routines run in parallel via `Promise.allSettled` (no `await` blocks the constructor — terminal output appears as the async routines complete).
3. The constructor returns synchronously. Tree views, status bar, etc. bind to a populated `_sessions` map immediately.
4. The existing `AUTO_LAUNCH_KEY` block in `extension.ts` (lines 94–97) still fires after construction. Because `launchSession` checks `getReuseTerminal()` and finds the just-tracked session, it focuses instead of creating — no double-dispatch.

### Per-session async reattach routine

```
1. await terminal.processId          → currentPid (number | undefined)
2. read stored PID for folderPath    → storedPid (number | undefined)
3. if currentPid === undefined       → log and skip (can't make a decision)
4. if storedPid === currentPid       → shell survived, claude likely running, skip
5. if !fs.existsSync(folderPath)     → dispose tab + toast "Could not restore session for <folder> — folder no longer exists"
6. else                              → call _dispatchClaudeCommand(terminal)
7. always (steps 4 and 6)            → _persistSessionPid(folderPath, currentPid)
```

Step 7 also runs on the survival branch (4) so `workspaceState` is refreshed every activation — keeps the record current even when no dispatch was needed.

### PID persistence lifecycle

| Event | Action |
|---|---|
| Session tracked (in `_trackIfClaudeSession`, after `terminal.processId` resolves) | Call `_persistSessionPid(folderPath, pid)` — writes the new entry into `workspaceState` |
| Session closed (in `_removeByKey`) | Call `_clearSessionPid(folderPath)` — removes the entry. Closed sessions shouldn't leave PID ghosts in state |
| Reattach decision (step 7 above) | Refresh after every dispatch decision |

### State shape

Stored under the key `claudeConductor.sessionPids` in `workspaceState`. Type: `Record<string, number>`. Keys are lower-cased normalized folder paths (matching the existing `_findSessionByFolder` convention: `path.normalize(folderPath).toLowerCase()`).

```ts
// Example
{
  "i:\\projects\\career-ops": 12345,
  "i:\\projects\\notes": 67890
}
```

### Write serialization

`_persistSessionPid` and `_clearSessionPid` perform read-modify-write on the single shared `claudeConductor.sessionPids` record. Multiple reattach routines run in parallel and each session's tracking-time PID resolution can also fire concurrently, so concurrent writes would race and clobber each other.

The implementation **must serialize** these writes through an internal promise queue:

```ts
private _pidWriteQueue: Promise<void> = Promise.resolve();

private _persistSessionPid(folderPath: string, pid: number): void {
  this._pidWriteQueue = this._pidWriteQueue.then(async () => {
    const current = this._workspaceState.get<Record<string, number>>(PID_KEY) ?? {};
    current[folderPath] = pid;
    await this._workspaceState.update(PID_KEY, current);
  });
}
```

Writes complete in order; reads inside the chain see the latest persisted record. Acceptable cost — these writes are infrequent and small.

## Error handling

| Failure | Handling |
|---|---|
| `terminal.processId` resolves to `undefined` | Log via `debugLog`, skip dispatch. Conservative — without a PID we can't compare, so we don't risk text injection. |
| `terminal.processId` rejects | Same as above — skip with a debug log. |
| `fs.existsSync(folderPath)` returns false | `terminal.dispose()` + `vscode.window.showInformationMessage` with the toast text. The dispose triggers existing close-detection cleanup, so `_sessions` and the PID record both clear automatically via `_handleTerminalClose` → `_removeByKey`. |
| `_dispatchClaudeCommand` falls through to delay-fallback `sendText` (existing 3-tier path) | Already handled by the existing implementation — terminal sees `claude` keystrokes after the `claudeConductor.launchDelayMs` delay (default 500 ms). Worst case: user gets a slightly slower reattach. Same behavior as new launches today. |
| `workspaceState` returns wrong-typed data (e.g., user manually edited it, or schema changed) | Defensive: treat as "no stored PID" → fall through to first-install path → dispatch. |
| Concurrent reattach + new launch race | Won't happen in practice — `launchSession` is only called from user-initiated commands, which can't fire during synchronous constructor execution. The async reattach routines complete naturally before any user input is possible. |

### `AUTO_LAUNCH_KEY` coordination (intentional, not a bug)

When VS Code is opened via a `vscode://` URI for a folder that *also* has a restored Claude tab, both reattach (from the constructor) and `AUTO_LAUNCH_KEY` (from `activate()` in `extension.ts`) fire. The reattach pass dispatches `claude` into the restored tab; then `AUTO_LAUNCH_KEY`'s `launchSession` call finds the now-tracked session and `focusSession`s it instead of creating a duplicate. Net effect: one terminal, one dispatch, one focus. **Intentional and correct** — flagged here so it's not "fixed" by mistake later.

## Decisions made during brainstorming

These design decisions were resolved during the 2026-04-27 brainstorm:

1. **PID comparison is the discriminator** — not "what triggered activation?" The right question is "did the shell process survive?", and PID identity answers it uniformly across VS Code close/open, Reload Window, ptyhost crashes, and system restarts.
2. **Unconditional behavior — no setting gate.** Reattach is a core property of how Conductor manages sessions. Following the strategic intent of "Conductor completely owns these tabs," there's no `claudeConductor.reattachOnStartup` setting; the behavior just happens.
3. **Dispose + toast on dead `cwd`.** When a restored tab's `cwd` no longer exists, `terminal.dispose()` removes the tab and a one-time toast informs the user. Cleaner than leaving a silently-broken bare prompt with a non-existent working directory.
4. **No-stored-PID → dispatch** (Option A). On first activation post-install (or after `workspaceState` reset), absence of a record is treated as "fresh shell, never seen before" and dispatch proceeds. Cost of being wrong is bounded: a one-time stray `"claude"` line in an active session, recoverable by the user. Cost of the alternative ("don't dispatch without positive evidence") is much worse — the feature appears broken on first impression.

## Test coverage

New file: `test/reattachOnStartup.test.ts`.

| # | Scenario | Setup | Assert |
|---|---|---|---|
| 1 | Same PID → no dispatch | Mock `vscode.window.terminals` with one `claude · foo` terminal whose `processId` resolves to `42`. Mock `workspaceState.get` to return `{ "/path/to/foo": 42 }`. Construct `SessionManager`. | `createTerminal` not called; `executeCommand("workbench.action.terminal.moveToEditor")` not called; the existing terminal is **not** sent any text via `sendText` or shell-integration `executeCommand`. |
| 2 | Different PID → dispatch via shell-integration fast path | Same setup, but stored PID is `99`. Mock `terminal.shellIntegration.executeCommand`. | `terminal.shellIntegration.executeCommand("claude")` called once. PID `42` written to `workspaceState`. |
| 3 | Different PID → dispatch via slow path | Same as 2, but `terminal.shellIntegration` is `undefined` initially. Fire `onDidChangeTerminalShellIntegration` after a short delay with `{ terminal, shellIntegration }`. | `shellIntegration.executeCommand("claude")` called once via the slow-path branch. |
| 4 | Different PID → dispatch via delay fallback | Same as 2, but neither shell-integration path fires (no event). Use vitest's fake timers. | `terminal.sendText("claude")` called after the configured delay. |
| 5 | No stored PID → dispatch | Stored map is empty. | Same dispatch behavior as scenario 2. PID written after dispatch. |
| 6 | Cwd missing → dispose + toast | Mock `fs.existsSync(folderPath)` to return false. | `terminal.dispose()` called. `vscode.window.showInformationMessage` called once with text containing the folder name. No `sendText` / `executeCommand("claude")` calls. |
| 7 | `processId` resolves to `undefined` | Mock `terminal.processId` to resolve undefined. | No dispatch, no dispose. Debug log emitted. State unchanged. |
| 8 | Multiple restored sessions in parallel | Three `claude · *` terminals, all with PID mismatches. | All three see their dispatch path called. After all routines settle, `workspaceState.update` reflects all three new PIDs (no clobber — verifies the write-queue serialization). |
| 9 | PID cleanup on close | Track + dispatch a session, then dispose its terminal. | `workspaceState.update` called with the entry removed. |
| 10 | `AUTO_LAUNCH_KEY` flow + reattach | Restored terminal for folder F + `AUTO_LAUNCH_KEY` set to F. | One dispatch (from reattach), one focus (from auto-launch's `launchSession` reuse path). No duplicate `createTerminal`. |

### Mock strategy

- Reuse the existing `test/mocks/vscode.ts` patterns (already used by `addFolderPrompt.stale.test.ts` from PR #73 and the existing `hookInstaller` tests).
- Add a `Memento` mock for `workspaceState`: `{ get, update, keys }` with an internal `Map<string, unknown>` backing store. Generic enough to live alongside the existing mocks.
- `terminal.processId` is mocked as `Promise.resolve(<number>)` per-test.
- `vi.mock("fs")` for the cwd-existence test (same pattern as the #71 test).

Existing tests stay untouched — the change is additive to `SessionManager`'s constructor, behind a new method that doesn't fire unless a tracked terminal exists at construction time.

## Rollout

- **No setting** → no migration.
- **First activation after upgrade**: any user who currently has restored Claude tabs sitting at bare prompts will see them auto-dispatch. Users with surviving shells (PIDs match → no dispatch) won't see a behavioral change.
- **Edge — surviving shells, no stored PIDs**: users upgrading from a pre-#43 version have no persisted PIDs in `workspaceState` yet, so the first activation post-upgrade falls into the "no stored PID → dispatch" branch (Option A above). For users whose shells *did* survive and where claude *is* still running, this means a one-time stray `"claude"` gets sent into the active Claude session per terminal. That's the documented cost of Option A; surfaces once per existing session per upgrade, then never again.
- **Mention this in the CHANGELOG** so users aren't surprised. Single bullet under the version entry: *"Sessions are now reattached on VS Code startup. On the first launch after upgrade, an existing tab with `claude` already running may receive a stray `claude` keystroke; subsequent launches won't."*

## Future direction (informative — not part of this PR)

### Strategic note on tab ownership

The unconditional-default and dispose-on-dead-cwd choices reflect a strategic intent surfaced during the brainstorm: **Conductor should completely own Claude session tabs**, rather than passively observing whatever VS Code's terminal API does. This PR is a step toward that: it makes Conductor the active manager of session lifecycle. Future design decisions in this area should default to "Conductor decides" rather than "Conductor adapts to VS Code." Capturing the rationale here so it doesn't get diluted later.

### #44 — custom PTY wrapper

Once #44 is on the table (Conductor owns the PTY directly), this entire reattach pass collapses into "the Conductor process is alive across VS Code restarts; tabs re-bind to live PTYs without dispatching anything." The work in this PR is not wasted — it makes the per-tab lifecycle ownership explicit, which is a precondition for #44. But the implementation surface (PID record, dispatch logic) will be replaced wholesale by the PTY-ownership design.

### #33 — externally-launched session adoption

The PID-record approach is forward-compatible. When #33 picks up `claude · *` terminals that were not created by us, they will be tracked the same way and PID-recorded the same way. The reattach survival check works identically for them — no code change needed in this design's surface to support that future work.

### #68 — close-detection spike

This design does not change close-detection paths. The PID record is keyed on folder path and is cleared on close-detection eviction (via `_removeByKey` → `_clearSessionPid`), so the two systems are decoupled.
