# Design Spec — Favorites Sidebar Section (Issue #75)

**Status:** Draft v3 (post second inquisitor review)
**Date:** 2026-04-28
**Issue:** [#75](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/75)
**Branch:** `75-favorites`

## Revision History

- **v1 (2026-04-28)** — initial brainstorm output.
- **v2 (2026-04-28)** — addressed inquisitor pass 1 (cross-panel race, UNC hangs, viewItem migration first attempt, storage shape, click-hijack).
- **v3 (2026-04-28)** — addressed inquisitor pass 2:
  - **Blocker fixes:** composite single-token contextValues (no multi-token regex matching); serialized persist queue with snapshot rollback; `version` envelope on storage with deferred-on-mutation migration; click-on-missing opens relocate dialog directly.
  - **Smaller fixes:** `peek()` keeps last-known on TTL expiry with `stale` flag; regex anchoring; bidirectional drift test; render-path 25-cap enforcement; relocate same-path toast restored; targeted `onDidChangeTreeData` invalidation; UNC launch failure feeds existence cache; cache eviction on remove/relocate; explicit `isWorktreePath` predicate sourced from `projectGrouping.ts`.
  - **YAGNI cut:** removed the `id: string` UUID field. Storage shape stays object-based (extensible) without a speculative identifier no v1 feature reads.

## Summary

Add a third top-level tree view, **Favorites**, to the Claude Conductor sidebar. It sits between **Active Sessions** and **Recent Projects** and renders user-pinned project roots, reusing the existing two-level grouping helper so worktrees nest under their parent project exactly as they do in Recent Projects today.

Favorites is a **manual curation overlay**, not a usage tracker. Pinning a project does not affect Recent Projects (parallel lists). Favoriting is per-machine via `globalState`. There is no auto-frequency tracking and no Settings Sync involvement in v1.

## Goals

- One-click access to a curated set of project roots, near the top of the sidebar.
- Reuse `projectGrouping.ts` and `RecentProjectsProvider` patterns — minimal new architecture.
- Tolerate transient absence (unmounted drives) and intentional moves (folder relocated on disk) without silent data loss.
- Keep the design scoped — no drag-to-reorder, no per-worktree pinning, no auto-tracking.
- Extensible storage shape so deferred features land non-breakingly.

## Non-Goals (with rationale)

- **Drag-to-reorder.** Deferred. Soft cap of 25 favorites enforced both at `addFavorite` (toast on overflow) AND at the render path (truncate display + log warning if storage drifts past). Past 25 alphabetical-only ordering is unusable; that's the trigger to revisit.
- **Per-worktree favorites.** Excluded. Favorites are project-rooted; worktrees come along via grouping. Both `addFavorite` and `locateFavorite` reject worktree paths via the shared `isWorktreePath()` predicate.
- **Auto-frequency tracking.** Out of scope per the issue.
- **Settings Sync (`setKeysForSync`).** Explicitly NOT registered in v1 because path portability across machines is unsolved (drive letters, project locations differ). The object-shape storage means adding sync later is non-breaking. A sync-portable identifier (UUID, content hash, or symbolic name) would be added at that time — *not* speculatively now.
- **Stable per-entry identifier.** Removed from v3. v2 added `id: string` to "future-proof" sync; the inquisitor pass correctly flagged this as YAGNI — no v1 feature reads it, multi-window cold-start migrates the same v1 data twice and races UUIDs, and any future identifier scheme has constraints we don't know yet (deterministic vs random, content vs path). Storage stays `[{path: string}]`; the object envelope is the actual extensibility hedge.
- **Cross-workspace filtering.** Favorites are user-global. Opening a workspace where most favorited paths live elsewhere produces `(missing)` rows for those paths. v1 accepts this; the dimmed visual treatment is intentionally unobtrusive.
- **Symlink/junction canonicalization.** Canonical key skips `realpathSync` (which throws on missing paths the relocate flow needs to handle uniformly). Documented tradeoff: two distinct path strings resolving to the same directory produce duplicate entries.

## Architecture

### View Registration

Add a third `TreeView` contribution in `package.json`:

```json
"views": {
  "claudeConductor": [
    { "id": "claudeConductor.activeSessions", "name": "Active Sessions" },
    { "id": "claudeConductor.favorites",      "name": "Favorites" },
    { "id": "claudeConductor.recentProjects", "name": "Recent Projects" }
  ]
}
```

### `FavoritesStore` service (new file: `src/favoritesStore.ts`)

A standalone service that owns all favorites state. Both providers consult it; neither owns it. The persist path is **serialized**: at most one `memento.update` is in flight at a time, ensuring rollback semantics are deterministic.

```typescript
export interface FavoritesEntry { path: string; }
export interface FavoritesStorageEnvelope {
  version: 2;
  entries: FavoritesEntry[];
}

export class FavoritesStore {
  private entries: FavoritesEntry[] = [];
  private keyIndex: Set<string> = new Set();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  // Serialized persist queue
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly memento: vscode.Memento) {
    this.entries = readWithoutMigrating(memento);  // pure read; no write side effects
    this.rebuildIndex();
  }

  // ---- Synchronous reads (called from getTreeItem) ----
  isFavorited(path: string): boolean {
    return this.keyIndex.has(canonicalKey(path));
  }
  list(): readonly FavoritesEntry[] { return this.entries; }

  // ---- Async mutations — all routed through enqueueMutation ----
  async add(path: string): Promise<{ ok: boolean; reason?: string }> { ... }
  async remove(path: string): Promise<void> { ... }
  async relocate(oldPath: string, newPath: string): Promise<{ ok: boolean; reason?: string }> { ... }

  /**
   * Serialized mutation: snapshot, apply in memory, fire change, then chain
   * the persist behind any in-flight persist. Rollback to snapshot on reject.
   */
  private enqueueMutation(apply: (entries: FavoritesEntry[]) => FavoritesEntry[]): Promise<void> {
    const snapshot = [...this.entries];
    this.entries = apply(snapshot);
    this.rebuildIndex();
    this._onDidChange.fire();

    this.persistChain = this.persistChain
      .catch(() => { /* swallow prior errors; each link handles its own rollback */ })
      .then(() => this.memento.update(STORAGE_KEY, { version: 2, entries: this.entries }))
      .catch(err => {
        // Roll back to the snapshot taken when *this* mutation was enqueued.
        // If subsequent mutations succeeded on top of this one, they're now
        // also rolled back — that's the contract of serialized persists:
        // failure of an earlier persist invalidates all later in-memory
        // mutations chained on it.
        this.entries = snapshot;
        this.rebuildIndex();
        this._onDidChange.fire();
        showPersistErrorToast(err);
      });

    return this.persistChain;
  }

  private rebuildIndex(): void {
    this.keyIndex = new Set(this.entries.map(e => canonicalKey(e.path)));
  }
}
```

**Why the persist queue is serialized:** the inquisitor's pass-2 charge correctly identified that `memento.update` rejecting after multiple mutations have stacked produces undefined rollback behavior. Serializing means there's only ever one in-flight persist whose rejection has unambiguous semantics: roll the in-memory state back to the snapshot taken when *that mutation* was enqueued. Any subsequent mutations chained behind it are also rolled back — they were predicated on the failed persist's success.

This costs latency on rapid-fire toggles (each waits behind the previous's persist) but is correct. For a curated list capped at 25 entries, latency is irrelevant.

### Canonical Key

```typescript
/**
 * Canonical lookup key. Pipeline: separator normalize → trim trailing
 * separator → case-fold (lower). Does NOT consult realpathSync — see
 * Non-Goals for the symlink tradeoff rationale.
 */
function canonicalKey(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}
```

Used identically in: `add` dedup, `relocate` dedup, `isFavorited`, and the existence cache key. No alternate normalizations anywhere.

### Worktree Path Predicate

`isWorktreePath(p: string): boolean` is exported from `src/projectGrouping.ts` (the same module that already has the worktree-detection regex internally). The predicate matches the existing detection rule: path ends with `/.worktrees/<single-segment>` after separator normalization, case-insensitive.

```typescript
// Exported from src/projectGrouping.ts
export function isWorktreePath(p: string): boolean {
  return /\/\.worktrees\/[^/]+$/i.test(p.replace(/\\/g, "/"));
}
```

This is the *only* predicate used to reject worktree paths in `addFavorite` and `locateFavorite`. No other heuristics, no shell-out to git.

### Existence Cache (async, stale-aware, UNC-skipping)

```typescript
type ExistenceState =
  | { kind: "exists"; checkedAt: number }
  | { kind: "missing"; checkedAt: number }
  | { kind: "unknown" };  // never checked

class PathExistenceCache {
  private cache = new Map<string, ExistenceState>();
  private readonly TTL_MS = 30_000;
  private readonly STAT_TIMEOUT_MS = 500;

  /**
   * Synchronous read for getTreeItem.
   * Returns: 'exists' | 'missing' | { kind: 'missing', stale: true } | 'unknown'.
   * Stale-missing keeps the dimmed render until the next stat lands.
   */
  peek(path: string): { kind: "exists" } | { kind: "missing"; stale: boolean } | { kind: "unknown" } {
    const e = this.cache.get(canonicalKey(path));
    if (!e || e.kind === "unknown") return { kind: "unknown" };
    const stale = Date.now() - e.checkedAt > this.TTL_MS;
    if (e.kind === "missing") return { kind: "missing", stale };
    if (stale) return { kind: "unknown" };  // exists+stale → re-confirm; safe to show present optimistically meanwhile
    return { kind: "exists" };
  }

  /** Mark a path missing immediately (e.g., after a launch failure). */
  markMissing(path: string): void { ... }

  /** Evict cache entry — called on remove/relocate. */
  evict(path: string): void { ... }

  /** Background refresh; non-blocking, with timeout. UNC paths skipped. */
  async refresh(paths: string[]): Promise<void> { ... }
}

function isLikelyNetworkPath(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}
```

**Behavior:**
- `peek`'s asymmetric staleness (return `unknown` for stale-exists but stale-missing for stale-missing) avoids the v2 flicker: a confirmed-missing entry stays dimmed across TTL expiry until a fresh stat result lands. No 30s on/off oscillation.
- `markMissing(path)` is called from `launchSession` failure handlers when launching a UNC favorite fails — the cache learns from launch attempts so repeated clicks don't keep optimistic-rendering an unreachable path.
- `evict(path)` is called by `FavoritesStore` from `remove` and `relocate` so stat results landing for stale paths never fire `onDidChange` for non-existent entries.
- UNC paths skipped by `refresh()` are still rendered as optimistic-present until a launch failure flips them to missing via `markMissing()` — feedback loop closes the v2 gap.

### Provider Refresh Decoupling

| Event | Trigger | Provider response |
|---|---|---|
| `onDidChangeSessions` (existing) | Active session set changes | RecentProjectsProvider re-fetches `getAllFolders()`, re-groups, fires `onDidChangeTreeData(undefined)` |
| `FavoritesStore.onDidChange` | Favorites set changes | Both providers fire `onDidChangeTreeData(toggledElement)` (targeted) when a single path was toggled. For multi-path mutations (e.g., relocate-with-dedup which removes one and updates another), fire `onDidChangeTreeData(undefined)`. |
| `existenceCache.onDidChange` | A row's existence state transitioned (e.g., stat result landed, `markMissing` called) | Both providers fire `onDidChangeTreeData(specificElement)` if the change is single-path; broad invalidation only when refresh batch returns >1 transition. |

**Targeted invalidation:** `FavoritesStore` exposes `onDidChange` as `Event<{ kind: "single"; path: string } | { kind: "broad" }>` (instead of `Event<void>`) so consumers can choose targeted vs full invalidation. Star-toggles emit `{ kind: "single", path }`; relocate-with-dedup and bulk operations emit `{ kind: "broad" }`.

### `viewItem` Context Values — Composite Single Tokens

**Crux of the v3 fix:** VS Code's `viewItem` matching with `==` is literal string equality. v2's "space-separated multi-token" claim was wrong. v3 uses *single composite tokens*.

| Provider | Row state | `contextValue` |
|---|---|---|
| RecentProjectsProvider (top-level) | not favorited | `recentProject.unfavorited` |
| RecentProjectsProvider (top-level) | favorited | `recentProject.favorited` |
| RecentProjectsProvider (top-level) | favorited + missing | `recentProject.missing` |
| FavoritesProvider (top-level) | present | `favoriteProject.favorited` |
| FavoritesProvider (top-level) | missing | `favoriteProject.missing` |
| Either provider (worktree child) | any | `worktreeChild` |
| ActiveSessionsProvider | unchanged | `activeSession` |

**`package.json` migration of the existing `recentProject` clause:**

```jsonc
{
  "command": "claudeConductor.openRecentProject",  // existing command
  "when": "view == claudeConductor.recentProjects && viewItem =~ /^recentProject\\b/",
  "group": "inline"
}
```

The `\b` word-boundary anchor ensures `recentProject.favorited` matches but a hypothetical future `recentProjectFoo` does not. The `^` ensures we don't match `xyzrecentProject.favorited`.

**Existing three `activeSession` clauses are unchanged** — `activeSession` is still a single literal token.

```typescript
// Exported from src/treeView.ts
export const VIEW_ITEM = {
  RECENT_PROJECT_FAVORITED:    "recentProject.favorited",
  RECENT_PROJECT_UNFAVORITED:  "recentProject.unfavorited",
  RECENT_PROJECT_MISSING:      "recentProject.missing",
  FAVORITE_PROJECT_FAVORITED:  "favoriteProject.favorited",
  FAVORITE_PROJECT_MISSING:    "favoriteProject.missing",
  WORKTREE_CHILD:              "worktreeChild",
  ACTIVE_SESSION:              "activeSession",
} as const;
```

### Storage Envelope

```typescript
const STORAGE_KEY = "claudeConductor.favorites";

interface FavoritesStorageEnvelope {
  version: 2;
  entries: { path: string }[];
}
```

| Stored value | Interpretation |
|---|---|
| `undefined` or `null` | No favorites; treat as `[]`. |
| `[]` | No favorites. |
| `string[]` (no version field) | v1 legacy. Read-time: convert to envelope shape and replace storage atomically on first **mutation** (not on first read). Multiple windows reading concurrently see the same legacy data; the migration write happens once, when the user actually changes something. |
| `{ version: 2, entries: [...] }` | v2 native; use as-is. |
| `{ version: <other>, ... }` | Future shape unknown to this build. Toast: `"Favorites storage was written by a newer version of the extension; v1 read-only mode."` Treat as `[]` for writes (no destructive overwrite), render entries best-effort if `entries` is an array. |

**Multi-window race resolution:** because migration is deferred to first mutation, two windows opening v1 data both display it correctly without writing. The first window to actually mutate triggers the migration write. The second window's `globalState` change listener (if VS Code provides one) or its next read picks up the new shape. Even if both windows mutate simultaneously, *no UUIDs are at stake* — `entries` is just `{path}` objects, dedup is canonical-key-based, and the worst case is a last-writer-wins on the entries array which is the same semantics as any concurrent storage update.

**v1-build compatibility:** the envelope shape is an object, not an array. A v1 build reading the envelope would see `Array.isArray(raw) === false` and fall through to its empty-state branch — no crash, no misinterpretation, just "no favorites" until the user upgrades again or downgrades v2. This is acceptable for a manual-curation feature where loss of pinned-state on downgrade is recoverable (re-pin a few projects).

## Commands

| Command ID | Args | Behavior |
|---|---|---|
| `claudeConductor.addFavorite` | `path: string` | Reject worktree paths via `isWorktreePath()` (toast). Reject when `entries.length >= 25` (toast: `"Favorites cap reached (25). Remove an entry first."`). Normalize. Append entry if not already present (canonical-key match). Idempotent. |
| `claudeConductor.removeFavorite` | `path: string` | Remove entries whose canonical key matches. Evict from existence cache. No-op if absent. |
| `claudeConductor.locateFavorite` | `oldPath: string` | Show `vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Select new location" })`. Reject if user cancels (no-op). Reject worktree paths via `isWorktreePath()` (toast). If `canonicalKey(newPath) === canonicalKey(oldPath)`: toast `"That's the same path. Choose a different folder."` and no-op. If `canonicalKey(newPath)` matches a different existing entry: drop the old entry, evict its cache key, toast `"That folder is already in your Favorites — removed the missing entry."`. Otherwise: replace `path` on the matched entry, evict the old cache key. |
| `claudeConductor.openMissingFavoriteRelocator` | `path: string` | **New** — invoked from `TreeItem.command` on a missing favorite row (click handler). Internally just calls `claudeConductor.locateFavorite(path)`. Exists separately so the on-click and right-click-menu paths can be tested and potentially diverge later. Registered but hidden from the command palette via `commandPalette` menu `when` clause set to `false`. |

## Menus

```jsonc
"menus": {
  "view/item/context": [
    // Star toggle (inline) — Recent + Favorites, unfavorited row → add
    {
      "command": "claudeConductor.addFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem == recentProject.unfavorited",
      "group": "inline@1"
    },
    // Star toggle (inline) — Recent, favorited row → remove (Recent shows the favorited state too)
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view == claudeConductor.recentProjects && viewItem == recentProject.favorited",
      "group": "inline@1"
    },
    // Star toggle (inline) — Favorites row → remove
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view == claudeConductor.favorites && viewItem == favoriteProject.favorited",
      "group": "inline@1"
    },
    // Missing favorite — Locate Folder (inline + context)
    {
      "command": "claudeConductor.locateFavorite",
      "when": "view == claudeConductor.favorites && viewItem =~ /^(favoriteProject|recentProject)\\.missing$/",
      "group": "inline@1"
    },
    // Missing favorite — Remove (context only, secondary)
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view == claudeConductor.favorites && viewItem =~ /^(favoriteProject|recentProject)\\.missing$/",
      "group": "missing@2"
    },
    // Non-inline duplicates for right-click discoverability
    {
      "command": "claudeConductor.addFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem == recentProject.unfavorited",
      "group": "favorites@1"
    },
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && (viewItem == recentProject.favorited || viewItem == favoriteProject.favorited)",
      "group": "favorites@1"
    }
  ],
  "commandPalette": [
    { "command": "claudeConductor.openMissingFavoriteRelocator", "when": "false" }
  ]
}
```

**Migration to existing `recentProject` clause** (`package.json:143`): change `"viewItem == recentProject"` → `"viewItem =~ /^recentProject\\b/"`. The regex matches any `recentProject.<state>` composite. `\b` prevents partial matches against future tokens.

## Missing-Folder Behavior (revised — click opens relocate)

When the existence cache reports `missing` (fresh or stale) for a row's path:

1. **Render** — `TreeItem.description = "(missing)"`, `TreeItem.iconPath = new ThemeIcon("folder", new ThemeColor("disabledForeground"))`, `contextValue = "favoriteProject.missing"` (or `recentProject.missing` for a favorited+missing Recent row).
2. **Tooltip** — `"This folder is missing on disk. Click or press Enter to relocate; right-click for more options."`
3. **`TreeItem.command`** — `{ command: "claudeConductor.openMissingFavoriteRelocator", arguments: [path], title: "Relocate Folder" }`. **Click and Enter both open the relocate dialog.** This is the keyboard-only path the inquisitor demanded.
4. **Right-click menu** — offers `Locate Folder...` (group `inline@1` — shows on hover too as a button) and `Remove from Favorites` (group `missing@2`).
5. **Worktree children** — a missing favorite's grouping yields zero worktree children (worktrees aren't in storage). Missing rows render as leaves.

**Keyboard-only journey from "I see missing" to "relocated":**
- Tab/arrow to the Favorites view → arrow-down to the missing row → press Enter → relocate dialog opens → arrow-keys + Enter through dialog → relocated.

## Data Flow

```
User clicks star (Recent Projects, unfavorited row)
  └─> command: claudeConductor.addFavorite(path)
        └─> store.add(path)
              └─> enqueueMutation(snapshot, applyAdd)
                    ├─> entries.push(...); rebuildIndex(); _onDidChange.fire({kind: "single", path})
                    │     ├─> RecentProjectsProvider fires onDidChangeTreeData(theElement)
                    │     └─> FavoritesProvider fires onDidChangeTreeData(undefined) (new row appears)
                    └─> persistChain.then(() => memento.update(...))
                          └─> .catch(err) → entries = snapshot; rebuild; fire; toast
```

```
User right-clicks a missing favorite → "Locate Folder..." (or clicks the row, or presses Enter)
  └─> command: claudeConductor.locateFavorite(oldPath)
        └─> showOpenDialog → newPath?
              ├─ undefined → no-op
              ├─ isWorktreePath(newPath) → reject + toast
              ├─ canonicalKey(newPath) === canonicalKey(oldPath) → toast "same path" + no-op
              ├─ canonicalKey(newPath) matches another entry → drop old, evict cache, toast "already favorited"
              └─ otherwise → entry.path = newPath; evict oldPath from cache
        └─> store.relocate(...) → enqueueMutation → persist
```

```
launchSession on a UNC favorite fails
  └─> caller catches error
        └─> existenceCache.markMissing(path)
              └─> _onDidChange.fire({kind: "single", path})
                    └─> Both providers re-render that one row as (missing)
```

## Error Handling

| Failure | Treatment |
|---|---|
| `globalState.update` rejection | Roll back in-memory state to the mutation's pre-snapshot. Toast `"Couldn't save Favorites — please try again."` Subsequent in-flight mutations chained behind this one are also rolled back (serialized-persist contract). |
| `showOpenDialog` returns `undefined` | No-op. Missing entry stays. |
| `addFavorite` called with a path already favorited | Silent no-op. |
| `addFavorite` called with a worktree path | Reject with toast `"Favorite the project root, not a worktree."` |
| `addFavorite` called when `entries.length >= 25` | Reject with toast `"Favorites cap reached (25). Remove an entry first."` |
| Render path encounters `entries.length > 25` (storage drift) | Truncate display to first 25 entries (sorted alphabetically). `console.warn` once per session. Subsequent `addFavorite` calls continue to reject at the cap. |
| `removeFavorite` called with absent path | Silent no-op. |
| `locateFavorite` chosen path equals the old path (canonical) | Toast `"That's the same path. Choose a different folder."` No mutation. |
| `locateFavorite` chosen path is a worktree | Reject with toast (same as `addFavorite`). |
| Background stat throws (EACCES, etc.) | Cache as `missing`. Logged once per path per session. |
| Stat times out (>500ms) | No cache entry written; `peek` returns `unknown` next time; render as optimistic-present; re-checked on next refresh cycle. |
| `launchSession` fails on a favorite | `existenceCache.markMissing(path)`. Row dims on next render. |
| Read encounters unknown storage version (`version > 2`) | Toast warning. Render entries best-effort if `entries` is an array. Block writes until reset (skipping mutations with a different toast). |

## Testing (behavior-first)

New files:
- `test/favoritesStore.test.ts`
- `test/favoritesProvider.test.ts`
- `test/packageJsonContextKeys.test.ts`
- `test/pathExistenceCache.test.ts`

Additions to:
- `test/treeView.test.ts`

### `favoritesStore.test.ts`

- `isFavorited` returns true/false synchronously after add/remove.
- Canonical-key dedup: `C:\Foo` and `c:/foo/` produce the same key; second add is a no-op.
- `add` rejects worktree paths via `isWorktreePath()` (uses real predicate, no mock).
- `add` rejects past 25-entry cap.
- `relocate` to canonical-equal path emits the "same path" toast.
- `relocate` to a path already favorited drops the old entry; emits `{kind: "broad"}`.
- v1 `string[]` storage value is read correctly without triggering a write (deferred-migration semantics).
- First mutation after v1 read writes the `version: 2` envelope.
- Future-version envelope (`version: 99`) toasts a warning and renders entries best-effort.
- **Persist failure rollback:** mock `memento.update` to reject once. Add A. Then add B (chains behind). Assert: both rollbacks fire; final `entries` is empty; `onDidChange` fired three times (one for A applied, one for B applied, one for the rollback).
- **Serialized persist:** mock `memento.update` to delay 100ms. Fire 5 mutations rapid-fire. Assert: only one update is in flight at a time (verified via per-call counters); all 5 land in storage in order.

### `favoritesProvider.test.ts`

- Empty state.
- Single favorite, no worktrees.
- Single favorite with worktrees.
- Alphabetical ordering with same-basename tiebreak.
- **Missing folder render** (behavior-first): mock cache `peek` returns `{kind: "missing", stale: false}`. Assert: `description === "(missing)"`, dimmed icon, `contextValue === "favoriteProject.missing"`, `command.command === "claudeConductor.openMissingFavoriteRelocator"`, `command.arguments === [path]`.
- **Stale-missing render**: mock cache returns `{kind: "missing", stale: true}`. Assert: same render as fresh-missing (no flicker).
- **Optimistic-present on UNC**: mock cache returns `{kind: "unknown"}` for UNC path. Assert: rendered as present (no `(missing)` decoration).
- **Click-on-missing fires relocator command**: mock `commands.executeCommand`; assert that triggering the row's `TreeItem.command` invokes `claudeConductor.openMissingFavoriteRelocator` with the path.
- **Locate-folder dedup**: setup A and B (B is missing). Trigger `locateFavorite(B.path)` → dialog returns A.path. Assert: tree's getChildren returns exactly one row (A); toast `"already in your Favorites"` invoked.
- **Locate same-path toast**: dialog returns the same path. Assert: toast `"That's the same path"` invoked; tree unchanged.
- **`addFavorite` past cap toasts and does not mutate.**
- **Render-path cap enforcement**: directly write 30 entries to `globalState`; instantiate provider. Assert: tree renders only first 25 (alphabetical); `console.warn` invoked once.
- **Refresh-only-on-decoration-change**: spy on `getAllFolders()`. Toggle a favorite via store. Assert: `getAllFolders` called *zero* times.

### `pathExistenceCache.test.ts`

- `peek` returns `unknown` initially.
- `peek` returns `exists` after fresh stat; `unknown` after TTL expiry on previously-exists.
- `peek` returns `{missing, stale: false}` after fresh stat; `{missing, stale: true}` after TTL expiry — never returns `unknown` for stale-missing (regression guard against v2 flicker).
- `markMissing` immediately flips state without I/O.
- `evict` removes the entry; subsequent `peek` returns `unknown`.
- `refresh` skips UNC paths (`\\server\share\foo`); they stay `unknown`.
- Stat with simulated 1s delay times out at 500ms; entry stays `unknown`.

### `packageJsonContextKeys.test.ts`

The drift detector. Asserts a **bijection** between `package.json` `viewItem` references and `VIEW_ITEM` constants.

- Parse `package.json`; walk every `view/item/context` clause; extract every `viewItem == "X"` literal AND every `viewItem =~ /pattern/` regex.
- For each literal: assert it is a value in `VIEW_ITEM`.
- For each regex: assert at least one `VIEW_ITEM` value matches it.
- For each `VIEW_ITEM` value: assert it is referenced by at least one menu clause (catches orphaned constants).
- For each `\b`-anchored regex: assert it does not match a sibling token (e.g., `^recentProject\b` matches `recentProject.favorited` but not `recentProjectFoo`).

### `treeView.test.ts` additions

- **Star icon coupling.** Add path X via store. Render Recent Projects row for X — inline action shows `$(star-full)` and `contextValue === "recentProject.favorited"`. Remove via store. Re-render — `$(star-empty)` and `recentProject.unfavorited`.
- **`onDidChangeSessions` doesn't lose star state mid-toggle.** Setup: store has X favorited. Trigger a full data refresh. Assert: rendered row for X still shows `recentProject.favorited` (regression guard against the v1 race).
- **Existing `recentProject` clause migration**: assert that the existing inline action ("open recent project") still fires when the user clicks an unfavorited Recent Projects row, after the contextValue has been migrated to `recentProject.unfavorited`. (The package.json clause is now `=~ /^recentProject\b/`; this test verifies it still matches.)

## File Touch List

| File | Change |
|---|---|
| `package.json` | Add view contribution (3rd view), 4 commands (incl. internal relocator), 7 menu clauses (inline + context). **Migrate existing `recentProject == ` clause to `=~ /^recentProject\b/`.** Bump version. |
| `src/favoritesStore.ts` | **New.** `FavoritesStore` service, `canonicalKey`, `readWithoutMigrating`, deferred migration on first mutation, serialized persist queue. |
| `src/pathExistenceCache.ts` | **New.** Async stat, TTL, UNC skip, `markMissing`/`evict`. |
| `src/projectGrouping.ts` | **Add export:** `isWorktreePath(p): boolean`. No other changes. |
| `src/treeView.ts` | New `FavoritesProvider`. Add `VIEW_ITEM` constant. Update `RecentProjectsProvider` `contextValue` to `recentProject.{favorited,unfavorited,missing}`. Wire missing-row `command` to `claudeConductor.openMissingFavoriteRelocator`. |
| `src/extension.ts` | Construct store + cache at activation. Register `FavoritesProvider`. Register 4 commands. Wire `markMissing` callback into `launchSession` failure path. |
| `src/sessionManager.ts` | (or wherever `launchSession` lives) — call `existenceCache.markMissing(path)` on launch failure for paths that come from favorites/recents. |
| `test/favoritesStore.test.ts` | **New.** |
| `test/favoritesProvider.test.ts` | **New.** |
| `test/pathExistenceCache.test.ts` | **New.** |
| `test/packageJsonContextKeys.test.ts` | **New** drift detector with bidirectional bijection assertions. |
| `test/treeView.test.ts` | Additions per test plan. |
| `README.md` | Document Favorites section. Note 25-cap, click-to-relocate, UNC behavior (optimistic-present until launch failure). |
| `CHANGELOG.md` | New entry. |

## Open Questions Resolved During Brainstorm

| Question | Resolution |
|---|---|
| Parallel vs mutually exclusive lists? | **Parallel.** |
| Star button placement? | **Inline-on-hover + right-click context menu.** |
| Ordering scheme? | **Alphabetical** by basename, full path tiebreak. Drag-to-reorder deferred. |
| Per-worktree favorites? | **No.** Project-only, enforced via shared `isWorktreePath()`. |
| Missing-folder behavior? | **Dim + `(missing)` + click opens relocate dialog directly. Tooltip + right-click for explicit options.** |

## Risks & Mitigations

- **Risk:** A v1 build encountering v2's envelope `{version, entries}`.
  **Mitigation:** Object-shape envelope means v1's `Array.isArray` check fails → empty-state branch. No crash, no data corruption. User loses pinned state on downgrade (acceptable for manual curation).
- **Risk:** `viewItem` drift between TS and `package.json` (either direction).
  **Mitigation:** `packageJsonContextKeys.test.ts` enforces bidirectional bijection — JSON references must exist in `VIEW_ITEM`, AND `VIEW_ITEM` values must be referenced. Catches typos in either file.
- **Risk:** Symlink/junction → duplicate entries.
  **Mitigation:** Documented tradeoff (Non-Goals). README notes paths are tracked as typed.
- **Risk:** Unreachable workspace context (most favorites missing in current workspace).
  **Mitigation:** Acknowledged v1 cost (Non-Goals). Dimmed treatment is low-noise.
- **Risk:** Background stat refresh storms.
  **Mitigation:** 30s TTL caps re-stat frequency; UNC paths skipped; targeted invalidation (single-path `onDidChange`) avoids full re-renders.
- **Risk:** Persist queue starves under rapid mutations.
  **Mitigation:** Serialized queue's worst case is one persist per mutation, 25-entry cap means bounded list size, and persist latency is dominated by VS Code's `globalState.update` (typically <10ms locally). Acceptable.
- **Risk:** UNC path "looks present" until the user tries to launch it.
  **Mitigation:** `markMissing` is wired into the launch-failure path so the cache learns from the launch attempt; subsequent renders dim the row.
- **Risk:** Relocate dialog accepts a worktree path the existence-only check would have allowed.
  **Mitigation:** Both `addFavorite` and `locateFavorite` route through the same `isWorktreePath()` predicate; tested with shared fixtures.
- **Risk:** Multi-window simultaneous mutation overwriting each other.
  **Mitigation:** Last-writer-wins on the entries array — same semantics as any concurrent storage update. Because there's no per-entry identifier, no identity is lost; only the merged set differs from each window's view. Acceptable for v1; full sync resolution is deferred.
