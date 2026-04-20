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

/** Shared output channel for diagnostic logging — created once, reused everywhere. */
let _outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel("Claude Conductor");
  }
  return _outputChannel;
}

function log(message: string): void {
  getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Watches ~/.claude/session-state/ for state file changes written by
 * our Claude Code hooks, and triggers notifications + tree view updates.
 */
export class StateWatcher implements vscode.Disposable {
  private readonly _disposables: vscode.Disposable[] = [];
  private _watcher: vscode.FileSystemWatcher | undefined;
  private _pollTimer: NodeJS.Timeout | undefined;

  /** Track idle session folder paths for consolidated notification */
  private readonly _idleSessions = new Set<string>();

  /**
   * Track which idle session paths have already been shown in a notification
   * this idle episode. Cleared when the session transitions back to active or
   * is stopped, so a future idle episode will re-notify.
   */
  private readonly _notifiedSessions = new Set<string>();

  /** Track last-seen file timestamps to detect changes during polling */
  private readonly _fileTimestamps = new Map<string, number>();

  /**
   * Map from state-file basename (e.g. "abc123456789.json") to the cwd
   * stored inside that file. Used to resolve the folder path on deletion,
   * when the file content is no longer readable.
   */
  private readonly _fileToFolderPath = new Map<string, string>();

  /** Whether a notification is currently showing (avoid stacking) */
  private _notificationActive = false;

  /** Polling interval in ms — fallback for unreliable FileSystemWatcher on Windows */
  private static readonly POLL_INTERVAL_MS = 2000;

  constructor(private readonly sessionManager: SessionManager) {
    this._disposables.push(getOutputChannel());
    this._ensureStateDir();
    this._startWatching();
    this._startPolling();
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
      log(`Startup scan: found ${files.length} file(s) in ${STATE_DIR}`);
      for (const file of files) {
        if (file.endsWith(".json")) {
          this._onStateFileChanged(vscode.Uri.file(path.join(STATE_DIR, file)));
        }
      }
    } catch (err) {
      log(`Startup scan error: ${err}`);
    }
  }

  private _onStateFileChanged(uri: vscode.Uri): void {
    const state = this._readStateFile(uri.fsPath);
    if (!state) {
      log(`Read: ${path.basename(uri.fsPath)} — parse failed or missing fields`);
      return;
    }

    const filename = path.basename(uri.fsPath);
    // Remember the cwd stored in this file so we can resolve it on deletion
    this._fileToFolderPath.set(filename, state.cwd);

    log(`Read: ${filename} state=${state.state} cwd=${state.cwd}`);

    const session = this.sessionManager.findSessionByFolder(state.cwd);
    if (!session) {
      log(`Dispatch: no session found for cwd="${state.cwd}" — skipping`);
      return;
    }

    log(`Dispatch: matched session folderPath="${session.folderPath}" state=${state.state}`);

    if (state.state === "idle") {
      this.sessionManager.setSessionIdle(session.folderPath, true);

      if (getEnableNotifications() && !this._idleSessions.has(session.folderPath)) {
        this._idleSessions.add(session.folderPath);
        log(`Notification: queuing for "${session.folderPath}"`);
        this._showConsolidatedNotification();
      }
    } else if (state.state === "active") {
      this.sessionManager.setSessionIdle(session.folderPath, false);
      this._idleSessions.delete(session.folderPath);
      this._notifiedSessions.delete(session.folderPath);
      log(`Active: cleared idle for "${session.folderPath}"`);
    }
  }

  private _onStateFileDeleted(uri: vscode.Uri): void {
    const filename = path.basename(uri.fsPath);
    log(`Deleted: ${filename}`);

    // Resolve the folder path from our cache (file content is gone)
    const cwd = this._fileToFolderPath.get(filename);
    this._fileToFolderPath.delete(filename);

    if (!cwd) {
      log(`Deleted: no cached cwd for ${filename} — cannot clear idle state`);
      return;
    }

    const session = this.sessionManager.findSessionByFolder(cwd);
    if (session) {
      log(`Deleted: clearing idle for "${session.folderPath}"`);
      this.sessionManager.setSessionIdle(session.folderPath, false);
      this._idleSessions.delete(session.folderPath);
      this._notifiedSessions.delete(session.folderPath);
    } else {
      // Session may already be gone; still clean up our idle set by cwd
      const normalizedCwd = path.normalize(cwd).toLowerCase();
      for (const idlePath of this._idleSessions) {
        if (idlePath.toLowerCase() === normalizedCwd) {
          this._idleSessions.delete(idlePath);
          this._notifiedSessions.delete(idlePath);
          log(`Deleted: removed "${idlePath}" from idle set (session already gone)`);
          break;
        }
      }
    }
  }

  private _readStateFile(filePath: string): SessionState | null {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.state && parsed.cwd) {
        return parsed as SessionState;
      }
      log(`Read: ${path.basename(filePath)} — missing state or cwd fields`);
    } catch (err) {
      log(`Read: ${path.basename(filePath)} — error: ${err}`);
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

    // Idempotency guard: if every idle path has already been notified this
    // episode, there is nothing new to show. Fixes #42.
    if (
      this._idleSessions.size > 0 &&
      Array.from(this._idleSessions).every((p) => this._notifiedSessions.has(p))
    ) {
      log(`Show: all ${this._idleSessions.size} idle session(s) already notified — skipping`);
      return;
    }

    this._notificationActive = true;

    try {
      const idleCount = this._idleSessions.size;
      if (idleCount === 0) {
        return;
      }

      // Mark every currently-idle path as notified before we await the dialog.
      // This prevents the finally-block retry from re-firing for the same episode.
      for (const p of this._idleSessions) {
        this._notifiedSessions.add(p);
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
    } catch (err) {
      log(`Notification error: ${err}`);
    } finally {
      this._notificationActive = false;

      // Re-notify only if at least one idle session has NOT yet been notified
      // this episode (i.e. it went idle while we were awaiting the dialog).
      // Sessions the user dismissed remain in _notifiedSessions so we do NOT
      // re-fire for them — preventing the dismissal-spam loop (issue #39).
      const unnotifiedCount = Array.from(this._idleSessions).filter(
        (p) => !this._notifiedSessions.has(p)
      ).length;

      if (unnotifiedCount > 0) {
        log(
          `Notification retry: ${unnotifiedCount} unnotified idle session(s) — re-firing`
        );
        setTimeout(() => {
          if (this._notificationActive) {
            return;
          }
          const stillUnnotified = Array.from(this._idleSessions).some(
            (p) => !this._notifiedSessions.has(p)
          );
          if (stillUnnotified) {
            this._showConsolidatedNotification();
          } else {
            log(`Notification retry (deferred): no unnotified idle sessions remain — skipping`);
          }
        }, 1000);
      } else {
        log(
          `Notification retry: all ${this._idleSessions.size} idle session(s) already notified — stopping`
        );
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
        this._notifiedSessions.delete(picked.folderPath);
      }
    }
  }

  /**
   * Poll the state directory every few seconds as a fallback for
   * FileSystemWatcher which is unreliable on Windows for non-workspace dirs.
   *
   * Each tick also calls sessionManager.reconcile() to evict any _sessions
   * entry whose terminal is no longer in vscode.window.terminals. This is the
   * self-healing path for the editor-tab X case where onDidCloseTerminal
   * either doesn't fire or fires with a mismatched reference.
   */
  private _startPolling(): void {
    this._pollTimer = setInterval(() => {
      // Reconcile sessions first so stale entries don't produce idle-state
      // callbacks below for terminals that are already gone.
      this.sessionManager.reconcile();

      try {
        if (!fs.existsSync(STATE_DIR)) {
          return;
        }
        const files = fs.readdirSync(STATE_DIR);
        const currentFiles = new Set<string>();

        for (const file of files) {
          if (!file.endsWith(".json")) {
            continue;
          }
          currentFiles.add(file);
          const filePath = path.join(STATE_DIR, file);

          try {
            const mtime = fs.statSync(filePath).mtimeMs;
            const lastMtime = this._fileTimestamps.get(file);

            if (lastMtime === undefined || mtime > lastMtime) {
              this._fileTimestamps.set(file, mtime);
              this._onStateFileChanged(vscode.Uri.file(filePath));
            }
          } catch {
            // File may have been deleted between readdir and stat
          }
        }

        // Detect deleted files
        for (const tracked of this._fileTimestamps.keys()) {
          if (!currentFiles.has(tracked)) {
            this._fileTimestamps.delete(tracked);
            this._onStateFileDeleted(
              vscode.Uri.file(path.join(STATE_DIR, tracked))
            );
          }
        }
      } catch (err) {
        log(`Poll error: ${err}`);
      }
    }, StateWatcher.POLL_INTERVAL_MS);
  }

  dispose(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
    }
    for (const d of this._disposables) {
      d.dispose();
    }
    _outputChannel = undefined;
    this._idleSessions.clear();
    this._notifiedSessions.clear();
    this._fileTimestamps.clear();
    this._fileToFolderPath.clear();
  }
}
