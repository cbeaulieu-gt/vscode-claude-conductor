# Claude Session Manager v1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VS Code extension that manages multiple Claude Code CLI sessions as editor tabs with a sidebar tree view, quick-pick launcher, status bar indicator, terminal link provider, and keyboard navigation.

**Architecture:** The extension has a central `SessionManager` that owns terminal lifecycle and emits events. All UI components (tree view, quick-pick, status bar) subscribe to those events. `FolderSource` fetches folder lists from VS Code recents + config. Each Claude session is a terminal promoted to an editor tab.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode` module), no external dependencies.

---

### Task 1: Project Scaffolding (closes #1)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.vscodeignore`
- Create: `src/config.ts`
- Create: `src/extension.ts`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
node_modules/
out/
*.vsix
.worktrees/
```

- [ ] **Step 2: Create `.vscodeignore`**

```
.vscode/**
src/**
node_modules/**
tsconfig.json
.gitignore
docs/**
.claude/**
.worktrees/**
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2020",
    "lib": ["ES2020"],
    "outDir": "out",
    "rootDir": "src",
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "out"]
}
```

- [ ] **Step 4: Create `package.json`**

This is the complete manifest with all commands, views, configuration, and keybindings for the full v1.0 scope. We register everything upfront so the activity bar icon and commands exist from the start — implementations get wired in as we build each component.

```json
{
  "name": "vscode-claude-sessions",
  "displayName": "Claude Session Manager",
  "description": "Manage multiple Claude Code sessions across projects as editor tabs",
  "version": "1.0.0",
  "publisher": "cbeaulieu-gt",
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "claudeSessions.openSession",
        "title": "Claude Sessions: Launch Session",
        "icon": "$(play)"
      },
      {
        "command": "claudeSessions.addFolder",
        "title": "Claude Sessions: Add Folder",
        "icon": "$(add)"
      },
      {
        "command": "claudeSessions.nextSession",
        "title": "Claude Sessions: Next Session"
      },
      {
        "command": "claudeSessions.prevSession",
        "title": "Claude Sessions: Previous Session"
      },
      {
        "command": "claudeSessions.focusSession",
        "title": "Focus Session"
      },
      {
        "command": "claudeSessions.closeSession",
        "title": "Close Session",
        "icon": "$(close)"
      },
      {
        "command": "claudeSessions.refreshTreeView",
        "title": "Refresh",
        "icon": "$(refresh)"
      }
    ],
    "viewsContainers": {
      "activitybar": [
        {
          "id": "claudeSessions",
          "title": "Claude Sessions",
          "icon": "$(sparkle)"
        }
      ]
    },
    "views": {
      "claudeSessions": [
        {
          "id": "claudeSessions.activeSessions",
          "name": "Active Sessions"
        },
        {
          "id": "claudeSessions.recentProjects",
          "name": "Recent Projects"
        }
      ]
    },
    "menus": {
      "view/title": [
        {
          "command": "claudeSessions.openSession",
          "when": "view == claudeSessions.recentProjects",
          "group": "navigation"
        },
        {
          "command": "claudeSessions.addFolder",
          "when": "view == claudeSessions.recentProjects",
          "group": "navigation"
        },
        {
          "command": "claudeSessions.refreshTreeView",
          "when": "view == claudeSessions.activeSessions || view == claudeSessions.recentProjects",
          "group": "navigation"
        }
      ],
      "view/item/context": [
        {
          "command": "claudeSessions.focusSession",
          "when": "viewItem == activeSession",
          "group": "inline"
        },
        {
          "command": "claudeSessions.closeSession",
          "when": "viewItem == activeSession",
          "group": "inline"
        },
        {
          "command": "claudeSessions.openSession",
          "when": "viewItem == recentProject",
          "group": "inline"
        }
      ]
    },
    "configuration": {
      "title": "Claude Sessions",
      "properties": {
        "claudeSessions.claudeCommand": {
          "type": "string",
          "default": "claude",
          "description": "The Claude Code CLI command to run"
        },
        "claudeSessions.reuseExistingTerminal": {
          "type": "boolean",
          "default": true,
          "description": "Focus existing session tab instead of opening a duplicate"
        },
        "claudeSessions.extraFolders": {
          "type": "array",
          "items": { "type": "string" },
          "default": [],
          "description": "Additional folder paths to show in the session launcher"
        }
      }
    },
    "keybindings": [
      {
        "command": "claudeSessions.openSession",
        "key": "ctrl+shift+alt+c",
        "mac": "cmd+shift+alt+c"
      },
      {
        "command": "claudeSessions.nextSession",
        "key": "ctrl+alt+]",
        "mac": "cmd+alt+]"
      },
      {
        "command": "claudeSessions.prevSession",
        "key": "ctrl+alt+[",
        "mac": "cmd+alt+["
      }
    ]
  },
  "scripts": {
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "package": "npm run compile && vsce package --no-dependencies",
    "lint": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/vscode": "^1.85.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.3.0",
    "@vscode/vsce": "^2.24.0"
  }
}
```

- [ ] **Step 5: Create `src/config.ts`**

```typescript
import * as vscode from "vscode";
import * as os from "os";

const SECTION = "claudeSessions";

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function getClaudeCommand(): string {
  return getConfig().get<string>("claudeCommand", "claude");
}

export function getReuseTerminal(): boolean {
  return getConfig().get<boolean>("reuseExistingTerminal", true);
}

export function getExtraFolders(): string[] {
  return getConfig()
    .get<string[]>("extraFolders", [])
    .map((f) => f.replace(/^~/, os.homedir()));
}
```

- [ ] **Step 6: Create `src/extension.ts` with stub commands**

```typescript
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
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
```

- [ ] **Step 7: Install dependencies and verify compilation**

Run: `npm install`
Run: `npm run compile`
Expected: compiles with no errors, `out/` directory created with `.js` files

- [ ] **Step 8: Commit**

```bash
git add .gitignore .vscodeignore tsconfig.json package.json package-lock.json src/config.ts src/extension.ts
git commit -m "feat: project scaffolding with package.json, tsconfig, config, and stub commands

closes #1"
```

---

### Task 2: Folder Source (closes #2)

**Files:**
- Create: `src/folderSource.ts`

- [ ] **Step 1: Create `src/folderSource.ts`**

This module fetches folders from two sources: VS Code's internal recent folders list and the user's `extraFolders` config. The `_workbench.getRecentlyOpened()` command returns an object with `workspaces` and `files` arrays. Workspace entries can be either folder URIs or workspace config files — we only want the folder URIs.

```typescript
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getExtraFolders } from "./config";

export interface FolderEntry {
  /** Resolved absolute path on disk */
  folderPath: string;
  /** Display name (basename) */
  name: string;
  /** Parent directory for display */
  parentDir: string;
  /** Where this entry came from */
  source: "recent" | "configured";
}

