import * as vscode from "vscode";
import { SessionManager, ActiveSession } from "./sessionManager";
import { showQuickPick, addFolderPrompt } from "./quickPick";
import { ActiveSessionsProvider, RecentProjectsProvider } from "./treeView";
import { StatusBar } from "./statusBar";
import { ClaudeTerminalLinkProvider } from "./terminalLinks";
import { StateWatcher } from "./stateWatcher";
import { ensureHooksInstalled, setupHooksCommand, uninstallHooks } from "./hookInstaller";

let sessionManager: SessionManager;

/**
 * URI handler for cross-window session launch.
 * Handles: vscode://cbeaulieu-gt.claude-conductor/launch?folder=<encoded-path>
 *
 * When a URI is received, we open the folder as the workspace (if not already open)
 * and auto-launch a Claude session in an editor tab.
 */
const AUTO_LAUNCH_KEY = "claudeSessions.autoLaunchFolder";

class SessionUriHandler implements vscode.UriHandler {
  constructor(
    private readonly sm: SessionManager,
    private readonly globalState: vscode.Memento
  ) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    if (uri.path !== "/launch") {
      return;
    }

    const params = new URLSearchParams(uri.query);
    const folderPath = params.get("folder");
    if (!folderPath) {
      return;
    }

    const folderUri = vscode.Uri.file(folderPath);

    // Check if this folder is already the workspace — if not, open it
    const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!currentFolder || currentFolder.toLowerCase() !== folderPath.toLowerCase()) {
      // Save a flag so the extension auto-launches after VS Code reloads
      await this.globalState.update(AUTO_LAUNCH_KEY, folderPath);
      // Open folder in a new window
      await vscode.commands.executeCommand("vscode.openFolder", folderUri, true);
      return;
    }

    // Folder is already open — launch the session directly
    await this.sm.launchSession(folderPath);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  sessionManager = new SessionManager();
  context.subscriptions.push(sessionManager);

  // URI handler for cross-window launch
  context.subscriptions.push(
    vscode.window.registerUriHandler(
      new SessionUriHandler(sessionManager, context.globalState)
    )
  );

  // Check if we should auto-launch a session (set by URI handler before window reload)
  const autoLaunchFolder = context.globalState.get<string>(AUTO_LAUNCH_KEY);
  if (autoLaunchFolder) {
    context.globalState.update(AUTO_LAUNCH_KEY, undefined);
    sessionManager.launchSession(autoLaunchFolder);
  }

  // State watcher for idle notifications (via Claude Code hooks)
  const stateWatcher = new StateWatcher(sessionManager);
  context.subscriptions.push(stateWatcher);

  // Check/prompt for hook installation
  // Delayed slightly to avoid being buried by other startup notifications
  setTimeout(() => {
    ensureHooksInstalled(context);
  }, 3000);

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

    vscode.commands.registerCommand("claudeSessions.openInNewWindow", (session?: ActiveSession) => {
      const folderPath = session?.folderPath;
      if (!folderPath) {
        return;
      }
      const encodedPath = encodeURIComponent(folderPath);
      const uri = vscode.Uri.parse(
        `vscode://cbeaulieu-gt.claude-conductor/launch?folder=${encodedPath}`
      );
      vscode.env.openExternal(uri);
    }),

    vscode.commands.registerCommand("claudeSessions.setupHooks", () =>
      setupHooksCommand(context)
    ),

    vscode.commands.registerCommand("claudeSessions.removeHooks", () => {
      uninstallHooks();
      vscode.window.showInformationMessage("Claude session hooks removed.");
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

export function deactivate(): void {
  // Hooks are intentionally left in ~/.claude/settings.json on deactivate.
  // VS Code calls deactivate() on every window close, not just uninstall.
  // Use "Claude Sessions: Remove Notification Hooks" command to clean up manually.
}
