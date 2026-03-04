import { describe, expect, it } from "bun:test";

import type { SectionConfig, SectionRule, SectionRuleCondition } from "@/common/schemas/project";

import {
  evaluateCondition,
  evaluateSectionRules,
  type SectionRuleEvaluationResult,
  type WorkspaceRuleContext,
} from "./sectionRules";

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

function expectResult(
  actual: SectionRuleEvaluationResult,
  expected: SectionRuleEvaluationResult
): void {
  expect(actual).toEqual(expected);
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

  it("returns inconclusive when the condition field is unavailable", () => {
    const condition = makeCondition({ field: "prState", op: "eq", value: "OPEN" });
    const ctx = makeCtx({
      availableFields: new Set(["agentMode", "streaming", "taskStatus", "hasAgentStatus"]),
    });

    expect(evaluateCondition(condition, ctx)).toBe("inconclusive");
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

  it("returns false for in when parsed value is not an array", () => {
    const condition = makeCondition({
      field: "taskStatus",
      op: "in",
      value: '{"status":"running"}',
    });

    expect(evaluateCondition(condition, makeCtx({ taskStatus: "running" }))).toBe(false);
  });
});

describe("evaluateSectionRules", () => {
  it("returns no target when no sections have rules", () => {
    const sections = [makeSection("a"), makeSection("b")];

    expectResult(evaluateSectionRules(sections, makeCtx()), {
      targetSectionId: undefined,
      hasInconclusiveRules: false,
      currentSectionInconclusive: false,
    });
  });

  it("returns section id for single matching rule", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "agentMode", op: "eq", value: "plan" })],
        },
      ]),
    ];

    expectResult(evaluateSectionRules(sections, makeCtx({ agentMode: "plan" })), {
      targetSectionId: "a",
      hasInconclusiveRules: false,
      currentSectionInconclusive: false,
    });
  });

  it("returns no target when single rule does not match", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "agentMode", op: "eq", value: "plan" })],
        },
      ]),
    ];

    expectResult(evaluateSectionRules(sections, makeCtx({ agentMode: "exec" })), {
      targetSectionId: undefined,
      hasInconclusiveRules: false,
      currentSectionInconclusive: false,
    });
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

    expectResult(
      evaluateSectionRules(
        sections,
        makeCtx({
          agentMode: "plan",
          streaming: true,
        })
      ),
      {
        targetSectionId: "a",
        hasInconclusiveRules: false,
        currentSectionInconclusive: false,
      }
    );
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

    expectResult(
      evaluateSectionRules(
        sections,
        makeCtx({
          agentMode: "plan",
          streaming: false,
        })
      ),
      {
        targetSectionId: undefined,
        hasInconclusiveRules: false,
        currentSectionInconclusive: false,
      }
    );
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

    expectResult(evaluateSectionRules(sections, makeCtx({ streaming: true })), {
      targetSectionId: "a",
      hasInconclusiveRules: false,
      currentSectionInconclusive: false,
    });
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

    expectResult(evaluateSectionRules(sections, makeCtx({ streaming: true })), {
      targetSectionId: "first",
      hasInconclusiveRules: false,
      currentSectionInconclusive: false,
    });
  });

  it("skips auto-assignment for pinned workspaces", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "agentMode", op: "eq", value: "plan" })],
        },
      ]),
    ];

    expectResult(
      evaluateSectionRules(
        sections,
        makeCtx({
          agentMode: "plan",
          pinnedToSection: true,
        })
      ),
      {
        targetSectionId: undefined,
        hasInconclusiveRules: false,
        currentSectionInconclusive: false,
      }
    );
  });

  it("marks rule evaluation inconclusive when a field is unavailable", () => {
    const sections = [
      makeSection("open-pr", [
        {
          conditions: [makeCondition({ field: "prState", op: "eq", value: "OPEN" })],
        },
      ]),
    ];

    expectResult(
      evaluateSectionRules(
        sections,
        makeCtx({
          currentSectionId: "open-pr",
          availableFields: new Set(["agentMode", "streaming", "taskStatus", "hasAgentStatus"]),
        })
      ),
      {
        targetSectionId: undefined,
        hasInconclusiveRules: true,
        currentSectionInconclusive: true,
      }
    );
  });

  it("currentSectionInconclusive is true only for current section's rules", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "prState", op: "eq", value: "OPEN" })],
        },
      ]),
      makeSection("b", [
        {
          conditions: [makeCondition({ field: "gitDirty", op: "eq", value: true })],
        },
      ]),
    ];

    expectResult(
      evaluateSectionRules(
        sections,
        makeCtx({
          currentSectionId: "a",
          prState: "CLOSED",
          availableFields: new Set(["prState"]),
        })
      ),
      {
        targetSectionId: undefined,
        hasInconclusiveRules: true,
        currentSectionInconclusive: false,
      }
    );
  });

  it("currentSectionInconclusive is true when current section has unknown fields", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "gitDirty", op: "eq", value: true })],
        },
      ]),
    ];

    expectResult(
      evaluateSectionRules(
        sections,
        makeCtx({
          currentSectionId: "a",
          availableFields: new Set(["agentMode", "streaming", "taskStatus", "hasAgentStatus"]),
        })
      ),
      {
        targetSectionId: undefined,
        hasInconclusiveRules: true,
        currentSectionInconclusive: true,
      }
    );
  });

  it("does not reassign when current section is inconclusive even if another section matches", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "prState", op: "eq", value: "OPEN" })],
        },
      ]),
      makeSection("b", [
        {
          conditions: [makeCondition({ field: "streaming", op: "eq", value: false })],
        },
      ]),
    ];

    expectResult(
      evaluateSectionRules(
        sections,
        makeCtx({
          currentSectionId: "a",
          streaming: false,
          availableFields: new Set(["agentMode", "streaming", "taskStatus", "hasAgentStatus"]),
        })
      ),
      {
        targetSectionId: "b",
        hasInconclusiveRules: true,
        currentSectionInconclusive: true,
      }
    );
  });

  it("returns first conclusive match even when prior rules were inconclusive", () => {
    const sections = [
      makeSection("mixed", [
        {
          conditions: [makeCondition({ field: "prState", op: "eq", value: "OPEN" })],
        },
        {
          conditions: [makeCondition({ field: "streaming", op: "eq", value: true })],
        },
      ]),
    ];

    expectResult(
      evaluateSectionRules(
        sections,
        makeCtx({
          streaming: true,
          availableFields: new Set(["agentMode", "streaming", "taskStatus", "hasAgentStatus"]),
        })
      ),
      {
        targetSectionId: "mixed",
        hasInconclusiveRules: true,
        currentSectionInconclusive: false,
      }
    );
  });

  it("marks rule inconclusive when any condition is inconclusive", () => {
    const sections = [
      makeSection("mixed", [
        {
          conditions: [
            makeCondition({ field: "streaming", op: "eq", value: false }),
            makeCondition({ field: "prState", op: "eq", value: "OPEN" }),
          ],
        },
      ]),
    ];

    expectResult(
      evaluateSectionRules(
        sections,
        makeCtx({
          streaming: true,
          availableFields: new Set(["agentMode", "streaming", "taskStatus", "hasAgentStatus"]),
        })
      ),
      {
        targetSectionId: undefined,
        hasInconclusiveRules: true,
        currentSectionInconclusive: false,
      }
    );
  });

  it("returns no target when a previously assigned workspace no longer matches any conclusive rule", () => {
    const sections = [
      makeSection("a", [
        {
          conditions: [makeCondition({ field: "agentMode", op: "eq", value: "plan" })],
        },
      ]),
    ];

    expectResult(
      evaluateSectionRules(
        sections,
        makeCtx({
          currentSectionId: "a",
          agentMode: "exec",
        })
      ),
      {
        targetSectionId: undefined,
        hasInconclusiveRules: false,
        currentSectionInconclusive: false,
      }
    );
  });
});
