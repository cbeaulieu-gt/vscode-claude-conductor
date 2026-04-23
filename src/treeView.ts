import * as vscode from "vscode";
import * as path from "path";
import { SessionManager, ActiveSession } from "./sessionManager";
import { getAllFolders, FolderEntry } from "./folderSource";

class ActiveSessionItem extends vscode.TreeItem {
  readonly session: ActiveSession;

  constructor(session: ActiveSession) {
    super(session.folderName, vscode.TreeItemCollapsibleState.None);
    this.session = session;
    this.description = path.dirname(session.folderPath);
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

class RecentProjectItem extends vscode.TreeItem {
  readonly folderPath: string;

  constructor(entry: FolderEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.folderPath = entry.folderPath;
    this.description = entry.parentDir;
    this.tooltip = `${entry.folderPath} (${entry.source})`;
    this.iconPath = new vscode.ThemeIcon("folder");
    this.contextValue = "recentProject";
    this.command = {
      command: "claudeConductor.openSession",
      title: "Launch Session",
      arguments: [entry.folderPath],
    };
  }
}

export class ActiveSessionsProvider implements vscode.TreeDataProvider<ActiveSessionItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onDidChangeSessions(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: ActiveSessionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ActiveSessionItem[] {
    return this.sessionManager.activeSessions.map((s) => new ActiveSessionItem(s));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}

export class RecentProjectsProvider implements vscode.TreeDataProvider<RecentProjectItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onDidChangeSessions(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: RecentProjectItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<RecentProjectItem[]> {
    const folders = await getAllFolders();
    const activeSet = new Set(
      this.sessionManager.activeSessions.map((s) => s.folderPath.toLowerCase())
    );

    return folders
      .filter((f) => !activeSet.has(f.folderPath.toLowerCase()))
      .map((f) => new RecentProjectItem(f));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}
