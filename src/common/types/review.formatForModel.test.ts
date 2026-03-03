import { describe, expect, test } from "bun:test";

import {
  formatReviewForModel,
  isPlanFilePath,
  normalizePlanFilePath,
  type ReviewNoteData,
} from "./review";

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

  test("formats Docker plan annotations with Plan location", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "/var/mux/plans/workspace/my-plan.md",
      lineRange: "+5-8",
    });

    expect(formatted).toContain("Re Plan:L5-8");
    expect(formatted).not.toContain("/var/mux/plans");
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

describe("normalizePlanFilePath", () => {
  test("normalizes local and Docker plan paths to a stable .mux/plans suffix", () => {
    expect(normalizePlanFilePath("~/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/home/user/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("C:\\Users\\user\\.mux\\plans\\workspace\\plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/var/mux/plans/myproject/workspace.md")).toBe(
      ".mux/plans/myproject/workspace.md"
    );
    expect(normalizePlanFilePath("C:\\var\\mux\\plans\\myproject\\workspace.md")).toBe(
      ".mux/plans/myproject/workspace.md"
    );
  });
});

describe("isPlanFilePath", () => {
  test("recognizes local and Docker plan paths across separators", () => {
    expect(isPlanFilePath("~/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath(".mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("C:\\Users\\user\\.mux\\plans\\workspace\\plan.md")).toBeTrue();
    expect(isPlanFilePath("C:/Users/user/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("/var/mux/plans/myproject/workspace.md")).toBeTrue();
    expect(isPlanFilePath("C:\\var\\mux\\plans\\myproject\\workspace.md")).toBeTrue();
  });

  test("rejects non-plan paths and empty paths", () => {
    expect(isPlanFilePath("src/planning/planner.ts")).toBeFalse();
    expect(isPlanFilePath("plan.txt")).toBeFalse();
    expect(isPlanFilePath("/var/mux/plan/myproject/workspace.md")).toBeFalse();
    expect(isPlanFilePath("")).toBeFalse();
  });
});
