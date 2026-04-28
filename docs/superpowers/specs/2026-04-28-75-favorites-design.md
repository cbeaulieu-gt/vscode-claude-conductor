# Design Spec — Favorites Sidebar Section (Issue #75)

**Status:** Draft v4 (post third inquisitor review)
**Date:** 2026-04-28
**Issue:** [#75](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/75)
**Branch:** `75-favorites`

## Revision History

- **v1 (2026-04-28)** — initial brainstorm output.
- **v2 (2026-04-28)** — addressed inquisitor pass 1.
- **v3 (2026-04-28)** — addressed inquisitor pass 2.
- **v4 (2026-04-28)** — addressed inquisitor pass 3 blockers:
  - **Persist serialization changed from "chained with cascade rollback" to "await-prior-then-apply."** Each mutation waits for the prior persist to fully resolve (success or rollback) before snapshotting and applying. Eliminates the cascade rollback that destroyed later mutations on transient persist failure.
  - **`launchSession` now returns a result.** Caller (favorites click handler) uses the result to call `markMissing` or `markPresent` on the existence cache. `markPresent` was added — UNC favorites that flip missing on a launch failure now unflip on a subsequent successful launch.
  - **`_onDidChange` payload is now typed** as `FavoritesChangeEvent`. All `fire()` sites pass the typed payload. Targeted invalidation is now actually implementable.
  - **Smaller fixes:** `TreeItem.command` on missing rows uses `claudeConductor.locateFavorite` directly (no internal hidden command, no `when: "false"` folklore); `isWorktreePath` trims trailing separators before regex; `viewItem` prefix split collapsed to a single set of tokens shared across providers; render-path no longer silently truncates >25 entries (renders all with a banner); drift detector has an explicit negative fixture list; multi-window last-writer-wins is justified with engineering rationale rather than dismissed.

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

- **Drag-to-reorder.** Deferred. Soft cap of 25 favorites enforced at `addFavorite` only. Past 25 alphabetical-only ordering is unusable; that's the trigger to revisit.
- **Per-worktree favorites.** Excluded. Both `addFavorite` and `locateFavorite` reject worktree paths via the shared `isWorktreePath()` predicate.
- **Auto-frequency tracking.** Out of scope per the issue.
- **Settings Sync (`setKeysForSync`).** Explicitly NOT registered in v1 because path portability across machines is unsolved. The object envelope storage means adding sync later is non-breaking.
- **Stable per-entry identifier.** Removed in v3 as YAGNI. Storage stays `[{path: string}]`.
- **Cross-workspace filtering.** Favorites are user-global. Dimmed `(missing)` rows for unreachable paths are accepted.
- **Symlink/junction canonicalization.** Canonical key skips `realpathSync`. Documented tradeoff: distinct path strings resolving to the same directory produce duplicate entries.
- **Multi-window read-merge-write merge semantics.** Last-writer-wins is accepted for v1. **Engineering rationale:** the favorites set is bounded at 25 entries with human-rate mutation frequency (not bulk imports). Collision probability across windows in a realistic workflow (user adds A in window 1, switches to window 2, adds B) is dominated by the *user* serializing their own actions. The expensive alternative — read-merge-write inside `enqueueMutation`, with operational-transform-style merge for conflicting mutations — is correct but heavyweight for a feature without measured collision incidents. Revisit when (a) Settings Sync ships and brings genuine concurrent multi-machine writes, or (b) a user reports lost favorites from concurrent windows. v1 documents the limitation in the README's "Known Limits" section.

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

### `FavoritesStore` service (`src/favoritesStore.ts`)

```typescript
export interface FavoritesEntry { path: string; }

export type FavoritesChangeEvent =
  | { kind: "single"; path: string }
  | { kind: "broad" };

interface FavoritesStorageEnvelope {
  version: 2;
  entries: FavoritesEntry[];
}

const STORAGE_KEY = "claudeConductor.favorites";
const MAX_FAVORITES = 25;

export class FavoritesStore {
  private entries: FavoritesEntry[] = [];
  private keyIndex: Set<string> = new Set();
  private readonly _onDidChange = new vscode.EventEmitter<FavoritesChangeEvent>();
  readonly onDidChange = this._onDidChange.event;

  /** Tracks the latest persist so the next mutation can wait for it. */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly memento: vscode.Memento) {
    this.entries = readWithoutMigrating(memento);
    this.rebuildIndex();
  }

  // ---- Synchronous reads ----
  isFavorited(path: string): boolean {
    return this.keyIndex.has(canonicalKey(path));
  }
  list(): readonly FavoritesEntry[] { return this.entries; }
  isOverCap(): boolean { return this.entries.length > MAX_FAVORITES; }

  // ---- Async mutations ----
  async add(path: string): Promise<{ ok: boolean; reason?: string }> { /* ... */ }
  async remove(path: string): Promise<void> { /* ... */ }
  async relocate(oldPath: string, newPath: string): Promise<{ ok: boolean; reason?: string }> { /* ... */ }

  /**
   * Mutation contract:
   *   1. Wait for any in-flight persist to fully resolve (success OR rollback).
   *   2. Snapshot current entries.
   *   3. Run apply(snapshot) inside try/catch — on throw, do NOT mutate state and reject the caller.
   *   4. Apply the result to in-memory state.
   *   5. Fire onDidChange with the supplied payload.
   *   6. Persist; on rejection, restore from snapshot, fire onDidChange (broad), toast.
   *
   * Step 1 means each mutation operates on the actual current state, not on a
   * speculative state that depends on prior persists succeeding. There is no
   * cascade rollback — if persist N fails, only mutation N is rolled back.
   * Mutations N+1, N+2 ... were already serialized to wait for N's resolution
   * and will snapshot the post-rollback state when their turn comes.
   */
  private async enqueueMutation(
    apply: (snapshot: FavoritesEntry[]) => FavoritesEntry[],
    payload: FavoritesChangeEvent
  ): Promise<void> {
    // Step 1: wait for any prior persist (success or rollback) to fully resolve.
    await this.persistChain.catch(() => undefined);

    // Step 2: snapshot the *actual current* state.
    const snapshot = [...this.entries];

    // Step 3: run apply guarded.
    let next: FavoritesEntry[];
    try {
      next = apply(snapshot);
    } catch (err) {
      // Apply itself threw — do not mutate, do not fire, surface to caller.
      log(`[favoritesStore] apply threw: ${err}`);
      throw err;
    }

    // Step 4 + 5: in-memory mutation + fire change.
    this.entries = next;
    this.rebuildIndex();
    this._onDidChange.fire(payload);

    // Step 6: persist; rollback this mutation only on failure.
    this.persistChain = this.memento
      .update(STORAGE_KEY, { version: 2, entries: this.entries } as FavoritesStorageEnvelope)
      .then(() => undefined)
      .catch((err: unknown) => {
        this.entries = snapshot;
        this.rebuildIndex();
        this._onDidChange.fire({ kind: "broad" });
        showPersistErrorToast(err);
      });

    return this.persistChain;
  }

  private rebuildIndex(): void {
    this.keyIndex = new Set(this.entries.map(e => canonicalKey(e.path)));
  }
}
```

**Why "await prior, then apply":** the v3 design chained mutations and on rejection restored the *first* failing mutation's snapshot, which clobbered later in-memory mutations that had already been applied speculatively. The v4 design serializes mutations end-to-end: each waits for the prior persist's resolution (success → entries reflect the success; rollback → entries reflect the rollback) before snapshotting. There is no speculative state. A persist failure rolls back exactly one mutation and toasts exactly once.

**Trade-off:** rapid mutations are now strictly serial — clicking the star 5 times in 100ms means 5 persists serialized one after the other. With `MAX_FAVORITES = 25` and `globalState.update` typically completing in <10ms locally, total worst-case latency is ~50ms for a burst of 5. Acceptable.

### Canonical Key

```typescript
function canonicalKey(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}
```

### Worktree Path Predicate

`isWorktreePath()` trims trailing separators before the regex test, matching how the rest of the codebase normalizes paths. This closes the v3 gap where `C:\proj\.worktrees\fix\` (trailing slash) bypassed the worktree gate.

```typescript
// Exported from src/projectGrouping.ts
export function isWorktreePath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /\/\.worktrees\/[^/]+$/i.test(normalized);
}
```

### `launchSession` result type + cache feedback loop (charge 4 fix)

`sessionManager.ts:launchSession` is refactored from `Promise<void>` to:

```typescript
type LaunchResult =
  | { ok: true; reused: boolean }
  | { ok: false; reason: "missing" | "other"; message: string };

