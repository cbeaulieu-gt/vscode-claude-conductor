/**
 * Extract the body of a versioned section from a CHANGELOG markdown string.
 *
 * Finds the section that begins with `## [<version>]` (exact version match,
 * dots treated as literals). Captures everything after that heading line up
 * to — but not including — the next `## [` heading, or the end of the string.
 *
 * @param markdown  - Full CHANGELOG content as a string.
 * @param version   - The version to look up, e.g. "1.3.0".
 * @returns The section body (leading/trailing whitespace trimmed), or null if
 *          the section is not found or the inputs are invalid.
 */
export function extractChangelogSection(
  markdown: string,
  version: string
): string | null;