/**
 * Shape returned by the internal _workbench.getRecentlyOpened command.
 * This is undocumented but stable — used by many extensions.
 */
interface RecentlyOpened {
  workspaces: Array<{
    folderUri?: vscode.Uri;
    configPath?: vscode.Uri;
  }>;
}

/**
 * Fetch VS Code's recently opened folders via internal command.
 * Returns resolved folder paths in recency order.
 */
async function getRecentFolders(): Promise<string[]> {
  try {
    const recent = await vscode.commands.executeCommand<RecentlyOpened>(
      "_workbench.getRecentlyOpened"
    );
    if (!recent?.workspaces) {
      return [];
    }
    return recent.workspaces
      .filter((w): w is { folderUri: vscode.Uri } => w.folderUri !== undefined)
      .map((w) => w.folderUri.fsPath);
  } catch {
    return [];
  }
}

/**
 * Get all folders from both sources, deduplicated.
 * Recent folders first (in recency order), then extra folders.
 */
export async function getAllFolders(): Promise<FolderEntry[]> {
  const recentPaths = await getRecentFolders();
  const extraPaths = getExtraFolders();

  const seen = new Set<string>();
  const entries: FolderEntry[] = [];

  const addEntry = (folderPath: string, source: "recent" | "configured"): void => {
    const normalized = path.normalize(folderPath);
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    // Only include folders that exist on disk
    try {
      if (!fs.statSync(normalized).isDirectory()) {
        return;
      }
    } catch {
      return;
    }

    entries.push({
      folderPath: normalized,
      name: path.basename(normalized),
      parentDir: path.dirname(normalized),
      source,
    });
  };

  for (const p of recentPaths) {
    addEntry(p, "recent");
  }
  for (const p of extraPaths) {
    addEntry(p, "configured");
  }

  return entries;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npm run compile`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src/folderSource.ts
git commit -m "feat: folder source from VS Code recents + extraFolders config

Replaces broken ~/.claude/projects decoder with reliable VS Code
recent folders API. Deduplicates and validates paths on disk.

closes #2"
```

---

### Task 3: Session Manager (closes #3)

**Files:**
- Create: `src/sessionManager.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Create `src/sessionManager.ts`**

This is the core module. It tracks active Claude terminals, provides launch/focus/close operations, and emits events for UI components to react to.

```typescript
import * as vscode from "vscode";
import * as path from "path";
import { getClaudeCommand, getReuseTerminal } from "./config";

/** Prefix used for all Claude session terminal names */
export const SESSION_NAME_PREFIX = "claude · ";

export interface ActiveSession {
  terminal: vscode.Terminal;
  folderPath: string;
  folderName: string;
  startedAt: Date;
}

export class SessionManager implements vscode.Disposable {
  private readonly _sessions = new Map<vscode.Terminal, ActiveSession>();
  private readonly _disposables: vscode.Disposable[] = [];

  private readonly _onDidChangeSessions = new vscode.EventEmitter<void>();
  /** Fires whenever the active session list changes (open or close). */
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  constructor() {
    // Pick up any Claude terminals that already exist (e.g., extension reloaded)
    for (const terminal of vscode.window.terminals) {
      this._trackIfClaudeSession(terminal);
    }

    this._disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        this._trackIfClaudeSession(terminal);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        if (this._sessions.delete(terminal)) {
          this._onDidChangeSessions.fire();
        }
      }),
      this._onDidChangeSessions
    );
  }

  /** All currently active Claude sessions. */
  get activeSessions(): ActiveSession[] {
    return Array.from(this._sessions.values());
  }

  /** Number of active sessions. */
  get count(): number {
    return this._sessions.size;
  }

  /**
   * Launch a new Claude session in the given folder, or focus an existing one
   * if reuseExistingTerminal is enabled.
   */
  async launchSession(folderPath: string): Promise<void> {
    const normalized = path.normalize(folderPath);

    if (getReuseTerminal()) {
      const existing = this._findSessionByFolder(normalized);
      if (existing) {
        this.focusSession(existing);
        return;
      }
    }

    const folderName = path.basename(normalized);
    const terminal = vscode.window.createTerminal({
      name: `${SESSION_NAME_PREFIX}${folderName}`,
      cwd: normalized,
      iconPath: new vscode.ThemeIcon("sparkle"),
      color: new vscode.ThemeColor("terminal.ansiGreen"),
    });

    // Show the terminal first (required before moving to editor)
    terminal.show(true);

    // Move terminal from panel to editor tab area
    await vscode.commands.executeCommand("workbench.action.terminal.moveToEditor");

    // Send the claude command
    terminal.sendText(getClaudeCommand());
  }

  /** Focus an existing session's editor tab. */
  focusSession(session: ActiveSession): void {
    session.terminal.show(true);
  }

  /** Close a session's terminal. */
  closeSession(session: ActiveSession): void {
    session.terminal.dispose();
    // onDidCloseTerminal listener handles cleanup and event firing
  }

  /** Find a session by its folder path (case-insensitive). */
  findSessionByFolder(folderPath: string): ActiveSession | undefined {
    return this._findSessionByFolder(path.normalize(folderPath));
  }

  /** Check if a terminal is a Claude session by name pattern. */
  private _isClaudeSession(terminal: vscode.Terminal): boolean {
    return terminal.name.startsWith(SESSION_NAME_PREFIX);
  }

  /** Extract folder path from a Claude session terminal. */
  private _extractFolderPath(terminal: vscode.Terminal): string | undefined {
    const opts = terminal.creationOptions as vscode.TerminalOptions;
    if (opts.cwd) {
      return typeof opts.cwd === "string" ? opts.cwd : opts.cwd.fsPath;
    }
    return undefined;
  }

  /** Track a terminal if it's a Claude session. */
  private _trackIfClaudeSession(terminal: vscode.Terminal): void {
    if (!this._isClaudeSession(terminal)) {
      return;
    }
    const folderPath = this._extractFolderPath(terminal);
    if (!folderPath) {
      return;
    }

    this._sessions.set(terminal, {
      terminal,
      folderPath: path.normalize(folderPath),
      folderName: path.basename(folderPath),
      startedAt: new Date(),
    });
    this._onDidChangeSessions.fire();
  }

  /** Find session by normalized folder path. */
  private _findSessionByFolder(normalizedPath: string): ActiveSession | undefined {
    const key = normalizedPath.toLowerCase();
    for (const session of this._sessions.values()) {
      if (session.folderPath.toLowerCase() === key) {
        return session;
      }
    }
    return undefined;
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose();
    }
    this._sessions.clear();
  }
}
```

- [ ] **Step 2: Wire session manager into `extension.ts`**

Replace the full contents of `src/extension.ts`:

```typescript
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
```

- [ ] **Step 3: Verify compilation**

Run: `npm run compile`
Expected: compiles with no errors

- [ ] **Step 4: Commit**

```bash
git add src/sessionManager.ts src/extension.ts
git commit -m "feat: session manager with terminal lifecycle, editor-tab promotion, event emitter

