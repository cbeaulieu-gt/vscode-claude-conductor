/**
 * Tests for hook path reconciliation (issue #64).
 *
 * When the extension updates, VS Code installs it to a new directory. The
 * hook entries in ~/.claude/settings.json embed an absolute path to
 * hooks/session-state.js inside the OLD extension directory. These tests
 * verify that:
 *  - hooksUpToDate() correctly detects stale vs current paths
 *  - reconcileHookPaths() rewrites every stale command preserving the action arg
 *  - ensureHooksInstalled() silently reconciles without prompting if paths are stale
 *  - No spurious write happens when paths are already current
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";

// We mock fs so we don't touch the real ~/.claude/settings.json
vi.mock("fs");

const OLD_PATH = "/c/Users/chris/.vscode/extensions/conductor-0.1.0";
const NEW_PATH = "/c/Users/chris/.vscode/extensions/conductor-0.2.0";

const OLD_SCRIPT_BASE_WIN = `/c/PROGRA~1/nodejs/node.exe ${OLD_PATH}/hooks/session-state.js`;
const NEW_SCRIPT_BASE_WIN = `/c/PROGRA~1/nodejs/node.exe ${NEW_PATH}/hooks/session-state.js`;

const OLD_SCRIPT_BASE_POSIX = `node ${OLD_PATH}/hooks/session-state.js`;
const NEW_SCRIPT_BASE_POSIX = `node ${NEW_PATH}/hooks/session-state.js`;

function makeSettingsWithHooks(scriptBase: string): Record<string, unknown> {
  return {
    hooks: {
      Notification: [
        {
          matcher: "idle_prompt",
          hooks: [{ type: "command", command: `${scriptBase} idle` }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: `${scriptBase} active` }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: `${scriptBase} stop` }],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Import helpers under test AFTER setting up the vi.mock above
// ---------------------------------------------------------------------------
import { hooksUpToDate, reconcileHookPaths } from "../src/hookInstaller.js";

describe("hooksUpToDate", () => {
  it("returns true when all hook commands match the expected script base", () => {
    const settings = makeSettingsWithHooks(NEW_SCRIPT_BASE_WIN);
    expect(hooksUpToDate(settings, NEW_SCRIPT_BASE_WIN)).toBe(true);
  });

  it("returns false when hook commands contain the marker but point at a different path", () => {
    const settings = makeSettingsWithHooks(OLD_SCRIPT_BASE_WIN);
    expect(hooksUpToDate(settings, NEW_SCRIPT_BASE_WIN)).toBe(false);
  });

  it("returns true for POSIX paths when they match", () => {
    const settings = makeSettingsWithHooks(NEW_SCRIPT_BASE_POSIX);
    expect(hooksUpToDate(settings, NEW_SCRIPT_BASE_POSIX)).toBe(true);
  });

  it("returns false for POSIX paths when stale", () => {
    const settings = makeSettingsWithHooks(OLD_SCRIPT_BASE_POSIX);
    expect(hooksUpToDate(settings, NEW_SCRIPT_BASE_POSIX)).toBe(false);
  });

  it("returns true when no hooks are installed at all (nothing to be stale)", () => {
    expect(hooksUpToDate({}, NEW_SCRIPT_BASE_WIN)).toBe(true);
  });
});

describe("reconcileHookPaths", () => {
  it("rewrites stale Windows-style paths to the new script base", () => {
    const settings = makeSettingsWithHooks(OLD_SCRIPT_BASE_WIN);
    reconcileHookPaths(settings, NEW_SCRIPT_BASE_WIN);

    const hooks = settings.hooks as Record<string, unknown[]>;
    const notifCmd = (
      (hooks.Notification[0] as Record<string, unknown[]>).hooks[0] as Record<
        string,
        string
      >
    ).command;
    expect(notifCmd).toBe(`${NEW_SCRIPT_BASE_WIN} idle`);

    const submitCmd = (
      (hooks.UserPromptSubmit[0] as Record<string, unknown[]>).hooks[0] as Record<
        string,
        string
      >
    ).command;
    expect(submitCmd).toBe(`${NEW_SCRIPT_BASE_WIN} active`);

    const stopCmd = (
      (hooks.Stop[0] as Record<string, unknown[]>).hooks[0] as Record<
        string,
        string
      >
    ).command;
    expect(stopCmd).toBe(`${NEW_SCRIPT_BASE_WIN} stop`);
  });

  it("rewrites stale POSIX-style paths to the new script base", () => {
    const settings = makeSettingsWithHooks(OLD_SCRIPT_BASE_POSIX);
    reconcileHookPaths(settings, NEW_SCRIPT_BASE_POSIX);

    const hooks = settings.hooks as Record<string, unknown[]>;
    const notifCmd = (
      (hooks.Notification[0] as Record<string, unknown[]>).hooks[0] as Record<
        string,
        string
      >
    ).command;
    expect(notifCmd).toBe(`${NEW_SCRIPT_BASE_POSIX} idle`);
  });

  it("preserves the trailing action arg after rewriting", () => {
    const settings = makeSettingsWithHooks(OLD_SCRIPT_BASE_WIN);
    reconcileHookPaths(settings, NEW_SCRIPT_BASE_WIN);

    const hooks = settings.hooks as Record<string, unknown[]>;
    const stopCmd = (
      (hooks.Stop[0] as Record<string, unknown[]>).hooks[0] as Record<
        string,
        string
      >
    ).command;
    // Must end with " stop", not " idle" or " active"
    expect(stopCmd.endsWith(" stop")).toBe(true);
  });

  it("does not modify hooks that do not contain session-state.js", () => {
    const settings: Record<string, unknown> = {
      hooks: {
        Notification: [
          {
            hooks: [{ type: "command", command: "some-other-tool notify" }],
          },
        ],
      },
    };
    reconcileHookPaths(settings, NEW_SCRIPT_BASE_WIN);
    const hooks = settings.hooks as Record<string, unknown[]>;
    const cmd = (
      (hooks.Notification[0] as Record<string, unknown[]>).hooks[0] as Record<
        string,
        string
      >
    ).command;
    expect(cmd).toBe("some-other-tool notify");
  });
});

// ---------------------------------------------------------------------------
// Integration: ensureHooksInstalled reconciles stale paths silently
// ---------------------------------------------------------------------------

import { ensureHooksInstalled } from "../src/hookInstaller.js";

// Minimal ExtensionContext stub
function makeContext(extensionPath: string) {
  return {
    extensionPath,
    globalState: {
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
    subscriptions: [],
  } as unknown as import("vscode").ExtensionContext;
}

describe("ensureHooksInstalled — path reconciliation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("silently rewrites stale paths and returns true without prompting the user", async () => {
    // Arrange: settings on disk have hooks pointing at OLD_PATH
    const oldSettings = makeSettingsWithHooks(OLD_SCRIPT_BASE_WIN);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify(oldSettings)
    );
    const writeMock = fs.writeFileSync as ReturnType<typeof vi.fn>;
    writeMock.mockImplementation(() => {});

    // VS Code would install the new version at NEW_PATH
    // On Windows getHookScriptPath builds: /c/PROGRA~1/nodejs/node.exe /<drive><rest>
    // We need the context to resolve to a path that produces NEW_SCRIPT_BASE_WIN.
    // The function hard-codes the node prefix, so we set extensionPath to a value
    // that will produce NEW_PATH after drive-letter conversion.
    // NEW_PATH = "/c/Users/chris/.vscode/extensions/conductor-0.2.0"
    // → Windows equivalent: C:\Users\chris\.vscode\extensions\conductor-0.2.0
    const winExtPath = "C:\\Users\\chris\\.vscode\\extensions\\conductor-0.2.0";
    const context = makeContext(winExtPath);

    const { window } = await import("../test/mocks/vscode.js");
    const showInfoSpy = vi.spyOn(window, "showInformationMessage");

    const result = await ensureHooksInstalled(context);

    expect(result).toBe(true);
    // writeFileSync should have been called (settings were rewritten)
    expect(writeMock).toHaveBeenCalled();
    // showInformationMessage must NOT have been called with the consent prompt
    const consentCallArgs = showInfoSpy.mock.calls.find((args) =>
      String(args[0]).includes("requires adding hooks")
    );
    expect(consentCallArgs).toBeUndefined();
    // But a subtle info message about the update must have been shown
    const updateCallArgs = showInfoSpy.mock.calls.find((args) =>
      String(args[0]).includes("updated for new extension version")
    );
    expect(updateCallArgs).toBeDefined();
  });

  it("does not write settings when paths are already up to date", async () => {
    // The NEW context path is the same as what's already in the settings
    const winExtPath = "C:\\Users\\chris\\.vscode\\extensions\\conductor-0.2.0";
    const currentSettings = makeSettingsWithHooks(NEW_SCRIPT_BASE_WIN);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify(currentSettings)
    );
    const writeMock = fs.writeFileSync as ReturnType<typeof vi.fn>;
    writeMock.mockImplementation(() => {});

    const context = makeContext(winExtPath);
    const result = await ensureHooksInstalled(context);

    expect(result).toBe(true);
    expect(writeMock).not.toHaveBeenCalled();
  });
});
