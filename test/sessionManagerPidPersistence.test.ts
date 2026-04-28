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
import * as fs from "fs";

// Mock the entire `fs` module so we can control existsSync in launchSession tests.
vi.mock("fs");

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
    vi.mocked(fs.existsSync).mockReturnValue(true);

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
});
