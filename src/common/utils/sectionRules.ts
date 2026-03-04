import type { SectionConfig, SectionRuleCondition } from "@/common/schemas/project";
import { assertNever } from "@/common/utils/assertNever";

export interface WorkspaceRuleContext {
  workspaceId: string;
  agentMode: string | undefined;
  streaming: boolean;
  prState: "OPEN" | "CLOSED" | "MERGED" | "none" | undefined;
  prMergeStatus: string | undefined;
  prIsDraft: boolean | undefined;
  prHasFailedChecks: boolean | undefined;
  prHasPendingChecks: boolean | undefined;
  taskStatus: string | undefined;
  hasAgentStatus: boolean;
  gitDirty: boolean | undefined;
  currentSectionId: string | undefined;
  pinnedToSection: boolean;
  /**
   * Fields whose values are known for this evaluation pass.
   *
   * When omitted, all fields are assumed to be known.
   */
  availableFields?: Set<SectionRuleCondition["field"]>;
}

export interface SectionRuleEvaluationResult {
  /** The section ID to assign to, or undefined when no conclusive match was found. */
  targetSectionId: string | undefined;
  /** True when at least one rule could not be fully evaluated due to unknown fields. */
  hasInconclusiveRules: boolean;
  /** True when the workspace's current section has rules that couldn't be conclusively evaluated. */
  currentSectionInconclusive: boolean;
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
): boolean | "inconclusive" {
  if (ctx.availableFields && !ctx.availableFields.has(condition.field)) {
    return "inconclusive";
  }

  const actual = getFieldValue(condition.field, ctx);

  switch (condition.op) {
    case "eq":
      if (actual === undefined) {
        return false;
      }
      return actual === condition.value;

    case "neq":
      if (actual === undefined) {
        return false;
      }
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

      if (!Array.isArray(parsedAllowedValues)) {
        return false;
      }

      if (
        !parsedAllowedValues.every(
          (value) => typeof value === "string" || typeof value === "boolean"
        )
      ) {
        return false;
      }

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
 * - Rules with unknown field values are marked inconclusive.
 */
export function evaluateSectionRules(
  sections: SectionConfig[],
  ctx: WorkspaceRuleContext
): SectionRuleEvaluationResult {
  if (ctx.pinnedToSection) {
    return {
      targetSectionId: undefined,
      hasInconclusiveRules: false,
      currentSectionInconclusive: false,
    };
  }

  let hasInconclusiveRules = false;
  let currentSectionInconclusive = false;

  for (const section of sections) {
    const rules = section.rules;
    if (!rules || rules.length === 0) {
      continue;
    }

    const isCurrentSection = section.id === ctx.currentSectionId;

    for (const rule of rules) {
      let ruleHasInconclusiveCondition = false;
      let hasKnownFalseCondition = false;
      let allKnownConditionsPass = true;

      for (const condition of rule.conditions) {
        const conditionResult = evaluateCondition(condition, ctx);
        if (conditionResult === "inconclusive") {
          ruleHasInconclusiveCondition = true;
          // Unknown is not false: keep evaluating other conditions so known false still wins for AND.
          continue;
        }

        if (!conditionResult) {
          hasKnownFalseCondition = true;
          allKnownConditionsPass = false;
        }
      }

      if (ruleHasInconclusiveCondition && !hasKnownFalseCondition) {
        hasInconclusiveRules = true;
        if (isCurrentSection) {
          currentSectionInconclusive = true;
        }
      }

      if (allKnownConditionsPass && !ruleHasInconclusiveCondition) {
        return {
          targetSectionId: section.id,
          hasInconclusiveRules,
          currentSectionInconclusive,
        };
      }
    }
  }

  return {
    targetSectionId: undefined,
    hasInconclusiveRules,
    currentSectionInconclusive,
  };
}