async launchSession(folderPath: string): Promise<LaunchResult> {
  const normalized = path.normalize(folderPath);

  // For non-UNC paths, pre-flight existsSync is fast and informative.
  // For UNC paths, skip pre-flight to avoid SMB-timeout hang.
  if (!isLikelyNetworkPath(normalized)) {
    if (!fs.existsSync(normalized)) {
      log(`[launch] missing cwd: ${normalized}`);
      return { ok: false, reason: "missing", message: `Folder does not exist: ${normalized}` };
    }
  }

  // ... existing terminal creation ...

  return { ok: true, reused: false };
}
```

**Caller integration** (favorites/recents click handlers in `extension.ts`):

```typescript
const result = await sessionManager.launchSession(path);
if (result.ok) {
  existenceCache.markPresent(path);  // unsticks UNC favorites previously markMissing'd
} else if (result.reason === "missing") {
  existenceCache.markMissing(path);
  vscode.window.showErrorMessage(result.message);
}
// reason === "other" does not flip the cache — only existence-derived signals do.
```

**Coverage matrix:**

| Path type | Pre-flight result | Cache update on outcome |
|---|---|---|
| Local, exists | passes | `markPresent` on success |
| Local, missing | fails | `markMissing` on missing-result; user-visible error |
| UNC, share online | (skipped) | `markPresent` on launch success |
| UNC, share offline | (skipped) | NO automated `markMissing` (createTerminal returns sync without throwing). User feedback path: VS Code's terminal output shows `"starting directory does not exist"`; user right-clicks → Locate or Remove. **Crucially, the next time the user clicks the same UNC favorite after the share is back online, launchSession succeeds → `markPresent` flips the cache.** No stuck-missing state. |

This closes the v3 "stuck forever in missing" charge: even though we can't detect post-spawn UNC failures synchronously, we can detect successful launches, and the success signal is sufficient to recover from a previously-set missing state.

### Existence Cache (async, stale-aware, UNC-skipping, with markPresent)

```typescript
type ExistenceState =
  | { kind: "exists"; checkedAt: number }
  | { kind: "missing"; checkedAt: number }
  | { kind: "unknown" };

