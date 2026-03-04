import { describe, expect, it } from "bun:test";

import type { SectionConfig, SectionRule, SectionRuleCondition } from "@/common/schemas/project";

import { evaluateCondition, evaluateSectionRules, type WorkspaceRuleContext } from "./sectionRules";

function makeCtx(overrides: Partial<WorkspaceRuleContext> = {}): WorkspaceRuleContext {
  return {
    workspaceId: "ws-1",
    agentMode: undefined,
    streaming: false,
    prState: "none",
    prMergeStatus: undefined,
    prIsDraft: undefined,
    prHasFailedChecks: undefined,
    prHasPendingChecks: undefined,
    taskStatus: undefined,
    hasAgentStatus: false,
    gitDirty: undefined,
    currentSectionId: undefined,
    pinnedToSection: false,
    ...overrides,
  };
}

function makeSection(id: string, rules?: SectionRule[]): SectionConfig {
  return { id, name: `Section ${id}`, rules };
}

function makeCondition(overrides: Partial<SectionRuleCondition>): SectionRuleCondition {
  return {
    field: "agentMode",
    op: "eq",
    value: "plan",
    ...overrides,
  };
}

describe("evaluateCondition", () => {
  it("matches eq for string fields", () => {
    const condition = makeCondition({ field: "agentMode", op: "eq", value: "plan" });
    expect(evaluateCondition(condition, makeCtx({ agentMode: "plan" }))).toBe(true);
  });

  it("rejects eq mismatch for string fields", () => {
    const condition = makeCondition({ field: "agentMode", op: "eq", value: "plan" });
    expect(evaluateCondition(condition, makeCtx({ agentMode: "exec" }))).toBe(false);
  });

  it("matches neq when values differ", () => {
    const condition = makeCondition({ field: "prState", op: "neq", value: "OPEN" });
    expect(evaluateCondition(condition, makeCtx({ prState: "none" }))).toBe(true);
  });

  it("matches eq for boolean fields", () => {
    const condition = makeCondition({ field: "streaming", op: "eq", value: true });
    expect(evaluateCondition(condition, makeCtx({ streaming: true }))).toBe(true);
  });

  it("handles undefined fields for eq", () => {
    const condition = makeCondition({ field: "prMergeStatus", op: "eq", value: "CLEAN" });
    expect(evaluateCondition(condition, makeCtx({ prMergeStatus: undefined }))).toBe(false);
  });

  it("handles undefined fields for neq", () => {
    const condition = makeCondition({ field: "prMergeStatus", op: "neq", value: "CLEAN" });
    expect(evaluateCondition(condition, makeCtx({ prMergeStatus: undefined }))).toBe(true);
  });

  it("matches in when value is in set", () => {
    const condition = makeCondition({
      field: "taskStatus",
      op: "in",
      value: '["queued","running"]',
    });
    expect(evaluateCondition(condition, makeCtx({ taskStatus: "running" }))).toBe(true);
  });

  it("rejects in when value is not in set", () => {
    const condition = makeCondition({
      field: "taskStatus",
      op: "in",
      value: '["queued","running"]',
    });
    expect(evaluateCondition(condition, makeCtx({ taskStatus: "reported" }))).toBe(false);
  });

  it("returns false for in when field value is undefined", () => {
    const condition = makeCondition({
      field: "taskStatus",
      op: "in",
      value: '["queued","running"]',
    });
    expect(evaluateCondition(condition, makeCtx({ taskStatus: undefined }))).toBe(false);
  });

  it("returns false for in when value is malformed JSON", () => {
    const condition = makeCondition({
      field: "taskStatus",
      op: "in",
      value: "not-json",
    });
    expect(evaluateCondition(condition, makeCtx({ taskStatus: "running" }))).toBe(false);
  });
});

describe("evaluateSectionRules", () => {
  it("returns undefined when no sections have rules", () => {
    const sections = [makeSection("a"), makeSection("b")];
    expect(evaluateSectionRules(sections, makeCtx())).toBeUndefined();
  });

  it("returns section id for single matching rule", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "agentMode", op: "eq", value: "plan" })],
        },
      ]),
    ];

    expect(evaluateSectionRules(sections, makeCtx({ agentMode: "plan" }))).toBe("a");
  });

  it("returns undefined when single rule does not match", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "agentMode", op: "eq", value: "plan" })],
        },
      ]),
    ];

    expect(evaluateSectionRules(sections, makeCtx({ agentMode: "exec" }))).toBeUndefined();
  });

  it("matches multi-condition rules when all conditions pass (AND)", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [
            makeCondition({ field: "agentMode", op: "eq", value: "plan" }),
            makeCondition({ field: "streaming", op: "eq", value: true }),
          ],
        },
      ]),
    ];

    expect(
      evaluateSectionRules(
        sections,
        makeCtx({
          agentMode: "plan",
          streaming: true,
        })
      )
    ).toBe("a");
  });

  it("does not match multi-condition rules when one condition fails", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [
            makeCondition({ field: "agentMode", op: "eq", value: "plan" }),
            makeCondition({ field: "streaming", op: "eq", value: true }),
          ],
        },
      ]),
    ];

    expect(
      evaluateSectionRules(
        sections,
        makeCtx({
          agentMode: "plan",
          streaming: false,
        })
      )
    ).toBeUndefined();
  });

  it("matches section when any rule matches (OR)", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "agentMode", op: "eq", value: "exec" })],
        },
        {
          conditions: [makeCondition({ field: "streaming", op: "eq", value: true })],
        },
      ]),
    ];

    expect(evaluateSectionRules(sections, makeCtx({ streaming: true }))).toBe("a");
  });

  it("returns the first matching section across sections", () => {
    const sections = [
      makeSection("first", [
        {
          conditions: [makeCondition({ field: "streaming", op: "eq", value: true })],
        },
      ]),
      makeSection("second", [
        {
          conditions: [makeCondition({ field: "streaming", op: "eq", value: true })],
        },
      ]),
    ];

    expect(evaluateSectionRules(sections, makeCtx({ streaming: true }))).toBe("first");
  });

  it("skips auto-assignment for pinned workspaces", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "agentMode", op: "eq", value: "plan" })],
        },
      ]),
    ];

    expect(
      evaluateSectionRules(
        sections,
        makeCtx({
          agentMode: "plan",
          pinnedToSection: true,
        })
      )
    ).toBeUndefined();
  });

  it("ignores sections with empty rules arrays", () => {
    const sections = [makeSection("a", [])];
    expect(evaluateSectionRules(sections, makeCtx({ agentMode: "plan" }))).toBeUndefined();
  });

  it("returns undefined when a previously assigned workspace no longer matches any rule", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "agentMode", op: "eq", value: "plan" })],
        },
      ]),
    ];

    expect(
      evaluateSectionRules(
        sections,
        makeCtx({
          currentSectionId: "a",
          agentMode: "exec",
        })
      )
    ).toBeUndefined();
  });
});
