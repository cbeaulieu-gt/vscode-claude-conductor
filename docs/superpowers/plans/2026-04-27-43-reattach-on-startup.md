# Reattach Claude Sessions on VS Code Startup — Implementation Plan (#43)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When VS Code restarts and Claude session tab envelopes are restored with fresh shells inside, automatically dispatch `claude` into each restored tab — gated by `claudeConductor.relaunchOnStartup` (default `true`), with proactive day-1 collision detection for users running the official Claude Code extension.

**Architecture:** A new "reattach pass" runs at the end of `SessionManager`'s constructor. For each tracked Claude terminal, an async per-session routine compares the current shell PID against a previously-persisted PID for the same folder path. PIDs are stored in `workspaceState` via a serialized write queue. When the comparison shows a fresh shell, the routine dispatches `claude` via a variant of the existing `_dispatchClaudeCommand` that clears any buffered prompt input on the delay-fallback path. Dead-cwd tabs are disposed and aggregated into one toast.

**Tech Stack:** TypeScript (strict), VS Code Extension API (`vscode` module), vitest for tests. CI runs `npm run lint` (`tsc --noEmit`), `npm test` (`vitest run`), and `npm run compile` (`tsc -p ./`) — all three must pass.

**Spec reference:** `docs/superpowers/specs/2026-04-27-43-reattach-on-startup-design.md` (commit `216ce95`). Read it before starting; this plan implements the v3 design exactly as approved.

**Branch:** `43-reattach-on-startup` (worktree at `I:/other/vscode-claude-conductor/.worktrees/43-reattach-on-startup`).

---

### Task 1: Foundation — config setting + Memento mock + globalState/extensions mocks

**Files:**
- Modify: `package.json` — add `claudeConductor.relaunchOnStartup` configuration property
- Modify: `src/config.ts` — add `getRelaunchOnStartup()`
- Modify: `test/mocks/vscode.ts` — add `Memento` mock, `extensions.getExtension` mock, `globalState`-style Memento factory

This task lays groundwork that subsequent tasks need. No behavior changes yet — just plumbing.

- [ ] **Step 1: Add the configuration property to `package.json`**

In `contributes.configuration.properties`, after the `claudeConductor.debugLogging` block, add:

```json
        "claudeConductor.relaunchOnStartup": {
          "type": "boolean",
          "default": true,
          "description": "On VS Code startup, automatically run 'claude' in any Claude Conductor terminal tab whose inner shell was replaced (e.g. after a system restart or ptyhost crash). Set to false to disable, or if Conductor reattaches into terminals owned by another extension."
        }
```

- [ ] **Step 2: Add `getRelaunchOnStartup()` to `src/config.ts`**

After the `getDebugLogging` function, add:

```typescript
export function getRelaunchOnStartup(): boolean {
  return getConfig().get<boolean>("relaunchOnStartup", true);
}
```

- [ ] **Step 3: Add `Memento` mock factory to `test/mocks/vscode.ts`**

Append after the `OutputChannelStub` class:

```typescript
// ---------------------------------------------------------------------------
// Memento (workspaceState / globalState) factory
//
// Tests use this to construct mock Mementos with per-call control over
// `update` (e.g. via vi.mockImplementationOnce). The default `update`
// resolves to undefined and writes through to the internal Map; tests can
// override by calling `update.mockImplementationOnce(...)`.
// ---------------------------------------------------------------------------

export interface MementoMock {
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
  /** Direct access to the backing store for assertions in tests */
  readonly _store: Map<string, unknown>;
}

export function createMemento(initial: Record<string, unknown> = {}): MementoMock {
  const store = new Map<string, unknown>(Object.entries(initial));
  const get = vi.fn(<T>(key: string, defaultValue?: T): T | undefined => {
    return (store.has(key) ? store.get(key) : defaultValue) as T | undefined;
  });
  const update = vi.fn(async (key: string, value: unknown): Promise<void> => {
    if (value === undefined) {
      store.delete(key);
    } else {
      store.set(key, value);
    }
  });
  const keys = vi.fn(() => Array.from(store.keys()));
  return { get, update, keys, _store: store };
}
```

- [ ] **Step 4: Add `extensions` namespace mock to `test/mocks/vscode.ts`**

Append at the end of the file (after `env`):

```typescript
// ---------------------------------------------------------------------------
// extensions namespace
// ---------------------------------------------------------------------------

export const extensions = {
  getExtension: vi.fn().mockReturnValue(undefined),
};
```

- [ ] **Step 5: Run lint + compile to verify no regressions**

Run from worktree root:
```bash
npm run lint
npm run compile
```

Expected: both exit 0.

- [ ] **Step 6: Run existing test suite to confirm no regression**

Run from worktree root:
```bash
npm test
```

Expected: all existing tests still pass (the mock additions are additive — nothing imports the new symbols yet).

- [ ] **Step 7: Commit**

```bash
git add package.json src/config.ts test/mocks/vscode.ts
git commit -m "feat: add relaunchOnStartup config + Memento/extensions test mocks (#43)

Foundation for issue #43 reattach work: register the new
claudeConductor.relaunchOnStartup boolean setting (default true),
add getRelaunchOnStartup() config helper, and extend the vscode test
mock with a Memento factory and an extensions.getExtension stub.

No behavior change — subsequent commits wire these in."
```

---

### Task 2: SessionManager constructor signature + migrate existing tests

**Files:**
- Modify: `src/sessionManager.ts` — constructor accepts `workspaceState: vscode.Memento`; add `_disposed` flag; add `_pidWriteQueue`; add private constant `PID_KEY`
- Modify: `src/extension.ts` — pass `context.workspaceState` to `new SessionManager(...)`
- Modify: `test/sessionManager.debugLog.test.ts`, `test/sessionManager.focusSession.test.ts`, `test/addFolderPrompt.stale.test.ts` — pass mock Memento to constructor

The signature change has to land in one commit because every existing test that constructs `SessionManager` will fail to compile otherwise.

- [ ] **Step 1: Update `SessionManager` constructor in `src/sessionManager.ts`**

Add the `PID_KEY` constant near the top of the file (after `STATE_DIR`):

```typescript
/** workspaceState key for the PID record. */
const PID_KEY = "claudeConductor.sessionPids";
```

Replace the constructor (currently lines ~45–60) and add new private fields:

```typescript
  /** Set when dispose() is called — guards async-resolved writes. */
  private _disposed = false;

  /**
   * Serialized write queue for PID persistence. Each call extends the chain
   * with a leading .catch() so a prior rejection doesn't poison subsequent
   * writes, and an inner try/catch logs and swallows transient failures.
   */
  private _pidWriteQueue: Promise<void> = Promise.resolve();

  /** workspaceState injected by the extension activator. */
  private readonly _workspaceState: vscode.Memento;

  constructor(workspaceState: vscode.Memento) {
    this._workspaceState = workspaceState;

    // Pick up any Claude terminals that already exist (e.g., extension reloaded)
    for (const terminal of vscode.window.terminals) {
      this._trackIfClaudeSession(terminal);
    }

    this._disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        this._trackIfClaudeSession(terminal);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        this._handleTerminalClose(terminal);
      }),
      this._onDidChangeSessions
    );
  }
```

Replace `dispose()` (currently lines ~417–423):

```typescript
  dispose(): void {
    this._disposed = true;
    for (const d of this._disposables) {
      d.dispose();
    }
    this._sessions.clear();
    this._pidToTerminal.clear();
  }
```

- [ ] **Step 2: Pass `context.workspaceState` in `src/extension.ts`**

Modify the `activate()` body (line ~83). Change:

```typescript
  sessionManager = new SessionManager();
```

to:

```typescript
  sessionManager = new SessionManager(context.workspaceState);
```

- [ ] **Step 3: Update `test/sessionManager.debugLog.test.ts`**

Read the file first. At every `new SessionManager()` call, change to `new SessionManager(createMemento())`. Add the import at the top:

```typescript
import { createMemento } from "./mocks/vscode";
```

