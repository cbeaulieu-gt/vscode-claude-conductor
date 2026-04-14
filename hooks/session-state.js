#!/usr/bin/env node
/**
 * Claude Code hook script for session state tracking.
 * Called by hooks configured in ~/.claude/settings.json.
 *
 * Usage:
 *   node session-state.js idle    — session is idle (waiting for input)
 *   node session-state.js active  — session is active (user submitted prompt)
 *   node session-state.js stop    — session ended (delete state file)
 *
 * Reads hook event data from stdin (JSON), writes state to
 * ~/.claude/session-state/<cwd-hash>.json
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const STATE_DIR = path.join(os.homedir(), ".claude", "session-state");
const action = process.argv[2]; // "idle", "active", or "stop"

/**
 * Read all of stdin as a string.
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    // If stdin is empty or closed immediately, resolve after a short timeout
    setTimeout(() => resolve(data), 500);
  });
}

/**
 * Create a stable hash from a folder path for the state filename.
 */
function cwdHash(cwd) {
  return crypto.createHash("md5").update(cwd.toLowerCase()).digest("hex").slice(0, 12);
}

async function main() {
  if (!action || !["idle", "active", "stop"].includes(action)) {
    process.stderr.write(`session-state.js: unknown action "${action}"\n`);
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // Read hook event data from stdin
  let eventData = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      eventData = JSON.parse(raw);
    }
  } catch {
    // If stdin parse fails, continue with empty data
  }

  // Extract cwd from event data — hooks receive it in various places
  const cwd = eventData.cwd || eventData.tool_input?.cwd || process.cwd();
  const sessionId = eventData.session_id || "unknown";
  const hash = cwdHash(cwd);
  const stateFile = path.join(STATE_DIR, `${hash}.json`);

  try {
    if (action === "stop") {
      // Delete state file on session end
      if (fs.existsSync(stateFile)) {
        fs.unlinkSync(stateFile);
      }
    } else {
      // Ensure state directory exists
      fs.mkdirSync(STATE_DIR, { recursive: true });

      // Write state
      const state = {
        state: action, // "idle" or "active"
        cwd: cwd,
        sessionId: sessionId,
        timestamp: Date.now(),
      };
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    }
  } catch (err) {
    process.stderr.write(`session-state.js: ${err.message}\n`);
  }

  // Always allow Claude to continue
  process.stdout.write(JSON.stringify({ continue: true }));
}

main();