class PathExistenceCache {
  private cache = new Map<string, ExistenceState>();
  private readonly _onDidChange = new vscode.EventEmitter<{ kind: "single"; path: string } | { kind: "broad" }>();
  readonly onDidChange = this._onDidChange.event;
  private readonly TTL_MS = 30_000;
  private readonly STAT_TIMEOUT_MS = 500;

  peek(path: string): { kind: "exists" } | { kind: "missing"; stale: boolean } | { kind: "unknown" } {
    const e = this.cache.get(canonicalKey(path));
    if (!e || e.kind === "unknown") return { kind: "unknown" };
    const stale = Date.now() - e.checkedAt > this.TTL_MS;
    if (e.kind === "missing") return { kind: "missing", stale };
    if (stale) return { kind: "unknown" };
    return { kind: "exists" };
  }

  /** Force-mark missing (e.g., from launchSession failure or post-stat). */
  markMissing(path: string): void {
    this.cache.set(canonicalKey(path), { kind: "missing", checkedAt: Date.now() });
    this._onDidChange.fire({ kind: "single", path });
  }

  /** Force-mark present (e.g., from launchSession success — the canonical "this works" signal). */
  markPresent(path: string): void {
    this.cache.set(canonicalKey(path), { kind: "exists", checkedAt: Date.now() });
    this._onDidChange.fire({ kind: "single", path });
  }

