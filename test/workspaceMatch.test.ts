/**
 * Unit tests for isSameWorkspaceFolder helper (src/workspaceMatch.ts).
 *
 * This helper is pure (no VS Code dependencies), so no mocks are needed.
 */

import { describe, it, expect } from "vitest";
import { isSameWorkspaceFolder } from "../src/workspaceMatch";

describe("isSameWorkspaceFolder", () => {
  it("returns true when paths are identical", () => {
    expect(isSameWorkspaceFolder("/home/user/project", "/home/user/project")).toBe(true);
  });

  it("returns true for case-insensitive match (Windows paths)", () => {
    expect(isSameWorkspaceFolder("C:\\Users\\foo\\Project", "c:\\users\\foo\\project")).toBe(true);
  });

  it("returns true when only casing differs on Unix-style paths", () => {
    expect(isSameWorkspaceFolder("/Home/User/Project", "/home/user/project")).toBe(true);
  });

  it("returns false when paths are different", () => {
    expect(isSameWorkspaceFolder("/home/user/project-a", "/home/user/project-b")).toBe(false);
  });

  it("returns false when currentFolder is undefined", () => {
    expect(isSameWorkspaceFolder(undefined, "/home/user/project")).toBe(false);
  });

  it("returns false when currentFolder is an empty string", () => {
    expect(isSameWorkspaceFolder("", "/home/user/project")).toBe(false);
  });

  it("returns false when only one has a trailing separator", () => {
    // Exact match semantics — we do not normalise trailing slashes here
    expect(isSameWorkspaceFolder("/home/user/project/", "/home/user/project")).toBe(false);
  });
});
