import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { SessionManager } from "./sessionManager";
import { getEnableNotifications } from "./config";

const STATE_DIR = path.join(os.homedir(), ".claude", "session-state");

interface SessionState {
  state: "idle" | "active";
  cwd: string;
  sessionId: string;
  timestamp: number;
}

/**
 * Watches ~/.claude/session-state/ for state file changes written by
 * our Claude Code hooks, and triggers notifications + tree view updates.
 */
export class StateWatcher implements vscode.Disposable {
  private readonly _disposables: vscode.Disposable[] = [];
  private _watcher: vscode.FileSystemWatcher | undefined;

  /** Track idle session folder paths for consolidated notification */
  private readonly _idleSessions = new Set<string>();

  /** Whether a notification is currently showing (avoid stacking) */
  private _notificationActive = false;

  constructor(private readonly sessionManager: SessionManager) {
    this._ensureStateDir();
    this._startWatching();
  }

  private _ensureStateDir(): void {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    } catch {
      // May fail if ~/.claude doesn't exist yet
    }
  }

  private _startWatching(): void {
    const globPattern = new vscode.RelativePattern(
      vscode.Uri.file(STATE_DIR),
      "*.json"
    );

    this._watcher = vscode.workspace.createFileSystemWatcher(globPattern);

    this._disposables.push(
      this._watcher.onDidCreate((uri) => this._onStateFileChanged(uri)),
      this._watcher.onDidChange((uri) => this._onStateFileChanged(uri)),
      this._watcher.onDidDelete((uri) => this._onStateFileDeleted(uri)),
      this._watcher
    );

    // Process any existing state files on startup
    this._scanExistingFiles();
  }

  private _scanExistingFiles(): void {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        return;
      }
      const files = fs.readdirSync(STATE_DIR);
      for (const file of files) {
        if (file.endsWith(".json")) {
          this._onStateFileChanged(vscode.Uri.file(path.join(STATE_DIR, file)));
        }
      }
    } catch {
      // Ignore scan errors
    }
  }

  private _onStateFileChanged(uri: vscode.Uri): void {
    const state = this._readStateFile(uri.fsPath);
    if (!state) {
      return;
    }

    const session = this.sessionManager.findSessionByFolder(state.cwd);
    if (!session) {
      return;
    }

    if (state.state === "idle") {
      this.sessionManager.setSessionIdle(session.folderPath, true);

      if (getEnableNotifications() && !this._idleSessions.has(session.folderPath)) {
        this._idleSessions.add(session.folderPath);
        this._showConsolidatedNotification();
      }
    } else if (state.state === "active") {
      this.sessionManager.setSessionIdle(session.folderPath, false);
      this._idleSessions.delete(session.folderPath);
    }
  }

  private _onStateFileDeleted(uri: vscode.Uri): void {
    // Read all remaining state files to rebuild idle set
    // (we can't parse the deleted file)
    // The session close handler in sessionManager will clean up the session
  }

  private _readStateFile(filePath: string): SessionState | null {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.state && parsed.cwd) {
        return parsed as SessionState;
      }
    } catch {
      // File may be partially written or invalid
    }
    return null;
  }

  /**
   * Show a single notification for all idle sessions.
   * If only one session is idle, clicking "Focus" goes directly to it.
   * If multiple are idle, clicking "Show" opens a quick-pick to choose.
   */
  private async _showConsolidatedNotification(): Promise<void> {
    // Don't stack notifications — one at a time
    if (this._notificationActive) {
      return;
    }
    this._notificationActive = true;

    try {
      const idleCount = this._idleSessions.size;
      if (idleCount === 0) {
        return;
      }

      if (idleCount === 1) {
        // Single session — direct focus
        const folderPath = Array.from(this._idleSessions)[0];
        const folderName = path.basename(folderPath);

        const choice = await vscode.window.showInformationMessage(
          `Claude \u00b7 ${folderName} needs attention`,
          "Focus"
        );

        if (choice === "Focus") {
          const session = this.sessionManager.findSessionByFolder(folderPath);
          if (session) {
            this.sessionManager.focusSession(session);
          }
        }
      } else {
        // Multiple sessions — show quick-pick
        const choice = await vscode.window.showInformationMessage(
          `${idleCount} Claude sessions need attention`,
          "Show"
        );

        if (choice === "Show") {
          await this._showIdleSessionPicker();
        }
      }
    } finally {
      this._notificationActive = false;

      // If new idle sessions appeared while notification was showing, re-notify
      if (this._idleSessions.size > 0) {
        // Small delay to avoid immediate re-trigger
        setTimeout(() => {
          if (this._idleSessions.size > 0 && !this._notificationActive) {
            this._showConsolidatedNotification();
          }
        }, 1000);
      }
    }
  }

  /**
   * Quick-pick showing only idle sessions. Selecting one focuses it.
   */
  private async _showIdleSessionPicker(): Promise<void> {
    const items = Array.from(this._idleSessions).map((folderPath) => ({
      label: `$(bell) ${path.basename(folderPath)}`,
      description: path.dirname(folderPath),
      folderPath,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: "Sessions waiting for attention",
      placeHolder: "Select a session to focus",
    });

    if (picked) {
      const session = this.sessionManager.findSessionByFolder(picked.folderPath);
      if (session) {
        this.sessionManager.focusSession(session);
        this._idleSessions.delete(picked.folderPath);
      }
    }
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose();
    }
    this._idleSessions.clear();
  }
}
