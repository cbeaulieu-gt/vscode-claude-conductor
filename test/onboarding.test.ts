/**
 * Tests for the day-1 collision proactive-detection flow (#43, scenarios 16–18).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscodeMock from "./mocks/vscode";
import { createMemento, MementoMock } from "./mocks/vscode";
import { runReattachOnboarding, ONBOARDING_KEY } from "../src/onboarding";

describe("reattach onboarding (#43)", () => {
  let globalState: MementoMock;
  let configUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vscodeMock.window.showInformationMessage.mockClear();
    globalState = createMemento();
    configUpdate = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(vscodeMock.workspace, "getConfiguration").mockReturnValue({
      get: vi.fn(),
      update: configUpdate,
    } as unknown as import("vscode").WorkspaceConfiguration);
  });

  // Scenario 16: official extension installed + Disable click
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

  // Scenario 16 — Enable variant
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

  // Scenario 17: no official extension → no toast, flag still set
  it("no official extension → no toast, flag still set", async () => {
    vi.mocked(vscodeMock.extensions.getExtension).mockReturnValue(undefined);

    await runReattachOnboarding(globalState as unknown as import("vscode").Memento);

    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    expect(configUpdate).not.toHaveBeenCalled();
    expect(globalState._store.get(ONBOARDING_KEY)).toBe(true);
  });

  // Scenario 18: already shown → no toast, no flag write
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
