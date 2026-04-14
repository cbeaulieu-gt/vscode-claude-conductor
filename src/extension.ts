import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";

let sessionManager: SessionManager;

export function activate(context: vscode.ExtensionContext): void {
  sessionManager = new SessionManager();
  context.subscriptions.push(sessionManager);

  // Stub commands — wired to real implementations in subsequent tasks
  const stubs = [
    "claudeSessions.openSession",
    "claudeSessions.addFolder",
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
