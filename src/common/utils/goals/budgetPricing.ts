import assert from "@/common/utils/assert";
import type { GoalRecordV1, GoalSnapshot } from "@/common/types/goal";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { getModelStatsResolved } from "@/common/utils/tokens/modelStats";

/** Format a non-negative cents value as a dollar-prefixed two-decimal string ("$1.25"). */
export function formatGoalCents(cents: number): string {
  assert(Number.isInteger(cents) && cents >= 0, "formatGoalCents requires non-negative cents");
  return `$${(cents / 100).toFixed(2)}`;
}

type GoalBudgetState = Pick<GoalRecordV1 | GoalSnapshot, "status" | "budgetCents">;

/**
 * Returns true for any goal whose budget will be debited again if the user
 * continues working — i.e. `active`, `paused`, or `budget_limited` (the
 * non-terminal states with a numeric `budgetCents`). Used to gate model
 * switches: an unpriced model on such a goal silently records 0 cost on the
 * next stream, breaking budget enforcement after resume.
 */
export function hasBudgetedResumableGoal(goal: GoalBudgetState | null | undefined): boolean {
  if (goal?.budgetCents == null) {
    return false;
  }
  return goal.status === "active" || goal.status === "paused" || goal.status === "budget_limited";
}

function modelStatsHasBillableCosts(
  stats: NonNullable<ReturnType<typeof getModelStatsResolved>>
): boolean {
  return (
    stats.input_cost_per_token > 0 ||
    stats.output_cost_per_token > 0 ||
    (stats.input_cost_per_token_above_200k_tokens ?? 0) > 0 ||
    (stats.output_cost_per_token_above_200k_tokens ?? 0) > 0 ||
    (stats.cache_creation_input_token_cost ?? 0) > 0 ||
    (stats.cache_creation_input_token_cost_above_200k_tokens ?? 0) > 0 ||
    (stats.cache_read_input_token_cost ?? 0) > 0 ||
    (stats.cache_read_input_token_cost_above_200k_tokens ?? 0) > 0
  );
}

export function modelHasPricingData(model: string, providersConfig: unknown = null): boolean {
  const stats = getModelStatsResolved(model, providersConfig as ProvidersConfigMap | null);
  return stats != null && modelStatsHasBillableCosts(stats);
}

export const UNPRICED_CURRENT_MODEL_GOAL_MESSAGE =
  "Current model has no pricing data. Pick a priced model, set --no-budget, or rely on --turns N only.";

export const UNPRICED_TARGET_MODEL_GOAL_MESSAGE =
  "Target model has no pricing data. Pick a priced model or remove the active goal budget with /goal budget --no-budget before switching.";
