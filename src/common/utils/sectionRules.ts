import type { SectionConfig, SectionRuleCondition } from "@/common/schemas/project";
import assert from "@/common/utils/assert";
import { assertNever } from "@/common/utils/assertNever";

export interface WorkspaceRuleContext {
  workspaceId: string;
  agentMode: string | undefined;
  streaming: boolean;
  prState: "OPEN" | "CLOSED" | "MERGED" | "none";
  prMergeStatus: string | undefined;
  prIsDraft: boolean | undefined;
  prHasFailedChecks: boolean | undefined;
  prHasPendingChecks: boolean | undefined;
  taskStatus: string | undefined;
  hasAgentStatus: boolean;
  gitDirty: boolean | undefined;
  currentSectionId: string | undefined;
  pinnedToSection: boolean;
}

/** Map condition field names to context values. Record mapping keeps field handling exhaustive. */
function getFieldValue(
  field: SectionRuleCondition["field"],
  ctx: WorkspaceRuleContext
): string | boolean | undefined {
  const fieldMap: Record<SectionRuleCondition["field"], string | boolean | undefined> = {
    agentMode: ctx.agentMode,
    streaming: ctx.streaming,
    prState: ctx.prState,
    prMergeStatus: ctx.prMergeStatus,
    prIsDraft: ctx.prIsDraft,
    prHasFailedChecks: ctx.prHasFailedChecks,
    prHasPendingChecks: ctx.prHasPendingChecks,
    taskStatus: ctx.taskStatus,
    hasAgentStatus: ctx.hasAgentStatus,
    gitDirty: ctx.gitDirty,
  };

  return fieldMap[field];
}

/**
 * Evaluate a single rule condition against the provided workspace context.
 *
 * For the "in" operator, the condition value must be a JSON-serialized array
 * (for example: '["queued","running"]').
 */
export function evaluateCondition(
  condition: SectionRuleCondition,
  ctx: WorkspaceRuleContext
): boolean {
  const actual = getFieldValue(condition.field, ctx);

  switch (condition.op) {
    case "eq":
      return actual === condition.value;

    case "neq":
      return actual !== condition.value;

    case "in": {
      if (actual == null || typeof condition.value !== "string") {
        return false;
      }

      let parsedAllowedValues: unknown;
      try {
        parsedAllowedValues = JSON.parse(condition.value);
      } catch {
        // Self-heal malformed persisted rule config by treating the condition as non-matching.
        return false;
      }

      assert(
        Array.isArray(parsedAllowedValues),
        `"in" operator value must be a JSON array, got: ${condition.value}`
      );
      assert(
        parsedAllowedValues.every(
          (value) => typeof value === "string" || typeof value === "boolean"
        ),
        `"in" operator array entries must be string|boolean, got: ${condition.value}`
      );

      return parsedAllowedValues.includes(actual);
    }

    default:
      return assertNever(condition.op);
  }
}

/**
 * Evaluate sections against workspace context and return the first matching section ID.
 *
 * Rules semantics:
 * - Sections are evaluated in the provided order (caller should sort display order first).
 * - Pinned workspaces are not auto-assigned.
 * - Rules within a section are OR'd (any rule can match).
 * - Conditions within a rule are AND'd (all conditions must match).
 */
export function evaluateSectionRules(
  sections: SectionConfig[],
  ctx: WorkspaceRuleContext
): string | undefined {
  if (ctx.pinnedToSection) {
    return undefined;
  }

  for (const section of sections) {
    const rules = section.rules;
    if (!rules || rules.length === 0) {
      continue;
    }

    const sectionMatches = rules.some((rule) =>
      rule.conditions.every((condition) => evaluateCondition(condition, ctx))
    );

    if (sectionMatches) {
      return section.id;
    }
  }

  return undefined;
}