Tracks Claude terminals by name pattern, provides launch/focus/close,
promotes terminals to editor tabs, emits change events for UI consumers.

closes #3"
```

---

### Task 4: Quick-Pick Launcher (closes #4)

**Files:**
- Create: `src/quickPick.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Create `src/quickPick.ts`**

```typescript
import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { SessionManager } from "./sessionManager";
import { getAllFolders } from "./folderSource";

interface SessionPickItem extends vscode.QuickPickItem {
  folderPath: string;
  isActiveSession: boolean;
}

export async function showQuickPick(sessionManager: SessionManager): Promise<void> {
  const activeSessions = sessionManager.activeSessions;
  const folders = await getAllFolders();

  // Build set of active session folder paths for deduplication
  const activeSet = new Set(
    activeSessions.map((s) => s.folderPath.toLowerCase())
  );

  const items: SessionPickItem[] = [];

  // Active sessions first
  for (const session of activeSessions) {
    items.push({
      label: `$(terminal) ${session.folderName}`,
      description: path.dirname(session.folderPath),
      detail: "$(pulse) Active session",
      folderPath: session.folderPath,
      isActiveSession: true,
    });
  }

  // Then recent/configured folders (excluding those with active sessions)
  for (const folder of folders) {
    if (activeSet.has(folder.folderPath.toLowerCase())) {
      continue;
    }
    const sourceLabel = folder.source === "configured" ? "configured" : "recent";
    items.push({
      label: `$(folder) ${folder.name}`,
      description: folder.parentDir,
      detail: `$(history) ${sourceLabel}`,
      folderPath: folder.folderPath,
      isActiveSession: false,
    });
  }

  if (items.length === 0) {
    const choice = await vscode.window.showWarningMessage(
      "No recent folders found. Add a folder manually or open a folder in VS Code first.",
      "Add Folder",
      "Open Settings"
    );
    if (choice === "Add Folder") {
      vscode.commands.executeCommand("claudeSessions.addFolder");
    } else if (choice === "Open Settings") {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "claudeSessions"
      );
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `Claude Sessions (${activeSessions.length} active, ${items.length} total)`,
    placeHolder: "Search projects to launch or switch Claude sessions…",
    matchOnDescription: true,
  });

  if (!picked) {
    return;
  }

  if (picked.isActiveSession) {
    const session = sessionManager.findSessionByFolder(picked.folderPath);
    if (session) {
      sessionManager.focusSession(session);
    }
  } else {
    await sessionManager.launchSession(picked.folderPath);
  }
}

export async function addFolderPrompt(): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: "Add Folder to Claude Sessions",
    prompt: "Enter the absolute path to the folder (~ supported)",
    placeHolder: "C:\\Users\\you\\project  or  ~/project",
    validateInput: (value) => {
      const expanded = value.replace(/^~/, os.homedir());
      if (!value.trim()) {
        return "Path cannot be empty";
      }
      try {
        if (!fs.statSync(expanded).isDirectory()) {
          return `Not a directory: ${expanded}`;
        }
      } catch {
        return `Path does not exist: ${expanded}`;
      }
      return null;
    },
  });

  if (!input) {
    return;
  }

  const config = vscode.workspace.getConfiguration("claudeSessions");
  const current = config.get<string[]>("extraFolders", []);
  const expanded = input.replace(/^~/, os.homedir());

  if (current.some((f) => path.normalize(f).toLowerCase() === path.normalize(expanded).toLowerCase())) {
    vscode.window.showInformationMessage("Folder already in list.");
    return;
  }

  await config.update("extraFolders", [...current, expanded], vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Added: ${path.basename(expanded)}`);
}
```

- [ ] **Step 2: Wire quick-pick into `extension.ts`**

Replace the full contents of `src/extension.ts`:

```typescript
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
```

- [ ] **Step 3: Verify compilation**

Run: `npm run compile`
Expected: compiles with no errors

- [ ] **Step 4: Commit**

```bash
git add src/quickPick.ts src/extension.ts
git commit -m "feat: quick-pick launcher with active session switching and folder add

