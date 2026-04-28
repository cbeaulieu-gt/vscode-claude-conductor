import * as vscode from "vscode";
import * as os from "os";

const SECTION = "claudeConductor";

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function getClaudeCommand(): string {
  return getConfig().get<string>("claudeCommand", "claude");
}

export function getReuseTerminal(): boolean {
  return getConfig().get<boolean>("reuseExistingTerminal", true);
}

export function getEnableNotifications(): boolean {
  return getConfig().get<boolean>("enableNotifications", true);
}

export function getExtraFolders(): string[] {
  return getConfig()
    .get<string[]>("extraFolders", [])
    .map((f) => f.replace(/^~/, os.homedir()));
}

export function getLaunchDelayMs(): number {
  const raw = getConfig().get<number>("launchDelayMs", 500);
  return Math.max(0, raw);
}

export function getDebugLogging(): boolean {
  return getConfig().get<boolean>("debugLogging", false);
}

export function getRelaunchOnStartup(): boolean {
  return getConfig().get<boolean>("relaunchOnStartup", true);
}
