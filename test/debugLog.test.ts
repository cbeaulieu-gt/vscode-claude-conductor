import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for debugLog() in src/output.ts.
 *
 * Strategy: call getOutputChannel() once to force channel creation, then spy
 * on the channel's appendLine. Control getDebugLogging() by spying on
 * workspace.getConfiguration. Between tests, restore spies and clear call
 * history on appendLine.
 *
 * We cannot use vi.resetModules() here because the vscode alias would resolve
 * to a fresh copy of the mock — distinct from the vscodeMock object we hold
 * references to — so spies set on vscodeMock would not affect the freshly-
 * imported output.ts's vscode reference.
 */

import * as vscodeMock from "./mocks/vscode";
import { log, debugLog, getOutputChannel } from "../src/output";

// Force channel creation so createOutputChannel.mock.results[0] is populated.
getOutputChannel();

const channel = (vscodeMock.window.createOutputChannel as ReturnType<typeof vi.fn>).mock.results[0]
  ?.value as { appendLine: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };

describe("debugLog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    channel.appendLine.mockClear();
  });

  it("does NOT write to the output channel when claudeConductor.debugLogging is false", () => {
    vi.spyOn(vscodeMock.workspace, "getConfiguration").mockReturnValue({
      get: <T>(section: string, defaultValue: T): T => {
        if (section === "debugLogging") return false as unknown as T;
        return defaultValue;
      },
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("vscode").WorkspaceConfiguration);

    debugLog("should not appear");

    expect(channel.appendLine).not.toHaveBeenCalled();
  });

  it("writes a [debug]-prefixed message to the output channel when claudeConductor.debugLogging is true", () => {
    vi.spyOn(vscodeMock.workspace, "getConfiguration").mockReturnValue({
      get: <T>(section: string, defaultValue: T): T => {
        if (section === "debugLogging") return true as unknown as T;
        return defaultValue;
      },
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("vscode").WorkspaceConfiguration);

    debugLog("test message");

    expect(channel.appendLine).toHaveBeenCalledOnce();
    const written: string = channel.appendLine.mock.calls[0][0];
    expect(written).toContain("[debug]");
    expect(written).toContain("test message");
  });

  it("log() always writes regardless of debugLogging setting", () => {
    vi.spyOn(vscodeMock.workspace, "getConfiguration").mockReturnValue({
      get: <T>(section: string, defaultValue: T): T => {
        if (section === "debugLogging") return false as unknown as T;
        return defaultValue;
      },
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("vscode").WorkspaceConfiguration);

    log("always visible");

    expect(channel.appendLine).toHaveBeenCalledOnce();
    expect(channel.appendLine.mock.calls[0][0]).toContain("always visible");
    expect(channel.appendLine.mock.calls[0][0]).not.toContain("[debug]");
  });
});
