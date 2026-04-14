import * as vscode from "vscode";
import { SessionManager, ActiveSession } from "./sessionManager";
import { showQuickPick, addFolderPrompt } from "./quickPick";
import { ActiveSessionsProvider, RecentProjectsProvider } from "./treeView";
import { StatusBar } from "./statusBar";
import { ClaudeTerminalLinkProvider } from "./terminalLinks";

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

  // Status bar
  context.subscriptions.push(new StatusBar(sessionManager));

  // Terminal link provider
  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider(new ClaudeTerminalLinkProvider())
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
    }),

    vscode.commands.registerCommand("claudeSessions.nextSession", () => {
      cycleSession(sessionManager, 1);
    }),

    vscode.commands.registerCommand("claudeSessions.prevSession", () => {
      cycleSession(sessionManager, -1);
    }),
  );
}

/**
 * Cycle through active Claude sessions by the given direction (+1 forward, -1 back).
 * Wraps around at the ends of the list.
 */
function cycleSession(sm: SessionManager, direction: 1 | -1): void {
  const sessions = sm.activeSessions;
  if (sessions.length === 0) {
    vscode.window.showInformationMessage("No active Claude sessions");
    return;
  }

  // Find which session is currently focused (if any)
  const activeTerminal = vscode.window.activeTerminal;
  let currentIndex = -1;
  if (activeTerminal) {
    currentIndex = sessions.findIndex((s) => s.terminal === activeTerminal);
  }

  // If no Claude session is focused, go to the first one
  const nextIndex =
    currentIndex === -1
      ? 0
      : (currentIndex + direction + sessions.length) % sessions.length;

  sm.focusSession(sessions[nextIndex]);
}

export function deactivate(): void {}
