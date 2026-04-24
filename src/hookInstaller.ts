import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const STATE_DIR = path.join(os.homedir(), ".claude", "session-state");
const HOOK_MARKER = "session-state.js";
const SETUP_DECLINED_KEY = "claudeConductor.hookSetupDeclined";

/**
 * Get the path to our hook script, using Unix-style paths for git bash compatibility.
 * Claude Code on Windows uses git bash paths like /c/Users/...
 */
function getHookScriptPath(context: vscode.ExtensionContext): string {
  const hookPath = path.join(context.extensionPath, "hooks", "session-state.js");

  if (process.platform === "win32") {
    // Convert Windows path to git bash style: C:\Users\... → /c/Users/...
    const drive = hookPath[0].toLowerCase();
    const rest = hookPath.slice(2).replace(/\\/g, "/");
    return `/c/PROGRA~1/nodejs/node.exe /${drive}${rest}`;
  }

  return `node ${hookPath}`;
}

/**
 * Read and parse ~/.claude/settings.json.
 */
function readSettings(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Write settings back to ~/.claude/settings.json.
 */
function writeSettings(settings: Record<string, unknown>): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

/**
 * Check if our hooks are already installed by looking for session-state.js in hook commands.
 */
function hooksInstalled(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) {
    return false;
  }

  const json = JSON.stringify(hooks);
  return json.includes(HOOK_MARKER);
}

/**
 * Return true only when every hook entry containing the session-state.js marker
 * has a command string that starts with expectedScriptBase.
 *
 * If no hooks containing the marker exist, there is nothing stale — returns true.
 */
export function hooksUpToDate(
  settings: Record<string, unknown>,
  expectedScriptBase: string
): boolean {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) {
    return true;
  }

  for (const entries of Object.values(hooks)) {
    for (const entry of entries as Array<Record<string, unknown>>) {
      const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
      if (!innerHooks) {
        continue;
      }
      for (const h of innerHooks) {
        const cmd = h.command as string | undefined;
        if (cmd && cmd.includes(HOOK_MARKER)) {
          if (!cmd.startsWith(expectedScriptBase)) {
            return false;
          }
        }
      }
    }
  }

  return true;
}

/**
 * Rewrite every hook command that contains the session-state.js marker so
 * its leading path portion is replaced with expectedScriptBase, preserving
 * the trailing action argument (idle / active / stop).
 *
 * Both Windows git-bash form (`/c/PROGRA~1/nodejs/node.exe /c/Users/...`) and
 * POSIX form (`node /path/to/...`) round-trip correctly because we split on
 * the last space before the action arg to isolate the action, then reconstruct.
 */
export function reconcileHookPaths(
  settings: Record<string, unknown>,
  expectedScriptBase: string
): void {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) {
    return;
  }

  for (const entries of Object.values(hooks)) {
    for (const entry of entries as Array<Record<string, unknown>>) {
      const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
      if (!innerHooks) {
        continue;
      }
      for (const h of innerHooks) {
        const cmd = h.command as string | undefined;
        if (cmd && cmd.includes(HOOK_MARKER)) {
          // The command is "<scriptBase> <action>" — extract the action from
          // the last whitespace-delimited token.
          const lastSpace = cmd.lastIndexOf(" ");
          const action = lastSpace !== -1 ? cmd.slice(lastSpace + 1) : "";
          h.command = `${expectedScriptBase} ${action}`;
        }
      }
    }
  }
}

/**
 * Install our hooks into the existing settings, preserving all existing hooks.
 */
function installHooks(settings: Record<string, unknown>, scriptBase: string): void {
  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;

  // Helper to append a hook entry to an event type's array
  const appendHook = (
    eventType: string,
    matcher: string | undefined,
    action: string
  ): void => {
    if (!hooks[eventType]) {
      hooks[eventType] = [];
    }
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: "command",
          command: `${scriptBase} ${action}`,
        },
      ],
    };
    if (matcher) {
      entry.matcher = matcher;
    }
    (hooks[eventType] as unknown[]).push(entry);
  };

  appendHook("Notification", "idle_prompt", "idle");
  appendHook("UserPromptSubmit", undefined, "active");
  appendHook("Stop", undefined, "stop");

  settings.hooks = hooks;
}

