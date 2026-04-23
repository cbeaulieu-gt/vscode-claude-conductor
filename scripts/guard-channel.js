// guard-channel.js
//
// VS Code Marketplace version-parity guard.
//
// Rule: the minor version number encodes the publish channel.
//   Even minor (0, 2, 4, …) → stable channel   (vsce publish)
//   Odd  minor (1, 3, 5, …) → pre-release channel (vsce publish --pre-release)
//
// This mirrors Microsoft's own convention for first-party VS Code extensions.
// See: https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions
//
// Usage (CLI):
//   node scripts/guard-channel.js <stable|prerelease>
//
// Usage (programmatic):
//   const { validateChannel } = require('./scripts/guard-channel');
//   validateChannel('1.2.0', 'stable');  // throws on mismatch

"use strict";

/**
 * Validate that a semver version string is compatible with the target publish
 * channel, using the odd/even minor convention.
 *
 * Contract:
 *   - Throws an Error with a descriptive message on any problem.
 *   - Returns undefined (void) on success.
 *
 * @param {string} version  - The version string from package.json (e.g. "1.2.0").
 * @param {"stable"|"prerelease"} channel - The intended publish channel.
 * @throws {Error} If the version is malformed, the channel is unknown, or the
 *                 minor parity does not match the channel.
 */
function validateChannel(version, channel) {
  // --- validate channel arg ---
  if (channel !== "stable" && channel !== "prerelease") {
    throw new Error(
      `Unknown channel "${channel}". Expected "stable" or "prerelease".`
    );
  }

  // --- validate & parse version ---
  if (!version || typeof version !== "string") {
    throw new Error(`Malformed version: expected a non-empty string, got ${JSON.stringify(version)}.`);
  }

  const parts = version.split(".");
  if (parts.length !== 3) {
    throw new Error(`Malformed version "${version}": expected MAJOR.MINOR.PATCH format.`);
  }

  const minor = parseInt(parts[1], 10);
  if (isNaN(minor)) {
    throw new Error(`Invalid version "${version}": minor segment "${parts[1]}" is not a number.`);
  }

  const isEven = minor % 2 === 0;

  // --- parity check ---
  if (channel === "stable" && !isEven) {
    throw new Error(
      `Version ${version} has ODD minor (${minor}) — cannot publish as stable. ` +
      `Bump to ${parts[0]}.${minor + 1}.0 first, or use \`npm run publish:prerelease\`.`
    );
  }

  if (channel === "prerelease" && isEven) {
    throw new Error(
      `Version ${version} has EVEN minor (${minor}) — cannot publish as pre-release. ` +
      `Bump to ${parts[0]}.${minor + 1}.0 first, or use \`npm run publish:stable\`.`
    );
  }
}

module.exports = { validateChannel };

// CLI entrypoint
if (require.main === module) {
  const channel = process.argv[2];

  if (!channel || (channel !== "stable" && channel !== "prerelease")) {
    process.stderr.write(
      "Usage: node scripts/guard-channel.js <stable|prerelease>\n"
    );
    process.exit(2);
  }

  // Read package.json relative to this script file
  const path = require("path");
  const fs = require("fs");
  const pkgPath = path.resolve(__dirname, "..", "package.json");

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (err) {
    process.stderr.write(`Failed to read package.json: ${err.message}\n`);
    process.exit(3);
  }

  const version = pkg.version;
  if (!version) {
    process.stderr.write(`package.json does not contain a "version" field.\n`);
    process.exit(3);
  }

  try {
    validateChannel(version, channel);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }

  process.exit(0);
}
