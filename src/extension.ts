import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
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
