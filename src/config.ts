import * as vscode from "vscode";
import * as os from "os";

const SECTION = "claudeSessions";

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