Active sessions shown first, then recent folders, then configured.
Selecting active session focuses its tab; selecting folder launches new session.

closes #4"
```

---

### Task 5: Sidebar Tree View (closes #5)

**Files:**
- Create: `src/treeView.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Create `src/treeView.ts`**

```typescript
import * as vscode from "vscode";
import * as path from "path";
import { SessionManager, ActiveSession } from "./sessionManager";
import { getAllFolders, FolderEntry } from "./folderSource";

/**
 * Tree item representing an active Claude session.
 */
class ActiveSessionItem extends vscode.TreeItem {
  readonly session: ActiveSession;

  constructor(session: ActiveSession) {
    super(session.folderName, vscode.TreeItemCollapsibleState.None);
    this.session = session;
    this.description = path.dirname(session.folderPath);
    this.tooltip = `${session.folderPath}\nStarted: ${session.startedAt.toLocaleTimeString()}`;
    this.iconPath = new vscode.ThemeIcon("terminal", new vscode.ThemeColor("testing.iconPassed"));
    this.contextValue = "activeSession";
    this.command = {
      command: "claudeSessions.focusSession",
      title: "Focus Session",
      arguments: [session],
    };
  }
}

/**
 * Tree item representing a recent/configured folder (no active session).
 */
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
      command: "claudeSessions.openSession",
      title: "Launch Session",
      arguments: [entry.folderPath],
    };
  }
}

/**
 * Data provider for the Active Sessions tree view.
 */
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

/**
 * Data provider for the Recent Projects tree view.
 * Excludes folders that already have an active session.
 */
export class RecentProjectsProvider implements vscode.TreeDataProvider<RecentProjectItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly sessionManager: SessionManager) {
    // Refresh when sessions change (a launch may move a project from recent to active)
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
```

