import { describe, it, expect } from "vitest";
import { extractChangelogSection } from "../scripts/extract-changelog.js";

// Sample CHANGELOG content used across test cases
const SAMPLE_CHANGELOG = `# Changelog

## [Unreleased]

_No unreleased changes._

## [2.0.0] — 2026-05-01

### Added
- Big new feature

## [1.3.0] — 2026-04-23

### Added
- Vitest test infrastructure

### Fixed
- Shell init race condition

## [1.1.5] — 2026-04-19

### Fixed
- README marketplace badges now render
`;

describe("extractChangelogSection", () => {
  // --- happy paths ---

  it("returns body for section at the top (2.0.0 is first versioned section)", () => {
    const result = extractChangelogSection(SAMPLE_CHANGELOG, "2.0.0");
    expect(result).toContain("Big new feature");
    // Should NOT include the next heading
    expect(result).not.toContain("## [1.3.0]");
    // Should NOT include the heading line itself
    expect(result).not.toContain("## [2.0.0]");
  });

  it("returns body for section in middle (1.3.0)", () => {
    const result = extractChangelogSection(SAMPLE_CHANGELOG, "1.3.0");
    expect(result).toContain("Vitest test infrastructure");
    expect(result).toContain("Shell init race condition");
    // Bounded above by 2.0.0 heading and below by 1.1.5 heading
    expect(result).not.toContain("## [2.0.0]");
    expect(result).not.toContain("## [1.1.5]");
  });

  it("returns body for section at end of file (1.1.5)", () => {
    const result = extractChangelogSection(SAMPLE_CHANGELOG, "1.1.5");
    expect(result).toContain("README marketplace badges now render");
    expect(result).not.toContain("## [1.3.0]");
  });

  // --- not found / empty / malformed ---

  it("returns null when the version section is not present", () => {
    const result = extractChangelogSection(SAMPLE_CHANGELOG, "9.9.9");
    expect(result).toBeNull();
  });

  it("returns null for an empty CHANGELOG string", () => {
    const result = extractChangelogSection("", "1.3.0");
    expect(result).toBeNull();
  });

  it("returns null when CHANGELOG contains no '## [' headings at all", () => {
    const result = extractChangelogSection("# Just a title\nSome prose.", "1.3.0");
    expect(result).toBeNull();
  });

  // --- regex safety ---

  it("matches version containing dots literally, not as regex wildcards (1.3.0 must not match 1X3Y0)", () => {
    // "1X3Y0" would match /1.3.0/ if dots were treated as regex wildcards
    const deceptive = `# Changelog\n\n## [1X3Y0] — 2026-01-01\n\n- fake\n`;
    const result = extractChangelogSection(deceptive, "1.3.0");
    expect(result).toBeNull();
  });

  it("finds the real 1.3.0 section even when a deceptive near-match precedes it", () => {
    const content = `# Changelog\n\n## [1X3Y0] — 2026-01-01\n\n- fake\n\n## [1.3.0] — 2026-04-23\n\n- real\n`;
    const result = extractChangelogSection(content, "1.3.0");
    expect(result).not.toBeNull();
    expect(result).toContain("real");
    expect(result).not.toContain("fake");
  });
});
