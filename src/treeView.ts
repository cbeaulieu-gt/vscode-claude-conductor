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

  constructor(group: ProjectGroup<ActiveSession>, state: { favorited: boolean }) {
    const label = path.basename(group.root);
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.group = group;

    const count = group.children.length + (group.top !== null ? 1 : 0);
    this.description = `(${count})`;
    this.iconPath = new vscode.ThemeIcon("folder");
    this.contextValue = state.favorited
      ? VIEW_ITEM.PROJECT_ROOT_FAVORITED
      : VIEW_ITEM.PROJECT_ROOT_UNFAVORITED;
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

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly favoritesStore: FavoritesStore
  ) {
    sessionManager.onDidChangeSessions(() => this._onDidChangeTreeData.fire());
    favoritesStore.onDidChange(() => this._onDidChangeTreeData.fire());
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
    return groups.map((g) => {
      const fav = this.favoritesStore.isFavorited(g.root);
      return new ActiveGroupItem(g, { favorited: fav });
    });
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

  constructor(
    group: ProjectGroup<FolderEntry>,
    state: { favorited: boolean; missing: boolean }
  ) {
    const label = path.basename(group.root);
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.group = group;

    const count = group.children.length + (group.top !== null ? 1 : 0);

    if (group.isPhantom) {
      // Phantom roots stay un-favoritable. No contextValue → no star menu.
      // (We don't conflate "not in recents" with "favorite missing on disk".)
      this.description = `(${count}) (not in recents)`;
      this.iconPath = new vscode.ThemeIcon(
        "folder",
        new vscode.ThemeColor("disabledForeground")
      );
    } else if (state.missing && state.favorited) {
      // Favorite whose root is missing on disk → projectRoot.missing
      this.description = `(${count}) (missing)`;
      this.iconPath = new vscode.ThemeIcon(
        "folder",
        new vscode.ThemeColor("disabledForeground")
      );
      this.contextValue = VIEW_ITEM.PROJECT_ROOT_MISSING;
    } else if (state.favorited) {
      this.description = `(${count})`;
      this.iconPath = new vscode.ThemeIcon("folder");
      this.contextValue = VIEW_ITEM.PROJECT_ROOT_FAVORITED;
    } else {
      this.description = `(${count})`;
      this.iconPath = new vscode.ThemeIcon("folder");
      this.contextValue = VIEW_ITEM.PROJECT_ROOT_UNFAVORITED;
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

  constructor(entry: FolderEntry, isWorktreeChild: boolean) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.folderPath = entry.folderPath;
    this.description = isWorktreeChild
      ? path.basename(entry.folderPath)
      : entry.parentDir;
    this.tooltip = `${entry.folderPath} (${entry.source})`;
    this.iconPath = new vscode.ThemeIcon("folder");
    this.contextValue = isWorktreeChild ? VIEW_ITEM.WORKTREE_CHILD : undefined;

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
        leaves.push(new RecentProjectItem(group.top, false));
      }
      for (const child of group.children) {
        leaves.push(new RecentProjectItem(child, true));
      }
      return leaves;
    }

    // Top level: fetch all folders, group them, return one group row per root.
    // Note: the dedup filter (exclude active-session paths) has been REMOVED
    // by design — the same folder may appear in both Active Sessions and Recent
    // Projects simultaneously.
    const folders = await getAllFolders();
    const groups = groupByProjectRoot(folders, (f) => f.folderPath);
    return groups.map((g) => {
      // For phantom groups, state is read but the constructor ignores it.
      const fav = !g.isPhantom && this.favoritesStore.isFavorited(g.root);
      const peek = this.existenceCache.peek(g.root);
      const missing = fav && peek.kind === "missing";
      return new RecentGroupItem(g, { favorited: fav, missing });
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }
}

// ---------------------------------------------------------------------------
// Favorites — tree items
// ---------------------------------------------------------------------------

/**
 * A single flat row in the Favorites panel.
 *
 * v1: favorites are rendered single-level (no nested worktree children).
 * Worktree children of favorited project roots appear in Recent Projects only.
 * Missing entries get a dimmed icon and a click-to-relocate command instead of
 * the normal open-session command, so the user cannot accidentally launch a
 * session for a path that no longer exists.
 */
class FavoriteLeafItem extends vscode.TreeItem {
  readonly folderPath: string;

  constructor(folderPath: string, state: { missing: boolean }) {
    super(path.basename(folderPath) || folderPath, vscode.TreeItemCollapsibleState.None);
    this.folderPath = folderPath;
    this.tooltip = state.missing
      ? "This folder is missing on disk. Click or press Enter to relocate; right-click for more options."
      : folderPath;

    if (state.missing) {
      this.contextValue = VIEW_ITEM.PROJECT_ROOT_MISSING;
      this.description = "(missing)";
      this.iconPath = new vscode.ThemeIcon(
        "folder",
        new vscode.ThemeColor("disabledForeground")
      );
      this.command = {
        command: "claudeConductor.locateFavorite",
        title: "Relocate Folder",
        arguments: [folderPath],
      };
    } else {
      this.contextValue = VIEW_ITEM.PROJECT_ROOT_FAVORITED;
      this.iconPath = new vscode.ThemeIcon("folder");
      this.command = {
        command: "claudeConductor.openSession",
        title: "Launch Session",
        arguments: [folderPath],
      };
    }
  }
}

type FavoriteTreeNode = FavoriteLeafItem;  // single-level for now

export class FavoritesProvider implements vscode.TreeDataProvider<FavoriteTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FavoriteTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: FavoritesStore,
    private readonly cache: PathExistenceCache
  ) {
    store.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
    cache.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  getTreeItem(el: FavoriteTreeNode): vscode.TreeItem { return el; }

  async getChildren(_element?: FavoriteTreeNode): Promise<FavoriteTreeNode[]> {
    // Single-level rendering: each favorite is a flat top-level row.
    // Worktree children of favorited project roots are NOT nested here in v1
    // (worktrees aren't stored in favorites). Recent Projects continues to
    // show the nested view.
    const entries = [...this.store.list()];

    entries.sort((a, b) => {
      const aName = path.basename(a.path).toLowerCase();
      const bName = path.basename(b.path).toLowerCase();
      if (aName !== bName) return aName.localeCompare(bName);
      return a.path.toLowerCase().localeCompare(b.path.toLowerCase());
    });

    return entries.map(e => {
      const peek = this.cache.peek(e.path);
      // Treat "unknown" as optimistic-present (e.g. UNC paths never get stat-checked).
      const missing = peek.kind === "missing";
      return new FavoriteLeafItem(e.path, { missing });
    });
  }

  /** Returns the over-cap banner string when storage drift exists; null otherwise. */
  getOverCapBanner(): string | null {
    if (!this.store.isOverCap()) return null;
    return `Favorites: ${this.store.list().length} entries (over the 25 cap — consider removing some).`;
  }
}