- [ ] **Step 2: Wire tree views and remaining commands into `extension.ts`**

Replace the full contents of `src/extension.ts`:

```typescript
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
    // Quick-pick launcher — also handles tree view inline launch (receives folderPath arg)
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
```

- [ ] **Step 3: Verify compilation**

Run: `npm run compile`
Expected: compiles with no errors

- [ ] **Step 4: Commit**

```bash
git add src/treeView.ts src/extension.ts
git commit -m "feat: activity bar sidebar with active sessions and recent projects tree views

Active sessions show running terminals with green indicator and click-to-focus.
Recent projects show VS Code recents excluding active sessions.
Both refresh on terminal open/close events.

closes #5"
```

---

### Task 6: Status Bar (closes #6)

**Files:**
- Create: `src/statusBar.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Create `src/statusBar.ts`**

```typescript
import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";

export class StatusBar implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private readonly _disposable: vscode.Disposable;

  constructor(sessionManager: SessionManager) {
    this._item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this._item.command = "claudeSessions.openSession";
    this._item.tooltip = "Claude Sessions — click to launch or switch";

    this._update(sessionManager.count);

    this._disposable = sessionManager.onDidChangeSessions(() => {
      this._update(sessionManager.count);
    });
  }

  private _update(count: number): void {
    if (count === 0) {
      this._item.hide();
      return;
    }
    this._item.text = `$(sparkle) ${count} session${count === 1 ? "" : "s"}`;
    this._item.show();
  }

  dispose(): void {
    this._disposable.dispose();
    this._item.dispose();
  }
}
```

- [ ] **Step 2: Wire status bar into `extension.ts`**

Add the import at the top of `src/extension.ts`:

```typescript
import { StatusBar } from "./statusBar";
```

Add after the tree view registrations inside `activate()`:

```typescript
  // Status bar
  context.subscriptions.push(new StatusBar(sessionManager));