(Adjust the import path if the test file is in a subdirectory — should be `"./mocks/vscode"` since it's a sibling to `test/mocks/`.)

- [ ] **Step 4: Update `test/sessionManager.focusSession.test.ts`**

Same migration as Step 3.

- [ ] **Step 5: Update `test/addFolderPrompt.stale.test.ts`**

Same migration as Step 3.

- [ ] **Step 6: Run lint, test, compile to verify migration**

```bash
npm run lint
npm test
npm run compile
```

Expected: all three exit 0. Test count unchanged from before (constructor migration is purely mechanical).

- [ ] **Step 7: Commit**

```bash
git add src/sessionManager.ts src/extension.ts test/sessionManager.debugLog.test.ts test/sessionManager.focusSession.test.ts test/addFolderPrompt.stale.test.ts
git commit -m "refactor: SessionManager takes workspaceState arg (#43)

Threads context.workspaceState into SessionManager so the upcoming
reattach logic can persist PID baselines. Adds a _disposed flag and
_pidWriteQueue (unused yet — populated in a follow-up commit).

Migrates the three existing tests to construct with a mock Memento
via createMemento().

Behavior unchanged — pure plumbing."
```

---

### Task 3: PID persistence helpers (`_normalizePersistKey`, `_persistSessionPid`, `_clearSessionPid`)

**Files:**
- Modify: `src/sessionManager.ts` — add three private methods
- Create: `test/sessionManagerPidPersistence.test.ts` — tests for the helpers in isolation

TDD: write the tests first, run to confirm they fail, then implement.

- [ ] **Step 1: Create the test file `test/sessionManagerPidPersistence.test.ts`**

```typescript
/**
 * Unit tests for SessionManager PID persistence helpers (#43).
 *
 * Covers _persistSessionPid, _clearSessionPid, _normalizePersistKey, the
 * _disposed guard, and the write-queue rejection-recovery path.
 *
 * These tests reach into SessionManager via `as any` to call private methods
 * directly — that's intentional. The public surface for these helpers is
 * exercised through the reattach-pass integration tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscodeMock from "./mocks/vscode";
import { createMemento, MementoMock } from "./mocks/vscode";
import { SessionManager } from "../src/sessionManager";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Private = any;

const PID_KEY = "claudeConductor.sessionPids";

describe("SessionManager PID persistence", () => {
  let mem: MementoMock;
  let sm: SessionManager;

  beforeEach(() => {
    vi.restoreAllMocks();
    (vscodeMock.window as Record<string, unknown>).terminals = [];
    mem = createMemento();
    sm = new SessionManager(mem as unknown as import("vscode").Memento);
  });

  it("_normalizePersistKey preserves case", () => {
    const result = (sm as Private)._normalizePersistKey("D:\\Projects\\MyApp");
    expect(result.toLowerCase()).not.toBe(result); // sanity: input has uppercase
    expect(result).toBe("D:\\Projects\\MyApp");
  });

  it("_persistSessionPid writes through to workspaceState", async () => {
    (sm as Private)._persistSessionPid("D:\\proj\\foo", 42);
    // Wait for the queue chain to drain
    await (sm as Private)._pidWriteQueue;
    expect(mem.update).toHaveBeenCalledWith(PID_KEY, { "D:\\proj\\foo": 42 });
  });

  it("_persistSessionPid is no-op after dispose()", async () => {
    sm.dispose();
    (sm as Private)._persistSessionPid("D:\\proj\\foo", 42);
    await (sm as Private)._pidWriteQueue;
    expect(mem.update).not.toHaveBeenCalled();
  });

  it("_clearSessionPid removes the entry", async () => {
    (sm as Private)._persistSessionPid("D:\\proj\\foo", 42);
    (sm as Private)._persistSessionPid("D:\\proj\\bar", 43);
    await (sm as Private)._pidWriteQueue;
    (sm as Private)._clearSessionPid("D:\\proj\\foo");
    await (sm as Private)._pidWriteQueue;
    expect(mem._store.get(PID_KEY)).toEqual({ "D:\\proj\\bar": 43 });
  });

  it("_clearSessionPid is no-op after dispose()", async () => {
    (sm as Private)._persistSessionPid("D:\\proj\\foo", 42);
    await (sm as Private)._pidWriteQueue;
    sm.dispose();
    (sm as Private)._clearSessionPid("D:\\proj\\foo");
    await (sm as Private)._pidWriteQueue;
    expect(mem._store.get(PID_KEY)).toEqual({ "D:\\proj\\foo": 42 });
  });

  it("queue self-heals after a workspaceState.update rejection", async () => {
    mem.update.mockImplementationOnce(() => Promise.reject(new Error("disk full")));
    (sm as Private)._persistSessionPid("D:\\proj\\foo", 42);
    (sm as Private)._persistSessionPid("D:\\proj\\bar", 43);
    await (sm as Private)._pidWriteQueue;
    // First update rejected; second update should still have run.
    expect(mem.update).toHaveBeenCalledTimes(2);
    expect(mem._store.get(PID_KEY)).toEqual({ "D:\\proj\\bar": 43 });
  });

  it("preserves persisted-key case (does not lowercase)", async () => {
    (sm as Private)._persistSessionPid("D:\\Project\\MyApp", 42);
    await (sm as Private)._pidWriteQueue;
    const stored = mem._store.get(PID_KEY) as Record<string, number>;
    expect(Object.keys(stored)).toEqual(["D:\\Project\\MyApp"]);
  });
});
```

- [ ] **Step 2: Run the test file to confirm it fails**

```bash
npx vitest run test/sessionManagerPidPersistence.test.ts
```

Expected: tests fail with `_normalizePersistKey is not a function` or similar — methods don't exist yet.

- [ ] **Step 3: Implement the three methods in `src/sessionManager.ts`**

Add `import { log } from "./output"` if not already imported (it is). Add the methods inside the `SessionManager` class, near the other private methods (e.g., after `_findSessionByFolder`):

```typescript
  /**
   * Normalize a folder path for use as a persistence key.
   * Case is PRESERVED — see "Persistence vs in-memory key" in the design spec.
   * Lower-case folding applies only to in-memory `_findSessionByFolder` lookups,
   * NOT to keys persisted in workspaceState.
   */
  private _normalizePersistKey(folderPath: string): string {
    return path.normalize(folderPath);
  }

  /**
   * Write the (folderPath -> pid) entry to workspaceState[PID_KEY].
   * No-op after dispose().
   *
   * Writes are serialized through `_pidWriteQueue` to prevent read-modify-write
   * races between concurrent reattach routines and `launchSession` flows. The
   * leading `.catch(() => undefined)` ensures a prior rejection doesn't poison
   * subsequent writes; the inner try/catch logs and swallows transient failures.
   */
  private _persistSessionPid(folderPath: string, pid: number): void {
    if (this._disposed) return;
    this._pidWriteQueue = this._pidWriteQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          const current = this._workspaceState.get<Record<string, number>>(PID_KEY) ?? {};
          current[this._normalizePersistKey(folderPath)] = pid;
          await this._workspaceState.update(PID_KEY, current);
        } catch (err) {
          log(`[reattach] failed to persist PID for ${folderPath}: ${String(err)}`);
        }
      });
  }

  /**
   * Remove the entry for `folderPath` from workspaceState[PID_KEY].
   * Same queue + rejection semantics as `_persistSessionPid`. No-op after dispose().
   */
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

- [ ] **Step 4: Run the test file to confirm it passes**

```bash
npx vitest run test/sessionManagerPidPersistence.test.ts
```

Expected: 7/7 tests pass.

- [ ] **Step 5: Run full lint + test + compile**

```bash
npm run lint
npm test
npm run compile
```

Expected: all three exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/sessionManager.ts test/sessionManagerPidPersistence.test.ts
git commit -m "feat: PID persistence helpers with serialized write queue (#43)

Adds _normalizePersistKey, _persistSessionPid, and _clearSessionPid as
private methods on SessionManager. Writes go through _pidWriteQueue,
which serializes them and self-heals from individual workspaceState
update failures via the .catch(() => undefined).then(...) pattern.

Both writers honor the _disposed flag so async-resolved writes after
dispose() no-op cleanly.

Persisted keys are case-preserved (path.normalize, no toLowerCase) to
avoid collisions on case-sensitive filesystems.

Includes 7 unit tests covering: case preservation, write-through,
disposed guards, clear, queue rejection self-healing."
```

---

### Task 4: Wire PID persistence into `launchSession` and `_removeByKey`

**Files:**
- Modify: `src/sessionManager.ts` — call `_persistSessionPid` after a new session's `processId` resolves; call `_clearSessionPid` from `_removeByKey`
- Modify: `test/sessionManagerPidPersistence.test.ts` — add tests for the integration points

- [ ] **Step 1: Add tests for the integration points**

Append to `test/sessionManagerPidPersistence.test.ts` inside the `describe` block:

```typescript
  it("launchSession persists PID after the new terminal's processId resolves", async () => {
    // Mock createTerminal to return a fake terminal whose processId resolves to 999
    const fakeTerminal = {
      name: "claude · proj",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
      processId: Promise.resolve(999),
      shellIntegration: undefined,
      creationOptions: { cwd: "D:\\proj" },
    };
    vi.mocked(vscodeMock.window.createTerminal).mockReturnValue(
      fakeTerminal as unknown as import("vscode").Terminal
    );
    // fs.existsSync must return true for launchSession's cwd guard
    const fs = await import("fs");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    await sm.launchSession("D:\\proj");
    // launchSession schedules the persist — drain the queue
    await (sm as Private)._pidWriteQueue;

    const stored = mem._store.get(PID_KEY) as Record<string, number>;
    expect(stored).toEqual({ "D:\\proj": 999 });
  });

  it("_removeByKey clears the PID entry on session close", async () => {
    // Seed _sessions and PID record
    const fakeTerminal = {
      name: "claude · proj",
      processId: Promise.resolve(123),
      creationOptions: { cwd: "D:\\proj" },
    } as unknown as import("vscode").Terminal;
    (sm as Private)._sessions.set(fakeTerminal, {
      terminal: fakeTerminal,
      folderPath: "D:\\proj",
      folderName: "proj",
      startedAt: new Date(),
      isIdle: false,
    });
    (sm as Private)._persistSessionPid("D:\\proj", 123);
    await (sm as Private)._pidWriteQueue;
    expect(mem._store.get(PID_KEY)).toEqual({ "D:\\proj": 123 });

    // Trigger close cleanup
    (sm as Private)._removeByKey(fakeTerminal);
    await (sm as Private)._pidWriteQueue;

    expect(mem._store.get(PID_KEY)).toEqual({});
  });
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
npx vitest run test/sessionManagerPidPersistence.test.ts -t "launchSession persists"
npx vitest run test/sessionManagerPidPersistence.test.ts -t "_removeByKey clears"
```

Expected: both fail — `launchSession` doesn't write the PID yet, `_removeByKey` doesn't call `_clearSessionPid`.

- [ ] **Step 3: Update `launchSession` to persist the PID**

In `src/sessionManager.ts`, find the end of `launchSession` (after `await this._dispatchClaudeCommand(terminal)`). Add:

```typescript
    // Persist the new shell's PID so the next activation's reattach pass
    // has a baseline. processId is a Thenable; we don't block here.
    terminal.processId.then(
      (pid) => {
        if (pid !== undefined) {
          this._persistSessionPid(normalized, pid);
        }
      },
      () => { /* ignore — best-effort persistence */ }
    );
```

- [ ] **Step 4: Update `_removeByKey` to clear the PID**

In `src/sessionManager.ts`, find `_removeByKey` (around line 345). Inside the method, after `this._sessions.delete(terminal);` and the existing `terminal.processId.then` block (which clears `_pidToTerminal`), add a call to `_clearSessionPid`:

The simplest place is right after the existing PID-index cleanup. Modify the method to:

```typescript
  private _removeByKey(terminal: vscode.Terminal): boolean {
    const session = this._sessions.get(terminal);
    if (!session) {
      debugLog(`[remove] miss name=${JSON.stringify(terminal.name)} — key already gone (possible double-fire)`);
      return false;
    }
    this._sessions.delete(terminal);
    debugLog(`[remove] success folderPath=${JSON.stringify(session.folderPath)} sessionsAfter=${this._sessions.size}`);

    // Remove from PID index (two-argument .then() because PromiseLike lacks .catch())
    terminal.processId.then(
      (pid) => {
        if (pid !== undefined) {
          this._pidToTerminal.delete(pid);
          debugLog(`[pid:delete] pid=${pid} pidsAfter=${this._pidToTerminal.size}`);
        }
      },
      () => { /* ignore */ }
    );

    // Clear the persisted PID for this folder so the next activation's
    // reattach pass doesn't see a stale baseline. Runs UNCONDITIONALLY
    // (regardless of relaunchOnStartup setting) to prevent stale baselines
    // when the user toggles the setting off then back on.
    this._clearSessionPid(session.folderPath);

    this._cleanupStateFile(session.folderPath);
    this._onDidChangeSessions.fire();
    return true;
  }
```

- [ ] **Step 5: Run the new tests to confirm they pass**

```bash
npx vitest run test/sessionManagerPidPersistence.test.ts
```

Expected: 9/9 tests pass.

- [ ] **Step 6: Run full lint + test + compile**

```bash
npm run lint
npm test
npm run compile
```

Expected: all three exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/sessionManager.ts test/sessionManagerPidPersistence.test.ts
git commit -m "feat: persist session PID on launch and clear on close (#43)

launchSession schedules a _persistSessionPid call once the new terminal's
processId resolves, capturing the baseline shell PID for the next
activation's reattach decision.

_removeByKey calls _clearSessionPid unconditionally on session close so
toggling relaunchOnStartup off then back on doesn't leave stale baselines
in the persistence record.

Adds 2 integration tests."
```

---

### Task 5: `_dispatchClaudeIntoRestoredTerminal` — buffered-input mitigation

**Files:**
- Modify: `src/sessionManager.ts` — add the new private method
- Create: `test/dispatchClaudeIntoRestoredTerminal.test.ts` — tests for each dispatch tier

The reattach helper reuses the 3-tier dispatch logic from `_dispatchClaudeCommand` but inserts a clear-prefix (`\u0003\u0015` = Ctrl-C, Ctrl-U) only on the **delay-fallback path**. This avoids racing against shell-integration's command-boundary marker on the fast/slow paths.

- [ ] **Step 1: Create the test file `test/dispatchClaudeIntoRestoredTerminal.test.ts`**

```typescript
/**
 * Tests for SessionManager._dispatchClaudeIntoRestoredTerminal (#43).
 *
 * Verifies the three dispatch tiers and that the buffered-input clear-prefix
 * (\u0003\u0015) is sent ONLY on the delay-fallback path — not on the
 * shell-integration fast or slow paths, where executeCommand handles command
 * boundaries safely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscodeMock from "./mocks/vscode";
import { createMemento } from "./mocks/vscode";
import { SessionManager } from "../src/sessionManager";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Private = any;

describe("_dispatchClaudeIntoRestoredTerminal", () => {
  let sm: SessionManager;

  beforeEach(() => {
    vi.restoreAllMocks();
    (vscodeMock.window as Record<string, unknown>).terminals = [];
    sm = new SessionManager(createMemento() as unknown as import("vscode").Memento);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fast path: shell integration active → executeCommand called once, no clear-prefix", async () => {
    const executeCommand = vi.fn();
    const sendText = vi.fn();
    const terminal = {
      name: "claude · foo",
      sendText,
      shellIntegration: { executeCommand },
      creationOptions: { cwd: "D:\\foo" },
    } as unknown as import("vscode").Terminal;

    await (sm as Private)._dispatchClaudeIntoRestoredTerminal(terminal);

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith("claude");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("slow path: shell integration activates within window → executeCommand called", async () => {
    const executeCommand = vi.fn();
    const sendText = vi.fn();
    const terminal = {
      name: "claude · foo",
      sendText,
      shellIntegration: undefined as unknown,
      creationOptions: { cwd: "D:\\foo" },
    } as unknown as import("vscode").Terminal;

    // Capture the listener registered by the slow path
    let registeredListener: ((e: { terminal: unknown; shellIntegration: { executeCommand: typeof executeCommand } }) => void) | undefined;
    vi.spyOn(vscodeMock.window, "onDidChangeTerminalShellIntegration").mockImplementation((cb) => {
      registeredListener = cb as typeof registeredListener;
      return new vscodeMock.Disposable(() => {});
    });

    const dispatchPromise = (sm as Private)._dispatchClaudeIntoRestoredTerminal(terminal);

    // Fire the activation event with a fresh shellIntegration object
    const activated = { executeCommand: vi.fn() };
    expect(registeredListener).toBeDefined();
    registeredListener!({ terminal, shellIntegration: activated });

    await dispatchPromise;

    expect(activated.executeCommand).toHaveBeenCalledWith("claude");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("delay fallback: no shell integration → clear-prefix sent, then claude after delay", async () => {
    vi.useFakeTimers();
    const sendText = vi.fn();
    const terminal = {
      name: "claude · foo",
      sendText,
      shellIntegration: undefined as unknown,
      creationOptions: { cwd: "D:\\foo" },
    } as unknown as import("vscode").Terminal;

    // The slow-path listener is registered but never fires
    vi.spyOn(vscodeMock.window, "onDidChangeTerminalShellIntegration").mockReturnValue(
      new vscodeMock.Disposable(() => {})
    );

    const dispatchPromise = (sm as Private)._dispatchClaudeIntoRestoredTerminal(terminal);

    // Advance 2000ms → slow-path times out
    await vi.advanceTimersByTimeAsync(2000);
    // Advance 50ms breather between clear-prefix and dispatch
    await vi.advanceTimersByTimeAsync(50);
    // Advance launchDelayMs (default 500ms) → delay-fallback fires sendText("claude")
    await vi.advanceTimersByTimeAsync(500);
    await dispatchPromise;

    // Two sendText calls in order:
    //   1. clear-prefix \u0003\u0015 with addNewLine: false (2 args)
    //   2. "claude" with implicit newline (1 arg)
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenNthCalledWith(1, "\u0003\u0015", false);
    expect(sendText).toHaveBeenNthCalledWith(2, "claude");
  });
});
```

- [ ] **Step 2: Run the test file to confirm it fails**

```bash
npx vitest run test/dispatchClaudeIntoRestoredTerminal.test.ts
```

Expected: tests fail — `_dispatchClaudeIntoRestoredTerminal is not a function`.

- [ ] **Step 3: Implement `_dispatchClaudeIntoRestoredTerminal` in `src/sessionManager.ts`**

Add inside the `SessionManager` class, after `_dispatchClaudeCommand`:

```typescript
  /**
   * Variant of `_dispatchClaudeCommand` for restored terminals.
   *
   * Same 3-tier path, but the delay-fallback prepends `\u0003\u0015` (Ctrl-C,
   * Ctrl-U) before sending `claude`, with a 50ms breather. On POSIX shells
   * and Windows PowerShell with PSReadLine (default), this clears any
   * buffered prompt input the user typed before VS Code closed. On legacy
   * cmd.exe and PowerShell-without-PSReadLine these escape sequences are
   * not interpreted as kill-line — see "Known limitations" in the design.
   *
   * The clear-prefix is NOT sent on the fast or slow paths because
   * shell-integration's `executeCommand` handles command boundaries
   * safely; sending raw bytes there could race the integration handshake.
   */
  private async _dispatchClaudeIntoRestoredTerminal(terminal: vscode.Terminal): Promise<void> {
    const cmd = getClaudeCommand();

    // Fast path: shell integration already active
    if (terminal.shellIntegration) {
      log(`[reattach:dispatch] fast path — shell integration already active`);
      terminal.shellIntegration.executeCommand(cmd);
      return;
    }

    // Slow path: wait up to 2 s for shell integration to activate
    const shellIntegrationAvailable = await new Promise<boolean>((resolve) => {
      let disposed = false;

      const timeoutHandle = setTimeout(() => {
        if (!disposed) {
          disposed = true;
          listener.dispose();
          log(`[reattach:dispatch] slow path timed out — falling back to delay sendText`);
          resolve(false);
        }
      }, 2000);

      const listener = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal && !disposed) {
          disposed = true;
          clearTimeout(timeoutHandle);
          listener.dispose();
          log(`[reattach:dispatch] slow path — shell integration activated`);
          e.shellIntegration.executeCommand(cmd);
          resolve(true);
        }
      });
    });

    if (shellIntegrationAvailable) {
      return;
    }

    // Delay fallback — CLEAR-PREFIX REQUIRED HERE.
    //  (Ctrl-C) signals the running foreground command; no-op on a clean prompt.
    //  (Ctrl-U) clears the current input line on POSIX shells and PowerShell+PSReadLine.
    log(`[reattach:dispatch] delay fallback — sending clear-prefix then claude`);
    terminal.sendText("\u0003\u0015", false);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const delayMs = getLaunchDelayMs();
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    terminal.sendText(cmd);
  }
