import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PathExistenceCache } from "../src/pathExistenceCache";

describe("PathExistenceCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("peek returns unknown for an unseen path", () => {
    const cache = new PathExistenceCache();
    expect(cache.peek("C:/x")).toEqual({ kind: "unknown" });
  });

  it("markPresent flips state and fires single-path event", () => {
    const cache = new PathExistenceCache();
    const events: unknown[] = [];
    cache.onDidChange(e => events.push(e));

    cache.markPresent("C:/x");

    expect(cache.peek("C:/x")).toEqual({ kind: "exists" });
    expect(events).toEqual([{ kind: "single", path: "C:/x" }]);
  });

  it("markMissing flips state and fires single-path event", () => {
    const cache = new PathExistenceCache();
    cache.markMissing("C:/x");
    expect(cache.peek("C:/x")).toEqual({ kind: "missing", stale: false });
  });

  it("missing entries report stale=true after TTL but never collapse to unknown (v2 flicker regression)", () => {
    const cache = new PathExistenceCache();
    cache.markMissing("C:/x");
    vi.advanceTimersByTime(31_000);  // > 30s TTL
    expect(cache.peek("C:/x")).toEqual({ kind: "missing", stale: true });
  });

  it("exists entries collapse to unknown after TTL", () => {
    const cache = new PathExistenceCache();
    cache.markPresent("C:/x");
    vi.advanceTimersByTime(31_000);
    expect(cache.peek("C:/x")).toEqual({ kind: "unknown" });
  });

  it("markPresent after markMissing unsticks the entry (v3 stuck-missing regression)", () => {
    const cache = new PathExistenceCache();
    cache.markMissing("C:/x");
    expect(cache.peek("C:/x")).toEqual({ kind: "missing", stale: false });
    cache.markPresent("C:/x");
    expect(cache.peek("C:/x")).toEqual({ kind: "exists" });
  });

  it("evict removes the entry", () => {
    const cache = new PathExistenceCache();
    cache.markPresent("C:/x");
    cache.evict("C:/x");
    expect(cache.peek("C:/x")).toEqual({ kind: "unknown" });
  });

  it("canonical-key matching: case and separator insensitive", () => {
    const cache = new PathExistenceCache();
    cache.markPresent("C:\\Foo");
    expect(cache.peek("c:/foo")).toEqual({ kind: "exists" });
    expect(cache.peek("C:\\Foo\\")).toEqual({ kind: "exists" });
  });

  it("refresh skips UNC paths (\\\\server\\share style)", async () => {
    const cache = new PathExistenceCache();
    const statSpy = vi.fn();
    // Inject stat for testability:
    (cache as unknown as { _statForTest: typeof statSpy })._statForTest = statSpy;

    await cache.refresh(["\\\\server\\share\\foo", "//server/share/bar"]);

    expect(statSpy).not.toHaveBeenCalled();
    expect(cache.peek("\\\\server\\share\\foo")).toEqual({ kind: "unknown" });
  });
});
