# Design Spec — Favorites Sidebar Section (Issue #75)

**Status:** Draft v2 (post inquisitor review)
**Date:** 2026-04-28
**Issue:** [#75](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/75)
**Branch:** `75-favorites`

## Revision History

- **v1 (2026-04-28)** — initial brainstorm output.
- **v2 (2026-04-28)** — addressed inquisitor charges:
  - Cross-panel race fixed by extracting a `FavoritesStore` service (charge 1).
  - Synchronous `existsSync` replaced with async stat + TTL cache + UNC skip (charge 2).
  - `viewItem` migration explicitly acknowledged with package.json menu-clause updates (charge 3).
  - Storage shape changed to `Array<{path: string}>` with a one-shot read-side migration (charge 4).
  - Missing-row click no longer hijacks `TreeItem.command` — relies on context menu + tooltip (charge 5).
  - Risks/Non-Goals expanded for charges 6–11 (dedup canonical key, Settings Sync rationale, max favorites cap, refresh-storm split, test plan rewritten to behavior-based, cross-workspace acknowledgement).

## Summary

Add a third top-level tree view, **Favorites**, to the Claude Conductor sidebar. It sits between **Active Sessions** and **Recent Projects** and renders user-pinned project roots, reusing the existing two-level grouping helper so worktrees nest under their parent project exactly as they do in Recent Projects today.

Favorites is a **manual curation overlay**, not a usage tracker. Pinning a project does not affect Recent Projects (parallel lists). Favoriting is per-machine via `globalState`. There is no auto-frequency tracking and no Settings Sync involvement in v1.

## Goals

- One-click access to a curated set of project roots, near the top of the sidebar.
- Reuse `projectGrouping.ts` and `RecentProjectsProvider` patterns — minimal new architecture.
- Tolerate transient absence (unmounted drives) and intentional moves (folder relocated on disk) without silent data loss.
- Keep the design scoped — no drag-to-reorder, no per-worktree pinning, no auto-tracking.
- Future-proof storage so deferred features (drag-reorder, sync, frequency) don't force a schema migration later.

## Non-Goals (with rationale)

- **Drag-to-reorder.** Deferred. Soft cap of 25 favorites enforced at `addFavorite` (toast on overflow); past that, alphabetical-only ordering is unusable and we revisit the deferred feature.
- **Per-worktree favorites.** Excluded. Favorites are project-rooted; worktrees come along via grouping. Both `addFavorite` and `locateFavorite` reject worktree paths.
- **Auto-frequency tracking.** Out of scope per the issue.
- **Settings Sync (`setKeysForSync`).** Explicitly NOT registered in v1 because path portability across machines is unsolved (drive letters, project locations differ across desktop/laptop). Revisit when a user requests it AND proposes a path-resolution strategy. The forward-compatible storage shape (see Storage) means adding sync later is non-breaking — the `id` field can serve as a sync-portable identifier independent of the `path`.
- **Cross-workspace filtering.** Favorites are user-global. Opening a workspace where most favorited paths live elsewhere produces `(missing)` rows for those paths. v1 accepts this; the dimmed visual treatment is intentionally unobtrusive so the panel doesn't read as "everything is broken."
- **Promoting Favorites into a workspace-level setting.** Stays user-global.

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

A standalone service that owns all favorites state. **Both providers consult it; neither owns it.** This is the architectural crux that fixes the cross-panel race.

```typescript
export interface FavoritesEntry {
  /** Canonical user-facing path, original case preserved. */
  path: string;
  /** Stable id (UUID v4) — survives path relocation, future-proofs sync. */
  id: string;
}

export class FavoritesStore {
  private entries: FavoritesEntry[] = [];
  private keyIndex: Set<string> = new Set();   // lowercased canonical keys
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly memento: vscode.Memento) {
    this.entries = readAndMigrate(memento);
    this.rebuildIndex();
  }

  // ---- Synchronous reads (called from getTreeItem) ----
  isFavorited(path: string): boolean {
    return this.keyIndex.has(canonicalKey(path));
  }
  list(): readonly FavoritesEntry[] { return this.entries; }

  // ---- Async mutations (called from commands) ----
  async add(path: string): Promise<{ ok: boolean; reason?: string }> { /* ... */ }
  async remove(path: string): Promise<void> { /* ... */ }
  async relocate(oldPath: string, newPath: string): Promise<{ ok: boolean; reason?: string }> { /* ... */ }

  private rebuildIndex(): void { /* ... */ }
}
```

**Why this fixes the race:** providers do not cache the favorites set across an `await`. Inside `getTreeItem(element)` — which VS Code calls synchronously per visible row — they call `store.isFavorited(element.path)` and read the live index. When the store mutates, it updates `entries` and `keyIndex` *first* (synchronous), then fires `onDidChange`, then persists to `globalState` asynchronously in the background. Stale paint is impossible because there is no stale snapshot to paint against — the index is the only source of truth and it's read fresh every render.

**Persistence sequencing:** mutations apply to in-memory state synchronously; the async `memento.update()` is fire-and-forget but errors surface through a `.catch(handlePersistError)` that toasts the user and rolls back the in-memory change.

### Canonical Key

```typescript
/**
 * Canonical lookup key for dedup, isFavorited(), and store lookups.
 * Pipeline: separator normalize → trim trailing separator → case-fold (lower).
 *
 * Notably does NOT call fs.realpathSync — symlink/junction resolution is
 * deferred to v2 because realpathSync on missing paths throws, and the
 * caller cannot distinguish "missing path that's also a symlink" from
 * "missing path." Acknowledged tradeoff: two distinct symlink-resolved-same
 * paths produce duplicate favorite entries. Document this in user-facing
 * docs ("Favorites tracks paths as you typed them").
 */
function canonicalKey(p: string): string {
  return p
    .replace(/\\/g, "/")           // separator normalize
    .replace(/\/+$/, "")           // trim trailing separators
    .toLowerCase();                // case-fold (Windows-correct, harmless on POSIX)
}
```

This canonical key is used in **every** dedup check: `add`, `relocate`, `isFavorited`, and the menu `when`-clause `viewItem` derivation. Tests assert the same key derivation in both `package.json` menu-clause logic and the store.

### Existence Check (async, cached, UNC-aware)

Replace the v1 sync `fs.existsSync` design with an async cache:

```typescript
class PathExistenceCache {
  private cache = new Map<string, { exists: boolean; checkedAt: number }>();
  private readonly TTL_MS = 30_000;
  private readonly STAT_TIMEOUT_MS = 500;

  /** Synchronous read for getTreeItem. Returns last-known value or 'unknown'. */
  peek(path: string): "exists" | "missing" | "unknown" {
    const e = this.cache.get(canonicalKey(path));
    if (!e) return "unknown";
    if (Date.now() - e.checkedAt > this.TTL_MS) return "unknown";
    return e.exists ? "exists" : "missing";
  }

  /** Async refresh — non-blocking, with timeout. UNC paths skipped. */
  async refresh(paths: string[]): Promise<void> {
    const toCheck = paths.filter(p => !isLikelyNetworkPath(p));  // skip \\server\share
    // ...stat each with Promise.race against STAT_TIMEOUT_MS, populate cache, fire event...
  }
}

function isLikelyNetworkPath(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}
```

**Behavior:**
- Render time: `peek()` returns `"unknown"` initially; treat as optimistic-present (no `(missing)` decoration). Tree renders instantly.
- Refresh: a background pass calls `cache.refresh(allFavoritedPaths)` on store load and on `onDidChange`. When stat results land, fire `_onDidChangeDecorations` so providers re-render rows with updated missing flags.
- UNC paths: skipped by the refresh loop; always rendered as optimistic-present. User who favorites `\\server\share\proj` won't see `(missing)` if the share is offline — they'll get a launch error if they click. This is the correct tradeoff vs hanging the extension host.
- TTL: 30s — re-stat happens at most twice per minute even with rapid refresh churn.

**Why this addresses the inquisitor's charge:** sync stat on disconnected UNC paths can block the extension host for the SMB timeout (tens of seconds). The async + timeout + UNC-skip design caps the worst case at 500ms per non-UNC path, run on a background async pass that doesn't block any tree render.

### Provider Refresh Decoupling

Two distinct refresh axes, two distinct events:

| Event | What changed | Provider response |
|---|---|---|
| `onDidChangeSessions` (existing) | Active session set | RecentProjectsProvider re-fetches `getAllFolders()`, re-groups, fires `onDidChangeTreeData(undefined)` |
| `FavoritesStore.onDidChange` (new) | Favorites set | Both providers fire `onDidChangeTreeData(undefined)` *without* re-fetching folders. VS Code re-calls `getTreeItem` per row, which reads the live `isFavorited()` and renders the new icon. No re-grouping, no I/O. |
| `existenceCache.onDidChange` (new) | A previously-unknown path now has a known existence state | Both providers fire `onDidChangeTreeData(undefined)`. Same pattern — re-render only, no re-fetch. |

**Why this fixes the refresh storm:** the v1 design had `RecentProjectsProvider` re-running `getAllFolders()` on every favorites change. That's three full data refreshes per logical action (open session → favorite → idle bell). v2 splits "data changed" from "decoration changed"; favorites toggles trigger only icon/contextValue re-render, not folder re-fetch.

### `viewItem` Context Values & Migration

**Existing state:** `RecentProjectsProvider` rows currently have `contextValue = "recentProject"` (`treeView.ts:159`), and `package.json:143` has a menu clause `viewItem == recentProject`. The v1 spec silently changed `contextValue` to `projectRoot.unfavorited`, which would have broken the existing menu clause.

**v2 migration plan:**

1. Define exported constants in `src/treeView.ts`:
   ```typescript
   export const VIEW_ITEM = {
     PROJECT_ROOT_FAVORITED:   "projectRoot.favorited",
     PROJECT_ROOT_UNFAVORITED: "projectRoot.unfavorited",
     PROJECT_ROOT_MISSING:     "projectRoot.missing",
     WORKTREE_CHILD:           "worktreeChild",
     // existing values preserved for back-compat
     RECENT_PROJECT:           "recentProject",
     ACTIVE_SESSION:           "activeSession",
   } as const;
   ```
2. **RecentProjectsProvider rows** — `contextValue` becomes a *space-separated multi-value*: `"recentProject projectRoot.favorited"` or `"recentProject projectRoot.unfavorited"`. VS Code's `viewItem` matching handles space-separated tokens via the `=~` regex operator. This preserves the existing `viewItem == recentProject` clause AND enables new `viewItem =~ /projectRoot\\.favorited/` clauses without breaking anything.
3. **FavoritesProvider rows** — `contextValue` is `"favoritedProject projectRoot.favorited"` (or `projectRoot.missing` when missing). The first token is a Favorites-specific marker; the second is the shared favorited-state token.
4. **Test:** add a `package-json-context-keys.test.ts` that parses `package.json` menu `when` clauses, extracts every `viewItem` literal, and asserts it appears in the `VIEW_ITEM` constants. This is the drift detector the inquisitor demanded.

### Storage

| Key | Type | Scope | Notes |
|---|---|---|---|
| `claudeConductor.favorites` | `FavoritesEntry[]` | `globalState` (per-machine) | Each entry has `path` and stable `id`. Order is **not** UX-visible — alphabetical sort happens at render time. |

**Read-side migration** (handles users coming from v1 string-array storage if any preview exists; also defensive):

```typescript
function readAndMigrate(memento: vscode.Memento): FavoritesEntry[] {
  const raw = memento.get("claudeConductor.favorites");
  if (!Array.isArray(raw)) return [];
  if (raw.length === 0) return [];

  // v1 shape: string[]
  if (typeof raw[0] === "string") {
    const migrated = (raw as string[]).map(path => ({ path, id: randomUUID() }));
    memento.update("claudeConductor.favorites", migrated);  // fire-and-forget upgrade
    return migrated;
  }

  // v2 shape: FavoritesEntry[]
  return raw as FavoritesEntry[];
}
```

**Why this matters:** four deferred features (drag-reorder, frequency tracking, sync, custom labels) all want per-entry metadata. `Array<{path, id}>` future-proofs all of them at zero current cost. The `id` field is the load-bearing piece — it survives path relocation, so a relocate operation preserves identity (sort position, future timestamps).

## Commands

| Command ID | Args | Behavior |
|---|---|---|
| `claudeConductor.addFavorite` | `path: string` | Reject worktree paths. Reject if `entries.length >= 25` (toast: `"Favorites cap reached (25). Remove an entry first."`). Normalize. Append entry with new UUID. Fire `onDidChange`. Idempotent: if already favorited (canonical-key match), no-op silently. |
| `claudeConductor.removeFavorite` | `path: string` | Remove entries whose canonical key matches. Fire `onDidChange`. No-op if absent. |
| `claudeConductor.locateFavorite` | `oldPath: string` | Show `vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Select new location" })`. **Reject worktree paths from the dialog result** with toast `"Favorite the project root, not a worktree."` (the same guard `addFavorite` uses). On valid selection: if the new canonical key matches a *different* existing entry, drop the old entry and toast `"That folder is already in your Favorites — removed the missing entry."`. If the new key matches the OLD entry's key (case/separator tweaks), update path string in place. Otherwise: replace `path` on the matched entry, preserving `id`. Fire `onDidChange`. |

## Menus

```jsonc
"menus": {
  "view/item/context": [
    {
      "command": "claudeConductor.addFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem =~ /projectRoot\\.unfavorited/",
      "group": "inline@1"
    },
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem =~ /projectRoot\\.favorited/",
      "group": "inline@1"
    },
    {
      "command": "claudeConductor.locateFavorite",
      "when": "view == claudeConductor.favorites && viewItem =~ /projectRoot\\.missing/",
      "group": "missing@1"
    },
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view == claudeConductor.favorites && viewItem =~ /projectRoot\\.missing/",
      "group": "missing@2"
    },
    // Non-inline duplicates for context-menu discoverability
    {
      "command": "claudeConductor.addFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem =~ /projectRoot\\.unfavorited/",
      "group": "favorites@1"
    },
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem =~ /projectRoot\\.favorited/",
      "group": "favorites@1"
    }
  ]
}
```

The `=~` operator matches against the multi-token contextValue string. Existing `viewItem == recentProject` clauses (package.json:143) continue to match unchanged.

## Missing-Folder Behavior (revised — no command hijack)

When the existence cache reports `"missing"` for a row's path:

1. **Render** — `TreeItem.description = "(missing)"`, `TreeItem.iconPath = new ThemeIcon("folder", new ThemeColor("disabledForeground"))`. The contextValue token `projectRoot.missing` is set.
2. **Tooltip** — `"This folder is missing on disk. Right-click to relocate or remove."`
3. **`TreeItem.command`** — *not set*. Clicking the row does nothing. (No toast hijack. The right-click context menu is the affordance.)
4. **Right-click menu** — offers `Locate Folder...` (group `missing@1`) and `Remove from Favorites` (group `missing@2`).

**Worktree children of a missing favorite:** the parent's missing render does not change expansion behavior; users can still expand the group, but children come from `groupByProjectRoot` over the favorited-paths list, which means missing parents have zero worktree children (since worktrees aren't in `globalState["claudeConductor.favorites"]`). Net effect: missing rows are leaf-rendered.