```

- [ ] **Step 4: Run the test file to confirm it passes**

```bash
npx vitest run test/dispatchClaudeIntoRestoredTerminal.test.ts
```

Expected: 3/3 tests pass.

- [ ] **Step 5: Run full lint + test + compile**

```bash
npm run lint
npm test
npm run compile
```

Expected: all three exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/sessionManager.ts test/dispatchClaudeIntoRestoredTerminal.test.ts
git commit -m "feat: dispatch helper for restored terminals with buffered-input clear (#43)

_dispatchClaudeIntoRestoredTerminal mirrors _dispatchClaudeCommand's
3-tier dispatch but prepends \u0003\u0015 (Ctrl-C, Ctrl-U) before the
delay-fallback sendText. Clears any buffered prompt input the user
typed before VS Code closed, on shells where those escape sequences are
interpreted as line-clear (POSIX shells, PowerShell+PSReadLine).

The clear-prefix is NOT sent on the fast/slow paths — executeCommand
there handles command boundaries safely; sending raw bytes would race
the integration handshake.

3 tests cover each dispatch tier."
```

---

### Task 6: `_reattachRestoredSessions` skeleton — setting gate + snapshot iteration + orchestration

**Files:**
- Modify: `src/sessionManager.ts` — add the new async method (skeleton); wire into the constructor
- Create: `test/reattachOnStartup.test.ts` — tests for the orchestration shell

