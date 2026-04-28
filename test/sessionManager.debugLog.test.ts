import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscodeMock from "./mocks/vscode";
import { createMemento } from "./mocks/vscode";
import { getOutputChannel } from "../src/output";
import { SessionManager } from "../src/sessionManager";

// Ensure the output channel singleton is created so we can spy on it.
getOutputChannel();

const channel = (vscodeMock.window.createOutputChannel as ReturnType<typeof vi.fn>).mock.results[0]
  ?.value as { appendLine: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };

/**
 * Verify that _handleTerminalClose emits at least one [close: log line when
 * debugLogging is enabled. This is a wiring test — it asserts the
 * instrumentation is plumbed in, not that every tier outcome is logged
 * (those are covered by close-tier behaviour tests).
 */
describe("SessionManager close-detection debug logging", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    channel.appendLine.mockClear();

    // Enable debug logging
    vi.spyOn(vscodeMock.workspace, "getConfiguration").mockReturnValue({
      get: <T>(section: string, defaultValue: T): T => {
        if (section === "debugLogging") return true as unknown as T;
        return defaultValue;
      },
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("vscode").WorkspaceConfiguration);
  });

  it("emits at least one [close: log line when a terminal-close event fires", () => {
    // Build a mock terminal that looks like a tracked Claude session
    const mockTerminal = {
      name: "claude · test-repo",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
      processId: Promise.resolve(42),
      shellIntegration: undefined,
      creationOptions: { cwd: "/tmp/test-repo" },
    } as unknown as import("vscode").Terminal;

    // Capture the onDidCloseTerminal callback so we can invoke it directly
    let closeCallback: ((t: import("vscode").Terminal) => void) | undefined;
    vi.spyOn(vscodeMock.window, "onDidCloseTerminal").mockImplementation(
      (cb: (t: import("vscode").Terminal) => void) => {
        closeCallback = cb;
        return new vscodeMock.Disposable(() => {});
      }
    );

    // Also intercept onDidOpenTerminal (needed for SessionManager constructor)
    vi.spyOn(vscodeMock.window, "onDidOpenTerminal").mockReturnValue(
      new vscodeMock.Disposable(() => {})
    );

    const manager = new SessionManager(createMemento() as unknown as import("vscode").Memento);

    // Manually insert the session so _handleTerminalClose has something to match
    // We do this by triggering onDidOpenTerminal with a claude-prefixed terminal.
    // But onDidOpenTerminal is now mocked to a no-op. Instead we call the
    // captured close callback directly on a terminal that was NOT tracked —
    // that exercises all three tiers (all miss) and still emits [close: lines.
    expect(closeCallback).toBeDefined();
    closeCallback!(mockTerminal);

    // At least one [close: line should have been written
    const calls = channel.appendLine.mock.calls.map((c) => c[0] as string);
    const hasCloseLine = calls.some((line) => line.includes("[close:") || line.includes("[close]"));
    expect(hasCloseLine).toBe(true);

    manager.dispose();
  });
});