/**
 * Remove our hooks from settings, identified by session-state.js in the command string.
 */
function removeHooks(settings: Record<string, unknown>): void {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) {
    return;
  }

  for (const eventType of Object.keys(hooks)) {
    const entries = hooks[eventType] as Array<Record<string, unknown>>;
    hooks[eventType] = entries.filter((entry) => {
      const entryJson = JSON.stringify(entry);
      return !entryJson.includes(HOOK_MARKER);
    });
    // Clean up empty arrays
    if ((hooks[eventType] as unknown[]).length === 0) {
      delete hooks[eventType];
    }
  }

  // Clean up empty hooks object
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }
}

/**
 * Clean up stale state files.
 */
function cleanupStateDir(): void {
  try {
    if (fs.existsSync(STATE_DIR)) {
      const files = fs.readdirSync(STATE_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(STATE_DIR, file));
      }
      fs.rmdirSync(STATE_DIR);
    }
  } catch {
    // Best effort cleanup
  }
}

/**
 * Check and prompt for hook installation on activation.
 * Returns true if hooks are installed (or were just installed).
 */
export async function ensureHooksInstalled(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const settings = readSettings();

  if (hooksInstalled(settings)) {
    const scriptBase = getHookScriptPath(context);
    if (!hooksUpToDate(settings, scriptBase)) {
      // Paths are stale (extension updated to a new directory). Silently
      // reconcile — consent was already granted at initial install.
      reconcileHookPaths(settings, scriptBase);
      writeSettings(settings);
      vscode.window.showInformationMessage(
        "Claude session hook paths updated for new extension version."
      );
    }
    return true;
  }

  // Check if user previously declined
  if (context.globalState.get<boolean>(SETUP_DECLINED_KEY)) {
    return false;
  }

  const choice = await vscode.window.showInformationMessage(
    "Claude Session Manager can notify you when a session needs attention. " +
      "This requires adding hooks to your Claude Code settings.",
    "Allow",
    "Not Now",
    "Don't Ask Again"
  );

  if (choice === "Allow") {
    try {
      const freshSettings = readSettings();
      const scriptBase = getHookScriptPath(context);
      installHooks(freshSettings, scriptBase);
      writeSettings(freshSettings);
      vscode.window.showInformationMessage("Claude session hooks installed.");
      return true;
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to install hooks: ${err instanceof Error ? err.message : err}`
      );
      return false;
    }
  }

  if (choice === "Don't Ask Again") {
    await context.globalState.update(SETUP_DECLINED_KEY, true);
  }

  return false;
}

/**
 * Manual setup command — always installs regardless of previous decline.
 */
export async function setupHooksCommand(
  context: vscode.ExtensionContext
): Promise<void> {
  const settings = readSettings();

  if (hooksInstalled(settings)) {
    vscode.window.showInformationMessage("Hooks are already installed.");
    return;
  }

  try {
    const scriptBase = getHookScriptPath(context);
    installHooks(settings, scriptBase);
    writeSettings(settings);
    await context.globalState.update(SETUP_DECLINED_KEY, undefined);
    vscode.window.showInformationMessage("Claude session hooks installed.");
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to install hooks: ${err instanceof Error ? err.message : err}`
    );
  }
}

/**
 * Remove our hooks and clean up state files. Called on deactivate().
 */
export function uninstallHooks(): void {
  try {
    const settings = readSettings();
    if (hooksInstalled(settings)) {
      removeHooks(settings);
      writeSettings(settings);
    }
  } catch {
    // Best effort on deactivate
  }

  cleanupStateDir();
}