This task lands the orchestrator. Per-session decision logic and dead-cwd handling come in subsequent tasks; the skeleton here just iterates a snapshot of `_sessions.values()`, awaits `Promise.allSettled`, and returns. The setting gate also lands here.

- [ ] **Step 1: Create the test file `test/reattachOnStartup.test.ts` with two skeleton tests**

```typescript
/**
 * Integration tests for SessionManager reattach-on-startup (#43).
 *
 * Tests are organized by spec scenario number (see design doc test table).
 * Scenarios are added incrementally as plan tasks 6-9 land.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscodeMock from "./mocks/vscode";
import { createMemento } from "./mocks/vscode";
import { SessionManager } from "../src/sessionManager";
import * as config from "../src/config";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Private = any;

const PID_KEY = "claudeConductor.sessionPids";

function makeTerminal(opts: {
  name: string;
  cwd: string;
  pid?: number;
  shellIntegration?: { executeCommand: ReturnType<typeof vi.fn> };
}): unknown {
  return {
    name: opts.name,
    show: vi.fn(),
    sendText: vi.fn(),
    dispose: vi.fn(),
    processId: Promise.resolve(opts.pid ?? 1234),
    shellIntegration: opts.shellIntegration,
    creationOptions: { cwd: opts.cwd },
  };
}

describe("reattach on startup — orchestration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (vscodeMock.window as Record<string, unknown>).terminals = [];
  });

  // Scenario 12 from the design spec
  it("setting off → reattach is a no-op (no dispatch, no toast)", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(false);
    const term = makeTerminal({ name: "claude · foo", cwd: "D:\\foo", pid: 42 });
    (vscodeMock.window as Record<string, unknown>).terminals = [term];

    const sm = new SessionManager(createMemento() as unknown as import("vscode").Memento);
    // Wait for any reattach work to complete (it shouldn't have started)
    await (sm as Private)._reattachPromise;

    expect((term as { sendText: ReturnType<typeof vi.fn> }).sendText).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  // Scenario 19 from the design spec
  it("snapshot iteration: onDidOpenTerminal mid-reattach is not included", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    const original = makeTerminal({ name: "claude · foo", cwd: "D:\\foo", pid: 42 });
    (vscodeMock.window as Record<string, unknown>).terminals = [original];

    // Capture onDidOpenTerminal callback so we can fire a synthetic event
    let openCallback: ((t: unknown) => void) | undefined;
    vi.spyOn(vscodeMock.window, "onDidOpenTerminal").mockImplementation((cb) => {
      openCallback = cb as typeof openCallback;
      return new vscodeMock.Disposable(() => {});
    });

    const mem = createMemento();
    const sm = new SessionManager(mem as unknown as import("vscode").Memento);

    // Fire onDidOpenTerminal for a NEW Claude terminal during reattach
    const newTerm = makeTerminal({ name: "claude · bar", cwd: "D:\\bar", pid: 99 });
    expect(openCallback).toBeDefined();
    openCallback!(newTerm);

    await (sm as Private)._reattachPromise;

    // The reattach iteration only saw the original (snapshot). The new terminal
    // is tracked in _sessions but no reattach dispatch fires for it.
    expect((newTerm as { sendText: ReturnType<typeof vi.fn> }).sendText).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run test/reattachOnStartup.test.ts
```

Expected: tests fail — `_reattachPromise` doesn't exist; reattach not wired.

- [ ] **Step 3: Add the orchestrator skeleton to `src/sessionManager.ts`**

Add the import for the new config helper at the top of the file:

```typescript
import { getClaudeCommand, getReuseTerminal, getLaunchDelayMs, getRelaunchOnStartup } from "./config";
```

Add a new private field next to `_pidWriteQueue`:

```typescript
  /**
   * Promise from the reattach pass kicked off in the constructor.
   * Tests await this to verify reattach completed; production callers
   * fire-and-forget.
   */
  private _reattachPromise: Promise<void> = Promise.resolve();
```

Update the constructor's body — after the existing `_disposables.push(...)` block, add:

```typescript
    // Kick off reattach pass for restored Claude tabs (gated by setting).
    // Fire-and-forget — _reattachPromise is exposed for tests.
    if (getRelaunchOnStartup()) {
      this._reattachPromise = this._reattachRestoredSessions();
    }
```

Add the orchestrator method inside the class (after `_dispatchClaudeIntoRestoredTerminal`):

```typescript
  /**
   * Reattach pass for restored Claude session tabs (#43).
   *
   * Runs once at the end of the constructor when relaunchOnStartup is on.
   * Iterates a SYNCHRONOUS SNAPSHOT of _sessions.values() taken at entry
   * (defensive against onDidOpenTerminal mid-iteration mutation), kicks
   * off per-session async routines, awaits Promise.allSettled, and shows
   * an aggregate dead-cwd toast when applicable.
   *
   * The toast is gated on !this._disposed so a dispose() that lands during
   * the routines doesn't surface a stale warning.
   *
   * Per-session decision logic, dispatch, and cwd-missing handling are
   * implemented in subsequent tasks of this plan.
   */
  private async _reattachRestoredSessions(): Promise<void> {
    debugLog(`[reattach] starting pass — sessions=${this._sessions.size}`);
    const snapshot = Array.from(this._sessions.values());
    const deadCwds: string[] = [];

    await Promise.allSettled(
      snapshot.map((session) => this._reattachOneSession(session, deadCwds))
    );

    if (!this._disposed && deadCwds.length > 0) {
      const shown = deadCwds.slice(0, 3);
      const overflow = deadCwds.length - shown.length;
      const folderList = shown.join(", ") + (overflow > 0 ? `, and ${overflow} more` : "");
      const noun = deadCwds.length === 1 ? "session" : "sessions";
      vscode.window.showInformationMessage(
        `Could not restore ${deadCwds.length} ${noun} — folder${deadCwds.length === 1 ? "" : "s"} no longer exist: ${folderList}`
      );
    }

    debugLog(`[reattach] pass complete — deadCwds=${deadCwds.length}`);
  }

  /**
   * Per-session reattach decision. Mutates `deadCwds` in place when the
   * session's cwd no longer exists on disk.
   *
   * Skeleton implementation in this task — full decision logic lands in
   * Task 7 (PID compare/dispatch) and Task 8 (cwd-missing handling).
   */
  private async _reattachOneSession(
    session: ActiveSession,
    deadCwds: string[]
  ): Promise<void> {
    // Placeholder — will be filled in by Task 7 and Task 8.
    void session;
    void deadCwds;
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run test/reattachOnStartup.test.ts
```

