import type { APIClient } from "@/browser/contexts/API";
import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults, type GoalDefaults } from "@/constants/goals";

/**
 * Inputs passed by callers (slash command, command palette, GoalTab) when
 * creating a goal. Each field is optional — defaults fill in the rest.
 *
 * - `budgetCents` is a discriminated tri-state:
 *   - `undefined` → "user did not specify; apply default"
 *   - `null` → "user explicitly cleared the budget"
 *   - `number` → explicit cents value
 */
export interface GoalSetIntentInput {
  objective: string;
  budgetCents?: number | null;
  turnCap?: number | null;
}

export interface GoalSetIntent {
  objective: string;
  budgetCents: number | null;
  turnCap: number | null;
}

/**
 * Apply goal defaults to a partial goal-creation intent.
 *
 * Defaults are surface-agnostic:
 *   - If the caller omitted `budgetCents`:
 *     - `alwaysRequireExplicitBudget` → fall back to `defaultBudgetCents`.
 *     - Otherwise → `null` (no budget).
 *   - `null` is preserved (explicit "no budget" clear).
 *   - If the caller omitted `turnCap`, fall back to `defaultTurnCap`.
 *
 * Coder-agents-review P3 DEREM-27: the slash command path (`/goal`) used to
 * apply this and the command palette did not, so a blank palette budget
 * silently created an unbudgeted goal in violation of the GoalsSection
 * contract ("omitted budgets use the default budget instead of creating
 * unbudgeted goals"). This helper unifies both entry points.
 */
export function resolveGoalSetIntent(
  input: GoalSetIntentInput,
  defaults: GoalDefaults
): GoalSetIntent {
  let budgetCents: number | null;
  if (input.budgetCents !== undefined) {
    budgetCents = input.budgetCents;
  } else if (defaults.alwaysRequireExplicitBudget) {
    budgetCents = defaults.defaultBudgetCents;
  } else {
    budgetCents = null;
  }

  const turnCap = input.turnCap !== undefined ? input.turnCap : defaults.defaultTurnCap;

  return {
    objective: input.objective,
    budgetCents,
    turnCap,
  };
}

/**
 * Load goal defaults from the user's config via the API client. Falls back
 * to `DEFAULT_GOAL_DEFAULTS` on any error so a missing/disconnected config
 * never blocks goal creation.
 */
export async function loadGoalDefaults(api: APIClient): Promise<GoalDefaults> {
  try {
    const config = await api.config?.getConfig?.();
    return normalizeGoalDefaults(config?.goalDefaults ?? DEFAULT_GOAL_DEFAULTS);
  } catch {
    return { ...DEFAULT_GOAL_DEFAULTS };
  }
}
