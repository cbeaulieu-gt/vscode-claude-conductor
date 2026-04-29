/**
 * Tests for the groupByProjectRoot helper (src/projectGrouping.ts).
 *
 * This module is pure — no VS Code dependencies — so tests run in plain Node
 * without any mocks.
 */

import { describe, it, expect } from "vitest";
import { groupByProjectRoot, isWorktreePath } from "../src/projectGrouping";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a simple item whose path is the string itself. */
const item = (p: string) => p;
const getPath = (p: string) => p;

// ---------------------------------------------------------------------------
// Basic grouping
// ---------------------------------------------------------------------------

describe("groupByProjectRoot — basic grouping", () => {
  it("single project with no worktrees → one group, top set, children empty, isPhantom false", () => {
    const items = ["/home/user/my-project"];
    const groups = groupByProjectRoot(items, getPath);

    expect(groups).toHaveLength(1);
    expect(groups[0].root).toBe("/home/user/my-project");
    expect(groups[0].top).toBe("/home/user/my-project");
    expect(groups[0].children).toHaveLength(0);
    expect(groups[0].isPhantom).toBe(false);
  });

  it("single project + 2 worktrees → one group with 2 children", () => {
    const root = "/home/user/my-project";
    const wt1 = "/home/user/my-project/.worktrees/feature-a";
    const wt2 = "/home/user/my-project/.worktrees/fix-b";
    const items = [root, wt1, wt2];

    const groups = groupByProjectRoot(items, getPath);

    expect(groups).toHaveLength(1);
    expect(groups[0].root).toBe(root);
    expect(groups[0].top).toBe(root);
    expect(groups[0].isPhantom).toBe(false);
    expect(groups[0].children).toContain(wt1);
    expect(groups[0].children).toContain(wt2);
    expect(groups[0].children).toHaveLength(2);
  });

  it("two projects interleaved → two groups, children correctly routed", () => {
    const rootA = "/home/user/project-a";
    const wtA1 = "/home/user/project-a/.worktrees/branch-1";
    const rootB = "/home/user/project-b";
    const wtB1 = "/home/user/project-b/.worktrees/branch-x";
    const items = [rootA, rootB, wtA1, wtB1];

    const groups = groupByProjectRoot(items, getPath);

    expect(groups).toHaveLength(2);

    const groupA = groups.find((g) => g.root === rootA);
    const groupB = groups.find((g) => g.root === rootB);

    expect(groupA).toBeDefined();
    expect(groupA!.children).toContain(wtA1);
    expect(groupA!.children).not.toContain(wtB1);

    expect(groupB).toBeDefined();
    expect(groupB!.children).toContain(wtB1);
    expect(groupB!.children).not.toContain(wtA1);
  });
});

// ---------------------------------------------------------------------------
// Phantom parents
// ---------------------------------------------------------------------------