Expected: 2/2 tests pass.

- [ ] **Step 5: Run full lint + test + compile**

```bash
npm run lint
npm test
npm run compile
```

Expected: all three exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/sessionManager.ts test/reattachOnStartup.test.ts
git commit -m "feat: reattach orchestrator skeleton with setting gate (#43)

Adds _reattachRestoredSessions, kicked off from the SessionManager
constructor when claudeConductor.relaunchOnStartup is true. Iterates a
synchronous snapshot of _sessions.values() (defensive against
onDidOpenTerminal mid-iteration), awaits Promise.allSettled on per-
session routines, and shows an aggregate dead-cwd toast gated on
!this._disposed.

Per-session decision logic (PID compare, dispatch, cwd-missing) is a
stub here — implemented in subsequent commits.

Tests: setting off no-ops; snapshot iteration excludes mid-reattach
opens (scenarios 12 and 19 from the design spec)."
```

---

### Task 7: Per-session reattach decision — PID compare + dispatch

**Files:**
- Modify: `src/sessionManager.ts` — fill in `_reattachOneSession`
- Modify: `test/reattachOnStartup.test.ts` — add scenarios 1, 2, 5, 8, 9

The decision logic is the heart of the feature. PID match → skip + refresh persistence; PID differ or no PID → dispatch + persist; undefined/rejected → skip.

- [ ] **Step 1: Add scenario tests to `test/reattachOnStartup.test.ts`**

Append inside the `describe` block:

```typescript
  // Scenario 1: same PID → no dispatch, but PID re-persisted
  it("same PID → no dispatch, record refreshed", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    const term = makeTerminal({ name: "claude · foo", cwd: "D:\\foo", pid: 42 });
    (vscodeMock.window as Record<string, unknown>).terminals = [term];
    const mem = createMemento({ [PID_KEY]: { "D:\\foo": 42 } });

    const sm = new SessionManager(mem as unknown as import("vscode").Memento);
    await (sm as Private)._reattachPromise;
    await (sm as Private)._pidWriteQueue;

    expect((term as { sendText: ReturnType<typeof vi.fn> }).sendText).not.toHaveBeenCalled();
    // Record refreshed (re-written even though PID matched)
    expect(mem.update).toHaveBeenCalled();
    expect(mem._store.get(PID_KEY)).toEqual({ "D:\\foo": 42 });
  });

  // Scenario 2: different PID → dispatch via shell-integration fast path
  it("different PID → fast-path dispatch + PID written", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    const executeCommand = vi.fn();
    const term = makeTerminal({
      name: "claude · foo",
      cwd: "D:\\foo",
      pid: 42,
      shellIntegration: { executeCommand },
    });
    // Mock fs.existsSync for the cwd check (needed in Task 8 — make it pass here)
    const fs = await import("fs");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    (vscodeMock.window as Record<string, unknown>).terminals = [term];
    const mem = createMemento({ [PID_KEY]: { "D:\\foo": 99 } });

    const sm = new SessionManager(mem as unknown as import("vscode").Memento);
    await (sm as Private)._reattachPromise;
    await (sm as Private)._pidWriteQueue;

    expect(executeCommand).toHaveBeenCalledWith("claude");
    expect((term as { sendText: ReturnType<typeof vi.fn> }).sendText).not.toHaveBeenCalled();
    expect(mem._store.get(PID_KEY)).toEqual({ "D:\\foo": 42 });
  });

  // Scenario 5: no stored PID → dispatch + PID written
  it("no stored PID → dispatch + PID written", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    const executeCommand = vi.fn();
    const term = makeTerminal({
      name: "claude · foo",
      cwd: "D:\\foo",
      pid: 42,
      shellIntegration: { executeCommand },
    });
    const fs = await import("fs");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    (vscodeMock.window as Record<string, unknown>).terminals = [term];
    const mem = createMemento(); // empty record

    const sm = new SessionManager(mem as unknown as import("vscode").Memento);
    await (sm as Private)._reattachPromise;
    await (sm as Private)._pidWriteQueue;

    expect(executeCommand).toHaveBeenCalledWith("claude");
    expect(mem._store.get(PID_KEY)).toEqual({ "D:\\foo": 42 });
  });

  // Scenario 8: processId resolves to undefined → no dispatch
  it("processId undefined → no dispatch, no dispose, no PID write", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    const term = {
      name: "claude · foo",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
      processId: Promise.resolve(undefined),
      shellIntegration: { executeCommand: vi.fn() },
      creationOptions: { cwd: "D:\\foo" },
    };
    (vscodeMock.window as Record<string, unknown>).terminals = [term];
    const mem = createMemento();

    const sm = new SessionManager(mem as unknown as import("vscode").Memento);
    await (sm as Private)._reattachPromise;

    expect(term.shellIntegration.executeCommand).not.toHaveBeenCalled();
    expect(term.sendText).not.toHaveBeenCalled();
    expect(term.dispose).not.toHaveBeenCalled();
    expect(mem._store.get(PID_KEY)).toBeUndefined();
  });

  // Scenario 9: processId rejects → no dispatch
  it("processId rejects → no dispatch, no dispose", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    const term = {
      name: "claude · foo",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
      processId: Promise.reject(new Error("rejected")),
      shellIntegration: { executeCommand: vi.fn() },
      creationOptions: { cwd: "D:\\foo" },
    };
    (vscodeMock.window as Record<string, unknown>).terminals = [term];
    const mem = createMemento();

    const sm = new SessionManager(mem as unknown as import("vscode").Memento);
    await (sm as Private)._reattachPromise;

    expect(term.shellIntegration.executeCommand).not.toHaveBeenCalled();
    expect(term.sendText).not.toHaveBeenCalled();
    expect(term.dispose).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
npx vitest run test/reattachOnStartup.test.ts
```

Expected: scenarios 1, 2, 5, 8, 9 fail — `_reattachOneSession` is still a stub.

- [ ] **Step 3: Implement `_reattachOneSession` decision logic**

Replace the stub `_reattachOneSession` method in `src/sessionManager.ts`:

```typescript
  private async _reattachOneSession(
    session: ActiveSession,
    deadCwds: string[]
  ): Promise<void> {
    // 1. Resolve current PID (await — Thenable)
    let currentPid: number | undefined;
    try {
      currentPid = await session.terminal.processId;
    } catch {
      currentPid = undefined;
    }

    if (currentPid === undefined) {
      debugLog(`[reattach:one] folderPath=${session.folderPath} pid=undefined — skip`);
      return;
    }

    // 2. Read previously-stored PID from workspaceState
    const record =
      this._workspaceState.get<Record<string, number>>(PID_KEY) ?? {};
    const storedPid = record[this._normalizePersistKey(session.folderPath)];

    // 3. PID match → shell survived, refresh record only, no dispatch
    if (storedPid === currentPid) {
      debugLog(`[reattach:one] folderPath=${session.folderPath} pid=${currentPid} match — skip dispatch`);
      this._persistSessionPid(session.folderPath, currentPid);
      return;
    }

    // 4. Cwd missing? Dispose and queue for the aggregate toast.
    //    (Task 8 finishes this branch — for now, fall through to dispatch.)
    if (!fs.existsSync(session.folderPath)) {
      debugLog(`[reattach:one] folderPath=${session.folderPath} cwd missing — dispose`);
      deadCwds.push(session.folderPath);
      session.terminal.dispose();
      return;
    }

    // 5. Fresh shell — dispatch claude, then persist new PID
    debugLog(`[reattach:one] folderPath=${session.folderPath} stored=${storedPid} current=${currentPid} — dispatch`);
    await this._dispatchClaudeIntoRestoredTerminal(session.terminal);
    this._persistSessionPid(session.folderPath, currentPid);
  }
```

- [ ] **Step 4: Run the new tests to confirm they pass**

```bash
npx vitest run test/reattachOnStartup.test.ts
```

Expected: 7/7 tests pass (scenarios 12, 19 from Task 6 plus 1, 2, 5, 8, 9).

- [ ] **Step 5: Run full lint + test + compile**

```bash
npm run lint
npm test
npm run compile
```

Expected: all three exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/sessionManager.ts test/reattachOnStartup.test.ts
git commit -m "feat: per-session reattach decision — PID compare + dispatch (#43)

_reattachOneSession reads the stored PID for the session's folder from
workspaceState, compares against the awaited current PID, and:
- PID match → skip dispatch but refresh the persistence record
- PID differ or no stored PID → dispatch via _dispatchClaudeIntoRestoredTerminal,
  then persist the new PID
- processId undefined or rejected → skip
- cwd missing → queue for the aggregate toast and dispose the terminal
  (the dead-cwd path is finished in the next commit)

5 scenario tests (1, 2, 5, 8, 9 from the design spec) cover each
decision branch."
```

---

### Task 8: Cwd-missing handling — aggregate toast + dispose

**Files:**
- Modify: `test/reattachOnStartup.test.ts` — add scenarios 6, 7

Task 7's implementation already handles cwd-missing by adding to `deadCwds` and disposing. Task 6's orchestrator already shows the aggregate toast. This task verifies both ends and the truncation behavior.

- [ ] **Step 1: Add scenario 6 and 7 tests to `test/reattachOnStartup.test.ts`**

Append inside the `describe` block:

```typescript
  // Scenario 6: cwd missing for one tab → dispose + single-entry toast
  it("cwd missing (single tab) → dispose + toast with one folder", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    const fs = await import("fs");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const term = makeTerminal({ name: "claude · foo", cwd: "D:\\foo", pid: 42 });
    (vscodeMock.window as Record<string, unknown>).terminals = [term];

    const sm = new SessionManager(createMemento() as unknown as import("vscode").Memento);
    await (sm as Private)._reattachPromise;

    expect((term as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled();
    expect((term as { sendText: ReturnType<typeof vi.fn> }).sendText).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("D:\\foo")
    );
  });

  // Scenario 7: 5 dead cwds → ONE toast with first 3 names + "and 2 more"
  it("5 cwds missing → ONE aggregate toast with truncation", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    const fs = await import("fs");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const folders = ["D:\\a", "D:\\b", "D:\\c", "D:\\d", "D:\\e"];
    const terms = folders.map((cwd, i) =>
      makeTerminal({ name: `claude · ${cwd}`, cwd, pid: 100 + i })
    );
    (vscodeMock.window as Record<string, unknown>).terminals = terms;

    const sm = new SessionManager(createMemento() as unknown as import("vscode").Memento);
    await (sm as Private)._reattachPromise;

    // All 5 disposed
    for (const t of terms) {
      expect((t as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled();
    }

    // ONE toast with first 3 folder names + "and 2 more"
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(vscodeMock.window.showInformationMessage).mock.calls[0][0];
    expect(msg).toContain("D:\\a");
    expect(msg).toContain("D:\\b");
    expect(msg).toContain("D:\\c");
    expect(msg).toContain("and 2 more");
    // d and e should NOT appear by name
    expect(msg).not.toContain("D:\\d");
    expect(msg).not.toContain("D:\\e");
  });
```

- [ ] **Step 2: Run the tests to confirm they pass (the implementation is already in place from Tasks 6 + 7)**

```bash
npx vitest run test/reattachOnStartup.test.ts
```

Expected: 9/9 tests pass.

- [ ] **Step 3: Run full lint + test + compile**

```bash
npm run lint
npm test
npm run compile
```

Expected: all three exit 0.

- [ ] **Step 4: Commit**

```bash
git add test/reattachOnStartup.test.ts
git commit -m "test: cwd-missing aggregation behavior (#43)

Verifies scenarios 6 and 7 from the design spec:
- 1 dead cwd → 1 toast naming the folder
- 5 dead cwds → 1 toast with first 3 names + 'and 2 more'

Implementation was added in earlier commits (orchestrator in Task 6,
per-session dispose in Task 7); these tests lock the contract."
```

---

### Task 9: Day-1 collision — proactive consent toast

**Files:**
- Create: `src/onboarding.ts` — encapsulates the first-activation consent flow
- Modify: `src/extension.ts` — call onboarding before `new SessionManager(...)`
- Create: `test/onboarding.test.ts` — scenarios 16, 17, 18

The onboarding logic lives in its own module (`src/onboarding.ts`) so it's independently testable without dragging the rest of `extension.ts` into the test setup.

- [ ] **Step 1: Create `test/onboarding.test.ts`**

```typescript
/**
 * Tests for the day-1 collision proactive-detection flow (#43, scenarios 16–18).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscodeMock from "./mocks/vscode";
import { createMemento, MementoMock } from "./mocks/vscode";
import { runReattachOnboarding } from "../src/onboarding";

const ONBOARDING_KEY = "claudeConductor.reattachOnboardingShown";

describe("reattach onboarding (#43)", () => {
  let globalState: MementoMock;
  let configUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    globalState = createMemento();
    configUpdate = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(vscodeMock.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn(),
      update: configUpdate,
    } as unknown as import("vscode").WorkspaceConfiguration);
  });

  // Scenario 16
  it("official extension installed + first activation + user clicks Disable → setting set to false, flag set", async () => {
    vi.mocked(vscodeMock.extensions.getExtension).mockReturnValue(
      { id: "Anthropic.claude-code" } as unknown as import("vscode").Extension<unknown>
    );
    vi.mocked(vscodeMock.window.showInformationMessage).mockResolvedValue(
      "Disable" as unknown as import("vscode").MessageItem
    );

    await runReattachOnboarding(globalState as unknown as import("vscode").Memento);

    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(configUpdate).toHaveBeenCalledWith(
      "relaunchOnStartup",
      false,
      expect.anything() // ConfigurationTarget.Global
    );
    expect(globalState._store.get(ONBOARDING_KEY)).toBe(true);
  });

  // Scenario 16 — user clicks Enable instead → no setting update, flag still set
  it("official extension installed + Enable click → no setting update, flag set", async () => {
    vi.mocked(vscodeMock.extensions.getExtension).mockReturnValue(
      { id: "Anthropic.claude-code" } as unknown as import("vscode").Extension<unknown>
    );
    vi.mocked(vscodeMock.window.showInformationMessage).mockResolvedValue(
      "Enable" as unknown as import("vscode").MessageItem
    );

    await runReattachOnboarding(globalState as unknown as import("vscode").Memento);

    expect(configUpdate).not.toHaveBeenCalled();
    expect(globalState._store.get(ONBOARDING_KEY)).toBe(true);
  });

  // Scenario 17
  it("no official extension → no toast, flag still set", async () => {
    vi.mocked(vscodeMock.extensions.getExtension).mockReturnValue(undefined);

    await runReattachOnboarding(globalState as unknown as import("vscode").Memento);

    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    expect(configUpdate).not.toHaveBeenCalled();
    expect(globalState._store.get(ONBOARDING_KEY)).toBe(true);
  });

  // Scenario 18
  it("already shown → no toast, no flag write, no setting change", async () => {
    globalState._store.set(ONBOARDING_KEY, true);
    vi.mocked(vscodeMock.extensions.getExtension).mockReturnValue(
      { id: "Anthropic.claude-code" } as unknown as import("vscode").Extension<unknown>
    );

    await runReattachOnboarding(globalState as unknown as import("vscode").Memento);

    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    expect(configUpdate).not.toHaveBeenCalled();
    // Flag was already true; no NEW write should happen, but value still true
    expect(globalState._store.get(ONBOARDING_KEY)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test file to confirm it fails (`runReattachOnboarding` doesn't exist)**

```bash
npx vitest run test/onboarding.test.ts
```

Expected: tests fail — module `../src/onboarding` not found.

- [ ] **Step 3: Create `src/onboarding.ts`**

```typescript
import * as vscode from "vscode";

/** globalState key set after the onboarding toast has been considered. */
const ONBOARDING_KEY = "claudeConductor.reattachOnboardingShown";

/** Marketplace ID of the official Anthropic Claude Code VS Code extension. */
const OFFICIAL_CLAUDE_EXT_ID = "Anthropic.claude-code";

/**
 * First-activation consent flow for the reattach feature (#43).
 *
 * If the user has the official Claude Code extension installed AND we have
 * not yet shown this onboarding toast, surface a one-time prompt asking
 * them to opt in or out of reattach. Their choice flips
 * `claudeConductor.relaunchOnStartup` accordingly.
 *
 * The flag is set regardless of outcome so the toast appears at most once.
 * If the user dismisses the toast without clicking, the setting stays at
 * its default (true).
 */
export async function runReattachOnboarding(
  globalState: vscode.Memento
): Promise<void> {
  const alreadyShown = globalState.get<boolean>(ONBOARDING_KEY, false);
  if (alreadyShown) {
    return;
  }

  const officialExt = vscode.extensions.getExtension(OFFICIAL_CLAUDE_EXT_ID);
  if (!officialExt) {
    // No collision risk — mark as shown and move on.
    await globalState.update(ONBOARDING_KEY, true);
    return;
  }

  // Surface the consent toast.
  const message =
    "Claude Conductor reattaches Claude sessions on VS Code restart by typing " +
    "`claude` into restored terminal tabs. We detected the official Claude " +
    "Code extension is also installed — Conductor may inject `claude` into " +
    "its sessions until issue #33 ships. Enable reattach for Conductor sessions?";
  const choice = await vscode.window.showInformationMessage(
    message,
    "Enable",
    "Disable"
  );

  if (choice === "Disable") {
    await vscode.workspace
      .getConfiguration("claudeConductor")
      .update("relaunchOnStartup", false, vscode.ConfigurationTarget.Global);
  }
  // "Enable" or dismiss → keep default (true), no setting update needed.

  await globalState.update(ONBOARDING_KEY, true);
}
```

- [ ] **Step 4: Wire onboarding into `src/extension.ts`**

Add the import at the top:

```typescript
import { runReattachOnboarding } from "./onboarding";
```

In `activate()`, before `sessionManager = new SessionManager(...)`, await the onboarding:

```typescript
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // First-activation consent gate for reattach feature (#43)
  await runReattachOnboarding(context.globalState);

  sessionManager = new SessionManager(context.workspaceState);
  context.subscriptions.push(sessionManager);

  // ... rest of activate body unchanged ...
```

> **Note**: `activate()` was previously synchronous (returned `void`). The signature change to `async` / `Promise<void>` is supported by VS Code's extension API.

- [ ] **Step 5: Run all tests to confirm onboarding tests pass and nothing else breaks**

```bash
npx vitest run test/onboarding.test.ts
npm test
```

Expected: 4 onboarding tests pass; full suite green.

- [ ] **Step 6: Run lint + compile**

```bash
npm run lint
npm run compile
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/onboarding.ts src/extension.ts test/onboarding.test.ts
git commit -m "feat: day-1 collision onboarding for reattach (#43)

On first activation post-install, if the official Claude Code extension
(Anthropic.claude-code) is detected, surface a one-time consent toast
with Enable/Disable buttons. Disable flips claudeConductor.relaunchOnStartup
to false via workspace config update; Enable or dismiss keeps the default
(true).

The globalState flag claudeConductor.reattachOnboardingShown ensures the
toast appears at most once. Without the official extension, the flag is
set silently — no user-visible behavior.

Onboarding lives in src/onboarding.ts so it's independently testable.
4 tests cover: Disable click, Enable click, no extension, already-shown."
```

---

### Task 10: Catch-all integration tests — scenarios 14, 15, 11

**Files:**
- Modify: `test/reattachOnStartup.test.ts` — add scenarios 14 (AUTO_LAUNCH_KEY ordering), 15 (dispose race), 11 (queue rejection at integration level), 13 (PID cleanup with setting on AND off)

Some of these scenarios test interactions that span multiple subsystems. They're integration-level rather than unit-level and live alongside the orchestrator tests.

- [ ] **Step 1: Add scenarios 11, 13, 14, 15 to `test/reattachOnStartup.test.ts`**

Append inside the `describe` block:

```typescript
  // Scenario 14: AUTO_LAUNCH_KEY interaction
  // Reattach dispatches first; AUTO_LAUNCH_KEY launchSession finds the
  // session and focuses it (no duplicate createTerminal).
  it("AUTO_LAUNCH_KEY + reattach for the same folder → one dispatch + one focus, no duplicate terminal", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    vi.spyOn(config, "getReuseTerminal").mockReturnValue(true);
    const executeCommand = vi.fn();
    const term = makeTerminal({
      name: "claude · foo",
      cwd: "D:\\foo",
      pid: 42,
      shellIntegration: { executeCommand },
    });
    (vscodeMock.window as Record<string, unknown>).terminals = [term];
    const fs = await import("fs");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const mem = createMemento({ [PID_KEY]: { "D:\\foo": 99 } });

    const sm = new SessionManager(mem as unknown as import("vscode").Memento);
    await (sm as Private)._reattachPromise;

    // Dispatch happened
    expect(executeCommand).toHaveBeenCalledTimes(1);
    const dispatchCallOrder = executeCommand.mock.invocationCallOrder[0];

    // Now simulate the AUTO_LAUNCH_KEY block — call launchSession for the same folder.
    // Because reuseExistingTerminal is true, this should focus the existing
    // session, not create a new terminal.
    const showSpy = vi.spyOn(term as { show: ReturnType<typeof vi.fn> }, "show");
    await sm.launchSession("D:\\foo");

    // No new terminal created — createTerminal call count unchanged
    // (showSpy invocation order is AFTER executeCommand)
    expect(showSpy).toHaveBeenCalled();
    const focusCallOrder = showSpy.mock.invocationCallOrder[0];
    expect(focusCallOrder).toBeGreaterThan(dispatchCallOrder);
    // No new terminal was created via createTerminal beyond the original
    expect(vscodeMock.window.createTerminal).not.toHaveBeenCalled();
  });

  // Scenario 15: dispose racing with reattach
  it("dispose() mid-reattach → no PID write, no toast, no exception", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    // processId resolves after 50ms — gives us time to dispose mid-await
    let resolveProcessId: (v: number | undefined) => void;
    const processIdPromise = new Promise<number | undefined>((r) => {
      resolveProcessId = r;
    });
    const term = {
      name: "claude · foo",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
      processId: processIdPromise,
      shellIntegration: { executeCommand: vi.fn() },
      creationOptions: { cwd: "D:\\foo" },
    };
    (vscodeMock.window as Record<string, unknown>).terminals = [term];
    const fs = await import("fs");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const mem = createMemento();

    const sm = new SessionManager(mem as unknown as import("vscode").Memento);

    // Dispose immediately — _disposed is now set
    sm.dispose();

    // Resolve the processId so the routine can complete
    resolveProcessId!(42);

    // Wait for the routine to settle
    await (sm as Private)._reattachPromise;
    await (sm as Private)._pidWriteQueue;

    // No PID write — _persistSessionPid no-ops after dispose()
    expect(mem.update).not.toHaveBeenCalled();
    // No toast (gated on !_disposed)
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  // Scenario 11: workspaceState.update rejection mid-chain → queue self-heals
  it("workspaceState.update rejects once → next persist still succeeds", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    const executeCommand = vi.fn();
    const t1 = makeTerminal({
      name: "claude · a",
      cwd: "D:\\a",
      pid: 1,
      shellIntegration: { executeCommand },
    });
    const t2 = makeTerminal({
      name: "claude · b",
      cwd: "D:\\b",
      pid: 2,
      shellIntegration: { executeCommand },
    });
    (vscodeMock.window as Record<string, unknown>).terminals = [t1, t2];
    const fs = await import("fs");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const mem = createMemento();
    // First update rejects — second + onward succeed
    mem.update.mockImplementationOnce(() => Promise.reject(new Error("disk full")));

    const sm = new SessionManager(mem as unknown as import("vscode").Memento);
    await (sm as Private)._reattachPromise;
    await (sm as Private)._pidWriteQueue;

    // Both dispatches happened
    expect(executeCommand).toHaveBeenCalledTimes(2);
    // The second update succeeded → store has at least t2's PID
    const stored = mem._store.get(PID_KEY) as Record<string, number>;
    expect(stored).toBeDefined();
    // Order isn't guaranteed (parallel), but at least one PID landed
    expect(Object.keys(stored).length).toBeGreaterThanOrEqual(1);
  });

  // Scenario 13: PID cleanup runs whether the setting is on or off
  it("_clearSessionPid runs unconditionally (setting off does not gate close cleanup)", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(false);
    const term = makeTerminal({ name: "claude · foo", cwd: "D:\\foo", pid: 42 });
    (vscodeMock.window as Record<string, unknown>).terminals = [term];
    const mem = createMemento({ [PID_KEY]: { "D:\\foo": 42 } });

    const sm = new SessionManager(mem as unknown as import("vscode").Memento);
    await (sm as Private)._reattachPromise;

    // Reattach didn't fire (setting off). Now simulate close.
    (sm as Private)._removeByKey(term);
    await (sm as Private)._pidWriteQueue;

    // PID cleared even though setting is off
    expect(mem._store.get(PID_KEY)).toEqual({});
  });
