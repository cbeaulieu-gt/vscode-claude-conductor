import * as vscode from "vscode";
import * as path from "path";
import { SessionManager, ActiveSession } from "./sessionManager";
import { getAllFolders, FolderEntry } from "./folderSource";
import { groupByProjectRoot, ProjectGroup } from "./projectGrouping";
import { FavoritesStore } from "./favoritesStore";
import { PathExistenceCache } from "./pathExistenceCache";

// ---------------------------------------------------------------------------
// Shared contextValue tokens
// ---------------------------------------------------------------------------

export const VIEW_ITEM = {
  PROJECT_ROOT_FAVORITED:   "projectRoot.favorited",
  PROJECT_ROOT_UNFAVORITED: "projectRoot.unfavorited",
  PROJECT_ROOT_MISSING:     "projectRoot.missing",
  WORKTREE_CHILD:           "worktreeChild",
  ACTIVE_SESSION:           "activeSession",
} as const;

// ---------------------------------------------------------------------------
// Active Sessions — tree items
// ---------------------------------------------------------------------------

/**
 * A group row in the Active Sessions panel.
 * Collapsed by default; description shows the child count for this panel.
 */
class ActiveGroupItem extends vscode.TreeItem {
  readonly group: ProjectGroup<ActiveSession>;

  constructor(group: ProjectGroup<ActiveSession>) {
    const label = path.basename(group.root);
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.group = group;

    const count = group.children.length + (group.top !== null ? 1 : 0);
    this.description = `(${count})`;
    // Folder icon — no command so click only expands/collapses.
    this.iconPath = new vscode.ThemeIcon("folder");
    this.tooltip = group.root;
  }
}

/**
 * A leaf row for one active session, shown under its group.
 * When the session is a worktree child, description shows the branch name
 * (the parent context is already given by the group row).
 */
class ActiveSessionItem extends vscode.TreeItem {
  readonly session: ActiveSession;

  constructor(session: ActiveSession, isWorktreeChild: boolean) {
    super(session.folderName, vscode.TreeItemCollapsibleState.None);
    this.session = session;
    // Worktree children: show the branch segment (basename of worktree path)
    // as the description — the parent is already implied by the group row.
    // Top-level items (non-worktree): keep the original parent directory.
    this.description = isWorktreeChild
      ? path.basename(session.folderPath)
      : path.dirname(session.folderPath);
    this.tooltip = `${session.folderPath}\nStarted: ${session.startedAt.toLocaleTimeString()}`;
    this.iconPath = session.isIdle
      ? new vscode.ThemeIcon("bell", new vscode.ThemeColor("editorWarning.foreground"))
      : new vscode.ThemeIcon("terminal", new vscode.ThemeColor("testing.iconPassed"));
    this.contextValue = "activeSession";
    this.command = {
      command: "claudeConductor.focusSession",
      title: "Focus Session",
      arguments: [session],
    };
  }
}

type ActiveTreeNode = ActiveGroupItem | ActiveSessionItem;

export class ActiveSessionsProvider
  implements vscode.TreeDataProvider<ActiveTreeNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onDidChangeSessions(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: ActiveTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ActiveTreeNode): ActiveTreeNode[] {
    if (element instanceof ActiveGroupItem) {
      // Return the leaves for this group.
      const { group } = element;
      const leaves: ActiveSessionItem[] = [];
      if (group.top !== null) {
        // The root itself is a non-worktree item — description shows parent dir.
        leaves.push(new ActiveSessionItem(group.top, false));
      }
      for (const child of group.children) {
        // Worktree children — description shows branch name.
        leaves.push(new ActiveSessionItem(child, true));
      }
      return leaves;
    }

    // Top level: return one group row per project root.
    const sessions = this.sessionManager.activeSessions;
    const groups = groupByProjectRoot(sessions, (s) => s.folderPath);
    return groups.map((g) => new ActiveGroupItem(g));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}

// ---------------------------------------------------------------------------
// Recent Projects — tree items
// ---------------------------------------------------------------------------

