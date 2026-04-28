import * as vscode from "vscode";
import { log } from "./output";

/** globalState key set after the onboarding toast has been considered. */
export const ONBOARDING_KEY = "claudeConductor.reattachOnboardingShown";

/** Marketplace ID of the official Anthropic Claude Code VS Code extension. */
const OFFICIAL_CLAUDE_EXT_ID = "Anthropic.claude-code";

/**
 * First-activation consent flow for the reattach feature (#43).
 *
 * If the user has the official Claude Code extension installed AND we have
 * not yet shown this onboarding toast, surface a one-time prompt asking
 * them to opt in or out of reattach. Their choice flips
 * `claudeConductor.relaunchOnStartup` accordingly.
 *
 * The flag is set regardless of outcome so the toast appears at most once.
 * If the user dismisses the toast without clicking, the setting stays at
 * its default (true).
 */
export async function runReattachOnboarding(
  globalState: vscode.Memento
): Promise<void> {
  const alreadyShown = globalState.get<boolean>(ONBOARDING_KEY, false);
  if (alreadyShown) {
    return;
  }

  const officialExt = vscode.extensions.getExtension(OFFICIAL_CLAUDE_EXT_ID);
  if (!officialExt) {
    // No collision risk — mark as shown and move on.
    try {
      await globalState.update(ONBOARDING_KEY, true);
    } catch (err) {
      log(`[onboarding] failed to set ONBOARDING_KEY: ${String(err)}`);
    }
    return;
  }

  // Surface the consent toast.
  const message =
    "Claude Conductor reattaches Claude sessions on VS Code restart by typing " +
    "`claude` into restored terminal tabs. We detected the official Claude " +
    "Code extension is also installed — Conductor may inject `claude` into " +
    "its sessions until issue #33 ships. Enable reattach for Conductor sessions?";
  const choice = await vscode.window.showInformationMessage(
    message,
    "Enable",
    "Disable"
  );

  if (choice === "Disable") {
    await vscode.workspace
      .getConfiguration("claudeConductor")
      .update("relaunchOnStartup", false, vscode.ConfigurationTarget.Global);
  }
  // "Enable" or dismiss → keep default (true), no setting update needed.

  try {
    await globalState.update(ONBOARDING_KEY, true);
  } catch (err) {
    log(`[onboarding] failed to set ONBOARDING_KEY: ${String(err)}`);
  }
}
