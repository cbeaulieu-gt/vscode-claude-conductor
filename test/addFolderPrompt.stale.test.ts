/**
 * Regression tests for issue #71: stale-cwd guard in SessionManager.launchSession.
 *
 * Precondition:  A Claude session for PATH_A (old location) is tracked in
 *                SessionManager._sessions but PATH_A's directory no longer
 *                exists on disk.
 *
 * Symptom:       VS Code surfaced "Starting directory (cwd) <PATH_A> does not
 *                exist" because launchSession had no existence check before
 *                calling createTerminal.
 *
 * Fix contracts tested here:
 *  1. addFolderPrompt (no manager arg, reverted to main signature) with a stale
 *     terminal in vscode.window.terminals — createTerminal is NEVER called as a
 *     side-effect of Add Folder. The only side-effects are config.update and the
 *     info-message toast.
 *  2. launchSession invoked directly with a deleted cwd — early-returns without
 *     calling createTerminal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemento } from "./mocks/vscode";
import * as fs from "fs";

// Mock the entire `fs` module so we can control existsSync / statSync / readdirSync
// without touching the real filesystem. Same pattern used in hookInstaller.test.ts.
vi.mock("fs");

import * as vscodeMock from "./mocks/vscode";
import { SessionManager } from "../src/sessionManager";
import { addFolderPrompt } from "../src/quickPick";

const PATH_A = "I:\\Web Development\\career-ops"; // old, deleted path
const PATH_B = "D:\\projects\\new-location";       // new, valid path

describe("addFolderPrompt — stale _sessions entry (issue #71)", () => {
  // Shared config mock — reused across all getConfiguration() calls per test
  // so that assertions on `update` see the same mock fn that addFolderPrompt called.
  let configUpdateMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();

    configUpdateMock = vi.fn().mockResolvedValue(undefined);

    // Reset the mock terminal list each test
    (vscodeMock.window as Record<string, unknown>).terminals = [];

    // fs.existsSync: PATH_A does NOT exist on disk; everything else does.
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.toLowerCase().includes("career-ops") || s.toLowerCase().includes("web development")) {
        return false;
      }
      return true;
    });

    // fs.statSync: PATH_B is a valid directory; PATH_A throws ENOENT.
    vi.mocked(fs.statSync).mockImplementation((p) => {
      const s = String(p);
      if (s.toLowerCase().includes("career-ops") || s.toLowerCase().includes("web development")) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return { isDirectory: () => true } as fs.Stats;
    });

    // fs.readdirSync: empty state directory (no session-state files to process)
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    // workspace.getConfiguration: returns the same config object every time so
    // that assertions on `configUpdateMock` observe the calls made inside addFolderPrompt.
    vi.spyOn(vscodeMock.workspace, "getConfiguration").mockReturnValue({
      get: <T>(key: string, defaultValue: T): T => {
        if (key === "extraFolders") return [] as unknown as T;
        if (key === "reuseExistingTerminal") return true as unknown as T;
        if (key === "claudeCommand") return "claude" as unknown as T;
        if (key === "launchDelayMs") return 0 as unknown as T;
        if (key === "debugLogging") return false as unknown as T;
        return defaultValue;
      },
      update: configUpdateMock,
    } as unknown as import("vscode").WorkspaceConfiguration);

    // showInputBox: simulate user entering PATH_B (with validateInput bypass for the
    // test — validateInput calls statSync which is mocked to succeed for PATH_B)
    vi.spyOn(vscodeMock.window, "showInputBox").mockImplementation(
      async (opts?: import("vscode").InputBoxOptions) => {
        // Exercise validateInput so the fs mock is verified to work correctly
        if (opts?.validateInput) {
          const result = opts.validateInput(PATH_B);
          if (result != null) {
            throw new Error(`validateInput unexpectedly rejected PATH_B: ${String(result)}`);
          }
        }
        return PATH_B;
      }
    );

    // showInformationMessage: no-op (swallow the "Added: …" toast)
    vi.spyOn(vscodeMock.window, "showInformationMessage").mockResolvedValue(undefined);

    // onDidOpenTerminal / onDidCloseTerminal: capture callbacks so SessionManager
    // constructs without errors.  We do not fire them in this test.
    vi.spyOn(vscodeMock.window, "onDidOpenTerminal").mockReturnValue(
      new vscodeMock.Disposable(() => {})
    );
    vi.spyOn(vscodeMock.window, "onDidCloseTerminal").mockReturnValue(
      new vscodeMock.Disposable(() => {})
    );
    vi.spyOn(vscodeMock.window, "onDidChangeTerminalShellIntegration").mockReturnValue(
      new vscodeMock.Disposable(() => {})
    );
    vi.spyOn(vscodeMock.commands, "executeCommand").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call createTerminal during addFolderPrompt — only persists config and shows toast", async () => {
    // -------------------------------------------------------------------------
    // ARRANGE: inject a stale terminal for PATH_A into vscode.window.terminals.
    //
    // This replicates the real repro: a Claude terminal was created for PATH_A
    // before the folder was deleted.  The terminal proxy is still alive in VS
    // Code's list even though the cwd is gone.
    // -------------------------------------------------------------------------
    const staleTerminal = {
      name: "claude · career-ops",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
      processId: Promise.resolve(42),
      shellIntegration: undefined,
      creationOptions: { cwd: PATH_A },
    } as unknown as import("vscode").Terminal;

    (vscodeMock.window as Record<string, unknown>).terminals = [staleTerminal];

    // Clear any prior createTerminal invocations before the act step
    vi.mocked(vscodeMock.window.createTerminal).mockClear();

    // -------------------------------------------------------------------------
    // ACT: user runs "Add Folder" for PATH_B.
    // addFolderPrompt takes no argument (reverted to main signature).
    // -------------------------------------------------------------------------
    await addFolderPrompt();

    // -------------------------------------------------------------------------
    // ASSERT 1: createTerminal was NEVER called.
    //
    // addFolderPrompt's only job is to persist the folder and show a toast.
    // Launching a session is a separate action. If createTerminal fires here
    // that means the add-and-launch over-reach crept back in.
    // -------------------------------------------------------------------------
    expect(
      vi.mocked(vscodeMock.window.createTerminal),
      "createTerminal must not be called — Add Folder should only persist config, not launch a session"
    ).not.toHaveBeenCalled();

    // -------------------------------------------------------------------------
    // ASSERT 2: config.update was called with PATH_B in the extraFolders list.
    //
    // This is the one real side-effect the function SHOULD produce.
    // configUpdateMock is the same fn reference injected via the getConfiguration
    // spy, so it captures the call that addFolderPrompt made.
    // -------------------------------------------------------------------------
    expect(configUpdateMock).toHaveBeenCalledWith(
      "extraFolders",
      expect.arrayContaining([PATH_B]),
      expect.anything()
    );
  });

  it("launchSession with a deleted cwd early-returns without calling createTerminal", async () => {
    // -------------------------------------------------------------------------
    // ARRANGE: construct a fresh SessionManager with no terminals.
    // PATH_A is mocked as non-existent on disk via fs.existsSync above.
    // -------------------------------------------------------------------------
    const manager = new SessionManager(createMemento() as unknown as import("vscode").Memento);

    vi.mocked(vscodeMock.window.createTerminal).mockClear();

    // -------------------------------------------------------------------------
    // ACT: call launchSession directly with the stale/deleted path.
    // -------------------------------------------------------------------------
    let threw = false;
    try {
      await manager.launchSession(PATH_A);
    } catch {
      threw = true;
    }

    // -------------------------------------------------------------------------
    // ASSERT 1: no exception — early-return must be silent.
    // -------------------------------------------------------------------------
    expect(threw, "launchSession must not throw when cwd does not exist").toBe(false);

    // -------------------------------------------------------------------------
    // ASSERT 2: createTerminal was not called.
    // -------------------------------------------------------------------------
    expect(
      vi.mocked(vscodeMock.window.createTerminal),
      "createTerminal must not be called for a non-existent cwd"
    ).not.toHaveBeenCalled();

    manager.dispose();
  });
});
