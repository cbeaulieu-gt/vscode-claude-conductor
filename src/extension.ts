import * as vscode from "vscode";
import { SessionManager, ActiveSession } from "./sessionManager";
import { showQuickPick, addFolderPrompt } from "./quickPick";
import { ActiveSessionsProvider, RecentProjectsProvider } from "./treeView";
import { StatusBar } from "./statusBar";
import { ClaudeTerminalLinkProvider } from "./terminalLinks";
import { StateWatcher } from "./stateWatcher";
import { ensureHooksInstalled, setupHooksCommand, uninstallHooks } from "./hookInstaller";
import { isSameWorkspaceFolder } from "./workspaceMatch";

let sessionManager: SessionManager;

/**
 * Normalizes the argument passed to a tree-view-triggered command.
 *
 * Row-click commands receive an `ActiveSession` (via `TreeItem.command.arguments`),
 * but inline action buttons and context-menu entries receive the `TreeItem` itself
 * (VS Code ignores `command.arguments` for those). The `ActiveSessionItem` tree item
 * exposes its `ActiveSession` at `.session`, so we unwrap if needed.
 *
 * Also tolerates direct `ActiveSession` arguments from programmatic callers.
 */
function resolveSession(arg: unknown): ActiveSession | undefined {
  if (!arg || typeof arg !== "object") {
    return undefined;
  }
  const obj = arg as Record<string, unknown>;
  // TreeItem case: has a nested .session property
  if ("session" in obj && obj.session && typeof obj.session === "object") {
    return obj.session as ActiveSession;
  }
  // ActiveSession case: has a .terminal property
  if ("terminal" in obj && "folderPath" in obj) {
    return obj as unknown as ActiveSession;
  }
  return undefined;
}

/**
 * URI handler for cross-window session launch.
 * Handles: vscode://cbeaulieu-gt.claude-conductor/launch?folder=<encoded-path>
 *
 * When a URI is received, we open the folder as the workspace (if not already open)
 * and auto-launch a Claude session in an editor tab.
 */
const AUTO_LAUNCH_KEY = "claudeConductor.autoLaunchFolder";

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
    if (!isSameWorkspaceFolder(currentFolder, folderPath)) {
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
  sessionManager = new SessionManager(context.workspaceState);
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
    vscode.window.registerTreeDataProvider("claudeConductor.activeSessions", activeProvider),
    vscode.window.registerTreeDataProvider("claudeConductor.recentProjects", recentProvider)
  );

  // Status bar
  context.subscriptions.push(new StatusBar(sessionManager));

  // Terminal link provider
  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider(new ClaudeTerminalLinkProvider())
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeConductor.openSession", async (folderPath?: string) => {
      if (typeof folderPath === "string") {
        await sessionManager.launchSession(folderPath);
      } else {
        await showQuickPick(sessionManager);
      }
    }),

    vscode.commands.registerCommand("claudeConductor.addFolder", () =>
      addFolderPrompt()
    ),

    vscode.commands.registerCommand("claudeConductor.focusSession", (arg?: unknown) => {
      const session = resolveSession(arg);
      if (session) {
        sessionManager.focusSession(session);
      }
    }),

    vscode.commands.registerCommand("claudeConductor.closeSession", (arg?: unknown) => {
      const session = resolveSession(arg);
      if (session) {
        sessionManager.closeSession(session);
      }
    }),

    vscode.commands.registerCommand("claudeConductor.openInNewWindow", (arg?: unknown) => {
      const session = resolveSession(arg);
      const folderPath = session?.folderPath;
      if (!folderPath || !session) {
        return;
      }

      // If the target folder is already the current workspace, opening a new
      // URI would round-trip back to this window and do nothing visible.
      // Instead, show a dismissible info toast and focus the session tab.
      const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (isSameWorkspaceFolder(currentFolder, folderPath)) {
        void vscode.window.showInformationMessage(
          "You're already in this project's window — focused the session instead."
        );
        sessionManager.focusSession(session);
        return;
      }

      const encodedPath = encodeURIComponent(folderPath);
      const uri = vscode.Uri.parse(
        `vscode://cbeaulieu-gt.claude-conductor/launch?folder=${encodedPath}`
      );
      vscode.env.openExternal(uri);
    }),

    vscode.commands.registerCommand("claudeConductor.setupHooks", () =>
      setupHooksCommand(context)
    ),

    vscode.commands.registerCommand("claudeConductor.removeHooks", () => {
      uninstallHooks();
      vscode.window.showInformationMessage("Claude session hooks removed.");
    }),

    vscode.commands.registerCommand("claudeConductor.refreshTreeView", () => {
      activeProvider.refresh();
      recentProvider.refresh();
    }),

    vscode.commands.registerCommand("claudeConductor.nextSession", () => {
      cycleSession(sessionManager, 1);
    }),

    vscode.commands.registerCommand("claudeConductor.prevSession", () => {
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
  // Use "Claude Conductor: Remove Notification Hooks" command to clean up manually.
}
