import { describe, expect, it } from "bun:test";

import {
  createWorkspaceHarnessConfigFromPlanDraft,
  extractJsonObjectFromMarkdown,
} from "./workspaceHarnessFromPlan";

describe("workspaceHarnessFromPlan", () => {
  it("derives a non-empty checklist with stable IDs", () => {
    const result = createWorkspaceHarnessConfigFromPlanDraft({
      checklist: [{ title: "Add schema" }, { title: "Update router" }],
      gates: [{ command: "make static-check" }],
    });

    expect(result.usedFallback).toBe(false);
    expect(result.config.checklist.map((i) => i.id)).toEqual(["item-1", "item-2"]);
    expect(result.config.checklist.map((i) => i.status)).toEqual(["todo", "todo"]);
    expect(result.config.loop?.autoCommit).toBe(true);
  });

  it("falls back to a single checklist item when the draft is empty", () => {
    const result = createWorkspaceHarnessConfigFromPlanDraft({});

    expect(result.usedFallback).toBe(true);
    expect(result.config.checklist).toEqual([
      { id: "item-1", title: "Implement the plan", status: "todo" },
    ]);
    expect(result.config.loop?.autoCommit).toBe(false);
  });

  it("drops unsafe gates and disables auto-commit", () => {
    const result = createWorkspaceHarnessConfigFromPlanDraft({
      checklist: [{ title: "Ship it" }],
      gates: [{ command: "rm -rf /" }, { command: "make typecheck" }],
    });

    expect(result.usedFallback).toBe(false);
    expect(result.droppedUnsafeGates).toBe(true);
    expect(result.config.gates.map((g) => g.command)).toEqual(["make typecheck"]);
    expect(result.config.loop?.autoCommit).toBe(false);
  });

  it("dedupes checklist titles and drops trivial placeholders", () => {
    const result = createWorkspaceHarnessConfigFromPlanDraft({
      checklist: [
        { title: "TODO" },
        { title: "Add schema" },
        { title: "Add schema " },
        { title: "Update router" },
        { title: "TBD" },
      ],
    });

    expect(result.usedFallback).toBe(false);
    expect(result.config.checklist.map((i) => i.title)).toEqual(["Add schema", "Update router"]);
  });

  describe("extractJsonObjectFromMarkdown", () => {
    it("parses a ```json fenced block", () => {
      const res = extractJsonObjectFromMarkdown('```json\n{"checklist": []}\n```');

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data).toEqual({ checklist: [] });
      }
    });

    it("parses raw JSON", () => {
      const res = extractJsonObjectFromMarkdown('{"checklist": []}');

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data).toEqual({ checklist: [] });
      }
    });

    it("fails on non-JSON", () => {
      const res = extractJsonObjectFromMarkdown("not json");

      expect(res.success).toBe(false);
    });
  });
});
