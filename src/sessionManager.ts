import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { getClaudeCommand, getReuseTerminal, getLaunchDelayMs } from "./config";
import { log, debugLog } from "./output";

/** Prefix used for all Claude session terminal names */
export const SESSION_NAME_PREFIX = "claude · ";

const STATE_DIR = path.join(os.homedir(), ".claude", "session-state");

/** workspaceState key for the PID record. */
const PID_KEY = "claudeConductor.sessionPids";

interface SessionState {
  state: "idle" | "active";
  cwd: string;
  sessionId: string;
  timestamp: number;
}

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

  /**
   * Secondary index: processId → terminal map entry key.
   * When moveToEditor causes VS Code to swap terminal references, the new
   * onDidCloseTerminal fires with a reference that isn't in _sessions by
   * identity. Storing the PID lets us fall back to a pid-based lookup when
   * both the identity check and the name-match fail.
   */
  private readonly _pidToTerminal = new Map<number, vscode.Terminal>();

  private readonly _onDidChangeSessions = new vscode.EventEmitter<void>();
  /** Fires whenever the active session list changes (open or close). */
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  /** Set when dispose() is called — guards async-resolved writes. */
  private _disposed = false;

  /**
   * Serialized write queue for PID persistence. Each call extends the chain
   * with a leading .catch() so a prior rejection doesn't poison subsequent
   * writes, and an inner try/catch logs and swallows transient failures.
   */
  private _pidWriteQueue: Promise<void> = Promise.resolve();

  /** workspaceState injected by the extension activator. */
  private readonly _workspaceState: vscode.Memento;

  constructor(workspaceState: vscode.Memento) {
    this._workspaceState = workspaceState;

    // Pick up any Claude terminals that already exist (e.g., extension reloaded)
    for (const terminal of vscode.window.terminals) {
      this._trackIfClaudeSession(terminal);
    }

    this._disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        this._trackIfClaudeSession(terminal);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        this._handleTerminalClose(terminal);
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

    // Guard: refuse to create a terminal for a cwd that no longer exists on
    // disk.  This prevents VS Code from emitting "Starting directory does not
    // exist" errors when a stale _sessions entry (whose directory has since
    // been deleted or moved) is somehow passed here.
    if (!fs.existsSync(normalized)) {
      log(`[launch] skipping — cwd does not exist: ${normalized}`);
      return;
    }

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

    // Dispatch the claude command only after the shell prompt is ready
    await this._dispatchClaudeCommand(terminal);
  }

  /**
   * Dispatch `claude` to the terminal using the best available mechanism:
   *
   * 1. Fast path — shell integration already active at call time.
   * 2. Slow path — wait up to 2 s for shell integration to activate.
   * 3. Delay fallback — sleep `claudeConductor.launchDelayMs` ms then sendText.
   *    Covers VS Code < 1.93 and setups where shell integration never activates.
   */
  private async _dispatchClaudeCommand(terminal: vscode.Terminal): Promise<void> {
    const cmd = getClaudeCommand();

    // Fast path: shell integration already active
    if (terminal.shellIntegration) {
      log(`[dispatch] fast path — shell integration already active`);
      terminal.shellIntegration.executeCommand(cmd);
      return;
    }

    // Slow path: wait for shell integration to activate (up to 2000 ms)
    const shellIntegrationAvailable = await new Promise<boolean>((resolve) => {
      let disposed = false;

      const timeoutHandle = setTimeout(() => {
        if (!disposed) {
          disposed = true;
          listener.dispose();
          log(`[dispatch] slow path timed out — falling back to delay sendText`);
          resolve(false);
        }
      }, 2000);

      const listener = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal && !disposed) {
          disposed = true;
          clearTimeout(timeoutHandle);
          listener.dispose();
          log(`[dispatch] slow path — shell integration activated`);
          e.shellIntegration.executeCommand(cmd);
          resolve(true);
        }
      });
    });

    if (shellIntegrationAvailable) {
      return;
    }

    // Delay fallback: sendText after a configurable delay
    const delayMs = getLaunchDelayMs();
    log(`[dispatch] delay fallback — waiting ${delayMs} ms then sendText`);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    terminal.sendText(cmd);
  }

  /** Focus an existing session's editor tab. */
  focusSession(session: ActiveSession): void {
    session.terminal.show(false);
  }

  /** Close a session's terminal. */
  closeSession(session: ActiveSession): void {
    // The terminal reference on the passed session may be the pre-moveToEditor
    // panel terminal whose internal VS Code handle is no longer valid — calling
    // dispose() on it throws "Cannot read properties of undefined (reading
    // 'dispose')" inside the terminal proxy. Always resolve the live entry from
    // _sessions by folderPath so we dispose the current, valid terminal
    // reference. Falls back to session.terminal when the entry has already been
    // evicted (e.g. a rapid double-close), in which case ?. makes it a no-op.
    const live = this._findSessionByFolder(session.folderPath);
    const terminal = live?.terminal ?? session.terminal;
    terminal?.dispose();
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

  /**
   * Reconcile _sessions against vscode.window.terminals.
   *
   * Called each poll tick by StateWatcher. Any session whose terminal is no
   * longer present in the live terminal list is treated as closed (the
   * onDidCloseTerminal event was missed, e.g. editor-tab X on Windows).
   * The corresponding state file in ~/.claude/session-state/ is also deleted
   * so the Stop hook gap doesn't leave orphaned idle files on disk.
   */
  reconcile(): void {
    const liveTerminals = new Set(vscode.window.terminals);
    debugLog(`[reconcile] sessions=${this._sessions.size} liveTerminals=${vscode.window.terminals.length}`);
    let changed = false;

    for (const [terminal, session] of this._sessions) {
      if (!liveTerminals.has(terminal)) {
        debugLog(`[reconcile:evict] name=${JSON.stringify(terminal.name)} folderPath=${JSON.stringify(session.folderPath)}`);
        this._sessions.delete(terminal);
        this._cleanupStateFile(session.folderPath);
        changed = true;
      }
    }

    if (!changed) {
      debugLog(`[reconcile:clean] no evictions`);
    }

    if (changed) {
      this._onDidChangeSessions.fire();
    }
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
      debugLog(`[track] skip name=${JSON.stringify(terminal.name)} reason=not-claude sessions=${this._sessions.size} pids=${this._pidToTerminal.size}`);
      return;
    }
    const folderPath = this._extractFolderPath(terminal);
    if (!folderPath) {
      debugLog(`[track] skip name=${JSON.stringify(terminal.name)} reason=no-cwd sessions=${this._sessions.size} pids=${this._pidToTerminal.size}`);
      return;
    }

    debugLog(`[track] tracking name=${JSON.stringify(terminal.name)} folderPath=${JSON.stringify(folderPath)} sessions=${this._sessions.size} pids=${this._pidToTerminal.size}`);

    this._sessions.set(terminal, {
      terminal,
      folderPath: path.normalize(folderPath),
      folderName: path.basename(folderPath),
      startedAt: new Date(),
      isIdle: false,
    });

    // Register PID as a secondary lookup key once it resolves.
    // processId is a Thenable<number | undefined> — we don't await here to
    // avoid blocking the synchronous tracking path.
    // Use two-argument .then() because PromiseLike lacks .catch().
    terminal.processId.then(
      (pid) => {
        if (pid !== undefined) {
          this._pidToTerminal.set(pid, terminal);
          debugLog(`[track:pid] resolved pid=${pid} name=${JSON.stringify(terminal.name)} pids=${this._pidToTerminal.size}`);
        } else {
          debugLog(`[track:pid] pid=undefined name=${JSON.stringify(terminal.name)} — not indexed`);
        }
      },
      () => { debugLog(`[track:pid] processId rejected name=${JSON.stringify(terminal.name)}`); }
    );

    this._onDidChangeSessions.fire();
  }

  /**
   * Handle a terminal-close event with three-tier fallback:
   * 1. Identity match (the common case for panel terminals).
   * 2. Name match (handles some reference swaps after moveToEditor).
   * 3. PID match (handles the editor-tab X case where name becomes "").
   */
  private _handleTerminalClose(terminal: vscode.Terminal): void {
    debugLog(`[close] event name=${JSON.stringify(terminal.name)} sessionsBefore=${this._sessions.size} pids=${this._pidToTerminal.size}`);

    // Tier 1 — identity
    if (this._removeByKey(terminal)) {
      debugLog(`[close:tier1] hit name=${JSON.stringify(terminal.name)}`);
      return;
    }
    debugLog(`[close:tier1] miss name=${JSON.stringify(terminal.name)}`);

    // Tier 2 — name match (only when name is non-empty)
    if (terminal.name) {
      for (const [key, session] of this._sessions) {
        if (session.terminal.name === terminal.name) {
          debugLog(`[close:tier2] hit name=${JSON.stringify(terminal.name)} matchedSession=${JSON.stringify(session.folderPath)}`);
          this._removeByKey(key);
          return;
        }
      }
      debugLog(`[close:tier2] miss name=${JSON.stringify(terminal.name)} checkedSessions=${this._sessions.size}`);
    } else {
      debugLog(`[close:tier2] skip name="" (empty — cannot match by name)`);
    }

    // Tier 3 — PID match. processId is a Thenable; we must handle it async.
    // Use two-argument .then() because PromiseLike lacks .catch().
    // Falls back to reconcile() on the next poll tick if this also misses.
    terminal.processId.then(
      (pid) => {
        if (pid === undefined) {
          debugLog(`[close:tier3:no-pid] processId=undefined name=${JSON.stringify(terminal.name)} — deferring to reconcile()`);
          return;
        }
        const trackedTerminal = this._pidToTerminal.get(pid);
        const sessionStillExists = trackedTerminal ? this._sessions.has(trackedTerminal) : false;
        debugLog(`[close:tier3] pid=${pid} name=${JSON.stringify(terminal.name)} inPidIndex=${trackedTerminal !== undefined} sessionStillExists=${sessionStillExists}`);
        if (trackedTerminal && sessionStillExists) {
          this._removeByKey(trackedTerminal);
        }
      },
      () => {
        debugLog(`[close:tier3:no-pid] processId rejected name=${JSON.stringify(terminal.name)} — deferring to reconcile()`);
      }
    );
  }

  /**
   * Remove a session keyed by terminal, clean up the PID index and state
   * file, and fire the change event. Returns true if a session was removed.
   */
  private _removeByKey(terminal: vscode.Terminal): boolean {
    const session = this._sessions.get(terminal);
    if (!session) {
      debugLog(`[remove] miss name=${JSON.stringify(terminal.name)} — key already gone (possible double-fire)`);
      return false;
    }
    this._sessions.delete(terminal);
    debugLog(`[remove] success folderPath=${JSON.stringify(session.folderPath)} sessionsAfter=${this._sessions.size}`);

    // Remove from PID index (two-argument .then() because PromiseLike lacks .catch())
    terminal.processId.then(
      (pid) => {
        if (pid !== undefined) {
          this._pidToTerminal.delete(pid);
          debugLog(`[pid:delete] pid=${pid} pidsAfter=${this._pidToTerminal.size}`);
        }
      },
      () => { /* ignore */ }
    );

    this._cleanupStateFile(session.folderPath);
    this._onDidChangeSessions.fire();
    return true;
  }

  /**
   * Delete the ~/.claude/session-state/*.json file whose `cwd` matches
   * folderPath. This is a best-effort extension-side fallback for the case
   * where the Claude Code Stop hook didn't run (e.g. terminal killed via
   * editor-tab X). Without this, StateWatcher keeps re-marking the session
   * idle on every poll tick even after the terminal is gone.
   */
  private _cleanupStateFile(folderPath: string): void {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        return;
      }
      const files = fs.readdirSync(STATE_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) {
          continue;
        }
        const filePath = path.join(STATE_DIR, file);
        try {
          const raw = fs.readFileSync(filePath, "utf8");
          const parsed = JSON.parse(raw) as Partial<SessionState>;
          if (
            parsed.cwd &&
            path.normalize(parsed.cwd).toLowerCase() === folderPath.toLowerCase()
          ) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // File may be partially written, already deleted, or unreadable
        }
      }
    } catch {
      // STATE_DIR may not exist yet or may be unreadable
    }
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
    this._disposed = true;
    for (const d of this._disposables) {
      d.dispose();
    }
    this._sessions.clear();
    this._pidToTerminal.clear();
  }
}
