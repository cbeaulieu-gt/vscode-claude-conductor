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
import * as fs from "fs";

vi.mock("fs");

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
    // Clear call history on plain vi.fn() instances (vi.restoreAllMocks only
    // resets spies, not these module-level fns, so counts bleed otherwise).
    vscodeMock.window.showInformationMessage.mockClear();
    // Default: all paths exist on disk (individual tests override as needed)
    vi.mocked(fs.existsSync).mockReturnValue(true);
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
    vi.mocked(fs.existsSync).mockReturnValue(true);
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
    vi.mocked(fs.existsSync).mockReturnValue(true);
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

  // Scenario 6: cwd missing for one tab → dispose + single-entry toast
  it("cwd missing (single tab) → dispose + toast with one folder", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    vi.mocked(fs.existsSync).mockReturnValue(false);
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
    // Lock the singular/plural pluralization branch: 1 dead cwd → singular noun
    const msg = vi.mocked(vscodeMock.window.showInformationMessage).mock.calls[0][0] as string;
    expect(msg).toMatch(/1 session\b/);  // exactly "1 session" (singular), not "sessions"
    expect(msg).not.toMatch(/sessions\b/);
  });

  // Scenario 7: 5 dead cwds → ONE toast with first 3 names + "and 2 more"
  it("5 cwds missing → ONE aggregate toast with truncation", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    // Map.values() preserves insertion order in modern JS, so the toast
    // truncation will list folders in the order they were tracked here.
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
    vi.mocked(fs.existsSync).mockReturnValue(true);
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

    expect(showSpy).toHaveBeenCalled();
    const focusCallOrder = showSpy.mock.invocationCallOrder[0];
    expect(focusCallOrder).toBeGreaterThan(dispatchCallOrder);
    // No new terminal was created via createTerminal beyond the original
    expect(vscodeMock.window.createTerminal).not.toHaveBeenCalled();
  });

  // Scenario 15: dispose racing with reattach
  it("dispose() mid-reattach → no PID write, no toast, no exception", async () => {
    vi.spyOn(config, "getRelaunchOnStartup").mockReturnValue(true);
    // processId resolves after a delay — gives us time to dispose mid-await
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
    vi.mocked(fs.existsSync).mockReturnValue(true);
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
    vi.mocked(fs.existsSync).mockReturnValue(true);
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
});
