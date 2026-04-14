import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { SessionManager } from "./sessionManager";
import { getAllFolders } from "./folderSource";

interface SessionPickItem extends vscode.QuickPickItem {
  folderPath: string;
  isActiveSession: boolean;
}

export async function showQuickPick(sessionManager: SessionManager): Promise<void> {
  const activeSessions = sessionManager.activeSessions;
  const folders = await getAllFolders();

  const activeSet = new Set(
    activeSessions.map((s) => s.folderPath.toLowerCase())
  );

  const items: SessionPickItem[] = [];

  for (const session of activeSessions) {
    items.push({
      label: `$(terminal) ${session.folderName}`,
      description: path.dirname(session.folderPath),
      detail: "$(pulse) Active session",
      folderPath: session.folderPath,
      isActiveSession: true,
    });
  }

  for (const folder of folders) {
    if (activeSet.has(folder.folderPath.toLowerCase())) {
      continue;
    }
    const sourceLabel = folder.source === "configured" ? "configured" : "recent";
    items.push({
      label: `$(folder) ${folder.name}`,
      description: folder.parentDir,
      detail: `$(history) ${sourceLabel}`,
      folderPath: folder.folderPath,
      isActiveSession: false,
    });
  }

  if (items.length === 0) {
    const choice = await vscode.window.showWarningMessage(
      "No recent folders found. Add a folder manually or open a folder in VS Code first.",
      "Add Folder",
      "Open Settings"
    );
    if (choice === "Add Folder") {
      vscode.commands.executeCommand("claudeSessions.addFolder");
    } else if (choice === "Open Settings") {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "claudeSessions"
      );
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `Claude Sessions (${activeSessions.length} active, ${items.length} total)`,
    placeHolder: "Search projects to launch or switch Claude sessions…",
    matchOnDescription: true,
  });

  if (!picked) {
    return;
  }

  if (picked.isActiveSession) {
    const session = sessionManager.findSessionByFolder(picked.folderPath);
    if (session) {
      sessionManager.focusSession(session);
    }
  } else {
    await sessionManager.launchSession(picked.folderPath);
  }
}

export async function addFolderPrompt(): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: "Add Folder to Claude Sessions",
    prompt: "Enter the absolute path to the folder (~ supported)",
    placeHolder: "C:\\Users\\you\\project  or  ~/project",
    validateInput: (value) => {
      const expanded = value.replace(/^~/, os.homedir());
      if (!value.trim()) {
        return "Path cannot be empty";
      }
      try {
        if (!fs.statSync(expanded).isDirectory()) {
          return `Not a directory: ${expanded}`;
        }
      } catch {
        return `Path does not exist: ${expanded}`;
      }
      return null;
    },
  });

  if (!input) {
    return;
  }

  const config = vscode.workspace.getConfiguration("claudeSessions");
  const current = config.get<string[]>("extraFolders", []);
  const expanded = input.replace(/^~/, os.homedir());

  if (current.some((f) => path.normalize(f).toLowerCase() === path.normalize(expanded).toLowerCase())) {
    vscode.window.showInformationMessage("Folder already in list.");
    return;
  }

  await config.update("extraFolders", [...current, expanded], vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Added: ${path.basename(expanded)}`);
}
