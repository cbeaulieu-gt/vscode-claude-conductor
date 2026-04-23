// extract-changelog.js
//
// Extracts the body of a versioned section from CHANGELOG.md.
//
// Usage (CLI):
//   node scripts/extract-changelog.js <version>  — e.g. "1.3.0"
//   Emits the section body (without the heading line) to stdout.
//   Exit codes:
//     0 — success
//     1 — section not found in CHANGELOG
//     2 — CHANGELOG.md missing or unreadable
//     3 — missing or invalid version argument
//
// Usage (programmatic):
//   const { extractChangelogSection } = require('./scripts/extract-changelog');
//   const body = extractChangelogSection(markdownString, '1.3.0');
//   // Returns the body string, or null if the section is not found.

"use strict";

/**
 * Extract the body of a versioned section from a CHANGELOG markdown string.
 *
 * Finds the section that begins with `## [<version>]` (exact version match,
 * dots are treated as literals, not regex wildcards). Captures everything
 * after that heading line up to — but not including — the next `## [` heading,
 * or the end of the string.
 *
 * @param {string} markdown  - Full CHANGELOG content as a string.
 * @param {string} version   - The version to look up, e.g. "1.3.0".
 * @returns {string|null}    - The section body (leading/trailing whitespace
 *                             trimmed), or null if not found / input invalid.
 */
function extractChangelogSection(markdown, version) {
  if (!markdown || typeof markdown !== "string" || !markdown.trim()) {
    return null;
  }

  if (!version || typeof version !== "string") {
    return null;
  }

  // Escape regex-special characters in the version string so "1.3.0" matches
  // literally and not as "1X3Y0".
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Match the heading line for this version, then capture everything up to
  // the next ## [ heading or end of string.
  const pattern = new RegExp(
    `^## \\[${escapedVersion}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|\\Z)`,
    "m"
  );

  // The \Z anchor isn't supported in JS regex; use alternation with $ and the
  // end-of-string position by replacing \Z with end-of-input via a two-pass
  // approach: try the bounded match first, then the unbounded (last section).
  const boundedPattern = new RegExp(
    `^## \\[${escapedVersion}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[)`,
    "m"
  );
  const unboundedPattern = new RegExp(
    `^## \\[${escapedVersion}\\][^\\n]*\\n([\\s\\S]*)$`,
    "m"
  );

  const bounded = boundedPattern.exec(markdown);
  if (bounded) {
    return bounded[1].trim();
  }

  const unbounded = unboundedPattern.exec(markdown);
  if (unbounded) {
    return unbounded[1].trim();
  }

  return null;
}

module.exports = { extractChangelogSection };

// CLI entrypoint
if (require.main === module) {
  const version = process.argv[2];

  if (!version || typeof version !== "string" || !version.trim()) {
    process.stderr.write(
      "Usage: node scripts/extract-changelog.js <version>\n" +
        "  e.g.: node scripts/extract-changelog.js 1.3.0\n"
    );
    process.exit(3);
  }

  const path = require("path");
  const fs = require("fs");
  const changelogPath = path.join(__dirname, "..", "CHANGELOG.md");

  let markdown;
  try {
    markdown = fs.readFileSync(changelogPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `Failed to read CHANGELOG.md at ${changelogPath}: ${err.message}\n`
    );
    process.exit(2);
  }

  const body = extractChangelogSection(markdown, version);

  if (body === null) {
    process.stderr.write(
      `Section for version [${version}] not found in CHANGELOG.md\n`
    );
    process.exit(1);
  }

  process.stdout.write(body + "\n");
  process.exit(0);
}