  /** Drop the cache entry — called from FavoritesStore on remove/relocate. */
  evict(path: string): void { /* ... */ }

  /** Background refresh — async stat with timeout, UNC-skipped. */
  async refresh(paths: string[]): Promise<void> { /* ... */ }
}
```

### Provider Refresh Decoupling

Single source of truth for change events; all providers subscribe to:
- `FavoritesStore.onDidChange` — typed `FavoritesChangeEvent`. Single-path payloads enable targeted `onDidChangeTreeData(treeNode)`.
- `existenceCache.onDidChange` — same shape.
- Existing `sessionManager.onDidChangeSessions` — drives RecentProjectsProvider data refresh only.

Providers route the `kind` to either `_onDidChangeTreeData.fire(specificElement)` (single) or `_onDidChangeTreeData.fire(undefined)` (broad). Single-path operations: star toggle, single-favorite cache flip, `markMissing`/`markPresent`. Broad operations: relocate-with-dedup, persist rollback, multi-path stat refresh batches.

### `viewItem` Context Values — Shared Single Token Set (v3 prefix split collapsed)

The v3 design used distinct prefixes (`recentProject.*` vs `favoriteProject.*`) for the same logical row state. v4 collapses to a single token set used by both providers, with `view ==` doing all panel disambiguation:

| Provider | Row state | `contextValue` |
|---|---|---|
| RecentProjectsProvider (top-level) | not favorited | `projectRoot.unfavorited` |
| RecentProjectsProvider (top-level) | favorited | `projectRoot.favorited` |
| RecentProjectsProvider (top-level) | favorited + missing | `projectRoot.missing` |
| FavoritesProvider (top-level) | present | `projectRoot.favorited` |
| FavoritesProvider (top-level) | missing | `projectRoot.missing` |
| Either provider (worktree child) | any | `worktreeChild` |
| ActiveSessionsProvider | unchanged | `activeSession` |

```typescript
// Exported from src/treeView.ts
export const VIEW_ITEM = {
  PROJECT_ROOT_FAVORITED:   "projectRoot.favorited",
  PROJECT_ROOT_UNFAVORITED: "projectRoot.unfavorited",
  PROJECT_ROOT_MISSING:     "projectRoot.missing",
  WORKTREE_CHILD:           "worktreeChild",
  ACTIVE_SESSION:           "activeSession",
} as const;
```

**Migration of existing `recentProject` clause** (`package.json:143`):

The existing clause `"viewItem == recentProject"` becomes — *after deciding whether the existing inline action should fire on favorited rows too*. The existing inline action is "open recent project," which should fire on any state. New clause: `"viewItem =~ /^projectRoot\\./"`. This matches all three states (`favorited`, `unfavorited`, `missing`). The `^` anchor and `\\.` separator anchor prevent partial-match false positives on hypothetical future `projectRootSomething` values.

## Commands

| Command ID | Args | Behavior |
|---|---|---|
| `claudeConductor.addFavorite` | `path: string` | Reject worktree (`isWorktreePath` toast). Reject if `entries.length >= MAX_FAVORITES` (toast). Idempotent: canonical-key match → no-op. |
| `claudeConductor.removeFavorite` | `path: string` | Remove canonical-key match. Evict from existence cache. No-op if absent. |
| `claudeConductor.locateFavorite` | `oldPath: string` | `showOpenDialog`. Reject cancel (no-op). Reject worktree (toast). If new canonical = old canonical: toast `"That's the same path. Choose a different folder."` and no-op. If new canonical = some *other* entry: drop old entry, evict cache, toast `"already in your Favorites"`. Otherwise replace path on entry, evict old cache key. |

**No internal `openMissingFavoriteRelocator` command** (v3 introduced one; v4 drops it). Missing-row `TreeItem.command` directly references `claudeConductor.locateFavorite` with the path as argument. This avoids the `when: "false"` folklore concern entirely.

## Menus

```jsonc
"menus": {
  "view/item/context": [
    // Star toggle (inline) — Recent + Favorites, unfavorited row → add
    {
      "command": "claudeConductor.addFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem == projectRoot.unfavorited",
      "group": "inline@1"
    },
    // Star toggle (inline) — Recent + Favorites, favorited row → remove
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem == projectRoot.favorited",
      "group": "inline@1"
    },
    // Missing favorite — Locate Folder (inline + context)
    {
      "command": "claudeConductor.locateFavorite",
      "when": "view == claudeConductor.favorites && viewItem == projectRoot.missing",
      "group": "inline@1"
    },
    // Missing favorite — Remove (context only)
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view == claudeConductor.favorites && viewItem == projectRoot.missing",
      "group": "missing@2"
    },
    // Right-click discoverability (non-inline)
    {
      "command": "claudeConductor.addFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem == projectRoot.unfavorited",
      "group": "favorites@1"
    },
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem == projectRoot.favorited",
      "group": "favorites@1"
    }
  ]
}
```

**Migration to existing `recentProject` clause** (`package.json:143`): change `"viewItem == recentProject"` → `"viewItem =~ /^projectRoot\\./"`.

## Missing-Folder Behavior

When the existence cache reports `missing` (fresh or stale) for a row's path:

1. **Render** — `TreeItem.description = "(missing)"`, dimmed icon, `contextValue = "projectRoot.missing"`.
2. **Tooltip** — `"This folder is missing on disk. Click or press Enter to relocate; right-click for more options."`
3. **`TreeItem.command`** — `{ command: "claudeConductor.locateFavorite", arguments: [path], title: "Relocate Folder" }`. Click and Enter both open the relocate dialog.
4. **Right-click menu** — `Locate Folder...` (inline + context) and `Remove from Favorites` (context only).
5. **Worktree children** — none (worktrees aren't in storage).

## Render-Path Cap Behavior (v3 silent-truncation fixed)

The 25-cap is enforced only at `addFavorite`. If storage drifts past 25 (multi-window race, manual edit, future migration bug), the render path:

- **Renders all entries**, sorted alphabetically. No truncation, no silent hiding.
- **Displays a panel header banner** above the tree: `"Favorites: N entries (over the 25 cap — consider removing some)"`. Implemented via `TreeView.message` (the supported VS Code API for this — text shown above tree contents).
- Subsequent `addFavorite` calls continue to reject with the cap toast.

Rationale: silent truncation is data hiding. Showing all entries with a banner makes the over-cap state user-visible and self-correcting (the user removes some, the banner clears). The 25-cap is preserved as a soft policy on adds, not as a render-time invariant.

## Storage Envelope

Same as v3:

| Stored value | Interpretation |
|---|---|
| `undefined` / `null` / `[]` | No favorites. |
| `string[]` (no `version`) | v1 legacy. Read-only on first load. Convert to envelope shape on first mutation. |
| `{ version: 2, entries: [...] }` | v2 native. |
| `{ version: <other>, ... }` | Future-version warning toast. Render `entries` best-effort. Block writes. |

Multi-window race for v1→v2 migration: deferred to first mutation, so concurrent v1 reads don't write. First mutation wins; subsequent windows pick up via their own next read or activation.

## Data Flow

```
User clicks star (Recent Projects, unfavorited row)
  └─> command: claudeConductor.addFavorite(path)
        └─> store.add(path)
              └─> enqueueMutation(applyAdd, {kind: "single", path})
                    1. await persistChain    // wait for prior to fully resolve
                    2. snapshot = [...entries]
                    3. try { next = applyAdd(snapshot) } catch → throw
                    4. entries = next; rebuildIndex()
                    5. _onDidChange.fire({kind: "single", path})
                       ├─> RecentProjectsProvider fires onDidChangeTreeData(theNode)
                       └─> FavoritesProvider fires onDidChangeTreeData(undefined) (new row appears)
                    6. persistChain = memento.update(...)
                       └─ on reject: entries = snapshot; rebuild; fire {kind:"broad"}; toast
