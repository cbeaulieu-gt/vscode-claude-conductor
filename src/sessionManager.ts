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
  isIdle: boolean;
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
        // Try identity-based delete first
        if (this._sessions.delete(terminal)) {
          this._onDidChangeSessions.fire();
          return;
        }
        // Fallback: match by name (terminal reference can change after moveToEditor)
        for (const [key, session] of this._sessions) {
          if (session.terminal.name === terminal.name) {
            this._sessions.delete(key);
            this._onDidChangeSessions.fire();
            return;
          }
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

  /** Set the idle state for a session by folder path. */
  setSessionIdle(folderPath: string, idle: boolean): void {
    const session = this._findSessionByFolder(path.normalize(folderPath));
    if (session && session.isIdle !== idle) {
      session.isIdle = idle;
      this._onDidChangeSessions.fire();
    }
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
      isIdle: false,
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