```

- [ ] **Step 3: Verify compilation**

Run: `npm run compile`
Expected: compiles with no errors

- [ ] **Step 4: Commit**

```bash
git add src/statusBar.ts src/extension.ts
git commit -m "feat: status bar showing active session count with click-to-launch

Shows '⚡ N sessions' when sessions are active, hidden when zero.
Reactively updates on terminal open/close events.

closes #6"
```

---

### Task 7: Terminal Link Provider (closes #7)

**Files:**
- Create: `src/terminalLinks.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Create `src/terminalLinks.ts`**

```typescript
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SESSION_NAME_PREFIX } from "./sessionManager";

interface ClaudeTerminalLink extends vscode.TerminalLink {
  filePath: string;
}

/**
 * Provides clickable file path links in Claude session terminals.
 * Matches both absolute paths (C:\foo\bar.ts) and relative paths (src/app.ts).
 */
export class ClaudeTerminalLinkProvider implements vscode.TerminalLinkProvider<ClaudeTerminalLink> {
  /**
   * Regex patterns for file paths.
   * - Windows absolute: C:\Users\chris\file.ts (with optional :line:col)
   * - Unix absolute: /home/user/file.ts (with optional :line:col)
   * - Relative: src/components/App.tsx, ./foo/bar.py (with optional :line:col)
   */
  private readonly _patterns = [
    // Windows absolute path: C:\path\to\file.ext[:line[:col]]
    /[A-Za-z]:\\(?:[\w.\-]+\\)*[\w.\-]+\.\w+(?::\d+(?::\d+)?)?/g,
    // Unix absolute path: /path/to/file.ext[:line[:col]]
    /\/(?:[\w.\-]+\/)*[\w.\-]+\.\w+(?::\d+(?::\d+)?)?/g,
    // Relative path: src/file.ext or ./file.ext[:line[:col]]
    /\.{0,2}\/(?:[\w.\-]+\/)*[\w.\-]+\.\w+(?::\d+(?::\d+)?)?/g,
  ];

  provideTerminalLinks(
    context: vscode.TerminalLinkContext
  ): ClaudeTerminalLink[] {
    // Only provide links for Claude session terminals
    if (!context.terminal.name.startsWith(SESSION_NAME_PREFIX)) {
      return [];
    }

    const links: ClaudeTerminalLink[] = [];
    const line = context.line;

    for (const pattern of this._patterns) {
      // Reset lastIndex since we're reusing regex objects
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(line)) !== null) {
        const rawPath = match[0];
        // Strip trailing :line:col for the file path
        const filePath = rawPath.replace(/:\d+(?::\d+)?$/, "");

        links.push({
          startIndex: match.index,
          length: rawPath.length,
          tooltip: `Open ${filePath}`,
          filePath,
        });
      }
    }

    return links;
  }

  async handleTerminalLink(link: ClaudeTerminalLink): Promise<void> {
    let targetPath = link.filePath;

    // If relative, try to resolve against the terminal's cwd
    if (!path.isAbsolute(targetPath)) {
      // We can't easily get the terminal's cwd at runtime, but we set it at creation.
      // For now, try the workspace folder as a fallback.
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceFolder) {
        const resolved = path.resolve(workspaceFolder, targetPath);
        if (fs.existsSync(resolved)) {
          targetPath = resolved;
        }
      }
    }

    try {
      const uri = vscode.Uri.file(targetPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } catch {
      vscode.window.showWarningMessage(`Could not open file: ${link.filePath}`);
    }
  }
}
```

