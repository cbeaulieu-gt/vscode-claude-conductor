import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";

// Must use vi.mock("fs") — the same pattern as addFolderPrompt.stale.test.ts —
// because ESM module namespaces are not reconfigurable via vi.spyOn.
vi.mock("fs");

vi.mock("vscode", async () => {
  const m = await import("./mocks/vscode");
  return m;
});

import { SessionManager } from "../src/sessionManager";

describe("launchSession LaunchResult", () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    // Default: fs.existsSync returns true (path exists), readdirSync returns
    // empty array (no session-state files to process during cleanup).
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns {ok:false, reason:'missing'} for a non-UNC path that doesn't exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const sm = new SessionManager();
    const r = await sm.launchSession("C:/no/such/path");
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "missing" }));
    sm.dispose();
  });

  it("returns {ok:true} for a path that exists", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const sm = new SessionManager();
    const r = await sm.launchSession("C:/exists");
    expect(r.ok).toBe(true);
    sm.dispose();
  });

  it("skips fs.existsSync pre-flight for UNC paths", async () => {
    // existsSync returns false — but for UNC paths we should skip the check
    // and still succeed.
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const sm = new SessionManager();
    const r = await sm.launchSession("\\\\server\\share\\foo");
    // existsSync should not have been called for the UNC path itself
    expect(vi.mocked(fs.existsSync)).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\\\\server/)
    );
    expect(r.ok).toBe(true);
    sm.dispose();
  });
});
