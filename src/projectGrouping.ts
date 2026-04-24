/**
 * Pure grouping helper — zero VS Code dependencies.
 *
 * Detects which items in a flat list are worktrees under a shared project root
 * and groups them into a two-level structure that both ActiveSessionsProvider
 * and RecentProjectsProvider can consume.
 *
 * Detection rule (per spec):
 *   A path P is a worktree of root R iff:
 *     normalise(P) === normalise(R) + sep + ".worktrees" + sep + <branch-segment>
 *   where <branch-segment> is exactly ONE path segment (no further slashes).
 *   Both "\" and "/" are treated as separators; comparison is case-insensitive.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectGroup<T> {
  /** The project root path (may be phantom — not present in the original input). */
  root: string;
  /**
   * True when no item in the input matches `root` exactly. The root was
   * synthesised from a worktree path.
   */
  isPhantom: boolean;
  /** Worktree children (.worktrees/<branch>) under this root. */
  children: T[];
  /** The item whose path equals `root`, or null when isPhantom. */
  top: T | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalise separators to "/" and lowercase for comparison only. */
function normKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Normalise a path string to forward slashes only (preserves case). */
function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * If `p` is a worktree path (i.e. ends with `/.worktrees/<single-segment>`),
 * return the project root path (same casing as the input) and branch name.
 * Returns null if `p` does not match the pattern.
 */
function parseWorktreePath(p: string): { root: string; branch: string } | null {
  // Normalise to forward slashes for the regex. The original string and the
  // normalised version have the same length (backslash ↔ forward slash are
  // both one byte), so we can use segment counts to reconstruct the root.
  const fwd = toForwardSlashes(p);
  // Match exactly: <anything>/.worktrees/<single-segment-no-slash>
  const m = fwd.match(/^(.+)\/.worktrees\/([^/]+)$/i);
  if (!m) {
    return null;
  }
  const rootFwd = m[1];
  const branch = m[2];

  // Count segments in the forward-slash root to slice the original path.
  // Split original on both separators; take the same number of parts.
  const rootSegmentCount = rootFwd.split("/").length;
  const allParts = p.split(/[\\/]/);
  const rootParts = allParts.slice(0, rootSegmentCount);
  // Preserve the original separator style so the root looks native.
  const sep = p.includes("\\") ? "\\" : "/";
  const root = rootParts.join(sep);

  return { root, branch };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Group a flat list of items into project root + worktree-children buckets.
 *
 * @param items   Flat list of items to group.
 * @param getPath Extracts the filesystem path from an item.
 * @returns       One ProjectGroup per unique project root, in the order the
 *                root was first encountered (either directly or via a worktree).
 */
export function groupByProjectRoot<T>(
  items: T[],
  getPath: (item: T) => string
): ProjectGroup<T>[] {
  // Map from normalised root key → group (mutable during construction).
  const groupMap = new Map<string, ProjectGroup<T>>();

  // Canonical (original-case) root string per key — first root encountered wins.
  const canonicalRoot = new Map<string, string>();

  /** Get-or-create a group for `rootKey`, using `rootStr` as canonical name. */
  const getOrCreate = (rootKey: string, rootStr: string): ProjectGroup<T> => {
    if (!groupMap.has(rootKey)) {
      groupMap.set(rootKey, {
        root: rootStr,
        isPhantom: true, // will be set false if a top item is found
        children: [],
        top: null,
      });
      canonicalRoot.set(rootKey, rootStr);
    }
    return groupMap.get(rootKey)!;
  };

  for (const item of items) {
    const p = getPath(item);
    const parsed = parseWorktreePath(p);

    if (parsed !== null) {
      // This item is a worktree — add it as a child of its root.
      const rootKey = normKey(parsed.root);
      const group = getOrCreate(rootKey, parsed.root);
      group.children.push(item);
    } else {
      // This item is a regular path — it becomes the `top` of its own group.
      const rootKey = normKey(p);
      const group = getOrCreate(rootKey, p);
      group.top = item;
      group.isPhantom = false;
      // Prefer the canonical spelling from the top item itself.
      group.root = p;
      canonicalRoot.set(rootKey, p);
    }
  }

  return Array.from(groupMap.values());
}
