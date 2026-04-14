import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { showQuickPick, addFolderPrompt } from "./quickPick";

let sessionManager: SessionManager;

export function activate(context: vscode.ExtensionContext): void {
  sessionManager = new SessionManager();
  context.subscriptions.push(sessionManager);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.openSession", () =>
      showQuickPick(sessionManager)
    ),
    vscode.commands.registerCommand("claudeSessions.addFolder", () =>
      addFolderPrompt()
    )
  );

  // Remaining stubs — wired in subsequent tasks
  const stubs = [
    "claudeSessions.nextSession",
    "claudeSessions.prevSession",
    "claudeSessions.focusSession",
    "claudeSessions.closeSession",
    "claudeSessions.refreshTreeView",
  ];

  for (const id of stubs) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        vscode.window.showInformationMessage(`${id} not yet implemented`);
      })
    );
  }
}

export function deactivate(): void {}
