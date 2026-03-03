import { describe, expect, test } from "bun:test";

import { formatReviewForModel, isPlanFilePath, type ReviewNoteData } from "./review";

const baseReviewData: ReviewNoteData = {
  filePath: "src/common/types/review.ts",
  lineRange: "-10-12 +14-16",
  selectedCode: "const value = 1;",
  userNote: "Please rename this variable.",
};

describe("formatReviewForModel", () => {
  test("formats standard code review notes with file path and line range", () => {
    expect(formatReviewForModel(baseReviewData)).toBe(
      "<review>\nRe src/common/types/review.ts:-10-12 +14-16\n```\nconst value = 1;\n```\n> Please rename this variable.\n</review>"
    );
  });

  test("formats plan annotations with Plan location instead of raw plan file path", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "~/.mux/plans/workspace/my-plan.md",
      lineRange: "+5-8",
    });

    expect(formatted).toContain("Re Plan:L5-8");
    expect(formatted).not.toContain(".mux/plans");
  });

  test("uses clean L-prefixed line ranges for plan annotations", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: ".mux/plans/workspace/my-plan.md",
      lineRange: "-5-8 +5-8",
    });

    expect(formatted).toContain("Re Plan:L5-8");
  });

  test("does not treat non-plan paths containing plan-like words as plan paths", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "src/planning/planner.ts",
      lineRange: "+5-8",
    });

    expect(formatted).toContain("Re src/planning/planner.ts:+5-8");
  });

  test("trims surrounding whitespace from user note", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      userNote: "   keep this note trimmed   ",
    });

    expect(formatted).toContain("> keep this note trimmed\n</review>");
  });
});

describe("isPlanFilePath", () => {
  test("recognizes standard plan paths", () => {
    expect(isPlanFilePath("~/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath(".mux/plans/workspace/plan.md")).toBeTrue();
  });

  test("rejects non-plan paths and empty paths", () => {
    expect(isPlanFilePath("src/planning/planner.ts")).toBeFalse();
    expect(isPlanFilePath("plan.txt")).toBeFalse();
    expect(isPlanFilePath("")).toBeFalse();
  });
});