describe("groupByProjectRoot — phantom parents", () => {
  it("only a worktree in input → one group, top null, isPhantom true, root derived correctly", () => {
    const wt = "/home/user/my-project/.worktrees/feature-a";
    const groups = groupByProjectRoot([wt], getPath);

    expect(groups).toHaveLength(1);
    expect(groups[0].root).toBe("/home/user/my-project");
    expect(groups[0].top).toBeNull();
    expect(groups[0].isPhantom).toBe(true);
    expect(groups[0].children).toContain(wt);
    expect(groups[0].children).toHaveLength(1);
  });

  it("top-level item that has no worktree relation → own group, isPhantom false, top set, children empty", () => {
    const plain = "/home/user/some-folder";
    const groups = groupByProjectRoot([plain], getPath);

    expect(groups).toHaveLength(1);
    expect(groups[0].root).toBe(plain);
    expect(groups[0].top).toBe(plain);
    expect(groups[0].isPhantom).toBe(false);
    expect(groups[0].children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Windows path handling
// ---------------------------------------------------------------------------

describe("groupByProjectRoot — Windows paths", () => {
  it("Windows paths with backslash separators produce the same grouping as forward slashes", () => {
    const root = "C:\\Users\\chris\\my-project";
    const wt = "C:\\Users\\chris\\my-project\\.worktrees\\feature-branch";
    const items = [root, wt];

    const groups = groupByProjectRoot(items, getPath);

    expect(groups).toHaveLength(1);
    expect(groups[0].top).toBe(root);
    expect(groups[0].children).toContain(wt);
    expect(groups[0].isPhantom).toBe(false);
  });

  it("case-insensitive matching on Windows-style paths: worktree groups under its parent regardless of case", () => {
    const root = "C:\\Repo";
    const wt = "c:\\repo\\.worktrees\\x";
    const items = [root, wt];

    const groups = groupByProjectRoot(items, getPath);

    expect(groups).toHaveLength(1);
    expect(groups[0].children).toContain(wt);
    expect(groups[0].top).toBe(root);
  });

  it("phantom parent derived correctly from Windows backslash path", () => {
    const wt = "C:\\Users\\chris\\my-project\\.worktrees\\feature-branch";
    const groups = groupByProjectRoot([wt], getPath);

    expect(groups).toHaveLength(1);
    expect(groups[0].root.toLowerCase()).toBe("c:\\users\\chris\\my-project");
    expect(groups[0].isPhantom).toBe(true);
    expect(groups[0].top).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Not-a-worktree edge cases
// ---------------------------------------------------------------------------

describe("groupByProjectRoot — not-a-worktree edge cases", () => {
  it("path with .worktrees two levels deep does NOT count as a child (out of spec)", () => {
    const root = "/home/user/my-project";
    const deepNested = "/home/user/my-project/.worktrees/a/b";
    const items = [root, deepNested];

    const groups = groupByProjectRoot(items, getPath);

    // The deep-nested path is NOT a direct worktree child of root,
    // so it should form its own group (or be ungrouped as a standalone item).
    const rootGroup = groups.find((g) => g.root === root);
    expect(rootGroup!.children).not.toContain(deepNested);
  });

  it("folder literally named '.worktrees' at project root is not treated as a worktree", () => {
    // A path like /home/user/my-project/.worktrees (no branch segment after)
    // has nothing after .worktrees so it cannot be a worktree.
    const root = "/home/user/my-project";
    const worktreesDir = "/home/user/my-project/.worktrees";
    const items = [root, worktreesDir];

    const groups = groupByProjectRoot(items, getPath);

    const rootGroup = groups.find((g) => g.root === root);
    // The .worktrees dir itself should NOT be counted as a child worktree
    expect(rootGroup!.children).not.toContain(worktreesDir);
  });
});

// ---------------------------------------------------------------------------
// isWorktreePath
// ---------------------------------------------------------------------------

describe("isWorktreePath", () => {
  it("matches a basic .worktrees branch path with forward slashes", () => {
    expect(isWorktreePath("C:/proj/.worktrees/fix-bug")).toBe(true);
  });

  it("matches a path with backslashes (Windows native)", () => {
    expect(isWorktreePath("C:\\proj\\.worktrees\\fix-bug")).toBe(true);
  });

  it("matches a path with a trailing separator (regression for v3 raw-input gap)", () => {
    expect(isWorktreePath("C:\\proj\\.worktrees\\fix-bug\\")).toBe(true);
    expect(isWorktreePath("C:/proj/.worktrees/fix-bug/")).toBe(true);
  });

  it("rejects a project root (no .worktrees segment)", () => {
    expect(isWorktreePath("C:\\proj")).toBe(false);
    expect(isWorktreePath("/home/user/proj")).toBe(false);
  });

  it("rejects a .worktrees directory itself with no branch segment", () => {
    expect(isWorktreePath("C:/proj/.worktrees")).toBe(false);
    expect(isWorktreePath("C:/proj/.worktrees/")).toBe(false);
  });

  it("rejects a nested path beneath a worktree (more than one segment under .worktrees)", () => {
    expect(isWorktreePath("C:/proj/.worktrees/fix-bug/src")).toBe(false);
  });

  it("is case-insensitive on the .worktrees segment", () => {
    expect(isWorktreePath("C:/proj/.WorkTrees/branch")).toBe(true);
  });
});
