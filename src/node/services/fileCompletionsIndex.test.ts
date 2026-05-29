import { describe, expect, it } from "bun:test";

import { buildFileCompletionsIndex, searchFileCompletions } from "./fileCompletionsIndex";

describe("searchFileCompletions", () => {
  const files = [
    "README.md",
    "src/foo.ts",
    "src/bar.ts",
    "src/components/Button.tsx",
    "docs/guide.md",
  ];

  const index = buildFileCompletionsIndex(files);

  it("returns shallow paths first for empty queries", () => {
    expect(searchFileCompletions(index, "", 3)).toEqual(["README.md", "src/bar.ts", "src/foo.ts"]);
  });

  it("supports prefix matches on directory paths", () => {
    expect(searchFileCompletions(index, "src/", 10)).toEqual([
      "src/bar.ts",
      "src/components/Button.tsx",
      "src/foo.ts",
    ]);
  });
  it("supports prefix matches on full paths", () => {
    expect(searchFileCompletions(index, "src/f", 10)).toEqual(["src/foo.ts"]);
  });

  it("supports prefix matches on basenames", () => {
    expect(searchFileCompletions(index, "foo", 10)).toEqual(["src/foo.ts"]);
  });

  it("falls back to segment/substring matching", () => {
    expect(searchFileCompletions(index, "comp", 10)).toEqual(["src/components/Button.tsx"]);
  });

  it("normalizes Windows-style path separators", () => {
    expect(searchFileCompletions(index, "src\\b", 10)).toEqual(["src/bar.ts"]);
  });
});
