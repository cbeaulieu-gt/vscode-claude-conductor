# Design Spec — Favorites Sidebar Section (Issue #75)

**Status:** Draft
**Date:** 2026-04-28
**Issue:** [#75](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues/75)
**Branch:** `75-favorites`

## Summary

Add a third top-level tree view, **Favorites**, to the Claude Conductor sidebar. It sits between **Active Sessions** and **Recent Projects** and renders user-pinned project roots, reusing the existing two-level grouping helper so worktrees nest under their parent project exactly as they do in Recent Projects today.

Favorites is a **manual curation overlay**, not a usage tracker. Pinning a project does not affect Recent Projects (parallel lists). Favoriting is per-machine via `globalState`. There is no auto-frequency tracking and no Settings Sync involvement.

## Goals

- One-click access to a curated set of project roots, near the top of the sidebar.
- Reuse `projectGrouping.ts` and `RecentProjectsProvider` patterns — minimal new architecture.
- Tolerate transient absence (unmounted drives) and intentional moves (folder relocated on disk) without silent data loss.
- Keep the design scoped — no drag-to-reorder, no per-worktree pinning, no auto-tracking.

## Non-Goals

- Drag-to-reorder. Deferred until evidence the alphabetical default is insufficient.
- Per-worktree favorites. Explicitly excluded — favorites are project-rooted; worktrees come along for free via grouping.
- Auto-frequency tracking. Out of scope per the issue.
- Cross-machine sync. `globalState` is per-machine by design.
- Promoting Favorites into a workspace-level (per-folder) setting. Stays user-global.

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

`Favorites` deliberately renders between the other two so curated items sit above the noisy recents feed without obscuring active session state.

### Provider

A new `FavoritesProvider implements vscode.TreeDataProvider<TreeNode>` lives in `src/treeView.ts`, parallel to `RecentProjectsProvider`. It:

1. Reads `globalState["claudeConductor.favorites"]: string[]` on demand.
2. For each path, runs `fs.existsSync(path)` to compute a `missing` flag (synchronous; the same approach `RecentProjectsProvider` uses for `addFolderPrompt` parity).
3. Feeds the resolved list through `groupByProjectRoot` (reused, not modified) so worktrees nest under each favorited root.
4. Sorts top-level groups alphabetically by `path.basename(root)`, with the full `root` path as the tiebreak.
5. Emits a `_onDidChangeTreeData` event whenever the underlying `globalState` array changes.

### Storage

| Key | Type | Scope | Notes |
|---|---|---|---|
| `claudeConductor.favorites` | `string[]` | `globalState` (per-machine) | Flat list of normalized project root paths. Order is **not** UX-visible — alphabetical sort happens at render time. Storage order is whatever `addFavorite` produces (insertion). |

Path normalization: trim trailing separators; preserve original case (Windows is case-insensitive, but we render the user's own path back to them). Comparison index uses `lowerCase` for the duplicate-detection set.

### Star Toggle (cross-panel)

Both `RecentProjectsProvider` and `FavoritesProvider` consult the same lookup index — a `Set<string>` of lowercased favorited paths — built once per refresh. This drives:

- The inline action button icon: `$(star-empty)` if not favorited, `$(star-full)` if favorited.
- The `viewItem` context value (`projectRoot.favorited` / `projectRoot.unfavorited` / `projectRoot.missing`) used by `package.json` `menus.view/item/context` clauses.

When a favorite is added or removed, *both* providers fire `onDidChangeTreeData` so the star flips state in both panels simultaneously.

### Worktree Children

Worktree rows render as today (no star, no special context value beyond what they already carry). Favoriting only happens at project-root granularity; storage never contains a `.worktrees/<branch>` path.

## Commands

| Command ID | Args | Behavior |
|---|---|---|
| `claudeConductor.addFavorite` | `path: string` | Validate path is a project root (not a worktree child). Normalize. Append to `globalState` array if not already present. Fire refresh event. |
| `claudeConductor.removeFavorite` | `path: string` | Remove the matching entry (case-insensitive). Fire refresh event. No-op if absent. |
| `claudeConductor.locateFavorite` | `path: string` | Show `vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Select new location" })`. On selection, replace the missing path **in place** in the storage array (preserves alphabetical position via re-sort on next render). If the chosen path is already a favorite, drop the missing entry instead and toast `"That folder is already in your Favorites — removed the missing entry."` |

All three commands accept a path argument so they can be invoked both from inline action buttons (which pass the tree item's resource) and from the right-click context menu.

## Menus

```jsonc
"menus": {
  "view/item/context": [
    {
      "command": "claudeConductor.addFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem == projectRoot.unfavorited",
      "group": "inline@1"
    },
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view =~ /claudeConductor\\.(recentProjects|favorites)/ && viewItem == projectRoot.favorited",
      "group": "inline@1"
    },
    {
      "command": "claudeConductor.removeFavorite",
      "when": "view == claudeConductor.favorites && viewItem == projectRoot.missing",
      "group": "missing@2"
    },
    {
      "command": "claudeConductor.locateFavorite",
      "when": "view == claudeConductor.favorites && viewItem == projectRoot.missing",
      "group": "missing@1"
    }
    // ... plus the same add/remove pair under a non-inline group for context-menu discoverability
  ]
}
```

The inline `@1` slot is the on-hover star button. The non-inline duplicates appear in the right-click menu so users who don't hover still discover the action.

## Missing-Folder Behavior

When `fs.existsSync(path) === false`:

1. **Render** — `TreeItem.description = "(missing)"`, `TreeItem.iconPath = new ThemeIcon("folder", new ThemeColor("disabledForeground"))`. The `viewItem` context value becomes `projectRoot.missing`.
2. **Click** — the `command` on the tree item is intercepted to a small handler that shows:

   `vscode.window.showInformationMessage("This folder is missing on disk.", "Locate Folder...", "Remove from Favorites")`

   - `"Locate Folder..."` → invokes `claudeConductor.locateFavorite`.
   - `"Remove from Favorites"` → invokes `claudeConductor.removeFavorite`.
   - Dismiss → no action; entry stays.
3. **Right-click** — same two actions appear in the context menu (see `menus` above), so the user does not have to click and dismiss the toast first.

Worktree children of a missing favorite are never queried (the parent's missing render short-circuits expansion). Returning to a present folder simply unsets the missing flag on the next refresh — no state is lost across the missing→present transition.

## Data Flow

```
User clicks star (Recent Projects, unfavorited row)
  └─> command: claudeConductor.addFavorite(path)
        └─> globalState.update("claudeConductor.favorites", [...current, path])
              └─> emit favoritesChanged event
                    ├─> FavoritesProvider.refresh()
                    └─> RecentProjectsProvider.refresh()  // star icon flips
```

```
User clicks a missing favorite
  └─> command: internal "showMissingFavoriteToast" handler
        └─> showInformationMessage(..., "Locate Folder...", "Remove from Favorites")
              ├─ "Locate Folder..." → claudeConductor.locateFavorite(path)
              │     └─> showOpenDialog → globalState.update(replace-in-place)
              │           └─> emit favoritesChanged
              ├─ "Remove from Favorites" → claudeConductor.removeFavorite(path)
              └─ dismiss → no-op
```

## Error Handling

| Failure | Treatment |
|---|---|
| `globalState.update` rejection | Log via `console.error`; toast `"Couldn't save Favorites — please try again."`; do not mutate in-memory state. |
| `showOpenDialog` returns `undefined` (user cancelled) | No-op. Missing entry stays as-is. |
| `addFavorite` called with a path already present (case-insensitive) | No-op. Do not duplicate. Do not toast — silent dedup is fine for this case since the user expects "make this a favorite" to be idempotent. |
| `addFavorite` called with a `.worktrees/<branch>` path | Reject with toast `"Favorite the project root, not a worktree."` and do not mutate storage. The view-context guards make this unreachable from UI clicks, but the command is still callable from the command palette. |
| `removeFavorite` called with a path not in storage | Silent no-op. |
| `locateFavorite` chosen path equals the original missing path | Treat as no-op (user picked the same path that doesn't exist). Toast `"That's the same path. Choose a different folder."` |

## Testing

New file: `test/favoritesProvider.test.ts`. Additions to `test/treeView.test.ts` for the cross-panel star icon coupling.

### `favoritesProvider.test.ts`

- Empty state — provider returns `[]` when `globalState` key is unset or `[]`.
- Single favorite, no worktrees — top-level row renders, no children.
- Single favorite with worktrees — group renders with worktree children, no star on children.
- Multiple favorites — alphabetical by basename; same-basename pair tie-broken by full path.
- Missing folder — `description` is `"(missing)"`, icon dimmed, `contextValue` is `projectRoot.missing`.
- `addFavorite` idempotence — calling twice with the same path produces a single entry.
- `addFavorite` rejects worktree paths — storage unchanged, toast invoked.
- `removeFavorite` removes case-insensitively (Windows behavior).
- `locateFavorite` happy path — replaces path in-place; alphabetical position recomputed on next render.
- `locateFavorite` dedup path — chosen path already favorited → missing entry dropped, toast emitted.
- `locateFavorite` cancel — no storage mutation.
- Refresh propagation — toggling a favorite fires `onDidChangeTreeData` on **both** providers (use a spy).

### `treeView.test.ts` additions

- Star icon state — when `path X` is in `globalState["claudeConductor.favorites"]`, the inline icon on the corresponding `RecentProjectsProvider` row is `$(star-full)`; remove and it flips to `$(star-empty)`.
- View ordering — registration order in the test harness puts Favorites between Active and Recent.

## File Touch List

| File | Change |
|---|---|
| `package.json` | Add view contribution, three commands, menu clauses. Bump version. |
| `src/treeView.ts` | New `FavoritesProvider`. New shared favorites lookup index. Stars on `RecentProjectsProvider` rows. Missing-folder click interception handler. |
| `src/extension.ts` | Register `FavoritesProvider`, register the three new commands, wire the cross-provider refresh fan-out. |
| `src/projectGrouping.ts` | **No changes.** Reused as-is. |
| `test/favoritesProvider.test.ts` | New file (per the test plan above). |
| `test/treeView.test.ts` | Add star-state and ordering tests. |
| `README.md` | Document the Favorites section under "Activity Bar Sidebar". |
| `CHANGELOG.md` | New entry under the next version. |

## Open Questions Resolved During Brainstorm

| Question | Resolution |
|---|---|
| Parallel vs mutually exclusive lists? | **Parallel.** Favorites is a curated overlay; Recent stays untouched. |
| Star button placement? | **Inline-on-hover + right-click context menu** (both interaction paths). |
| Ordering scheme? | **Alphabetical** by folder basename, full path tiebreak. Drag-to-reorder deferred. |
| Per-worktree favorites? | **No.** Project-only; worktrees come along via grouping. |
| Missing-folder behavior? | **Dim + `(missing)` suffix; click shows toast with `[Locate Folder...]` and `[Remove from Favorites]`.** Locate-folder relocates in place with dedup. |

## Risks & Mitigations

- **Risk:** `fs.existsSync` on every refresh adds I/O overhead.
  **Mitigation:** Favorites lists are small (target ≤10 entries). Sync stat is fine; if profiling later shows pain, cache results between events.
- **Risk:** `viewItem` context-value churn — three values (`favorited`/`unfavorited`/`missing`) on the same row class could break menu `when` clauses if they're spelled inconsistently.
  **Mitigation:** Define them as exported string constants in `treeView.ts`; reference from both `package.json` (manually kept in sync) and tests.
- **Risk:** A user favorites a path during a session, then `clean_gone` deletes the worktree the path *was* (but shouldn't be — favorites are project-rooted, not worktree-rooted, so this shouldn't happen by design). The guard against worktree paths in `addFavorite` prevents this.
  **Mitigation:** Hard reject worktree-path favorites at command boundary; covered in tests.
