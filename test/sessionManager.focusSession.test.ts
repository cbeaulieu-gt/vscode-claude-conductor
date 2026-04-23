import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "../src/sessionManager";
import type { ActiveSession } from "../src/sessionManager";

describe("SessionManager.focusSession", () => {
  it("calls terminal.show(false) so focus is transferred to the terminal", () => {
    // Regression for PR #35: focusSession must pass preserveFocus=false so
    // keyboard focus actually moves to the terminal tab, not just reveal it.
    const show = vi.fn();

    const session: ActiveSession = {
      terminal: {
        name: "claude · test-project",
        show,
        sendText: vi.fn(),
        dispose: vi.fn(),
        processId: Promise.resolve(undefined),
        shellIntegration: undefined,
        creationOptions: { cwd: "/tmp/test-project" },
      } as unknown as import("vscode").Terminal,
      folderPath: "/tmp/test-project",
      folderName: "test-project",
      startedAt: new Date(),
      isIdle: false,
    };

    const manager = new SessionManager();
    manager.focusSession(session);

    expect(show).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith(false);

    manager.dispose();
  });
});
