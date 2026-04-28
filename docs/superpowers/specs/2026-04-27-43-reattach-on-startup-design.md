# Design — Reattach Claude sessions on VS Code startup (#43)

**Issue**: [#43](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/43)
**Date**: 2026-04-27 (revised v3 after second inquisitor pass)
**Status**: Awaiting user approval (round 3)

---

## Revision history

- **v1** (initial brainstorm output) — first design draft.
- **v2** (post-inquisitor pass 1) — restored the `claudeConductor.relaunchOnStartup` setting gate (was deleted in v1, contradicted issue #43 AC #4); eliminated PID write-ordering race by removing tracking-time writes; added Ctrl-C/Ctrl-U clear-prefix for buffered-input; rejection handling on the PID write queue; case-preserved persistence keys; aggregate dead-cwd toast; expanded test table; demoted "completely own these tabs" framing.
- **v3** (this revision, post-inquisitor pass 2) — see *Changes from v2* below.

### Changes from v2

| # | Change | Why |
|---|---|---|
| 1 | Specify `_normalizePersistKey` on **both** write and read paths; state explicitly that `_sessions[…].folderPath` is case-preserved | v2 named the helper only on the write side; an implementer could mismatch read/write keys and silently miss every record |
| 2 | Restructure clear-prefix: send only **on the delay-fallback path** (not before all dispatch attempts) | The `\u0003\u0015` (Ctrl-C, Ctrl-U) sequence is POSIX-shell semantics; cmd.exe and PowerShell-without-PSReadLine do not interpret it as kill-line. Restricting the clear to delay-fallback means shell-integration paths use safe `executeCommand` boundaries, and the cmd.exe limitation is documented rather than hidden |
| 3 | Name `_reattachRestoredSessions` as `async`; specify it awaits its own `Promise.allSettled`; gate the toast on `!_disposed` | v2 said "after all routines settle" without naming who awaits — left orchestration unspecified |
| 4 | Add explicit AC name-rename trail (`claudeSessions.*` → `claudeConductor.*` per PR #51) | Issue AC literal predates the rename; spec wording was correct but trail was missing |
| 5 | Specify `_clearSessionPid` runs **unconditionally** on session close; only `_reattachRestoredSessions` is gated by `relaunchOnStartup` | Prevents stale-baseline corruption when user toggles the setting `false → true` |
| 6 | Drop the explicit immediate `reconcile()` call from the dead-cwd path | `terminal.dispose()` already fires `_handleTerminalClose` → `_removeByKey`. Existing 2s poll catches the rare missed-event case. Belt-and-suspenders adds complexity without value |
| 7 | Add proactive day-1 collision detection — first-activation consent toast when the official Claude Code extension is installed | Don't bury the only mitigation in CHANGELOG. Surface the choice to the user when it's relevant |
| 8 | Snapshot `_sessions.values()` at entry to `_reattachRestoredSessions` (don't iterate the live map) | Prevents `onDidOpenTerminal` mid-iteration mutation in the rare case a new session opens during the reattach window |
| 9 | Test #14 asserts dispatch-before-focus call ordering | v2 only asserted counts — ordering regressions wouldn't be caught |
| 10 | Inline cleanups: comment precision; assert exact `sendText` arg count; `_clearSessionPid` also has `_disposed` guard; explicit acknowledgement that the constructor signature change requires updating existing-test setup | Tightens the test contract and removes inaccuracies |
| 11 | New *Known limitations / deferred* cluster | Captures the inquisitor's theoretical concerns we deliberately defer (Memento timeout, mock parameterization, terminal.show race, unbounded queue) so a future maintainer sees the explicit decision trail |

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
6. Users who also have the **official Claude Code extension** installed get a one-time consent prompt on first activation, so Conductor doesn't silently inject `claude` keystrokes into someone else's session.

## Non-goals

- **Restoring Claude's in-conversation memory.** That's an Anthropic-side property of Claude Code itself; this design only restores the *session* (a running `claude` process), not its prior context.
- **Replacing VS Code's terminal model with a custom PTY.** That's [#44](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/44). This design works inside VS Code's terminal API.
- **Adopting externally-launched `claude · *` sessions.** That's [#33](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/33). This design's PID-record approach is forward-compatible — externally-launched terminals will get tracked and PID-recorded the same way once #33 picks them up.
- **Changing close-detection.** That's [#68](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/68). PID records and close-detection records are decoupled and don't interact.
- **Moving or rearranging tabs.** Reattach operates strictly in-place on existing terminal references — no `moveToEditor` calls. Tab position, pinning, and editor-group placement are inherited from VS Code's restoration.

## Architecture

A new "reattach pass" runs at the end of `SessionManager`'s constructor, after the existing tracking loop, **gated by `claudeConductor.relaunchOnStartup`**. For each tracked Claude terminal, an async per-session routine compares the terminal's *current* shell PID against a previously-stored PID for the same folder path. The comparison decides whether to dispatch `claude`:

| Current PID vs stored PID | Meaning | Action |
|---|---|---|
| Match | Shell process survived; `claude` likely still running | **Skip dispatch** |
| Differ | Shell was replaced; `claude` is gone | **Dispatch `claude`** (delay-fallback path clears buffered input first; see *Buffered-input mitigation*) |
| No stored PID | First activation post-install, or after `workspaceState` was wiped | **Dispatch `claude`** (Option A — see *Decisions* below) |
| `processId` resolves to `undefined` or rejects | Can't reason about shell state | **Skip dispatch** (better a bare prompt than a stray `"claude"` injected into an active session) |

`workspaceState` is the persistence layer for the PID record. Both **read** and **write** paths use the same key-normalization helper:

```ts
private _normalizePersistKey(folderPath: string): string {
  return path.normalize(folderPath);   // case preserved — see Persistence vs in-memory key
}
```

`_sessions[…].folderPath` is also stored in the case-preserved `path.normalize(folderPath)` form. The reattach routine, iterating `_sessions.values()` snapshots, has access to the correct case-preserved folder path for the persistence read.

**Setting gate**: when `claudeConductor.relaunchOnStartup` is `false`, the reattach pass returns immediately without iterating sessions. PID persistence still happens for new launches via `launchSession`, AND `_clearSessionPid` runs unconditionally on session close (regardless of setting), so toggling the setting back on later still has accurate baselines.

## Code surfaces

| File | Change |
|---|---|
| `src/sessionManager.ts` | Constructor takes new `workspaceState: vscode.Memento` arg. New private methods `_reattachRestoredSessions()` (async), `_persistSessionPid(folderPath, pid)`, `_clearSessionPid(folderPath)`, `_dispatchClaudeIntoRestoredTerminal(terminal)`, `_normalizePersistKey(folderPath)`. Existing `_dispatchClaudeCommand` reused. |
| `src/extension.ts` | Pass `context.workspaceState` to `new SessionManager(...)`. Add **first-activation consent flow** (see *Day-1 collision: proactive detection* below) before constructing `SessionManager`. |
| `src/config.ts` | Add `getRelaunchOnStartup(): boolean` reading `claudeConductor.relaunchOnStartup`. Default `true`. |
| `package.json` | Register the `claudeConductor.relaunchOnStartup` boolean configuration property under `contributes.configuration.properties` with default `true` and a description. |
| `test/reattachOnStartup.test.ts` | New file covering the scenarios in *Test coverage* below. |
| `test/mocks/vscode.ts` | Add `Memento` mock if not already present (for `workspaceState`). The mock must support per-call return-value control (e.g., via vitest's `mockImplementationOnce`) so scenario 11 can express "reject once, then succeed." |
| `README.md` | Update *Features*, *Configuration*, and remove/update any "Known Limitations" implying sessions don't survive restart. |
| `CHANGELOG.md` | Note the new feature, the new setting, the day-1 collision behavior. |

> **Test-suite migration note**: the constructor signature change (`new SessionManager()` → `new SessionManager(workspaceState)`) requires updating every existing test that constructs a `SessionManager`. The "additive change" framing from v1 was inaccurate; existing tests need a mock-Memento argument added to their setup. Plan accordingly.

### Why a method on `SessionManager` and not a top-level activation step

Keeps lifecycle-management logic colocated with the terminal-tracking logic that already lives in `SessionManager`. The class already owns `_sessions`, `_pidToTerminal`, and the close-detection state machine. Adding the reattach pass to the same surface keeps the abstraction boundary clean: any future redesign (e.g., #44's PTY wrapper) replaces this entire surface as a unit.

### Why a single batch pass at the end of the constructor, not inline in `_trackIfClaudeSession`

`_trackIfClaudeSession` runs synchronously and is also called from `onDidOpenTerminal` during normal use. We don't want every newly-opened terminal to trigger reattach logic — only the snapshot of restored tabs at activation time. A separate explicit pass distinguishes "I just saw a terminal appear during normal use, don't reattach it" from "I'm enumerating restored tabs at activation, decide whether to reattach each one."

## Lifecycle

### Activation order (in `extension.ts`'s `activate()`)

1. **First-activation consent gate** — if no prior PID record exists in `workspaceState` AND the official Claude Code extension is installed (see *Day-1 collision* below), surface a consent toast and either set `claudeConductor.relaunchOnStartup` true/false based on user response, OR proceed with default `true` if the user dismisses without choosing. Mark the onboarding as shown so this runs at most once.
2. Construct `new SessionManager(context.workspaceState)`. The constructor:
   - Iterates `vscode.window.terminals` and calls `_trackIfClaudeSession` on each (existing behavior). **Note**: tracking-time writes to `workspaceState` are NOT performed here. Only `_pidToTerminal` is populated.
   - Calls `_reattachRestoredSessions()` (fire-and-forget — see step 3) if `getRelaunchOnStartup()` returns `true`.
3. `_reattachRestoredSessions` is `async` and **owns its own orchestration**:
   - Captures a synchronous **snapshot** of `_sessions.values()` at entry (defensive against `onDidOpenTerminal` firing mid-iteration).
   - Kicks off per-session routines and `await Promise.allSettled(...)` on them.
   - Collects dead-cwd folders during the routines.
   - After `allSettled`, if `!this._disposed` AND any dead-cwd folders were collected, shows ONE aggregate `showInformationMessage` listing first 3 folders + "and N more" if needed.
   - Returns. Caller (the constructor) does not await.
4. The existing `AUTO_LAUNCH_KEY` block in `extension.ts` (lines 94–97) still fires after construction. Because `launchSession` checks `getReuseTerminal()` and finds the just-tracked session, it focuses instead of creating — no double-dispatch.

### Per-session async reattach routine

```
1. await terminal.processId          → currentPid (number | undefined)
2. read stored PID                   → storedPid = workspaceState[
                                         _normalizePersistKey(session.folderPath)]
                                       (Reads only the PREVIOUS activation's writes,
                                        since this activation's tracking-time writes
                                        were removed.)
3. if currentPid === undefined       → log and skip (can't make a decision)
4. if storedPid === currentPid       → shell survived, skip dispatch.
                                       Still call _persistSessionPid(folderPath, currentPid)
                                       to refresh the record.
5. if !fs.existsSync(folderPath)     → enqueue folderPath into routine-local deadCwds[]
                                       array, call terminal.dispose().
                                       (No explicit reconcile() — _handleTerminalClose
                                        handles eviction; existing 2s poll catches misses.)
6. else                              → call _dispatchClaudeIntoRestoredTerminal(terminal),
                                       then _persistSessionPid(folderPath, currentPid)
```

After `Promise.allSettled` completes (in step 3 of *Activation order*), the orchestrator surfaces the aggregate dead-cwd toast.

### `_dispatchClaudeIntoRestoredTerminal` — buffered-input mitigation

The existing `_dispatchClaudeCommand` was designed for the launch path where the terminal is *just created* and at a clean prompt. Restored terminals may have buffered prompt input the user typed before closing VS Code (e.g., a partial `ls -`). The shell-integration paths (`executeCommand`) handle command boundaries safely — but the **delay-fallback path** (`terminal.sendText("claude")`) appends to whatever's at the prompt, which would commit `ls -claude\n`.

The mitigation sends a clear-prefix **only on the delay-fallback path**, not before the entire dispatch:

```ts
private async _dispatchClaudeIntoRestoredTerminal(terminal: vscode.Terminal): Promise<void> {
  // Variant of _dispatchClaudeCommand for restored terminals: shell-integration
  // paths are safe (executeCommand handles command boundaries). The clear-prefix
  // only fires on the delay-fallback path (no shell integration), so it doesn't
  // race against shell-integration's executeCommand.

  // Fast path — shell integration already active. Safe; no clear needed.
  if (terminal.shellIntegration) {
    terminal.shellIntegration.executeCommand(getClaudeCommand());
    return;
  }

  // Slow path — wait up to 2 s for shell integration to activate.
  const integrated = await this._waitForShellIntegration(terminal, 2000);
  if (integrated) {
    integrated.executeCommand(getClaudeCommand());
    return;
  }

  // Delay fallback — no shell integration. CLEAR-PREFIX REQUIRED HERE.
  //  (Ctrl-C) signals the running foreground command (no-op on a clean prompt).
  //  (Ctrl-U) clears the current input line on POSIX shells, bash/zsh/fish,
  // and PowerShell with PSReadLine (default keybindings).
  // On legacy cmd.exe and PowerShell-without-PSReadLine these are not interpreted
  // as line-clear — see "Known limitations" below.
  terminal.sendText("\u0003\u0015", false);   // false = no trailing newline
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  terminal.sendText(getClaudeCommand());      // newline implicit (default)
}
```

The 50ms breather is sufficient for the PTY to consume the clear bytes before the dispatch text arrives. Because the clear only fires on the delay-fallback (no shell integration), it never races against shell-integration's `executeCommand` — that race surface is removed by construction.

**Known limitation — Windows shell behavior**: on cmd.exe and PowerShell-without-PSReadLine, `\u0003\u0015` is not interpreted as kill-line. If a user on those shells has buffered prompt input AND is on the delay-fallback path AND the bug fires, the dispatched `claude` keystroke may corrupt the line. Mitigation: the user can set `claudeConductor.relaunchOnStartup: false`. Documented in CHANGELOG and README. The setting gate is the recovery mechanism.

### PID persistence lifecycle

Writes happen at exactly three points — chosen to eliminate the read-after-write race that v1 introduced:

| Event | Action | Setting-gated? |
|---|---|---|
| Reattach decision (steps 4 and 6 above) | Call `_persistSessionPid(folderPath, currentPid)` | Yes (entire reattach pass is gated) |
| New session launched (after `launchSession` creates a terminal and its `processId` resolves) | Call `_persistSessionPid(folderPath, pid)` | **No** — runs unconditionally |
| Session closed (in `_removeByKey`) | Call `_clearSessionPid(folderPath)` | **No** — runs unconditionally |

**Critical**: `_clearSessionPid` is **never** gated by `relaunchOnStartup`. Otherwise, when a user toggles the setting `false → true`, the persisted record contains stale entries for tabs the user closed during the off period — and reattach decisions get made against stale baselines.

### Persistence vs in-memory key

| Use | Key form | Why |
|---|---|---|
| `workspaceState["claudeConductor.sessionPids"][...]` (persistence read AND write) | `_normalizePersistKey(folderPath)` = `path.normalize(folderPath)` — **case preserved** | On case-sensitive filesystems (Linux, macOS, NFS), `D:\Project` and `D:\project` are distinct directories that must not collide |
| `_findSessionByFolder` (in-memory lookup only) | `path.normalize(folderPath).toLowerCase()` | On Windows, the user may pass either case; in-memory matching should be case-insensitive |

`_sessions[…].folderPath` itself is the case-preserved form (matches what's stored on the in-memory entry), so the reattach pass iterating `_sessions.values()` already has the right form for the persistence read. **Both `_persistSessionPid` and the reattach-pass read use `_normalizePersistKey` — never lowercase the persisted key.**

### Write serialization (with rejection handling)

`_persistSessionPid` and `_clearSessionPid` perform read-modify-write on the single shared `claudeConductor.sessionPids` record. Multiple reattach routines and concurrent `launchSession` flows can race on this without serialization.

The implementation serializes writes through an internal promise queue **with explicit rejection handling**:

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
        // Swallow — the next call will retry under fresh conditions.
      }
    });
}

private _clearSessionPid(folderPath: string): void {
  if (this._disposed) return;
  this._pidWriteQueue = this._pidWriteQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        const current = this._workspaceState.get<Record<string, number>>(PID_KEY) ?? {};
        delete current[this._normalizePersistKey(folderPath)];
        await this._workspaceState.update(PID_KEY, current);
      } catch (err) {
        log(`[reattach] failed to clear PID for ${folderPath}: ${String(err)}`);
      }
    });
}
```

The leading `.catch(() => undefined)` ensures even a rejection from the previous step doesn't poison the next step. Both methods have the `_disposed` guard. See *Known limitations / deferred* below for what we explicitly aren't guarding against.

## Day-1 collision: proactive detection

Issue [#33](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/33) covers adopting externally-launched `claude · *` terminals (e.g., from the official Claude Code VS Code extension `Anthropic.claude-code`). Until #33 lands, Conductor's reattach can't distinguish its own restored tabs from terminals opened by the official extension. With `relaunchOnStartup: true` as default, a user with both extensions installed could see Conductor inject a stray `claude` keystroke into the official extension's session on first activation.

**Mitigation**: on first activation post-install (detected via a new `claudeConductor.reattachOnboardingShown: boolean` in `globalState`, default `false`):

1. If `vscode.extensions.getExtension('Anthropic.claude-code')` returns a defined value AND `globalState.get('claudeConductor.reattachOnboardingShown')` is falsy:
2. Show a `vscode.window.showInformationMessage` with two action buttons:
   > "Claude Conductor reattaches Claude sessions on VS Code restart by typing `claude` into restored terminal tabs. We detected the official Claude Code extension is also installed — Conductor may inject `claude` into its sessions until #33 ships. Enable reattach for Conductor sessions?"
   - **"Enable" (default)**: leave `claudeConductor.relaunchOnStartup: true` (the default).
   - **"Disable"**: set `claudeConductor.relaunchOnStartup: false` via `vscode.workspace.getConfiguration().update(...)`.
3. If the user dismisses the toast without clicking, leave the setting at its default and proceed.
4. Always set `globalState.update('claudeConductor.reattachOnboardingShown', true)` regardless of choice — the toast appears at most once.

If the official extension is NOT installed, mark onboarding as shown without prompting (no need to bother the user). This means a user who later installs the official extension does NOT get a retroactive toast — they get the CHANGELOG note as a fallback. That's an accepted limitation: proactive detection runs once.

> **Implementer note on extension ID**: `Anthropic.claude-code` is the marketplace publisher.name for the official extension at the time of writing. Verify against the live marketplace listing before shipping; treat as configurable in case Anthropic renames.

## Error handling

| Failure | Handling |
|---|---|
| `terminal.processId` resolves to `undefined` | Log via `debugLog`, skip dispatch. Conservative — without a PID we can't compare, so we don't risk text injection. |
| `terminal.processId` rejects | Same as above — skip with a debug log. |
| `terminal.processId` resolves but value is the transient bootstrap shell PID rather than the restored shell | Mitigated, not eliminated. Shell-integration paths use safe `executeCommand` boundaries. The buffered-input clear-prefix (delay-fallback only) limits damage. The PID-vs-storedPID comparison may be wrong in this narrow window; worst case is a stray `claude` keystroke, already documented as the Option-A first-install cost. |
| `fs.existsSync(folderPath)` returns false | Add to dead-cwd list, call `terminal.dispose()`. Existing close-detection (`_handleTerminalClose` → `_removeByKey`) handles eviction. The aggregate toast at end of reattach surfaces all dead cwds at once. |
| `_dispatchClaudeCommand` falls through to delay-fallback `sendText` | The reattach variant clears buffered input via `\u0003\u0015` first (POSIX-safe; documented Windows limitations above). |
| `workspaceState` returns wrong-typed data | Defensive: treat as "no stored PID" → fall through to first-install path → dispatch. |
| `workspaceState.update` rejection | Caught and logged within the chain step. Next write retries under fresh conditions. Queue does not stay broken. |
| `SessionManager.dispose()` called mid-reattach | Per-session routines complete their work but `_persistSessionPid` and `_clearSessionPid` no-op because `_disposed` is set. Toast also gated by `_disposed`. |
| Concurrent reattach + new launch race | Won't happen in practice — `launchSession` is only called from user-initiated commands, which can't fire during synchronous constructor execution. |

### `AUTO_LAUNCH_KEY` coordination (intentional, not a bug)

When VS Code is opened via a `vscode://` URI for a folder that *also* has a restored Claude tab, both reattach (from the constructor) and `AUTO_LAUNCH_KEY` (from `activate()` in `extension.ts`) fire. The reattach pass dispatches `claude` into the restored tab; then `AUTO_LAUNCH_KEY`'s `launchSession` call finds the now-tracked session and `focusSession`s it instead of creating a duplicate. **Intentional and correct** — flagged here so it's not "fixed" by mistake later.

## Decisions

1. **PID comparison is the discriminator**. PID identity answers "did the shell process survive?" well in the common cases (VS Code close/open, Reload Window, ptyhost crashes, system restarts). Narrow timing-window failures (transient bootstrap PID) are mitigated by shell-integration safe-paths and the buffered-input clear-prefix.
2. **Setting gate restored** per AC #4. `claudeConductor.relaunchOnStartup`, default `true`. AC text predates PR #51's rename from `claudeSessions.*` to `claudeConductor.*`; the current convention is the correct one.
3. **`_clearSessionPid` runs unconditionally on close**. Only the reattach-pass itself is gated by the setting. This prevents stale baselines on `false → true` toggle.
4. **Dispose + aggregate toast on dead `cwd`** with up to 3 folder names + "and N more". One toast per reattach pass, not one per dead tab.
5. **No-stored-PID → dispatch** (Option A). On first activation post-install, absence of a record is treated as "fresh shell." Cost of being wrong is bounded (one stray `claude` keystroke, recoverable). Cost of the alternative ("don't dispatch without positive evidence") is much worse — the feature appears broken on first impression.
6. **Day-1 collision is proactively detected**. First-activation consent toast when `Anthropic.claude-code` extension is detected; CHANGELOG note as the fallback for installed-after-Conductor cases.
7. **Clear-prefix is delay-fallback only**. Removes the race against shell-integration `executeCommand` and acknowledges the Windows-cmd.exe limitation honestly rather than papering over it.
8. **Persisted key is `path.normalize` only — not lowercased**. In-memory lookups remain case-folded for Windows ergonomics; persistence preserves case for cross-platform correctness.
9. **Write queue with rejection handling but without timeout**. The chain pattern self-heals from transient failures via per-step catches. We do NOT add a `Promise.race` timeout for hung `Memento.update` — see *Known limitations / deferred*.

The "Conductor completely owns these tabs" framing from v1 is informative future-direction toward #44 only; it is not load-bearing on this PR's scope or any of these decisions.

## Test coverage

New file: `test/reattachOnStartup.test.ts`.

| # | Scenario | Setup | Assert |
|---|---|---|---|
| 1 | Same PID → no dispatch | One `claude · foo` terminal, `processId` → `42`, `workspaceState.get` → `{ "/path/to/foo": 42 }`. Setting on. | `createTerminal` not called. No `sendText`/shell-integration calls on the existing terminal. PID re-persisted. |
| 2 | Different PID → dispatch via shell-integration fast path | Stored PID `99`, current `42`, `shellIntegration.executeCommand` mocked. | **No** clear-prefix `sendText` (clear is only on delay-fallback). `executeCommand("claude")` called once. PID `42` written. |
| 3 | Different PID → dispatch via slow path | Same as 2, `shellIntegration` undefined initially; fire `onDidChangeTerminalShellIntegration` after a short delay. | No clear-prefix. Slow path resolves and `executeCommand("claude")` called once. |
| 4 | Different PID → dispatch via delay fallback (POSIX) | Same as 2, no shell-integration ever activates. Vitest fake timers. | Clear-prefix `\u0003\u0015` sent via `sendText("\u0003\u0015", false)` (assert exact 2-arg call). After 50ms, `sendText("claude")` called (1-arg call — implicit newline). |
| 5 | No stored PID → dispatch | Stored map empty. | Same dispatch behavior as scenario 2. PID written after dispatch. |
| 6 | Cwd missing (single tab) → dispose + toast (one entry) | One terminal, `fs.existsSync` → false. | `terminal.dispose()` called. After all routines settle, `showInformationMessage` called once with text containing the folder name. No clear-prefix. No `claude` dispatch. **No explicit `reconcile()` call** (verifies v3 simplification). |
| 7 | Multiple cwds missing → ONE aggregate toast (max 3 names, then "and N more") | Five terminals, all dead cwds. | Five `dispose()` calls. **One** `showInformationMessage` listing first 3 folder names + "and 2 more". |
| 8 | `processId` resolves to `undefined` | `terminal.processId` → undefined. | No dispatch, no dispose. `debugLog` emitted. State unchanged. |
| 9 | `processId` rejects | `terminal.processId` rejects. | Same as 8. |
| 10 | Multiple restored sessions in parallel — write queue serializes correctly | Three terminals, all PID mismatches. | All three dispatch. After settle, `workspaceState.update` final state reflects all three new PIDs. |
| 11 | `workspaceState.update` rejects mid-chain | Stub `workspaceState.update` via `mockImplementationOnce(() => Promise.reject(...))`, then default `mockImplementation(() => Promise.resolve())`. | Subsequent `_persistSessionPid` calls succeed (queue not poisoned). Error logged. |
| 12 | Setting off → reattach is a no-op | `getRelaunchOnStartup()` → false. Three restored terminals tracked. | No `_reattachRestoredSessions` work performed. No dispatches, no toast, no PID writes via reattach path. **`_clearSessionPid` still runs** if a session is closed during the off period (verifies Decision #3). |
| 13 | PID cleanup on close (setting on AND off) | Track + dispatch a session, then dispose. Run twice — once with setting on, once with setting off. | `workspaceState.update` called both times with the entry removed. Verifies `_clearSessionPid` is unconditional. |
| 14 | `AUTO_LAUNCH_KEY` flow + reattach for the same folder | Restored terminal for folder F + `AUTO_LAUNCH_KEY` set to F. | One dispatch (from reattach), one focus (from auto-launch's `launchSession` reuse path). **Assert call ordering**: dispatch precedes focus. No duplicate `createTerminal`. |
| 15 | Deactivation racing with reattach | Construct `SessionManager`, immediately `dispose()` while async routines mid-await. `terminal.processId` mocked with 100ms delay. | After routines resolve, `workspaceState.update` is **not** called. **Aggregate toast also not shown** (gated by `_disposed`). No exceptions thrown. |
| 16 | Day-1 onboarding — official extension installed, first activation | Mock `vscode.extensions.getExtension('Anthropic.claude-code')` → defined. `globalState.get('claudeConductor.reattachOnboardingShown')` → false. | `showInformationMessage` called with two action buttons. After user clicks "Disable", `workspace.getConfiguration().update('claudeConductor.relaunchOnStartup', false, ...)` called. `globalState.update('claudeConductor.reattachOnboardingShown', true, ...)` called. |
| 17 | Day-1 onboarding — no official extension | Mock `getExtension` → undefined. Onboarding flag false. | No toast shown. `globalState.update(..., true, ...)` called (mark as shown). |
| 18 | Day-1 onboarding — already shown | Mock `getExtension` → defined. Onboarding flag true. | No toast shown. No `globalState.update`. |
| 19 | Snapshot iteration — `onDidOpenTerminal` fires mid-reattach | Construct `SessionManager` with one restored terminal. Inside the per-session routine's `await processId`, simulate `onDidOpenTerminal` for a NEW Claude terminal. | Reattach iteration only includes the original terminal (verifies snapshot). New terminal is tracked but not reattached. |

### Mock strategy

- Reuse the existing `test/mocks/vscode.ts` patterns (used by `addFolderPrompt.stale.test.ts` from PR #73 and `hookInstaller` tests).
- Add a `Memento` mock for `workspaceState`: `{ get, update, keys }`. The `update` method is implemented as a vitest `vi.fn()` so individual tests can override per-call behavior via `mockImplementationOnce`. Internal `Map<string, unknown>` backs the default `get`/`update` semantics.
- Add a mock for `vscode.extensions.getExtension` — used by scenarios 16/17/18.
- Add a mock for `globalState` (similar to `workspaceState`) — used by scenarios 16/17/18.
- `terminal.processId` mocked as `Promise.resolve(<number>)` per-test. Scenarios 15 and 19 use delayed promises.
- `vi.mock("fs")` for the cwd-existence test (same pattern as the #71 test).

**Test-suite migration**: every existing test that constructs `SessionManager` needs the new `workspaceState` arg added to its setup. Plan for the mock helper to be extracted to a shared util so the migration is one-import-per-file.

## Rollout

- **Setting default** is `true` per AC. Users who don't want it set `claudeConductor.relaunchOnStartup: false`.
- **First activation after upgrade**: any user with restored Claude tabs at bare prompts will see auto-dispatch. Surviving-shell users (PIDs match → no dispatch) see no behavioral change.
- **Edge — surviving shells, no stored PIDs**: users upgrading from a pre-#43 version have no persisted PIDs yet, so first activation post-upgrade falls into the "no stored PID → dispatch" branch. For surviving-shell + still-running-claude users, this means a one-time stray `claude` per terminal — *but* the buffered-input clear-prefix limits damage on the delay-fallback path, the shell-integration paths handle it cleanly, and the setting provides a recovery path. Subsequent activations are race-free.
- **Day-1 collision with official Claude Code extension**: handled proactively via the consent toast (see *Day-1 collision* above). For users who install the official extension *after* Conductor, the CHANGELOG note is the fallback.
- **README updates** (per AC):
  - *Features*: document the reattach behavior.
  - *Configuration*: document `claudeConductor.relaunchOnStartup`.
  - *Known Limitations*: remove or rewrite any wording implying sessions don't survive VS Code restart. Add a one-liner about the Windows-cmd.exe / PowerShell-without-PSReadLine clear-prefix limitation.
- **CHANGELOG**: note the new feature, the new setting, the day-1 collision behavior, the buffered-input clear-prefix, and the known Windows shell limitation.

## Known limitations / deferred

These were raised in adversarial review and explicitly deferred. A future maintainer should NOT silently reverse these decisions without revisiting the trade-off.

- **Windows cmd.exe and PowerShell-without-PSReadLine**: the clear-prefix `\u0003\u0015` is not interpreted as kill-line on these shells. If a user on those shells has buffered prompt input AND hits the delay-fallback path (no shell integration), the dispatched `claude` may corrupt the prompt line. Mitigation: setting gate. Acceptable cost; affected user base is small (most modern PowerShell installs ship with PSReadLine and Conductor's primary user-shell is PowerShell with PSReadLine per `CLAUDE.md`).
- **`workspaceState.update` indefinite hang**: the write queue has no `Promise.race` timeout. If `Memento.update` ever hangs without rejecting, the queue stalls forever. No documented case of this in VS Code; treated as theoretical until observed. The `_disposed` guard prevents new writes from piling up but doesn't cancel an in-flight stalled one.
- **Promise chain unbounded growth**: `_pidWriteQueue` grows by one promise per call over the session lifetime. Closures held by each chain link mean a slow memory growth proportional to session-lifecycle event count. Not a leak in practice (bounded by user activity); a more elegant single-slot mutex pattern was considered and deferred — promise chains are simpler to reason about.
- **`terminal.show()` keystroke race on Windows**: a user clicking a tab while reattach is mid-routine triggers `focusSession` → `terminal.show()`, which on Windows can shift keyboard focus and redirect user keystrokes into the terminal during the dispatch. Not unique to this design — same race exists for any extension typing into terminals while users click. Outside scope.
- **Onboarding toast retroactive trigger**: if a user installs the official Claude Code extension *after* Conductor's first activation has already marked onboarding as shown, no retroactive toast appears. CHANGELOG note is the fallback. Adding retroactive detection would require a periodic check or extension-list change listener — disproportionate complexity for a one-shot UX warning.

## Future direction (informative — not part of this PR)

### #44 — custom PTY wrapper

Once #44 is on the table (Conductor owns the PTY directly), this entire reattach pass collapses into "the Conductor process is alive across VS Code restarts; tabs re-bind to live PTYs without dispatching anything." The work in this PR is a precondition for #44 — it makes per-tab lifecycle ownership explicit, which #44 then takes over wholesale.

### #33 — externally-launched session adoption

The PID-record approach is forward-compatible. When #33 picks up `claude · *` terminals not created by us, they will be tracked and PID-recorded the same way. The reattach survival check works identically. Until #33 lands, the day-1 collision risk is mitigated by the proactive onboarding toast + the user-facing setting.

### #68 — close-detection spike

Independent of this design. PID record is keyed on folder path, cleared on close-detection eviction (via `_removeByKey` → `_clearSessionPid`). The two systems are decoupled.

### Activation latency / progress signal

Worst case for a heavy user with many restored tabs and no shell integration: slow path can fire several routines in parallel, each waiting up to 2s + 500ms delay-fallback. During that window, the tree view shows tracked sessions whose `claude` is not yet dispatched. Adding a `dispatchState: "pending" | "ready"` field on `ActiveSession` and rendering "reattaching..." in the tree view would close the UX gap. Out of scope for this PR — flagged as a follow-up if user feedback surfaces it.
