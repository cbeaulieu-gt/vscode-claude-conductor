/**
 * PathExistenceCache — tracks whether filesystem paths exist, with TTL-based staleness.
 *
 * Design notes:
 * - `peek()` is synchronous for use inside `getTreeItem` (called by both tree providers).
 * - "missing" entries stay dimmed (stale=true) across TTL expiry until a fresh stat lands,
 *   avoiding the v2 "flicker" failure mode where entries would briefly appear as unknown.
 * - "exists" entries collapse to unknown after TTL so a deleted path gets re-checked.
 * - Keys are canonicalized (lowercase, forward-slash, no trailing slash) so Windows paths
 *   with mixed separators and casing compare equal.
 * - UNC paths (\\server\share or //server/share) are skipped in refresh() to avoid
 *   hangs on unavailable network shares.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import { canonicalKey } from "./pathCanonical";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ExistenceState =
  | { kind: "exists"; checkedAt: number }
  | { kind: "missing"; checkedAt: number }
  | { kind: "unknown" };

export type PeekResult =
  | { kind: "exists" }
  | { kind: "missing"; stale: boolean }
  | { kind: "unknown" };

export type CacheChangeEvent =
  | { kind: "single"; path: string }
  | { kind: "broad" };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TTL_MS = 30_000;
const STAT_TIMEOUT_MS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true for UNC paths (\\server\share or //server/share). */
function isLikelyNetworkPath(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}

/**
 * Stat a path with a hard timeout.
 * Resolves to: true=exists, false=missing, null=timed out (cache left unchanged).
 */
function statWithTimeout(p: string): Promise<boolean | null> {
  return new Promise(resolve => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, STAT_TIMEOUT_MS);

    fs.stat(p, err => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(err === null);
    });
  });
}

// ---------------------------------------------------------------------------
// PathExistenceCache
// ---------------------------------------------------------------------------

export class PathExistenceCache {
  private readonly cache = new Map<string, ExistenceState>();
  private readonly _onDidChange = new vscode.EventEmitter<CacheChangeEvent>();

  /** Subscribe to cache change events. */
  readonly onDidChange = this._onDidChange.event;

  /**
   * Test seam: inject a replacement for the real `statWithTimeout` so unit
   * tests can verify refresh() behavior without hitting the filesystem.
   * @internal — do not use in production code.
   */
  private _statForTest?: (p: string) => Promise<boolean | null>;

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Synchronously read the current state of a path.
   *
   * - "exists"  — confirmed present within TTL
   * - "missing" — confirmed absent; stale=true means TTL has elapsed but the
   *               entry is intentionally retained (avoids v2 flicker)
   * - "unknown" — never checked, or an "exists" entry whose TTL has lapsed
   */
  peek(p: string): PeekResult {
    const e = this.cache.get(canonicalKey(p));
    if (!e || e.kind === "unknown") return { kind: "unknown" };
    const stale = Date.now() - e.checkedAt > TTL_MS;
    if (e.kind === "missing") return { kind: "missing", stale };
    // "exists": collapse to unknown when stale so the path gets re-checked
    if (stale) return { kind: "unknown" };
    return { kind: "exists" };
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /** Record that a path exists and notify listeners. */
  markPresent(p: string): void {
    this.cache.set(canonicalKey(p), { kind: "exists", checkedAt: Date.now() });
    this._onDidChange.fire({ kind: "single", path: p });
  }

  /** Record that a path is missing and notify listeners. */
  markMissing(p: string): void {
    this.cache.set(canonicalKey(p), { kind: "missing", checkedAt: Date.now() });
    this._onDidChange.fire({ kind: "single", path: p });
  }

  /**
   * Remove a path from the cache. Only fires `onDidChange` if the path was
   * actually present (no spurious events for paths that were never tracked).
   */
  evict(p: string): void {
    if (this.cache.delete(canonicalKey(p))) {
      this._onDidChange.fire({ kind: "single", path: p });
    }
  }

  // -------------------------------------------------------------------------
  // Async refresh
  // -------------------------------------------------------------------------

  /**
   * Stat a list of paths and update the cache.
   *
   * - UNC paths are skipped entirely (network share hangs).
   * - Paths that time out leave the cache unchanged.
   * - Fires a single "broad" event if any entry changed kind.
   */
  async refresh(paths: string[]): Promise<void> {
    const stat = this._statForTest ?? statWithTimeout;
    const toCheck = paths.filter(p => !isLikelyNetworkPath(p));
    let anyChange = false;

    for (const p of toCheck) {
      const result = await stat(p);
      if (result === null) continue; // timeout — leave cache alone
      const key = canonicalKey(p);
      const prev = this.cache.get(key);
      const next: ExistenceState = result
        ? { kind: "exists", checkedAt: Date.now() }
        : { kind: "missing", checkedAt: Date.now() };
      this.cache.set(key, next);
      if (!prev || prev.kind !== next.kind) anyChange = true;
    }

    if (anyChange) this._onDidChange.fire({ kind: "broad" });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  dispose(): void {
    this._onDidChange.dispose();
  }
}
