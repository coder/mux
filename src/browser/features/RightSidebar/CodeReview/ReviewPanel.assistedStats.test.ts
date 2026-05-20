import { describe, expect, test } from "bun:test";

import type { AssistedReviewHunk, DiffHunk } from "@/common/types/review";
import { countUnreadAssistedHunks } from "./ReviewPanel";

function hunk(overrides: Partial<DiffHunk>): DiffHunk {
  return {
    id: overrides.id ?? "h1",
    filePath: overrides.filePath ?? "src/file.ts",
    oldStart: overrides.oldStart ?? 1,
    oldLines: overrides.oldLines ?? 3,
    newStart: overrides.newStart ?? 1,
    newLines: overrides.newLines ?? 3,
    content: overrides.content ?? " line\n+change",
    header: overrides.header ?? "@@ -1,3 +1,3 @@",
    changeType: overrides.changeType,
    oldPath: overrides.oldPath,
  };
}

describe("countUnreadAssistedHunks", () => {
  test("counts only matched assisted hunks that are not read", () => {
    const hunks = [
      hunk({ id: "unread-match", filePath: "src/a.ts", newStart: 10, newLines: 5 }),
      hunk({ id: "read-match", filePath: "src/a.ts", newStart: 30, newLines: 5 }),
      hunk({ id: "unmatched", filePath: "src/b.ts", newStart: 10, newLines: 5 }),
    ];
    const assisted: AssistedReviewHunk[] = [{ path: "src/a.ts" }];

    const count = countUnreadAssistedHunks(hunks, assisted, (id) => id === "read-match");

    expect(count).toBe(1);
  });

  test("range filters count only overlapping new-side hunks", () => {
    const hunks = [
      hunk({ id: "before", filePath: "src/a.ts", newStart: 1, newLines: 3 }),
      hunk({ id: "overlap", filePath: "src/a.ts", newStart: 9, newLines: 3 }),
      hunk({ id: "after", filePath: "src/a.ts", newStart: 20, newLines: 3 }),
    ];
    const assisted: AssistedReviewHunk[] = [{ path: "src/a.ts", range: { start: 10, end: 12 } }];

    expect(countUnreadAssistedHunks(hunks, assisted, () => false)).toBe(1);
  });
});