```

```
User clicks a favorite that points at a UNC share that just came online
  └─> command: claudeConductor.openFavorite(path)  (existing pattern)
        └─> sessionManager.launchSession(path)
              ├─ pre-flight skipped for UNC
              ├─ createTerminal succeeds
              └─ returns { ok: true, reused: false }
        └─> existenceCache.markPresent(path)
              └─> _onDidChange.fire({kind: "single", path})
                    └─> All providers re-render that row as present
              ↑
              This is the unstick path the v3 spec was missing.
```

```
User clicks a favorite whose folder was deleted (local path)
  └─> launchSession(path) → { ok: false, reason: "missing", message: ... }
        └─> existenceCache.markMissing(path)
              └─> Providers re-render row as (missing)
        └─> showErrorMessage(message)
```

## Error Handling

| Failure | Treatment |
|---|---|
| `globalState.update` rejection | Roll back this mutation only (the prior await ensured no later mutation has been applied). Toast once. Fire broad `onDidChange`. Subsequent enqueued mutations operate on the post-rollback state. |
| `apply` callback throws | Do not mutate. Reject the caller's promise with the error. Do not fire `onDidChange`. Log. |
| `showOpenDialog` returns `undefined` | No-op. |
| `addFavorite` already favorited | Silent no-op. |
| `addFavorite` worktree path | Reject + toast `"Favorite the project root, not a worktree."` |
| `addFavorite` at or above cap | Reject + toast `"Favorites cap reached (25). Remove an entry first."` |
| Render encounters >25 entries | Render all + show `TreeView.message` banner. No `console.warn` (banner is the user signal). |
| `removeFavorite` absent path | Silent no-op. |
| `locateFavorite` same-path | Toast `"That's the same path. Choose a different folder."` No mutation. |
| `locateFavorite` worktree | Reject + toast (same as `addFavorite`). |
| Background stat throws | Cache as `missing`. Logged once per path per session. |
| Stat times out (>500ms) | No cache write. Render as optimistic-present (or last-known). |
| `launchSession` returns `{ok: false, reason: "missing"}` | `markMissing(path)`; show error toast. |
| `launchSession` returns `{ok: true}` | `markPresent(path)` — unsticks any prior `missing` state. |
| Read encounters unknown storage version | Toast warning. Render `entries` best-effort. Block writes. |

## Testing (behavior-first)

New files:
- `test/favoritesStore.test.ts`
- `test/favoritesProvider.test.ts`
- `test/packageJsonContextKeys.test.ts`
- `test/pathExistenceCache.test.ts`

Additions:
- `test/treeView.test.ts`
- `test/sessionManager.test.ts` (existing, augment for `LaunchResult`)

### `favoritesStore.test.ts`

- `isFavorited` returns true/false synchronously after add/remove.
- Canonical-key dedup: `C:\Foo` and `c:/foo/` collapse.
- `add` rejects worktree paths via real `isWorktreePath()`.
- `add` rejects past 25-cap; `isOverCap()` reports correctly.
- `relocate` to canonical-equal path emits "same path" toast and no-op.
- `relocate` to a path already favorited drops old entry; emits `{kind: "broad"}`.
- v1 `string[]` storage value reads correctly without writing (deferred migration).
- First mutation after v1 read writes `version: 2` envelope.
- Future-version envelope (`version: 99`) toasts warning and renders best-effort.
- **Persist failure rolls back exactly one mutation** (regression guard for v3 cascade bug):
  - Mock `memento.update` to reject only on the *first* call, then succeed.
  - Add A (persist 1, will reject). Add B (persist 2, will succeed).
  - Assert: B's enqueue waited for A's persist to resolve. After A rolls back, B's snapshot is `[]`, B applies, B persists `[B]`. Final state = `[B]`. **Not** `[A, B]` rolled back to `[]`, and **not** `[A, B]` rolled back to `[B]`. The await-prior-then-apply contract is what makes this deterministic.
- **`apply` throw is contained**: pass an `apply` that throws. Assert `entries` unchanged, no `onDidChange` fired, returned promise rejects.
- **`apply` is wrapped in try/catch**: same as above but with a real mutation that hits an internal invariant violation.

### `favoritesProvider.test.ts`

- Empty state.
- Single favorite (with/without worktrees).
- Alphabetical ordering with same-basename tiebreak.
- Missing folder render: assert `description === "(missing)"`, dimmed icon, `contextValue === "projectRoot.missing"`, `command.command === "claudeConductor.locateFavorite"`, `command.arguments === [path]`.
- Stale-missing render: same as fresh-missing (no flicker regression).
- Optimistic-present on UNC: `peek` returns `unknown` for UNC path → row rendered without `(missing)`.
- Locate-folder dedup, same-path toast, worktree rejection.
- `addFavorite` past cap: toast, no mutation.
- **Render path with storage drift >25**: directly write 30 entries to `globalState`. Instantiate provider. Assert: `getChildren` returns 30 nodes (sorted alphabetically); `TreeView.message` is set to the over-cap banner string. `console.warn` is NOT invoked.
- Refresh-only-on-decoration-change: spy on `getAllFolders()`. Star toggle. Assert zero data calls.

### `pathExistenceCache.test.ts`

- `peek` returns `unknown` initially.
- `peek` after `markPresent`: `{kind: "exists"}`; after TTL → `{kind: "unknown"}`.
- `peek` after `markMissing`: `{kind: "missing", stale: false}`; after TTL → `{kind: "missing", stale: true}` (regression guard against v2 flicker).
- `markPresent` after a prior `markMissing` flips state and fires `{kind: "single"}` (regression guard for v3 stuck-missing).
- `evict` removes entry.
- `refresh` skips UNC paths (`\\server\share\foo`); they stay `unknown`.
- Stat with simulated 1s delay times out at 500ms; entry stays `unknown`.

### `packageJsonContextKeys.test.ts`

- Parse `package.json` `view/item/context` clauses; extract every `viewItem ==` literal AND every `viewItem =~` regex.
- For each literal: assert it is a value in `VIEW_ITEM`.
- For each regex: assert at least one `VIEW_ITEM` value matches it.
- For each `VIEW_ITEM` value: assert it is referenced by at least one menu clause (orphan detection).
- **Explicit negative-fixture list for regex anchoring**:
  ```typescript
  const negativeFixtures = [
    "projectRootSomething",   // missing dot separator
    "projectRoot",            // missing state suffix
    "myprojectRoot.favorited", // prefix
    "projectRoot.favoritedExtra", // suffix beyond a state token
    "recentProject",          // legacy un-migrated value
  ];
  ```
  For each `\b`/`\.`-anchored regex in `package.json`, assert that none of these strings match. This is the spec's explicit answer to the v3 "what counts as a sibling token?" charge.

### `treeView.test.ts` additions

- Star icon coupling (Recent ↔ Favorites).
- `onDidChangeSessions` mid-toggle does not lose star state (race regression guard).
- **Existing `recentProject` clause migration test**: in a test harness, register a fake command bound to `viewItem =~ /^projectRoot\\./`. Render a Recent Projects row in any state (favorited, unfavorited, missing). Assert the menu clause matches all three. Verifies the migration of `package.json:143`.

### `sessionManager.test.ts` (additions)

- `launchSession` returns `{ok: false, reason: "missing"}` for a non-UNC path that doesn't exist.
- `launchSession` returns `{ok: true}` for a path that exists (mock `createTerminal`).
- `launchSession` skips pre-flight existsSync for UNC paths (verified by spying on `fs.existsSync` not being called for `\\server\share\foo`).

## File Touch List

| File | Change |
|---|---|
| `package.json` | Add 3rd view contribution. Add 3 commands (no internal hidden command). 6 menu clauses. Migrate existing `recentProject ==` clause to `=~ /^projectRoot\\./`. Bump version. |
| `src/favoritesStore.ts` | **New.** Service per spec. |
| `src/pathExistenceCache.ts` | **New.** Cache per spec, with `markPresent`. |
| `src/projectGrouping.ts` | Add `isWorktreePath` export with trailing-separator trim. |
| `src/treeView.ts` | New `FavoritesProvider`. `VIEW_ITEM` constants. `RecentProjectsProvider` `contextValue` migrated. Missing-row `TreeItem.command` → `claudeConductor.locateFavorite`. |
| `src/extension.ts` | Construct store + cache. Register `FavoritesProvider`. Register 3 commands. Wire `markMissing`/`markPresent` callbacks into the favorite-launch click handler. |
| `src/sessionManager.ts` | `launchSession` returns `LaunchResult` instead of `void`. UNC pre-flight skipped. |
| `test/favoritesStore.test.ts` | **New.** |
| `test/favoritesProvider.test.ts` | **New.** |
| `test/pathExistenceCache.test.ts` | **New.** |
| `test/packageJsonContextKeys.test.ts` | **New.** With explicit negative fixtures. |
| `test/treeView.test.ts` | Cross-panel coupling, race regression guard, migration verification. |
| `test/sessionManager.test.ts` | `LaunchResult` cases. |
| `README.md` | Favorites section, 25-cap, click-to-relocate, UNC behavior, multi-window last-writer-wins limit. |
| `CHANGELOG.md` | New entry. |

## Open Questions Resolved

| Question | Resolution |
|---|---|
| Parallel vs mutually exclusive lists? | **Parallel.** |
| Star button placement? | **Inline-on-hover + right-click context menu.** |
| Ordering scheme? | **Alphabetical** (basename, full path tiebreak). Drag-to-reorder deferred. |
| Per-worktree favorites? | **No.** Project-only; shared `isWorktreePath()` predicate. |
| Missing-folder behavior? | **Dim + `(missing)` + click opens relocate dialog directly.** |

## Risks & Mitigations

- **Risk:** v1 build encountering v2 envelope.
  **Mitigation:** Object-shape envelope means v1's `Array.isArray` check fails → empty-state. Acceptable downgrade cost for manual curation.
- **Risk:** `viewItem` drift (TS ↔ `package.json`).
  **Mitigation:** `packageJsonContextKeys.test.ts` enforces bidirectional bijection plus explicit negative fixtures.
- **Risk:** Symlink-resolved duplicates.
  **Mitigation:** Documented (Non-Goals).
- **Risk:** Cross-workspace unreachable paths render `(missing)`.
  **Mitigation:** Acknowledged.
- **Risk:** Stat refresh storm.
  **Mitigation:** 30s TTL; UNC-skipped; targeted invalidation.
- **Risk:** Persist queue starves under rapid mutations.
  **Mitigation:** Strict serialization. Worst case for 25-entry list is ~10ms per persist; bursts of 5 → ~50ms total. Acceptable.
- **Risk:** UNC path stuck-missing after launch failure.
  **Mitigation:** `markPresent` on next successful launch flips it back. Verified by `pathExistenceCache.test.ts`.
- **Risk:** Multi-window last-writer-wins data loss.
  **Mitigation:** Acknowledged with engineering rationale (Non-Goals). Documented in README "Known Limits."
- **Risk:** `apply` throws inside `enqueueMutation`.
  **Mitigation:** try/catch around `apply`; entries unchanged; promise rejects; no event fired. Tested.
