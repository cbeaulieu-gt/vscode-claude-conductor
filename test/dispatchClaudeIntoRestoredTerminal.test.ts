/**
 * Tests for SessionManager._dispatchClaudeIntoRestoredTerminal (#43).
 *
 * Verifies the three dispatch tiers and that the buffered-input clear-prefix
 * () is sent ONLY on the delay-fallback path — not on the
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
    const sendText = vi.fn();
    const terminal = {
      name: "claude · foo",
      sendText,
      shellIntegration: undefined as unknown,
      creationOptions: { cwd: "D:\\foo" },
    } as unknown as import("vscode").Terminal;

    // Capture the listener registered by the slow path
    let registeredListener:
      | ((e: {
          terminal: unknown;
          shellIntegration: { executeCommand: ReturnType<typeof vi.fn> };
        }) => void)
      | undefined;
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
    //   1. clear-prefix  with addNewLine: false (2 args)
    //   2. "claude" with implicit newline (1 arg)
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenNthCalledWith(1, "", false);
    expect(sendText).toHaveBeenNthCalledWith(2, "claude");
  });
});