## Data Flow

```
User clicks star (Recent Projects, unfavorited row)
  └─> command: claudeConductor.addFavorite(path)
        └─> store.add(path)                       // sync: mutate entries[] + keyIndex
              ├─> emit onDidChange                 // sync, immediate
              │   ├─> RecentProjectsProvider fires onDidChangeTreeData → re-render icons
              │   └─> FavoritesProvider fires onDidChangeTreeData → re-render list
              └─> memento.update(...)              // async, background
                  └─> .catch(handlePersistError)   // rollback + toast on failure
```

```
User right-clicks a missing favorite → "Locate Folder..."
  └─> command: claudeConductor.locateFavorite(oldPath)
        └─> showOpenDialog → newPath
              ├─ undefined → no-op
              ├─ worktree path → reject with toast
              ├─ canonical(newPath) === canonical(oldPath) → update entry.path in place
              ├─ canonical(newPath) matches another entry → drop old entry, toast
              └─ otherwise → entry.path = newPath, preserve id
        └─> store.relocate(...) → onDidChange → re-render
```

## Error Handling

| Failure | Treatment |
|---|---|
| `globalState.update` rejection | Log to `console.error`. Toast `"Couldn't save Favorites — please try again."` Roll back the in-memory mutation. |
| `showOpenDialog` returns `undefined` | No-op. Missing entry stays. |
| `addFavorite` called with a path already favorited (canonical match) | Silent no-op. |
| `addFavorite` called with a `.worktrees/<branch>` path | Reject with toast `"Favorite the project root, not a worktree."` Storage unchanged. |
| `addFavorite` called when at cap (25) | Reject with toast `"Favorites cap reached (25). Remove an entry first."` |
| `removeFavorite` called with a path not in storage | Silent no-op. |
| `locateFavorite` chosen path equals the original missing path (canonical match) | Update path in place — covers case/separator tweaks where user "fixes" the casing. No toast. |
| `locateFavorite` chosen path is a worktree | Reject as `addFavorite` does. |
| Background stat throws (EACCES, etc.) | Cache as `missing`; the render falls through to the missing-row treatment. Logged once per path per session at console.warn. |
| Stat times out (>500ms) | Cache as `unknown`; rendered as optimistic-present. Re-checked on next refresh cycle. |