/**
 * A group row in the Recent Projects panel.
 * Phantom groups (root not present in recents) get a dimmed icon and a
 * "(not in recents)" suffix so they are visually distinguishable.
 *
 * Icon choice: "folder" with `disabledForeground` ThemeColor.
 * This is the most recognisable "muted folder" available as a codicon + color
 * pair that does not require an extra icon registration.
 */
class RecentGroupItem extends vscode.TreeItem {
  readonly group: ProjectGroup<FolderEntry>;

  constructor(group: ProjectGroup<FolderEntry>) {
    const label = path.basename(group.root);
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.group = group;

    const count = group.children.length + (group.top !== null ? 1 : 0);

    if (group.isPhantom) {
      this.description = `(${count}) (not in recents)`;
      // Dimmed folder icon — signals that the root itself is not in Recent Projects.
      this.iconPath = new vscode.ThemeIcon(
        "folder",
        new vscode.ThemeColor("disabledForeground")
      );
    } else {
      this.description = `(${count})`;
      this.iconPath = new vscode.ThemeIcon("folder");
    }

    this.tooltip = group.root;
  }
}

/**
 * A leaf row for one recent-project folder, shown under its group.
 * Worktree children: description is the branch name (parent implied by group).
 * Non-worktree top items: description is the parent directory.
 */
class RecentProjectItem extends vscode.TreeItem {
  readonly folderPath: string;

  constructor(
    entry: FolderEntry,
    isWorktreeChild: boolean,
    state: { favorited: boolean; missing: boolean }
  ) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.folderPath = entry.folderPath;
    this.description = isWorktreeChild
      ? path.basename(entry.folderPath)
      : entry.parentDir;
    this.tooltip = `${entry.folderPath} (${entry.source})`;
    this.iconPath = new vscode.ThemeIcon("folder");

    if (isWorktreeChild) {
      this.contextValue = VIEW_ITEM.WORKTREE_CHILD;
    } else if (state.missing) {
      this.contextValue = VIEW_ITEM.PROJECT_ROOT_MISSING;
      this.description = "(missing)";
      this.iconPath = new vscode.ThemeIcon(
        "folder",
        new vscode.ThemeColor("disabledForeground")
      );
    } else if (state.favorited) {
      this.contextValue = VIEW_ITEM.PROJECT_ROOT_FAVORITED;
    } else {
      this.contextValue = VIEW_ITEM.PROJECT_ROOT_UNFAVORITED;
    }

    this.command = {
      command: "claudeConductor.openSession",
      title: "Launch Session",
      arguments: [entry.folderPath],
    };
  }
}

type RecentTreeNode = RecentGroupItem | RecentProjectItem;

export class RecentProjectsProvider
  implements vscode.TreeDataProvider<RecentTreeNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RecentTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly favoritesStore: FavoritesStore,
    private readonly existenceCache: PathExistenceCache
  ) {
    sessionManager.onDidChangeSessions(() => this._onDidChangeTreeData.fire(undefined));
    favoritesStore.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
    existenceCache.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  getTreeItem(element: RecentTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RecentTreeNode): Promise<RecentTreeNode[]> {
    if (element instanceof RecentGroupItem) {
      const { group } = element;
      const leaves: RecentProjectItem[] = [];
      if (group.top !== null) {
        const fav = this.favoritesStore.isFavorited(group.top.folderPath);
        const peek = this.existenceCache.peek(group.top.folderPath);
        const missing = fav && peek.kind === "missing";  // only flag favorited rows as missing
        leaves.push(new RecentProjectItem(group.top, false, { favorited: fav, missing }));
      }
      for (const child of group.children) {
        leaves.push(new RecentProjectItem(child, true, { favorited: false, missing: false }));
      }
      return leaves;
    }

    // Top level: fetch all folders, group them, return one group row per root.
    // Note: the dedup filter (exclude active-session paths) has been REMOVED
    // by design — the same folder may appear in both Active Sessions and Recent
    // Projects simultaneously.
    const folders = await getAllFolders();
    const groups = groupByProjectRoot(folders, (f) => f.folderPath);
    return groups.map((g) => new RecentGroupItem(g));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }
}
