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

  /** Track which sessions we've already notified for (avoid duplicates) */
  private readonly _notifiedSessions = new Set<string>();

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

    const fileKey = path.basename(uri.fsPath);

    if (state.state === "idle") {
      // Mark session as idle
      this.sessionManager.setSessionIdle(session.folderPath, true);

      // Show notification (once per idle transition)
      if (!this._notifiedSessions.has(fileKey) && getEnableNotifications()) {
        this._notifiedSessions.add(fileKey);
        this._showIdleNotification(session.folderName, session.folderPath);
      }
    } else if (state.state === "active") {
      // Clear idle state
      this.sessionManager.setSessionIdle(session.folderPath, false);
      this._notifiedSessions.delete(fileKey);
    }
  }

  private _onStateFileDeleted(uri: vscode.Uri): void {
    const fileKey = path.basename(uri.fsPath);
    this._notifiedSessions.delete(fileKey);

    // Try to find and clear any session that was idle
    // We can't parse the deleted file, so clear all idle flags and let the
    // next state update set them correctly
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

  private async _showIdleNotification(
    folderName: string,
    folderPath: string
  ): Promise<void> {
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
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose();
    }
    this._notifiedSessions.clear();
  }
}
