import { describe, it, expect } from "vitest";
import { validateChannel } from "../scripts/guard-channel.js";

describe("validateChannel", () => {
  // --- happy paths ---

  it("accepts stable channel for even minor (1.2.0)", () => {
    expect(() => validateChannel("1.2.0", "stable")).not.toThrow();
  });

  it("accepts prerelease channel for odd minor (1.3.0)", () => {
    expect(() => validateChannel("1.3.0", "prerelease")).not.toThrow();
  });

  it("accepts stable channel for even minor (2.0.5)", () => {
    expect(() => validateChannel("2.0.5", "stable")).not.toThrow();
  });

  it("accepts prerelease channel for odd minor (1.1.0)", () => {
    expect(() => validateChannel("1.1.0", "prerelease")).not.toThrow();
  });

  // --- mismatch errors ---

  it("rejects even minor (1.2.0) for prerelease channel", () => {
    expect(() => validateChannel("1.2.0", "prerelease")).toThrow(
      /EVEN minor.*stable/i
    );
  });

  it("rejects odd minor (1.3.0) for stable channel", () => {
    expect(() => validateChannel("1.3.0", "stable")).toThrow(
      /ODD minor.*prerelease/i
    );
  });

  // --- malformed / missing inputs ---

  it("throws on malformed version string ('abc')", () => {
    expect(() => validateChannel("abc", "stable")).toThrow(/malformed|invalid/i);
  });

  it("throws on missing version (empty string)", () => {
    expect(() => validateChannel("", "stable")).toThrow(/malformed|invalid/i);
  });

  it("throws on unknown channel", () => {
    expect(() => validateChannel("1.2.0", "weird" as never)).toThrow(
      /unknown channel/i
    );
  });
});
