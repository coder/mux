import { describe, expect, it } from "bun:test";

import {
  TASK_GROUP_KIND,
  buildTaskGroupLaunches,
  formatTaskGroupCreationLabel,
  formatTaskGroupHeader,
  formatTaskGroupItemsLabel,
  formatTaskGroupMemberLabel,
  formatTaskGroupSummary,
  getTaskGroupCount,
  getTaskGroupKindFromArgs,
  getTaskGroupKindFromMetadata,
  getTaskGroupLabelAtIndex,
  normalizeTaskGroupKind,
  normalizeTaskGroupLabel,
  replaceTaskVariantPlaceholder,
} from "./taskGroups";

describe("taskGroups", () => {
  it("defaults omitted task grouping to a single best-of candidate", () => {
    expect(getTaskGroupCount({})).toBe(1);
    expect(getTaskGroupKindFromArgs({})).toBe(TASK_GROUP_KIND.BEST_OF);
    expect(getTaskGroupKindFromMetadata(undefined)).toBe(TASK_GROUP_KIND.BEST_OF);
    expect(normalizeTaskGroupKind(undefined)).toBe(TASK_GROUP_KIND.BEST_OF);
  });

  it("builds repeated best-of launches with the shared prompt", () => {
    expect(buildTaskGroupLaunches({ prompt: "compare options", n: 3 })).toEqual([
      { index: 0, total: 3, kind: TASK_GROUP_KIND.BEST_OF, prompt: "compare options" },
      { index: 1, total: 3, kind: TASK_GROUP_KIND.BEST_OF, prompt: "compare options" },
      { index: 2, total: 3, kind: TASK_GROUP_KIND.BEST_OF, prompt: "compare options" },
    ]);
  });

  it("builds labeled variant launches with prompt substitution", () => {
    expect(
      buildTaskGroupLaunches({
        prompt: "Review ${variant} for regressions in ${variant}",
        variants: ["frontend", "backend"],
      })
    ).toEqual([
      {
        index: 0,
        total: 2,
        kind: TASK_GROUP_KIND.VARIANTS,
        label: "frontend",
        prompt: "Review frontend for regressions in frontend",
      },
      {
        index: 1,
        total: 2,
        kind: TASK_GROUP_KIND.VARIANTS,
        label: "backend",
        prompt: "Review backend for regressions in backend",
      },
    ]);
  });

  it("normalizes and trims task-group labels", () => {
    expect(normalizeTaskGroupLabel("  frontend  ")).toBe("frontend");
    expect(normalizeTaskGroupLabel("   ")).toBeUndefined();
    expect(replaceTaskVariantPlaceholder("Check ${variant}", "docs")).toBe("Check docs");
  });

  it("can recover variant labels from args by sibling index", () => {
    expect(getTaskGroupLabelAtIndex({ variants: ["frontend", "backend"] }, 0)).toBe("frontend");
    expect(getTaskGroupLabelAtIndex({ variants: ["frontend", "backend"] }, 1)).toBe("backend");
    expect(getTaskGroupLabelAtIndex({ variants: ["frontend", "backend"] }, 2)).toBeUndefined();
    expect(getTaskGroupLabelAtIndex({ n: 3 }, 0)).toBeUndefined();
  });

  it("formats task-group copy for best-of and variants", () => {
    expect(formatTaskGroupSummary(TASK_GROUP_KIND.BEST_OF, 3)).toBe("Best of 3");
    expect(formatTaskGroupSummary(TASK_GROUP_KIND.VARIANTS, 4)).toBe("Variants");
    expect(formatTaskGroupHeader(TASK_GROUP_KIND.VARIANTS, 4, "Split review")).toBe(
      "Variants · Split review"
    );
    expect(formatTaskGroupItemsLabel(TASK_GROUP_KIND.BEST_OF)).toBe("Candidates");
    expect(formatTaskGroupItemsLabel(TASK_GROUP_KIND.VARIANTS)).toBe("Variants");
    expect(formatTaskGroupCreationLabel(TASK_GROUP_KIND.VARIANTS)).toBe("Creating variants");
  });

  it("prefers explicit variant labels for grouped member display", () => {
    expect(
      formatTaskGroupMemberLabel({ kind: TASK_GROUP_KIND.VARIANTS, index: 0, label: "frontend" })
    ).toBe("frontend");
    expect(
      formatTaskGroupMemberLabel({ kind: TASK_GROUP_KIND.VARIANTS, index: 1, label: undefined })
    ).toBe("candidate 2");
    expect(
      formatTaskGroupMemberLabel({ kind: TASK_GROUP_KIND.BEST_OF, index: 2, label: "ignored" })
    ).toBe("candidate 3");
  });
});
