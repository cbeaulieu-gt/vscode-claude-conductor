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