## Testing (behavior-first, not implementation-first)

New file: `test/favoritesStore.test.ts` — store unit tests.
New file: `test/favoritesProvider.test.ts` — provider rendering tests.
New file: `test/packageJsonContextKeys.test.ts` — package.json drift detector.
Additions to `test/treeView.test.ts` — cross-panel star coupling, multi-token contextValue.

### `favoritesStore.test.ts`

- `isFavorited` returns true/false synchronously after add/remove.
- Canonical-key dedup: `C:\Foo` and `c:/foo/` produce the same key; second add is a no-op.
- `add` rejects worktree paths.
- `add` rejects past 25-entry cap.
- `relocate` preserves `id`; in-place update for canonical-equal new path.
- `relocate` to a path already favorited drops the old entry; emits one `onDidChange`.
- Read-side migration: `string[]` storage value upgrades to `FavoritesEntry[]` on first read.
- `globalState.update` rejection rolls back in-memory state and re-emits.

### `favoritesProvider.test.ts`

- **Empty state.** Provider returns `[]` when store has no entries. Tree shows VS Code's default empty-state placeholder.
- **Single favorite, no worktrees.** Tree contains exactly one row; description is `""` (not `(missing)`); icon is the standard folder icon.
- **Single favorite with worktrees.** Group renders top + N worktree children; children's contextValue does NOT contain `projectRoot.favorited`.
- **Alphabetical ordering.** Adding `vscode-claude-conductor` then `claude-personal-configs` then `azure-skills`: tree renders `azure-skills`, `claude-personal-configs`, `vscode-claude-conductor`. Same-basename pair tie-broken by full path.
- **Missing folder render** (behavior-first). Mock existence cache to return `"missing"` for path X. Assert: tree row's `description === "(missing)"`, icon is the dimmed ThemeIcon, contextValue contains `projectRoot.missing`, **and `command` is `undefined`** (no click action). This is the test the inquisitor demanded — it would fail if rendering returns an empty array for missing rows.
- **Click-on-missing has no toast.** Mock `showInformationMessage`; assert it is *not* called when a missing row's `TreeItem.command` would have fired (which it shouldn't because `command` is undefined). Documents the behavior change from v1.
- **Locate-folder dedup.** Setup: favorites contains entries A and B (B is missing). Trigger `locateFavorite(B.path)` → dialog returns A.path. Assert: tree's getChildren returns exactly one row whose path is A.path. Toast was shown.
- **`addFavorite` past cap toasts and does not mutate.** Add 25 entries. Try the 26th. Assert: tree still shows 25 rows. Toast invoked.
- **Refresh-only-on-decoration-change.** Spy on `getAllFolders()`. Toggle a favorite via store. Assert `getAllFolders` was called *zero* times. (RecentProjectsProvider's data-axis refresh is unaffected.)

### `packageJsonContextKeys.test.ts`

- Parses `package.json`, walks `menus.view/item/context`, extracts every `viewItem ==` and `viewItem =~` literal/regex.
- Asserts every literal token (e.g., `projectRoot.favorited`, `projectRoot.missing`, `recentProject`, `worktreeChild`) appears as a value in `VIEW_ITEM` exported from `src/treeView.ts`.
- This is the drift detector. If a future PR changes the constant or the JSON without updating both, this test fails.

### `treeView.test.ts` additions

- **Star icon coupling.** Add path X via store. Render Recent Projects row for X — inline action shows `$(star-full)` and contextValue contains `projectRoot.favorited`. Remove via store. Re-render — row shows `$(star-empty)` and contextValue contains `projectRoot.unfavorited`. Existing `recentProject` token is *still* in the contextValue throughout.
- **`onDidChangeSessions` doesn't lose star state mid-toggle.** Setup: store has X favorited. Trigger `sessionManager._onDidChangeSessions.fire()` (full data refresh). Assert: rendered row for X still shows `projectRoot.favorited` (the live store read inside `getTreeItem` is the regression guard against the v1 race).

## File Touch List

| File | Change |
|---|---|
| `package.json` | Add view contribution, three commands, six menu clauses (three inline + three non-inline). Bump version. |
| `src/favoritesStore.ts` | **New.** `FavoritesStore` service, `canonicalKey`, `readAndMigrate`. Zero VS Code imports except `Memento` + `EventEmitter`. |
| `src/pathExistenceCache.ts` | **New.** Async stat + TTL + UNC skip. Zero VS Code imports. |
| `src/treeView.ts` | New `FavoritesProvider`. Add `VIEW_ITEM` constant. Update `RecentProjectsProvider` to consult `FavoritesStore.isFavorited` inside `getTreeItem` and emit multi-token contextValue. No changes to existing data-fetch path. |
| `src/extension.ts` | Construct `FavoritesStore` and `PathExistenceCache` at activation. Register `FavoritesProvider`. Register the three new commands. Wire `store.onDidChange` to fire both providers' `_onDidChangeTreeData`. |
| `src/projectGrouping.ts` | **No changes.** Reused as-is. |
| `test/favoritesStore.test.ts` | **New.** Per test plan above. |
| `test/favoritesProvider.test.ts` | **New.** Per test plan above. |
| `test/packageJsonContextKeys.test.ts` | **New.** Drift detector. |
| `test/treeView.test.ts` | Add cross-panel star coupling and race-regression tests. |
| `README.md` | Document the Favorites section under "Activity Bar Sidebar". Note the 25-favorite cap. Note UNC paths render optimistic-present. |
| `CHANGELOG.md` | New entry under the next version. |

## Open Questions Resolved During Brainstorm

| Question | Resolution |
|---|---|
| Parallel vs mutually exclusive lists? | **Parallel.** Favorites is a curated overlay; Recent stays untouched. |
| Star button placement? | **Inline-on-hover + right-click context menu** (both interaction paths). |
| Ordering scheme? | **Alphabetical** by folder basename, full path tiebreak. Drag-to-reorder deferred. Soft cap at 25. |
| Per-worktree favorites? | **No.** Project-only; worktrees come along via grouping. Both `addFavorite` and `locateFavorite` reject worktree paths. |
| Missing-folder behavior? | **Dim + `(missing)` suffix + tooltip; right-click to relocate or remove.** No click intercept. |

## Risks & Mitigations

- **Risk:** `viewItem` constants drift between TS and `package.json`.
  **Mitigation:** `packageJsonContextKeys.test.ts` parses package.json menu clauses and asserts every literal token exists in the `VIEW_ITEM` exported constant. Test fails if either side changes without the other.
- **Risk:** Symlink/junction-resolved paths produce duplicate entries (two distinct strings → same directory).
  **Mitigation:** Acknowledged tradeoff. v1 uses string-canonical key only (no `realpathSync`), because `realpathSync` on missing paths throws and the relocate flow needs to handle missing paths uniformly. Document in README: "Favorites tracks paths as you typed them — `C:\Code\Foo` and a junction pointing to it are tracked separately."
- **Risk:** A user opens a workspace where most favorites are unreachable; panel shows mostly `(missing)` rows.
  **Mitigation:** Acknowledged as v1 cost (see Non-Goals). Dimmed visual treatment is intentionally low-noise. v2 might add per-workspace filtering.
- **Risk:** Background stat refresh storms on rapid `onDidChangeSessions` events.
  **Mitigation:** 30s TTL means stat runs at most twice per minute per path even with refresh churn. UNC paths skipped entirely.
- **Risk:** `globalState.update` rejection mid-mutation leaves in-memory and persisted state divergent.
  **Mitigation:** `.catch(handlePersistError)` rolls back the in-memory mutation and fires `onDidChange` again to re-render the rolled-back state. User sees the toggle "snap back" with an error toast.
- **Risk:** Path containing only-case-different favorites on case-insensitive filesystems.
  **Mitigation:** Canonical key case-folds. `C:\Foo` and `c:/foo` collapse to one entry.
- **Risk:** User sets up Favorites on machine A; on machine B the paths don't exist.
  **Mitigation:** `globalState` is per-machine; this is by design (see Non-Goals — Settings Sync). The `id` field future-proofs the eventual sync story.