```

- [ ] **Step 2: Run the new tests to confirm they pass**

```bash
npx vitest run test/reattachOnStartup.test.ts
```

Expected: 13/13 tests pass.

- [ ] **Step 3: Run full lint + test + compile**

```bash
npm run lint
npm test
npm run compile
```

Expected: all three exit 0. Total test count should be 63 (existing) + 7 (PID persistence) + 3 (dispatch helper) + 13 (reattach orchestration) + 4 (onboarding) = ~90.

- [ ] **Step 4: Commit**

```bash
git add test/reattachOnStartup.test.ts
git commit -m "test: AUTO_LAUNCH ordering, dispose race, queue rejection, unconditional clear (#43)

Adds scenarios 11, 13, 14, 15 from the design spec:
- 14: dispatch precedes focus when reattach + AUTO_LAUNCH_KEY both
  fire for the same folder; no duplicate terminal
- 15: dispose() mid-reattach prevents PID write and toast, no exception
- 11: a single workspaceState.update rejection doesn't poison the
  queue — subsequent persists land
- 13: _clearSessionPid runs whether setting is on or off (verifies
  Decision #3 in the spec)"
```

---

### Task 11: README + CHANGELOG updates

**Files:**
- Modify: `README.md` — add reattach to Features, document the setting under Configuration, remove or rewrite "Known Limitations" implying sessions don't survive restart, add Windows shell limitation
- Modify: `CHANGELOG.md` — entry for the new behavior

- [ ] **Step 1: Update `README.md`**

Read the current README first to find the right sections (Features, Configuration, Known Limitations).

Open `README.md`. Locate the **Features** section. Add a new bullet (preserve the existing markdown style — match neighbors):

```markdown
- **Reattach on VS Code startup**: when VS Code restarts and Claude session tabs are restored with fresh shells, Conductor automatically dispatches `claude` into each tab so your sessions come back without manual relaunch. Gated by `claudeConductor.relaunchOnStartup` (default `true`).
```

Locate the **Configuration** section (or the table that lists existing config keys — `claudeCommand`, `reuseExistingTerminal`, `enableNotifications`, etc.). Add an entry for `relaunchOnStartup`:

```markdown
| `claudeConductor.relaunchOnStartup` | boolean | `true` | When VS Code restarts, dispatch `claude` into restored Conductor session tabs whose inner shell was replaced. Disable if you also use the official Claude Code extension and Conductor mis-fires into its sessions, or on Windows shells (cmd.exe / PowerShell without PSReadLine) where the buffered-input clear-prefix is not interpreted as kill-line. |
```

(Match the existing table format — column count and separators.)

Locate any **Known Limitations** section. If a bullet says something like "sessions don't survive VS Code restart" or "you'll need to manually relaunch claude after restart" — remove or rewrite it. Add a new bullet covering the Windows shell limitation:

```markdown
- **Reattach on cmd.exe / PowerShell without PSReadLine**: when the buffered-input clear-prefix on the delay-fallback dispatch path is not interpreted as line-clear (legacy Windows shells without modern line editing), a stray `claude` keystroke could land in any buffered prompt input. Disable `claudeConductor.relaunchOnStartup` if affected.
```

- [ ] **Step 2: Update `CHANGELOG.md`**

Read the current CHANGELOG. Add a new entry under the unreleased / next-version heading. If there's no unreleased section, add one (the existing release-strategy doc dictates format — preserve it).

```markdown
## Unreleased

### Added

- **Reattach Claude sessions on VS Code startup** (#43). Conductor now detects restored session tabs whose inner shell was replaced (after a system restart, ptyhost crash, or VS Code with persistent-session revival off) and dispatches `claude` into each tab automatically. Gated by the new `claudeConductor.relaunchOnStartup` setting (default `true`).
- First-activation consent toast when the official Claude Code extension (`Anthropic.claude-code`) is detected. Lets users opt out of reattach to avoid Conductor injecting keystrokes into the official extension's sessions.

### Notes

- **Windows shell limitation**: the buffered-input clear-prefix used on the delay-fallback dispatch path uses `\u0003\u0015` (Ctrl-C, Ctrl-U), which is interpreted as line-clear on POSIX shells and Windows PowerShell with PSReadLine (the default). On legacy cmd.exe and PowerShell-without-PSReadLine, the clear is a no-op — set `claudeConductor.relaunchOnStartup: false` if affected.
- **First launch after upgrade**: existing Claude tabs whose shells survived your last VS Code restart may receive a one-time stray `claude` keystroke (no stored PID baseline). Subsequent activations are race-free.
- **Day-1 collision with the official Claude Code extension**: if you install the official extension *after* Conductor's first activation, the consent toast won't retroactively fire. Set `claudeConductor.relaunchOnStartup: false` manually if needed.
```

- [ ] **Step 3: Run lint + test + compile to verify nothing broke**

```bash
npm run lint
npm test
npm run compile
```

Expected: all three exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: README and CHANGELOG entries for reattach feature (#43)

- README Features: document automatic reattach on restart
- README Configuration: document claudeConductor.relaunchOnStartup
- README Known Limitations: rewrite any 'sessions don't survive restart'
  wording; add Windows cmd.exe / PowerShell-without-PSReadLine
  limitation note
- CHANGELOG Unreleased: detailed entry covering the new feature, the
  setting, the day-1 collision behavior, the buffered-input clear-prefix,
  and the Windows shell limitation"
```

---

### Task 12: Final verification, manual smoke test, and PR

**Files:**
- All — final review

This task closes out the branch by running the full CI-equivalent suite, doing a manual smoke test, and opening the PR.

- [ ] **Step 1: Run the complete CI-equivalent suite**

```bash
npm run lint     # tsc --noEmit
npm test         # vitest run
npm run compile  # tsc -p ./
```

Expected: all three exit 0. Test count is at least 90 (63 existing + ~27 new across PID persistence, dispatch helper, reattach orchestration, onboarding).

- [ ] **Step 2: Build the VSIX for manual smoke test**

```bash
npm run package
```

Expected: `claude-conductor-1.3.0.vsix` (or whatever current version) generated in the worktree root.

- [ ] **Step 3: Install the VSIX into VS Code Extension Dev Host or a clean profile**

Open VS Code → Extensions view → `...` menu → "Install from VSIX…" → select the generated file.

> **Important**: install into a *clean profile* or the Extension Dev Host (F5 from this repo). Do NOT install over your daily-driver Conductor — you want to be able to roll back if anything goes wrong, and the upgrade path is one of the things you want to verify.

- [ ] **Step 4: Manual smoke test**

Run through these scenarios. Each should produce the expected behavior; check off as you go.

  - [ ] Open VS Code with the new build. Open the Claude Conductor sidebar. **No active sessions yet** is fine.
  - [ ] Launch a new Claude session via the command palette. Confirm a `claude · <folder>` tab opens and `claude` runs inside.
  - [ ] **VS Code restart**: close VS Code completely, reopen it. The session tab should be restored with `claude` running automatically (because PID matched on the surviving shell, OR fresh shell + dispatch fired).
  - [ ] **Setting off**: set `claudeConductor.relaunchOnStartup: false` in settings. Restart VS Code. Confirm the restored tab is at a bare prompt — no auto-dispatch.
  - [ ] **Setting back on**: set `claudeConductor.relaunchOnStartup: true`. Restart VS Code. Confirm dispatch fires (auto-`claude`) on the bare-prompt tab.
  - [ ] **Reload Window**: with claude running, run "Developer: Reload Window" from the command palette. Confirm claude session is preserved in-place — no stray `claude` keystroke landed in the running session.
  - [ ] **Dead cwd**: launch a session for a folder, then move/rename the folder on disk while VS Code is closed. Restart VS Code. Confirm the dead-cwd tab is disposed and you see the toast naming the folder.
  - [ ] **Day-1 onboarding**: if you have the official Claude Code extension installed, on the first activation of this build you should see the consent toast. Click Disable; confirm the setting flipped to false. Reset the `claudeConductor.reattachOnboardingShown` globalState entry (via Developer: Inspect Extension State, or just delete via "View > Command Palette > Developer: Reload Window") to test re-showing if needed.

If any scenario fails, file the failure as a sub-issue against #43 and address before merging.

- [ ] **Step 5: Push the branch**

```bash
git -C .worktrees/43-reattach-on-startup push -u origin 43-reattach-on-startup
```

- [ ] **Step 6: Open the PR via the GitHub MCP**

The PR body must contain `Closes #43` as plain text (no backticks), the test plan checklist, and the Claude attribution. The router (Claude Code) typically opens the PR via `mcp__plugin_github_github__create_pull_request`. The body template:

```
Closes #43.

## Summary

Reattach Claude sessions on VS Code startup by dispatching `claude` into restored terminal tabs whose inner shells were replaced. Implements the v3 design at `docs/superpowers/specs/2026-04-27-43-reattach-on-startup-design.md`.

## Architecture

A new `_reattachRestoredSessions` async pass runs at the end of the `SessionManager` constructor (gated by `claudeConductor.relaunchOnStartup`, default `true`). For each tracked Claude terminal, an async per-session routine compares the awaited current shell PID against a previously-persisted PID for the same folder (stored in `workspaceState`). PID match → skip dispatch (claude survived); PID differ or no-stored-PID → dispatch via `_dispatchClaudeIntoRestoredTerminal` (which clears buffered input on the delay-fallback path); cwd missing → dispose + aggregate toast.

Day-1 collision with the official Claude Code extension is handled proactively via `runReattachOnboarding` in `src/onboarding.ts` — first-activation consent toast with Enable/Disable buttons.

## Test plan

- [x] `npm run lint` — clean
- [x] `npm test` — full suite passes (90+ tests)
- [x] `npm run compile` — clean
- [ ] Manual: VS Code close + reopen restores running claude session in place
- [ ] Manual: setting=false disables auto-dispatch on restart
- [ ] Manual: dead-cwd tab disposes with aggregate toast
- [ ] Manual: day-1 onboarding toast shows when official Claude Code extension is detected on first activation

## Notes

- README and CHANGELOG updated per AC.
- The `_dispatchClaudeIntoRestoredTerminal` clear-prefix (`\u0003\u0015`) is POSIX-shell semantics; cmd.exe and PowerShell-without-PSReadLine fall back to the setting gate as the recovery mechanism. Documented as a known limitation.
- See `docs/superpowers/specs/2026-04-27-43-reattach-on-startup-design.md` for full design context including the *Known limitations / deferred* section that lists items intentionally not addressed.

🤖 *Generated by Claude Code on behalf of @cbeaulieu-gt*
```

> **Implementer note**: the router opens the PR with the title `feat: reattach Claude sessions on VS Code startup (#43)` (or similar — keep it under ~70 chars). The body must include `Closes #43` as plain text on its own line, no backticks, otherwise GitHub's parser will skip the closing keyword and the issue will stay open after merge.

- [ ] **Step 7: Verify PR opened and CI passes**

After PR creation, watch CI:
- `lint-and-test` job: should pass within a few minutes
- `compile` job: should pass

If CI fails, address the failure on the same branch (do not branch off) and push a fixup commit. Do NOT skip hooks or amend already-pushed commits per CLAUDE.md.

- [ ] **Step 8: Final commit (optional — only if needed for fixes)**

If CI surfaces any issue or the manual smoke test fails, address inline on the branch and push. Once CI is green AND manual smoke test passes, the branch is ready for review and merge.
