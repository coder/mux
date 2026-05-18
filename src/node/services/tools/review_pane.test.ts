import { describe, expect, it } from "bun:test";
import type { AssistedReviewHunk } from "@/common/types/review";
import { applyReviewPaneUpdate } from "./review_pane";

describe("applyReviewPaneUpdate", () => {
  it("replaces the current set when operation is 'replace'", () => {
    const current: AssistedReviewHunk[] = [{ path: "old.ts", comment: "stale" }];
    const result = applyReviewPaneUpdate(current, {
      operation: "replace",
      hunks: [{ path: "src/foo.ts:10-20", comment: "review here" }],
    });
    expect(result.hunks).toEqual([
      { path: "src/foo.ts", range: { start: 10, end: 20 }, comment: "review here" },
    ]);
  });

  it("appends to the current set when operation is 'add'", () => {
    const current: AssistedReviewHunk[] = [{ path: "src/a.ts" }];
    const result = applyReviewPaneUpdate(current, {
      operation: "add",
      hunks: [{ path: "src/b.ts:5", comment: "edge case" }],
    });
    expect(result.hunks.map((h) => h.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("dedupes by formatted path:range key when adding, preferring the latest comment", () => {
    const current: AssistedReviewHunk[] = [
      { path: "src/foo.ts", range: { start: 1, end: 10 }, comment: "first" },
    ];
    const result = applyReviewPaneUpdate(current, {
      operation: "add",
      hunks: [{ path: "src/foo.ts:1-10", comment: "refined" }],
    });
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.comment).toBe("refined");
  });

  it("returns rejected entries for malformed filters", () => {
    const result = applyReviewPaneUpdate([], {
      operation: "replace",
      hunks: [{ path: "  " }, { path: "src/ok.ts" }],
    });
    expect(result.rejected).toEqual(["  "]);
    expect(result.hunks.map((h) => h.path)).toEqual(["src/ok.ts"]);
  });

  it("normalizes empty comments to undefined", () => {
    const result = applyReviewPaneUpdate([], {
      operation: "replace",
      hunks: [{ path: "a.ts", comment: "   " }],
    });
    expect(result.hunks[0]?.comment).toBeUndefined();
  });

  it("clearing via replace with empty hunks returns empty list", () => {
    const result = applyReviewPaneUpdate([{ path: "a.ts" }, { path: "b.ts" }], {
      operation: "replace",
      hunks: [],
    });
    expect(result.hunks).toEqual([]);
  });
});
