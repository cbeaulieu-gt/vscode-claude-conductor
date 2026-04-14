import * as vscode from "vscode";
import { SessionManager, ActiveSession } from "./sessionManager";
import { showQuickPick, addFolderPrompt } from "./quickPick";
import { ActiveSessionsProvider, RecentProjectsProvider } from "./treeView";

let sessionManager: SessionManager;

export function activate(context: vscode.ExtensionContext): void {
  sessionManager = new SessionManager();
  context.subscriptions.push(sessionManager);

  // Tree view providers
  const activeProvider = new ActiveSessionsProvider(sessionManager);
  const recentProvider = new RecentProjectsProvider(sessionManager);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("claudeSessions.activeSessions", activeProvider),
    vscode.window.registerTreeDataProvider("claudeSessions.recentProjects", recentProvider)
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.openSession", async (folderPath?: string) => {
      if (typeof folderPath === "string") {
        await sessionManager.launchSession(folderPath);
      } else {
        await showQuickPick(sessionManager);
      }
    }),

    vscode.commands.registerCommand("claudeSessions.addFolder", () =>
      addFolderPrompt()
    ),

    vscode.commands.registerCommand("claudeSessions.focusSession", (session?: ActiveSession) => {
      if (session) {
        sessionManager.focusSession(session);
      }
    }),

    vscode.commands.registerCommand("claudeSessions.closeSession", (session?: ActiveSession) => {
      if (session) {
        sessionManager.closeSession(session);
      }
    }),

    vscode.commands.registerCommand("claudeSessions.refreshTreeView", () => {
      activeProvider.refresh();
      recentProvider.refresh();
    })
  );

  // Remaining stubs — wired in subsequent tasks
  const stubs = [
    "claudeSessions.nextSession",
    "claudeSessions.prevSession",
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
