export const GOAL_CONTINUATION_IDLE_CONSUMER_NAME = "goal_continuation";
export const GOAL_CONTINUATION_IDLE_CONSUMER_PRIORITY = 100;
export const DEFAULT_GOAL_CONTINUATION_COOLDOWN_MS = 60_000;
export const GOAL_CONTINUATION_KIND = "goal_continuation";
export const GOAL_BUDGET_LIMIT_KIND = "goal_budget_limit";
export type GoalSyntheticMessageKind =
  | typeof GOAL_CONTINUATION_KIND
  | typeof GOAL_BUDGET_LIMIT_KIND;

export interface GoalDefaults {
  defaultBudgetCents: number;
  defaultTurnCap: number | null;
  alwaysRequireExplicitBudget: boolean;
}

export const DEFAULT_GOAL_BUDGET_CENTS = 200;
export const DEFAULT_GOAL_TURN_CAP = null;
export const DEFAULT_GOAL_ALWAYS_REQUIRE_EXPLICIT_BUDGET = true;

export const DEFAULT_GOAL_DEFAULTS: GoalDefaults = {
  defaultBudgetCents: DEFAULT_GOAL_BUDGET_CENTS,
  defaultTurnCap: DEFAULT_GOAL_TURN_CAP,
  alwaysRequireExplicitBudget: DEFAULT_GOAL_ALWAYS_REQUIRE_EXPLICIT_BUDGET,
};

export function normalizeGoalDefaults(
  value: Partial<GoalDefaults> | null | undefined
): GoalDefaults {
  if (!value) {
    return { ...DEFAULT_GOAL_DEFAULTS };
  }

  const defaultBudgetCents = value.defaultBudgetCents;
  const defaultTurnCap = value.defaultTurnCap;

  let normalizedTurnCap = DEFAULT_GOAL_DEFAULTS.defaultTurnCap;
  if (defaultTurnCap == null) {
    normalizedTurnCap = null;
  } else if (Number.isInteger(defaultTurnCap) && defaultTurnCap > 0) {
    normalizedTurnCap = defaultTurnCap;
  }

  return {
    defaultBudgetCents:
      typeof defaultBudgetCents === "number" &&
      Number.isInteger(defaultBudgetCents) &&
      defaultBudgetCents >= 0
        ? defaultBudgetCents
        : DEFAULT_GOAL_DEFAULTS.defaultBudgetCents,
    defaultTurnCap: normalizedTurnCap,
    alwaysRequireExplicitBudget:
      typeof value.alwaysRequireExplicitBudget === "boolean"
        ? value.alwaysRequireExplicitBudget
        : DEFAULT_GOAL_DEFAULTS.alwaysRequireExplicitBudget,
  };
}
