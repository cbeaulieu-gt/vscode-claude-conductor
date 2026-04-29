import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { VIEW_ITEM } from "../src/treeView";

interface Menu {
  command?: string;
  when?: string;
  group?: string;
}

const PKG_PATH = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8")) as {
  contributes?: { menus?: { "view/item/context"?: Menu[] } };
};

const clauses = pkg.contributes?.menus?.["view/item/context"] ?? [];
const allWhen = clauses.map(c => c.when ?? "").filter(Boolean);

const VIEW_ITEM_VALUES = Object.values(VIEW_ITEM) as string[];

/** Extract every `viewItem == "X"` literal token from a when string. */
function extractEqLiterals(when: string): string[] {
  const re = /viewItem\s*==\s*([A-Za-z][A-Za-z0-9._-]*)/g;
  const out: string[] = [];
  let m;
  while ((m = re.exec(when)) !== null) out.push(m[1]);
  return out;
}

/** Extract every `viewItem =~ /pattern/flags?` regex (compiled as RegExp) from a when string. */
function extractRegexes(when: string): RegExp[] {
  // Match: viewItem =~ /escaped/flags?
  const re = /viewItem\s*=~\s*\/((?:\\\/|[^/])+)\/([gimsuy]*)/g;
  const out: RegExp[] = [];
  let m;
  while ((m = re.exec(when)) !== null) {
    // package.json stores `\\.` for a regex literal-dot. After JSON.parse the
    // string already contains a single `\.` — no further unescaping needed.
    out.push(new RegExp(m[1], m[2]));
  }
  return out;
}

const NEGATIVE_FIXTURES = [
  "projectRootSomething",       // missing dot separator
  "projectRoot",                // missing state suffix
  "myprojectRoot.favorited",    // prefix
  "projectRoot.favoritedExtra", // suffix beyond a state token
  "recentProject",              // legacy un-migrated value — should NOT match the migrated regex
  "xyzactiveSession",
  "activeSessionFoo",
];

describe("package.json viewItem ↔ VIEW_ITEM bidirectional bijection", () => {
  it("every `viewItem == X` literal references a VIEW_ITEM value", () => {
    const literals = allWhen.flatMap(extractEqLiterals);
    expect(literals.length).toBeGreaterThan(0);  // sanity: some `==` clauses exist
    for (const lit of literals) {
      expect(VIEW_ITEM_VALUES).toContain(lit);
    }
  });

  it("every `viewItem =~ /pattern/` matches at least one VIEW_ITEM value", () => {
    const regexes = allWhen.flatMap(extractRegexes);
    for (const re of regexes) {
      const matched = VIEW_ITEM_VALUES.some(v => re.test(v));
      expect(matched, `regex ${re.source} matched no VIEW_ITEM value`).toBe(true);
    }
  });

  it("every VIEW_ITEM value is referenced by at least one menu clause", () => {
    const literals = allWhen.flatMap(extractEqLiterals);
    const regexes = allWhen.flatMap(extractRegexes);
    for (const value of VIEW_ITEM_VALUES) {
      const referenced =
        literals.includes(value) ||
        regexes.some(re => re.test(value));
      expect(
        referenced,
        `VIEW_ITEM value '${value}' is orphaned (no menu clause references it)`
      ).toBe(true);
    }
  });

  it("regexes do not match negative-fixture sibling tokens", () => {
    const regexes = allWhen.flatMap(extractRegexes);
    for (const re of regexes) {
      for (const neg of NEGATIVE_FIXTURES) {
        expect(
          re.test(neg),
          `regex ${re.source} unexpectedly matched negative fixture '${neg}'`
        ).toBe(false);
      }
    }
  });
});
