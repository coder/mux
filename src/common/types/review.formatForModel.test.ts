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
      filePath: "/opt/user/.mux/plans/workspace/my-plan.md",
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

  test("formats dev-mode mux plan annotations with Plan location", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "/home/user/.mux-dev/plans/workspace/my-plan.md",
      lineRange: "+5-8",
    });

    expect(formatted).toContain("Re Plan:L5-8");
    expect(formatted).not.toContain(".mux-dev/plans");
  });

  test("uses clean L-prefixed line ranges for plan annotations", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: "/home/user/.mux/plans/workspace/my-plan.md",
      lineRange: "-5-8 +5-8",
    });

    expect(formatted).toContain("Re Plan:L5-8");
  });

  test("does not treat bare .mux/plans relative paths as plan annotations", () => {
    const formatted = formatReviewForModel({
      ...baseReviewData,
      filePath: ".mux/plans/workspace/my-plan.md",
      lineRange: "+5-8",
    });

    expect(formatted).toContain("Re .mux/plans/workspace/my-plan.md:+5-8");
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
  test("normalizes absolute, tilde-prefixed mux, mux-suffix, and Docker plan paths to a stable .mux/plans suffix", () => {
    expect(normalizePlanFilePath("/opt/user/.mux/plans/project/ws.md")).toBe(
      ".mux/plans/project/ws.md"
    );
    expect(normalizePlanFilePath("/home/user/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/Users/user/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/root/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/tmp/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("~/.mux/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("~/.mux-dev/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("~/.mux-test/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/home/user/.mux-dev/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("/home/user/.mux-test/plans/workspace/plan.md")).toBe(
      ".mux/plans/workspace/plan.md"
    );
    expect(normalizePlanFilePath("C:\\Users\\user\\.mux-dev\\plans\\workspace\\plan.md")).toBe(
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

  test("rejects embedded and relative paths that only contain .mux/plans", () => {
    expect(normalizePlanFilePath(".mux/plans/workspace/plan.md")).toBeNull();
    expect(normalizePlanFilePath("project/.mux/plans/workspace/plan.md")).toBeNull();
    expect(normalizePlanFilePath(".mux-dev/plans/workspace/plan.md")).toBeNull();
    expect(normalizePlanFilePath("project/.mux-dev/plans/workspace/plan.md")).toBeNull();
    expect(normalizePlanFilePath("/var/mux/plans/")).toBeNull();
  });
});

describe("isPlanFilePath", () => {
  test("recognizes absolute, tilde-prefixed local, and Docker plan paths across separators", () => {
    expect(isPlanFilePath("/opt/user/.mux/plans/project/ws.md")).toBeTrue();
    expect(isPlanFilePath("/home/user/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("/Users/user/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("/root/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("/tmp/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("~/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("~/.mux-dev/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("~/.mux-test/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("C:\\Users\\user\\.mux\\plans\\workspace\\plan.md")).toBeTrue();
    expect(isPlanFilePath("C:/Users/user/.mux/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("/home/user/.mux-dev/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("/home/user/.mux-test/plans/workspace/plan.md")).toBeTrue();
    expect(isPlanFilePath("C:\\Users\\user\\.mux-dev\\plans\\workspace\\plan.md")).toBeTrue();
    expect(isPlanFilePath("/var/mux/plans/myproject/workspace.md")).toBeTrue();
    expect(isPlanFilePath("C:\\var\\mux\\plans\\myproject\\workspace.md")).toBeTrue();
  });

  test("rejects non-plan paths, relative paths, and empty paths", () => {
    expect(isPlanFilePath("src/planning/planner.ts")).toBeFalse();
    expect(isPlanFilePath("plan.txt")).toBeFalse();
    expect(isPlanFilePath(".mux/plans/workspace/plan.md")).toBeFalse();
    expect(isPlanFilePath("project/.mux/plans/workspace/plan.md")).toBeFalse();
    expect(isPlanFilePath(".mux-dev/plans/workspace/plan.md")).toBeFalse();
    expect(isPlanFilePath("project/.mux-dev/plans/workspace/plan.md")).toBeFalse();
    expect(isPlanFilePath("/var/mux/plan/myproject/workspace.md")).toBeFalse();
    expect(isPlanFilePath("")).toBeFalse();
  });
});