- [ ] **Step 2: Wire terminal link provider into `extension.ts`**

Add the import at the top of `src/extension.ts`:

```typescript
import { ClaudeTerminalLinkProvider } from "./terminalLinks";
```

Add after the status bar registration inside `activate()`:

```typescript
  // Terminal link provider
  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider(new ClaudeTerminalLinkProvider())
  );
```

- [ ] **Step 3: Verify compilation**

Run: `npm run compile`
Expected: compiles with no errors

- [ ] **Step 4: Commit**

```bash
git add src/terminalLinks.ts src/extension.ts
git commit -m "feat: terminal link provider for clickable file paths in Claude output

Matches Windows absolute, Unix absolute, and relative file paths.
Clicking opens the file in the editor.

closes #7"
```

---

### Task 8: Keyboard Navigation (closes #8)

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Wire next/prev session commands in `extension.ts`**

Replace the remaining stubs block in `src/extension.ts` with the real implementations. Remove the stubs loop and add:

```typescript
    vscode.commands.registerCommand("claudeSessions.nextSession", () => {
      cycleSession(sessionManager, 1);
    }),

    vscode.commands.registerCommand("claudeSessions.prevSession", () => {
      cycleSession(sessionManager, -1);
    }),
```

Add this function at the bottom of `src/extension.ts` (before `deactivate`):

```typescript
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
```

- [ ] **Step 2: Verify the final `extension.ts` compiles**

Run: `npm run compile`
Expected: compiles with no errors

- [ ] **Step 3: Manual smoke test**

Run: `npm run package`
Expected: produces `vscode-claude-sessions-1.0.0.vsix`

Install it: open VS Code → Extensions → `...` menu → "Install from VSIX" → select the `.vsix` file.

Verify:
1. Sparkle icon appears in activity bar
2. `Ctrl+Shift+Alt+C` opens quick-pick with recent folders
3. Selecting a folder opens a `claude · <name>` terminal in an editor tab
4. Status bar shows session count
5. Sidebar tree view shows active session and remaining projects
6. `Ctrl+Alt+]` / `Ctrl+Alt+[` cycles between Claude tabs
7. File paths in Claude output are clickable

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat: keyboard navigation to cycle through active Claude sessions

Ctrl+Alt+] for next session, Ctrl+Alt+[ for previous.
Wraps around at ends of the list.

closes #8"
```

---

### Task 9: Final Extension.ts — Complete Reference

This is not a task to implement — it's a reference showing what the final `src/extension.ts` should look like after all tasks are complete. Use this to verify your final state.

**Files:**
- Verify: `src/extension.ts`

```typescript
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

function cycleSession(sm: SessionManager, direction: 1 | -1): void {
  const sessions = sm.activeSessions;
  if (sessions.length === 0) {
    vscode.window.showInformationMessage("No active Claude sessions");
    return;
  }

  const activeTerminal = vscode.window.activeTerminal;
  let currentIndex = -1;
  if (activeTerminal) {
    currentIndex = sessions.findIndex((s) => s.terminal === activeTerminal);
  }

  const nextIndex =
    currentIndex === -1
      ? 0
      : (currentIndex + direction + sessions.length) % sessions.length;

  sm.focusSession(sessions[nextIndex]);
}

export function deactivate(): void {}
```
