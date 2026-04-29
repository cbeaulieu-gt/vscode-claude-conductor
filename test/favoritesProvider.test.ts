import { describe, it, expect, vi } from "vitest";
import type { Memento } from "vscode";

import { FavoritesStore } from "../src/favoritesStore";
import { PathExistenceCache } from "../src/pathExistenceCache";
import { FavoritesProvider, VIEW_ITEM } from "../src/treeView";

function makeMemento(): Memento {
  const data: Record<string, unknown> = {};
  return {
    keys: () => Object.keys(data),
    get: <T>(k: string) => data[k] as T | undefined,
    update: async (k: string, v: unknown) => { data[k] = v; },
  } as unknown as Memento;
}

describe("FavoritesProvider", () => {
  it("returns empty children when store has no entries", async () => {
    const store = new FavoritesStore(makeMemento());
    const cache = new PathExistenceCache();
    const provider = new FavoritesProvider(store, cache);
    expect(await provider.getChildren()).toEqual([]);
  });

  it("renders a single favorite as a top-level row with projectRoot.favorited contextValue", async () => {
    const store = new FavoritesStore(makeMemento());
    await store.add("C:/proj");
    const cache = new PathExistenceCache();
    cache.markPresent("C:/proj");

    const provider = new FavoritesProvider(store, cache);
    const top = await provider.getChildren();
    expect(top).toHaveLength(1);
    expect(top[0].contextValue).toBe(VIEW_ITEM.PROJECT_ROOT_FAVORITED);
  });

  it("renders alphabetically (basename, full-path tiebreak)", async () => {
    const store = new FavoritesStore(makeMemento());
    await store.add("C:/zzz");
    await store.add("C:/aaa");
    await store.add("C:/mmm");
    const cache = new PathExistenceCache();
    const provider = new FavoritesProvider(store, cache);

    const top = await provider.getChildren();
    expect(top.map(n => n.label)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("alphabetical sort tiebreak: identical basenames sort by full path", async () => {
    const store = new FavoritesStore(makeMemento());
    await store.add("D:/zebra/aaa");
    await store.add("C:/alpha/aaa");
    const cache = new PathExistenceCache();
    const provider = new FavoritesProvider(store, cache);

    const top = await provider.getChildren();
    expect(top).toHaveLength(2);
    // Both rows have label "aaa"; their order is determined by the full-path tiebreak.
    // Lowercased full-path comparison: "c:/alpha/aaa" < "d:/zebra/aaa".
    expect((top[0] as { folderPath: string }).folderPath).toBe("C:/alpha/aaa");
    expect((top[1] as { folderPath: string }).folderPath).toBe("D:/zebra/aaa");
  });

  it("renders missing folder with (missing) description, dimmed icon, and locate command", async () => {
    const store = new FavoritesStore(makeMemento());
    await store.add("C:/missing");
    const cache = new PathExistenceCache();
    cache.markMissing("C:/missing");

    const provider = new FavoritesProvider(store, cache);
    const [row] = await provider.getChildren();

    expect(row.description).toBe("(missing)");
    expect(row.contextValue).toBe(VIEW_ITEM.PROJECT_ROOT_MISSING);
    expect(row.command).toEqual({
      command: "claudeConductor.locateFavorite",
      title: "Relocate Folder",
      arguments: ["C:/missing"],
    });
  });

  it("stale-missing renders identical to fresh-missing (no flicker regression)", async () => {
    vi.useFakeTimers();
    try {
      const store = new FavoritesStore(makeMemento());
      await store.add("C:/missing");
      const cache = new PathExistenceCache();
      cache.markMissing("C:/missing");
      vi.advanceTimersByTime(31_000);

      const provider = new FavoritesProvider(store, cache);
      const [row] = await provider.getChildren();
      expect(row.description).toBe("(missing)");
      expect(row.contextValue).toBe(VIEW_ITEM.PROJECT_ROOT_MISSING);
    } finally {
      vi.useRealTimers();
    }
  });

  it("optimistic-present on UNC paths (cache returns unknown)", async () => {
    const store = new FavoritesStore(makeMemento());
    await store.add("\\\\server\\share\\foo");
    const cache = new PathExistenceCache();

    const provider = new FavoritesProvider(store, cache);
    const [row] = await provider.getChildren();
    expect(row.description).not.toBe("(missing)");
    expect(row.contextValue).toBe(VIEW_ITEM.PROJECT_ROOT_FAVORITED);
  });

  it("renders all entries when storage drifts >25; getOverCapBanner returns banner string", async () => {
    const m = makeMemento();
    const seed = Array.from({ length: 30 }, (_, i) => ({ path: `C:/p${String(i).padStart(2, "0")}` }));
    await m.update("claudeConductor.favorites", { version: 2, entries: seed });

    const store = new FavoritesStore(m);
    const cache = new PathExistenceCache();
    const provider = new FavoritesProvider(store, cache);

    const top = await provider.getChildren();
    expect(top).toHaveLength(30);
    expect(provider.getOverCapBanner()).toMatch(/over the 25 cap.*consider removing/i);
  });

  it("addFavorite past cap: store rejects, provider state unchanged", async () => {
    const store = new FavoritesStore(makeMemento());
    for (let i = 0; i < 25; i++) await store.add(`C:/p${i}`);
    const cache = new PathExistenceCache();
    const provider = new FavoritesProvider(store, cache);

    const r = await store.add("C:/over");
    expect(r.ok).toBe(false);

    const top = await provider.getChildren();
    expect(top).toHaveLength(25);
  });
});
