# Design — Reattach Claude sessions on VS Code startup (#43)

**Issue**: [#43](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/43)
**Date**: 2026-04-27 (revised after inquisitor review)
**Status**: Awaiting user re-approval

---

## Revision history

This spec was reworked after an adversarial inquisitor review identified five critical bugs and a contradiction with issue #43's stated Acceptance Criteria. Notable changes from the first draft:

- **Setting gate restored**. The first draft removed `claudeConductor.relaunchOnStartup` (default `true`) under a "Conductor completely owns these tabs" framing. The issue's AC explicitly requires this setting; it is restored.
- **PID write ordering reordered to eliminate the read-after-write race**. Tracking-time PID writes are removed. The reattach-decision step is the only writer at activation.
- **Buffered-input corruption mitigated**. The reattach call site clears the prompt with `Ctrl-C, Ctrl-U` before the dispatch fallback can commit stray input.
- **Promise-queue rejection handling added**. Each chain step has its own catch handler so a single `workspaceState.update` rejection doesn't permanently halt the queue.
- **Persistence key separated from in-memory lookup key**. Persisted under `path.normalize(folderPath)` (case preserved); in-memory lookup remains case-folded.
- **Aggregate dead-cwd toast** instead of one per dead tab.
- **Dispose paired with `reconcile()`** to force eviction if `onDidCloseTerminal` is missed.
- **Test table expanded** to exercise every Error handling row.
- **README updates** added to Rollout per the issue's AC.

---

## Problem

When VS Code restarts (close → reopen, or in some configurations after a `ptyhost` crash or system restart), terminal **tab envelopes** are restored — name, position, icon, and `creationOptions.cwd` survive — but the inner shell process is sometimes replaced with a fresh one. In that case, a Claude Conductor tab labelled `claude · my-project` reopens with a bare prompt and no `claude` running. The user has to remember which tabs need re-launching and type `claude` manually into each.

Claude Conductor already detects these tabs (`SessionManager` constructor iterates `vscode.window.terminals` and calls `_trackIfClaudeSession`). The missing piece is **dispatching `claude` into the restored tab when its shell is fresh**, without firing into a tab whose shell survived (where `claude` is still running and dispatch would inject the literal text `"claude"` as user input).

## Goals

1. After VS Code restart, Claude tabs whose shells were replaced come back to a working `claude` session automatically — no user action required.
2. Tabs whose shells *survived* (the common case under default persistent-session settings) are left untouched.
3. Tabs whose `cwd` no longer exists on disk are cleaned up (disposed) with a one-time aggregate toast, rather than left as silently-broken bare prompts.
4. Tab position, pinning, and editor-group layout are preserved (per AC).
5. Users who don't want this behavior can disable it via `claudeConductor.relaunchOnStartup: false` (per AC).

## Non-goals

- **Restoring Claude's in-conversation memory.** That's an Anthropic-side property of Claude Code itself; this design only restores the *session* (a running `claude` process), not its prior context.
- **Replacing VS Code's terminal model with a custom PTY.** That's [#44](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/44). This design works inside VS Code's terminal API.
- **Adopting externally-launched `claude · *` sessions.** That's [#33](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/33). This design's PID-record approach is forward-compatible — externally-launched terminals will get tracked and PID-recorded the same way once #33 picks them up. Until then, users with both Conductor and the official Claude Code extension installed should set `claudeConductor.relaunchOnStartup: false` (called out in CHANGELOG).
- **Changing close-detection.** That's [#68](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/68). PID records and close-detection records are decoupled and don't interact.
- **Moving or rearranging tabs.** Reattach operates strictly in-place on existing terminal references — `terminal.show()`, dispatch into the terminal, no `moveToEditor` calls. Tab position, pinning, and editor-group placement are inherited from VS Code's restoration.

## Architecture

A new "reattach pass" runs at the end of `SessionManager`'s constructor, after the existing tracking loop, **gated by `claudeConductor.relaunchOnStartup`**. For each tracked Claude terminal, an async per-session routine compares the terminal's *current* shell PID against a previously-stored PID for the same folder path. The comparison decides whether to dispatch `claude`:

| Current PID vs stored PID | Meaning | Action |
|---|---|---|
| Match | Shell process survived across the activation boundary; `claude` is most likely still running | **Skip dispatch** |
| Differ | Shell was replaced; `claude` is gone | **Dispatch `claude`** (via reattach helper that clears buffered input first) |
| No stored PID | First activation post-install, or after `workspaceState` was wiped | **Dispatch `claude`** (Option A — see *Decisions* below) |
| `processId` resolves to `undefined` or rejects | We can't reason about the shell state | **Skip dispatch** (conservative — better a bare prompt than a stray `"claude"` injected into an active session) |

`workspaceState` is the persistence layer for the PID record. The record is keyed on `path.normalize(folderPath)` with **case preserved** (case folding applies only to in-memory lookup, not to the persisted key — see *Persistence vs in-memory key* below).

**Setting gate**: when `claudeConductor.relaunchOnStartup` is `false`, the reattach pass returns immediately without iterating sessions. PID persistence still happens for new launches (so toggling the setting back on later still has accurate baselines).

## Code surfaces

| File | Change |
|---|---|
| `src/sessionManager.ts` | Constructor takes new `workspaceState: vscode.Memento` arg. New private methods `_reattachRestoredSessions()`, `_persistSessionPid(folderPath, pid)`, `_clearSessionPid(folderPath)`, `_dispatchClaudeIntoRestoredTerminal(terminal)`. Existing `_dispatchClaudeCommand` reused. |
| `src/extension.ts` | Pass `context.workspaceState` to `new SessionManager(...)`. One-line change to constructor call. |
| `src/config.ts` | Add `getRelaunchOnStartup(): boolean` reading `claudeConductor.relaunchOnStartup`. Default `true`. |
| `package.json` | Register the `claudeConductor.relaunchOnStartup` boolean configuration property under `contributes.configuration.properties` with default `true` and a description. |
| `test/reattachOnStartup.test.ts` | New file covering the scenarios in *Test coverage* below. |
| `test/mocks/vscode.ts` | Add `Memento` mock if not already present (for `workspaceState`). |
| `README.md` | Update *Features* section: document reattach behavior. Update *Configuration* section: document the new setting. Remove/update any "Known Limitations" wording that implies sessions don't survive restart. |
| `CHANGELOG.md` | Note the new behavior, the new setting, and the day-1 caveat for users running the official Claude Code extension alongside Conductor. |

### Why a method on `SessionManager` and not a top-level activation step

Keeps the lifecycle-management logic colocated with the terminal-tracking logic that already lives in `SessionManager`. The class already owns the `_sessions` map, the `_pidToTerminal` map, and the close-detection state machine. Adding the reattach pass to the same surface keeps the abstraction boundary clean: any future redesign (e.g., #44's PTY wrapper) replaces this entire surface as a unit, rather than scattering startup logic across `extension.ts`.

### Why a single batch pass at the end of the constructor, not inline in `_trackIfClaudeSession`

`_trackIfClaudeSession` runs synchronously and is also called from `onDidOpenTerminal` during normal use. We don't want every newly-opened terminal to trigger reattach logic — only the snapshot of restored tabs at activation time. A separate explicit pass distinguishes "I just saw a terminal appear during normal use, don't reattach it" from "I'm enumerating restored tabs at activation, decide whether to reattach each one."

## Lifecycle

### Activation order

1. Existing constructor loop iterates `vscode.window.terminals` and calls `_trackIfClaudeSession` on each — same as today. **Note**: tracking-time PID writes are *removed* from `_trackIfClaudeSession`; only the in-memory `_pidToTerminal` index is populated, not `workspaceState`. This is the fix for the read-after-write race that the inquisitor identified.
2. **NEW**: After that loop, if `getRelaunchOnStartup()` returns `true`, `_reattachRestoredSessions()` is invoked. It iterates `_sessions.values()` and kicks off an async per-session routine for each. All routines run via `Promise.allSettled` (no `await` blocks the constructor).
3. The constructor returns synchronously. Tree views, status bar, etc. bind to a populated `_sessions` map immediately.
4. The existing `AUTO_LAUNCH_KEY` block in `extension.ts` (lines 94–97) still fires after construction. Because `launchSession` checks `getReuseTerminal()` and finds the just-tracked session, it focuses instead of creating — no double-dispatch.

### Per-session async reattach routine

```
1. await terminal.processId          → currentPid (number | undefined)
2. read stored PID for folderPath    → storedPid (number | undefined)
                                       (read from workspaceState — only PREVIOUS
                                        activation's writes are present, since
                                        this activation's tracking-time writes
                                        were removed)
3. if currentPid === undefined       → log and skip (can't make a decision)
4. if storedPid === currentPid       → shell survived, claude likely running, skip
                                       BUT still call _persistSessionPid(folderPath, currentPid)
                                       to keep the record fresh for next activation
5. if !fs.existsSync(folderPath)     → enqueue folderPath into a "dead-cwd" list,
                                       call terminal.dispose() + reconcile()
                                       (toast is shown ONCE at end of reattach,
                                        aggregating all dead cwds)
6. else                              → call _dispatchClaudeIntoRestoredTerminal(terminal),
                                       then _persistSessionPid(folderPath, currentPid)
```

After all routines settle, if any dead-cwd folders were collected:

```
7. show ONE showInformationMessage:
   "Could not restore N session(s) — folder(s) no longer exist: a, b, c"
   (truncate folder list to first 3, append "and N more" if needed)
```

### `_dispatchClaudeIntoRestoredTerminal` — the buffered-input mitigation

The existing `_dispatchClaudeCommand` was designed for the launch path where the terminal was *just created* and is at a clean prompt. For restored terminals, the prompt may have buffered input the user typed before closing VS Code (e.g., a partial `ls -`), and the existing helper's delay-fallback path (`terminal.sendText("claude")`) would commit `ls -claude` to the shell.

The reattach call site uses a wrapper that clears any buffered input first:

```ts
private async _dispatchClaudeIntoRestoredTerminal(terminal: vscode.Terminal): Promise<void> {
  // Clear any buffered prompt input. Ctrl-C signals the running shell (no-op if
  // nothing is running); Ctrl-U clears the current line. On a clean prompt this
  // is a no-op. On a dirty prompt this is a save.
  // The `false` arg to sendText suppresses the trailing newline — we don't want
  // to commit anything yet.
  terminal.sendText("\u0003\u0015", false);
  // Small breather so the shell processes the clear before we dispatch.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  await this._dispatchClaudeCommand(terminal);
}
```

The 50ms delay is imperceptible and applies even when `_dispatchClaudeCommand` takes the shell-integration fast path. This is acceptable cost for preventing the silent corruption case.

### PID persistence lifecycle

Writes happen at exactly three points — chosen to eliminate the read-after-write race the first draft introduced:

| Event | Action |
|---|---|
| Reattach decision (steps 4 and 6 above) | Call `_persistSessionPid(folderPath, currentPid)` |
| New session launched (after `launchSession` creates a terminal and its `processId` resolves) | Call `_persistSessionPid(folderPath, pid)` |
| Session closed (in `_removeByKey`) | Call `_clearSessionPid(folderPath)` — removes the entry |

**No tracking-time writes.** `_trackIfClaudeSession` populates the in-memory `_pidToTerminal` index but does not touch `workspaceState`. This is the structural fix for the race: the reattach read at step 2 sees only the previous activation's writes, never this activation's.

### Persistence vs in-memory key

The persisted record is `Record<string, number>` keyed on **`path.normalize(folderPath)`** (case preserved). The in-memory `_findSessionByFolder` lookup continues to use lowercased keys for Windows-friendly matching.

| Use | Key form | Why |
|---|---|---|
| `workspaceState["claudeConductor.sessionPids"][...]` (persistence) | `path.normalize(folderPath)` — case preserved | On case-sensitive filesystems (Linux, macOS, NFS), `D:\Project` and `D:\project` are distinct directories that must not collide in the record |
| `_findSessionByFolder` (in-memory lookup) | `path.normalize(folderPath).toLowerCase()` | On Windows, the user may pass either case; in-memory matching should be case-insensitive |

This is intentional asymmetry, not an oversight. The implementation must keep them separate.

### Write serialization (with rejection handling)

`_persistSessionPid` and `_clearSessionPid` perform read-modify-write on the single shared `claudeConductor.sessionPids` record. Multiple reattach routines and concurrent `launchSession` flows can race on this without serialization.

The implementation serializes writes through an internal promise queue **with explicit rejection handling** so a single `workspaceState.update` failure doesn't permanently halt the queue:

```ts
private _pidWriteQueue: Promise<void> = Promise.resolve();

private _persistSessionPid(folderPath: string, pid: number): void {
  if (this._disposed) return;
  this._pidWriteQueue = this._pidWriteQueue
    .catch(() => undefined)  // swallow prior rejection so chain doesn't stay broken
    .then(async () => {
      try {
        const current = this._workspaceState.get<Record<string, number>>(PID_KEY) ?? {};
        current[this._normalizePersistKey(folderPath)] = pid;
        await this._workspaceState.update(PID_KEY, current);
      } catch (err) {
        log(`[reattach] failed to persist PID for ${folderPath}: ${String(err)}`);
        // Swallow — the next call will retry the write under fresh conditions.
      }
    });
}
```

Each step has its own try/catch so a transient failure (host I/O error, disk full, schema validation rejection) is logged and the queue continues. The leading `.catch(() => undefined)` ensures even a rejection from the *previous* step doesn't poison the next step.

The `_normalizePersistKey` helper is `path.normalize(folderPath)` (no `.toLowerCase()`), per *Persistence vs in-memory key* above.

The `_disposed` guard prevents a stale `_persistSessionPid` call from a still-resolving async routine from writing to a disposed `Memento` after `SessionManager.dispose()` was invoked.

## Error handling

| Failure | Handling |
|---|---|
| `terminal.processId` resolves to `undefined` | Log via `debugLog`, skip dispatch. Conservative — without a PID we can't compare, so we don't risk text injection. |
| `terminal.processId` rejects | Same as above — skip with a debug log. |
| `terminal.processId` resolves but the value is the transient bootstrap shell PID rather than the restored shell | Mitigated, not eliminated. If shell integration appears within the slow-path window, the dispatch uses the (safe) shell-integration `executeCommand`; the buffered-input clear-prefix is a no-op when the prompt is clean. The PID-vs-storedPID comparison may be wrong in this narrow window, but the worst case is a stray `claude` keystroke (matched on stale PID) — already documented as the Option-A first-install cost. |
| `fs.existsSync(folderPath)` returns false | Add to dead-cwd list, call `terminal.dispose()` followed by `reconcile()`. The aggregate toast at the end of reattach surfaces all dead cwds at once. The explicit `reconcile()` call ensures `_sessions` and the PID record are evicted even if `onDidCloseTerminal` does not fire (which the existing close-detection infrastructure already accounts for). |
| `_dispatchClaudeCommand` falls through to delay-fallback `sendText` | Already handled by the existing implementation — terminal sees `claude` keystrokes after the `claudeConductor.launchDelayMs` delay (default 500 ms). The `_dispatchClaudeIntoRestoredTerminal` wrapper has already cleared buffered input via `Ctrl-C, Ctrl-U`, so the `claude` keystroke commits cleanly. |
| `workspaceState` returns wrong-typed data | Defensive: treat as "no stored PID" → fall through to first-install path → dispatch. |
| `workspaceState.update` rejection | Caught and logged within the chain step (see *Write serialization* above). The next write retries under fresh conditions. The queue does not stay broken. |
| `SessionManager.dispose()` called mid-reattach | The per-session routine completes its work but `_persistSessionPid` no-ops because `_disposed` is set. No write to a disposed `Memento`. |
| Concurrent reattach + new launch race | Won't happen in practice — `launchSession` is only called from user-initiated commands, which can't fire during synchronous constructor execution. |

### `AUTO_LAUNCH_KEY` coordination (intentional, not a bug)

When VS Code is opened via a `vscode://` URI for a folder that *also* has a restored Claude tab, both reattach (from the constructor) and `AUTO_LAUNCH_KEY` (from `activate()` in `extension.ts`) fire. The reattach pass dispatches `claude` into the restored tab; then `AUTO_LAUNCH_KEY`'s `launchSession` call finds the now-tracked session and `focusSession`s it instead of creating a duplicate. Net effect: one terminal, one dispatch, one focus. **Intentional and correct** — flagged here so it's not "fixed" by mistake later.

## Decisions

These design decisions were resolved during the 2026-04-27 brainstorm and re-affirmed (or revised) after the inquisitor review:

1. **PID comparison is the discriminator** — not "what triggered activation?" The right question is "did the shell process survive?", and PID identity answers it well in the common cases (VS Code close/open, Reload Window, ptyhost crashes, system restarts). The narrow timing-window failure (transient bootstrap PID resolving before the restored shell is wired) is mitigated by the buffered-input clear-prefix and the shell-integration safe-path.
2. **Setting gate restored** (revised from first draft). `claudeConductor.relaunchOnStartup`, default `true`. Per issue #43's AC. Provides the recovery path for any user-machine-specific reattach regression.
3. **Dispose + aggregate toast on dead `cwd`** (revised from first draft). When a restored tab's `cwd` no longer exists, `terminal.dispose()` + `reconcile()` removes the tab and clears state. A single aggregate toast is shown at the end of reattach when one or more cwds were dead, listing up to three folders.
4. **No-stored-PID → dispatch** (Option A). On first activation post-install (or after `workspaceState` reset), absence of a record is treated as "fresh shell, never seen before" and dispatch proceeds. Cost of being wrong is bounded — and reduced further by the buffered-input clear-prefix. Cost of the alternative ("don't dispatch without positive evidence") is much worse — the feature appears broken on first impression. Mitigated by the setting gate: any user who hits the false-positive case can disable.
5. **Write serialization with rejection handling**. The `_pidWriteQueue` chain pattern, with each step wrapped in its own try/catch and a leading `.catch` swallow, ensures durability under transient failures and avoids the silent-halt failure mode the inquisitor identified.
6. **Persistence key is `path.normalize` only — not lowercased**. In-memory lookups remain case-folded for Windows ergonomics; persistence preserves case for cross-platform correctness.

The "Conductor completely owns these tabs" framing from the first draft is removed from *Decisions* and demoted to an informative note in *Future direction*. It is descriptive of where the codebase is heading toward #44; it is not load-bearing on this PR's scope.

## Test coverage

New file: `test/reattachOnStartup.test.ts`.

| # | Scenario | Setup | Assert |
|---|---|---|---|
| 1 | Same PID → no dispatch | Mock one `claude · foo` terminal whose `processId` resolves to `42`. Mock `workspaceState.get` to return `{ "/path/to/foo": 42 }`. Setting on. | `createTerminal` not called. No `sendText` / shell-integration `executeCommand` calls on the existing terminal. PID `42` re-persisted (record refreshed). |
| 2 | Different PID → dispatch via shell-integration fast path | Same setup, stored PID `99`. Mock `terminal.shellIntegration.executeCommand`. | The buffered-input clear-prefix `\u0003\u0015` is sent (via `sendText` with `addNewLine: false`), then after 50ms `terminal.shellIntegration.executeCommand("claude")` is called once. PID `42` written. |
| 3 | Different PID → dispatch via slow path | Same as 2, but `shellIntegration` is `undefined` initially; fire `onDidChangeTerminalShellIntegration` after a short delay. | Clear-prefix sent. Then slow path resolves and `executeCommand("claude")` is called once. |
| 4 | Different PID → dispatch via delay fallback | Same as 2, but no shell-integration ever activates. Use vitest fake timers. | Clear-prefix sent (no newline). After `launchDelayMs`, `terminal.sendText("claude")` is called (with the implicit newline from the default `addNewLine: true`). |
| 5 | No stored PID → dispatch | Stored map is empty. | Same dispatch behavior as scenario 2. PID written after dispatch. |
| 6 | Cwd missing (single tab) → dispose + aggregate toast (with one entry) | One terminal, mock `fs.existsSync` to return false. | `terminal.dispose()` called. `reconcile()` called. After all routines settle, `vscode.window.showInformationMessage` called once with text containing the folder name. No clear-prefix. No `claude` dispatch. |
| 7 | Multiple cwds missing → ONE aggregate toast | Three terminals, all with dead cwds. | Three `dispose()` calls. **One** `showInformationMessage` call, listing the three folder names. (If list grows beyond 3, truncated with "and N more".) |
| 8 | `processId` resolves to `undefined` | Mock `terminal.processId` to resolve undefined. | No dispatch, no dispose. Debug log emitted. State unchanged. |
| 9 | `processId` rejects | Mock `terminal.processId` to reject. | Same as 8 — no dispatch, no dispose, debug log. |
| 10 | Multiple restored sessions in parallel — no PID race | Three `claude · *` terminals, all with PID mismatches. | All three dispatch. After all routines settle, `workspaceState.update` final state reflects all three new PIDs. Verifies the write queue serializes correctly. |
| 11 | `workspaceState.update` rejects mid-chain | Stub `workspaceState.update` to reject once, then succeed on next call. | Subsequent `_persistSessionPid` calls succeed (queue not poisoned). Error logged. |
| 12 | Setting off → reattach is a no-op | `getRelaunchOnStartup()` returns false. Three restored terminals tracked. | No `_reattachRestoredSessions` work performed. No dispatches, no toast, no PID writes. Tracking still happens (existing constructor loop). |
| 13 | PID cleanup on close | Track + dispatch a session, then dispose its terminal. | `workspaceState.update` called with the entry removed. |
| 14 | `AUTO_LAUNCH_KEY` flow + reattach for the same folder | Restored terminal for folder F + `AUTO_LAUNCH_KEY` set to F. | One dispatch (from reattach), one focus (from auto-launch's `launchSession` reuse path). No duplicate `createTerminal`. |
| 15 | Deactivation racing with reattach | Construct `SessionManager`, immediately call `dispose()` while async routines are mid-await. Mock `terminal.processId` with a 100ms delay. | After routines resolve, `workspaceState.update` is **not** called (the `_disposed` guard prevents writes). No exceptions thrown. |

### Mock strategy

- Reuse the existing `test/mocks/vscode.ts` patterns (already used by `addFolderPrompt.stale.test.ts` from PR #73 and the existing `hookInstaller` tests).
- Add a `Memento` mock for `workspaceState`: `{ get, update, keys }` with an internal `Map<string, unknown>` backing store. Generic enough to live alongside the existing mocks.
- `terminal.processId` is mocked as `Promise.resolve(<number>)` per-test. For scenario 15, use a delayed promise.
- `vi.mock("fs")` for the cwd-existence test (same pattern as the #71 test).

Existing tests stay untouched — the change is additive.

## Rollout

- **Setting default** is `true` per AC, so the feature is on for everyone after upgrade. Users who don't want it set `claudeConductor.relaunchOnStartup: false` — the gate makes the feature recoverable without a new release.
- **First activation after upgrade**: any user who currently has restored Claude tabs sitting at bare prompts will see them auto-dispatch. Users with surviving shells (PIDs match → no dispatch) won't see a behavioral change.
- **Edge — surviving shells, no stored PIDs**: users upgrading from a pre-#43 version have no persisted PIDs in `workspaceState` yet, so the first activation post-upgrade falls into the "no stored PID → dispatch" branch (Option A). For users whose shells *did* survive and where claude *is* still running, this means a one-time stray `"claude"` per terminal — *but* the buffered-input clear-prefix means it won't corrupt buffered shell input, and the setting provides a recovery path. Subsequent activations are race-free.
- **Day-1 collision warning** (CHANGELOG): if you also use the official Claude Code VS Code extension, set `claudeConductor.relaunchOnStartup: false` until #33 lands — Conductor's reattach can't yet distinguish its own restored sessions from sessions opened by the official extension.
- **README updates** (per AC):
  - *Features*: document the reattach behavior.
  - *Configuration*: document `claudeConductor.relaunchOnStartup`.
  - *Known Limitations*: remove (or rewrite) any wording implying sessions don't survive VS Code restart.
- **CHANGELOG**: note the new feature, the new setting, the day-1 caveat, and the buffered-input clear-prefix as a defensive behavior.

## Future direction (informative — not part of this PR)

### #44 — custom PTY wrapper

Once #44 is on the table (Conductor owns the PTY directly), this entire reattach pass collapses into "the Conductor process is alive across VS Code restarts; tabs re-bind to live PTYs without dispatching anything." The work in this PR is not wasted — it makes the per-tab lifecycle ownership explicit, which is a precondition for #44. The implementation surface (PID record, dispatch logic) will be replaced wholesale by the PTY-ownership design.

### #33 — externally-launched session adoption

The PID-record approach is forward-compatible. When #33 picks up `claude · *` terminals that were not created by us, they will be tracked the same way and PID-recorded the same way. The reattach survival check works identically for them — no code change needed in this design's surface to support that future work. Until #33 lands, the day-1 collision risk is mitigated by the user-facing setting (per AC).

### #68 — close-detection spike

This design does not change close-detection paths. The PID record is keyed on folder path and is cleared on close-detection eviction (via `_removeByKey` → `_clearSessionPid`), so the two systems are decoupled.

### Activation latency / progress signal

Worst case for a heavy user with many restored tabs and no shell integration: the slow path can fire several routines in parallel, each waiting up to 2s + 500ms delay-fallback. During that window, the tree view shows tracked sessions whose `claude` is not yet dispatched. Adding a `dispatchState: "pending" | "ready"` field on `ActiveSession` and rendering "reattaching..." in the tree view would close this UX gap. Not in scope for this PR — flagged as a follow-up if the latency surfaces in user feedback.

### Tab-ownership framing

The first draft of this spec leaned on a "Conductor completely owns these tabs" principle to discharge AC #4. The inquisitor flagged this as misleading: this design *observes* VS Code's terminal restoration and *types into* whatever shell VS Code chose to spawn — Conductor does not control envelope creation, shell selection, or persistence. True ownership is what #44 proposes. The framing is informative for the trajectory but is not load-bearing on this PR's scope, and AC #4's setting gate is restored regardless.
