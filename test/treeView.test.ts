/**
 * Tests for the grouped tree-view providers (src/treeView.ts).
 *
 * These tests exercise:
 *  - ActiveSessionsProvider: getChildren(undefined) returns group items;
 *    getChildren(group) returns leaf sessions.
 *  - RecentProjectsProvider: same two-level pattern.
 *  - Child-count in description for both phantom and non-phantom roots.
 *  - Phantom root: dimmed icon + "(not in recents)" suffix.
 *  - Dedup filter removed: active-session folders still appear in Recent Projects.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActiveSession } from "../src/sessionManager";
import type { FolderEntry } from "../src/folderSource";
import type { FavoritesStore as FavoritesStoreType } from "../src/favoritesStore";
import { FavoritesStore } from "../src/favoritesStore";
import type { PathExistenceCache as PathExistenceCacheType } from "../src/pathExistenceCache";
import { PathExistenceCache } from "../src/pathExistenceCache";

// ---------------------------------------------------------------------------
// Minimal stubs — keep them local so this test file is self-contained.
// ---------------------------------------------------------------------------

function makeSession(folderPath: string): ActiveSession {
  return {
    terminal: {
      name: `claude · ${folderPath.split(/[\\/]/).pop()}`,
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
      processId: Promise.resolve(undefined),
      shellIntegration: undefined,
      creationOptions: { cwd: folderPath },
    } as unknown as import("vscode").Terminal,
    folderPath,
    folderName: folderPath.split(/[\\/]/).pop() ?? "",
    startedAt: new Date(),
    isIdle: false,
  };
}

function makeFolder(folderPath: string): FolderEntry {
  const parts = folderPath.split(/[\\/]/);
  return {
    folderPath,
    name: parts[parts.length - 1] ?? "",
    parentDir: parts.slice(0, -1).join("/"),
    source: "recent" as const,
  };
}

// ---------------------------------------------------------------------------
// Minimal SessionManager stub
// ---------------------------------------------------------------------------

function makeSessionManager(sessions: ActiveSession[]) {
  const listeners: Array<() => void> = [];
  return {
    get activeSessions() { return sessions; },
    onDidChangeSessions: (cb: () => void) => {
      listeners.push(cb);
      return { dispose: () => {} };
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal FavoritesStore and PathExistenceCache stubs
// ---------------------------------------------------------------------------

function makeFakeFavoritesStore(): FavoritesStoreType {
  return {
    isFavorited: () => false,
    list: () => [],
    isOverCap: () => false,
    onDidChange: () => ({ dispose: () => {} }),
    add: async () => ({ ok: true }),
    remove: async () => undefined,
    relocate: async () => ({ ok: true }),
    waitForIdle: async () => undefined,
    dispose: () => {},
  } as unknown as FavoritesStore;
}

function makeFakeExistenceCache(): PathExistenceCacheType {
  return {
    peek: () => ({ kind: "unknown" } as const),
    markPresent: () => {},
    markMissing: () => {},
    evict: () => {},
    refresh: async () => {},
    onDidChange: () => ({ dispose: () => {} }),
    dispose: () => {},
  } as unknown as PathExistenceCache;
}

// ---------------------------------------------------------------------------
// Import providers under test (after vi.mock declarations)
// ---------------------------------------------------------------------------

// We need getAllFolders to be mockable. Do this before the import.
vi.mock("../src/folderSource", () => ({
  getAllFolders: vi.fn(),
}));

import { ActiveSessionsProvider, RecentProjectsProvider, VIEW_ITEM } from "../src/treeView";
import { getAllFolders } from "../src/folderSource";
import {
  TreeItemCollapsibleState,
  ThemeIcon,
  ThemeColor,
} from "./mocks/vscode";

// ---------------------------------------------------------------------------
// ActiveSessionsProvider
// ---------------------------------------------------------------------------

describe("ActiveSessionsProvider — grouped tree", () => {
  const root = "/home/user/my-project";
  const wt1 = "/home/user/my-project/.worktrees/feature-a";
  const wt2 = "/home/user/my-project/.worktrees/fix-b";

  it("getChildren(undefined) returns group-level items (not flat sessions)", () => {
    const sessions = [makeSession(root), makeSession(wt1), makeSession(wt2)];
    const mgr = makeSessionManager(sessions);
    const provider = new ActiveSessionsProvider(mgr as never, makeFakeFavoritesStore());

    const topLevel = provider.getChildren(undefined);

    // Should return 1 group item, not 3 flat items
    expect(topLevel).toHaveLength(1);
    // Group item must be collapsible (Collapsed by default)
    expect(topLevel[0].collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
  });

  it("getChildren(groupItem) returns the group's session leaf items", () => {
    const sessions = [makeSession(root), makeSession(wt1), makeSession(wt2)];
    const mgr = makeSessionManager(sessions);
    const provider = new ActiveSessionsProvider(mgr as never, makeFakeFavoritesStore());

    const topLevel = provider.getChildren(undefined);
    const children = provider.getChildren(topLevel[0]);

    // 3 sessions under one root → group has 3 children
    expect(children).toHaveLength(3);
    // Each child should be a leaf (None collapsible state)
    for (const child of children) {
      expect(child.collapsibleState).toBe(TreeItemCollapsibleState.None);
    }
  });

  it("child count N appears in the group row description", () => {
    const sessions = [makeSession(root), makeSession(wt1)];
    const mgr = makeSessionManager(sessions);
    const provider = new ActiveSessionsProvider(mgr as never, makeFakeFavoritesStore());

    const topLevel = provider.getChildren(undefined);

    expect(topLevel[0].description).toContain("2");
  });

  it("worktree leaf description shows branch name, not parent directory", () => {
    const sessions = [makeSession(root), makeSession(wt1)];
    const mgr = makeSessionManager(sessions);
    const provider = new ActiveSessionsProvider(mgr as never, makeFakeFavoritesStore());

    const [group] = provider.getChildren(undefined);
    const children = provider.getChildren(group);

    const wtChild = children.find((c) => c.label === "feature-a" || String(c.description ?? "").includes("feature-a"));
    // The worktree leaf should reference the branch name somehow (label or description)
    const wtSession = sessions.find((s) => s.folderPath === wt1)!;
    const wtLeaf = children.find(
      (c) => c.label === "feature-a" || c.label === wtSession.folderName
    );
    expect(wtLeaf).toBeDefined();
    // Its description should be the branch name, NOT the full parent path
    expect(wtLeaf!.description).not.toContain("/home/user/my-project/.worktrees");
  });

  it("two different project roots → two group items at top level", () => {
    const rootB = "/home/user/project-b";
    const sessions = [makeSession(root), makeSession(rootB)];
    const mgr = makeSessionManager(sessions);
    const provider = new ActiveSessionsProvider(mgr as never, makeFakeFavoritesStore());

    const topLevel = provider.getChildren(undefined);
    expect(topLevel).toHaveLength(2);
  });

  it("single session with no worktrees still returns a group with 1 child", () => {
    const sessions = [makeSession(root)];
    const mgr = makeSessionManager(sessions);
    const provider = new ActiveSessionsProvider(mgr as never, makeFakeFavoritesStore());

    const topLevel = provider.getChildren(undefined);
    expect(topLevel).toHaveLength(1);
    expect(topLevel[0].collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);

    const children = provider.getChildren(topLevel[0]);
    expect(children).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// RecentProjectsProvider
// ---------------------------------------------------------------------------

describe("RecentProjectsProvider — grouped tree", () => {
  const root = "/home/user/my-project";
  const wt1 = "/home/user/my-project/.worktrees/feature-a";

  beforeEach(() => {
    vi.mocked(getAllFolders).mockResolvedValue([]);
  });

  it("getChildren(undefined) returns group items when folders include worktrees", async () => {
    vi.mocked(getAllFolders).mockResolvedValue([makeFolder(root), makeFolder(wt1)]);
    const mgr = makeSessionManager([]);
    const provider = new RecentProjectsProvider(mgr as never, makeFakeFavoritesStore(), makeFakeExistenceCache());

    const topLevel = await provider.getChildren(undefined);

    expect(topLevel).toHaveLength(1);
    expect(topLevel[0].collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
  });

  it("getChildren(groupItem) returns the group's folder leaf items", async () => {
    vi.mocked(getAllFolders).mockResolvedValue([makeFolder(root), makeFolder(wt1)]);
    const mgr = makeSessionManager([]);
    const provider = new RecentProjectsProvider(mgr as never, makeFakeFavoritesStore(), makeFakeExistenceCache());

    const topLevel = await provider.getChildren(undefined);
    const children = await provider.getChildren(topLevel[0]);

    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.collapsibleState).toBe(TreeItemCollapsibleState.None);
    }
  });

  it("child count appears in group description for non-phantom root", async () => {
    vi.mocked(getAllFolders).mockResolvedValue([makeFolder(root), makeFolder(wt1)]);
    const mgr = makeSessionManager([]);
    const provider = new RecentProjectsProvider(mgr as never, makeFakeFavoritesStore(), makeFakeExistenceCache());

    const topLevel = await provider.getChildren(undefined);

    expect(topLevel[0].description).toContain("2");
  });

  it("phantom root has (not in recents) suffix in description", async () => {
    // Only the worktree is in recents — the root itself is absent
    vi.mocked(getAllFolders).mockResolvedValue([makeFolder(wt1)]);
    const mgr = makeSessionManager([]);
    const provider = new RecentProjectsProvider(mgr as never, makeFakeFavoritesStore(), makeFakeExistenceCache());

    const topLevel = await provider.getChildren(undefined);

    expect(topLevel).toHaveLength(1);
    expect(topLevel[0].description).toContain("not in recents");
  });

  it("phantom root has a dimmed icon", async () => {
    vi.mocked(getAllFolders).mockResolvedValue([makeFolder(wt1)]);
    const mgr = makeSessionManager([]);
    const provider = new RecentProjectsProvider(mgr as never, makeFakeFavoritesStore(), makeFakeExistenceCache());

    const topLevel = await provider.getChildren(undefined);
    const icon = topLevel[0].iconPath as ThemeIcon;

    // Must be a ThemeIcon with a muted color token
    expect(icon).toBeInstanceOf(ThemeIcon);
    expect(icon.color).toBeInstanceOf(ThemeColor);
    expect(icon.color!.id).toContain("disabled");
  });

  it("active-session folders are NOT filtered out of Recent Projects (dedup removed)", async () => {
    // Previously the dedup filter excluded active-session paths from recents.
    // After this change, the same path may appear in both panels.
    vi.mocked(getAllFolders).mockResolvedValue([makeFolder(root)]);
    const mgr = makeSessionManager([makeSession(root)]);
    const provider = new RecentProjectsProvider(mgr as never, makeFakeFavoritesStore(), makeFakeExistenceCache());

    const topLevel = await provider.getChildren(undefined);

    // root should appear in Recent Projects even though it has an active session
    expect(topLevel).toHaveLength(1);
    const allItems = [...topLevel, ...(await provider.getChildren(topLevel[0]))];
    const hasFolderPath = allItems.some(
      (item) => (item as { folderPath?: string }).folderPath === root ||
                item.label === "my-project"
    );
    expect(hasFolderPath).toBe(true);
  });

  it("two project roots → two group items at top level", async () => {
    const rootB = "/home/user/project-b";
    vi.mocked(getAllFolders).mockResolvedValue([makeFolder(root), makeFolder(rootB)]);
    const mgr = makeSessionManager([]);
    const provider = new RecentProjectsProvider(mgr as never, makeFakeFavoritesStore(), makeFakeExistenceCache());

    const topLevel = await provider.getChildren(undefined);
    expect(topLevel).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// VIEW_ITEM constants
// ---------------------------------------------------------------------------

describe("VIEW_ITEM constants", () => {
  it("has all required tokens", () => {
    expect(VIEW_ITEM.PROJECT_ROOT_FAVORITED).toBe("projectRoot.favorited");
    expect(VIEW_ITEM.PROJECT_ROOT_UNFAVORITED).toBe("projectRoot.unfavorited");
    expect(VIEW_ITEM.PROJECT_ROOT_MISSING).toBe("projectRoot.missing");
    expect(VIEW_ITEM.WORKTREE_CHILD).toBe("worktreeChild");
    expect(VIEW_ITEM.ACTIVE_SESSION).toBe("activeSession");
  });
});

// ---------------------------------------------------------------------------
// Cross-panel star coupling + race regression
// ---------------------------------------------------------------------------

describe("Cross-panel star coupling", () => {
  function makeRealMemento(): import("vscode").Memento {
    const data: Record<string, unknown> = {};
    return {
      keys: () => Object.keys(data),
      get: <T>(k: string) => data[k] as T | undefined,
      update: async (k: string, v: unknown) => { data[k] = v; },
    } as unknown as import("vscode").Memento;
  }

  it("Recent Projects group row reflects favorited state immediately after store.add", async () => {
    const store = new FavoritesStore(makeRealMemento());
    const cache = new PathExistenceCache();
    const sm = makeSessionManager([]);

    vi.mocked(getAllFolders).mockResolvedValue([
      { folderPath: "C:/proj", name: "proj", parentDir: "C:", source: "recent" as const },
    ]);

    const provider = new RecentProjectsProvider(sm as never, store, cache);

    // Before add: group row contextValue should be unfavorited
    const groupsBefore = await provider.getChildren();
    expect(groupsBefore[0].contextValue).toBe(VIEW_ITEM.PROJECT_ROOT_UNFAVORITED);

    await store.add("C:/proj");

    // After add: group row contextValue is favorited
    const groupsAfter = await provider.getChildren();
    expect(groupsAfter[0].contextValue).toBe(VIEW_ITEM.PROJECT_ROOT_FAVORITED);
  });

  it("regression: group rows reflect live store state, not a stale snapshot", async () => {
    // Simulates the v1-blocker race: provider's getChildren(undefined) is called
    // AFTER getAllFolders() resolved, so the group-item construction reads the
    // store synchronously at construction time. If a mutation lands between
    // getAllFolders() resolving and a second getChildren() call, the new state
    // must be reflected.
    const store = new FavoritesStore(makeRealMemento());
    const cache = new PathExistenceCache();
    const sm = makeSessionManager([]);

    vi.mocked(getAllFolders).mockResolvedValue([
      { folderPath: "C:/proj", name: "proj", parentDir: "C:", source: "recent" as const },
    ]);

    const provider = new RecentProjectsProvider(sm as never, store, cache);

    // Step 1: fetch top-level groups (this is where getAllFolders is awaited)
    const groups = await provider.getChildren();
    expect(groups).toHaveLength(1);

    // Step 2: mutate the store.
    await store.add("C:/proj");

    // Step 3: re-fetch groups — they MUST reflect the latest store state.
    const groupsAfter = await provider.getChildren();
    expect(groupsAfter[0].contextValue).toBe(VIEW_ITEM.PROJECT_ROOT_FAVORITED);
  });
});

// ---------------------------------------------------------------------------
// ActiveSessionsProvider favorited contextValue
// ---------------------------------------------------------------------------

describe("ActiveSessionsProvider favorited contextValue", () => {
  it("group row reflects favorited state synchronously after store.add", async () => {
    const data: Record<string, unknown> = {};
    const memento = {
      keys: () => Object.keys(data),
      get: <T>(k: string) => data[k] as T | undefined,
      update: async (k: string, v: unknown) => { data[k] = v; },
    } as unknown as import("vscode").Memento;

    const store = new FavoritesStore(memento);
    const sm = makeSessionManager([
      makeSession("C:/proj"),
    ]);

    const provider = new ActiveSessionsProvider(sm as never, store);

    const groupsBefore = provider.getChildren();
    expect(groupsBefore[0].contextValue).toBe(VIEW_ITEM.PROJECT_ROOT_UNFAVORITED);

    await store.add("C:/proj");

    const groupsAfter = provider.getChildren();
    expect(groupsAfter[0].contextValue).toBe(VIEW_ITEM.PROJECT_ROOT_FAVORITED);
  });
});
