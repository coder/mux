import { normalizeGoalBudgetCents } from "@/common/utils/goals/budgetPricing";
import type { APIClient } from "@/browser/contexts/API";
import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults, type GoalDefaults } from "@/constants/goals";
import type { z } from "zod";
import type { WorkspaceGoalDefaultsOverrideSchema } from "@/common/orpc/schemas";

export type WorkspaceGoalDefaultsOverride = z.infer<typeof WorkspaceGoalDefaultsOverrideSchema>;

/**
 * Merge a per-workspace sparse override on top of global defaults.
 *
 * Each field in the override is independently nullable:
 *   - `null` → follow the global default
 *   - explicit value → use this value
 *
 * Returns a fully-normalized `GoalDefaults` object so downstream
 * `resolveGoalSetIntent` does not need to know which fields were
 * inherited vs overridden. Exposed for unit tests; production callers
 * should go through `loadGoalDefaults`.
 */
export function mergeGoalDefaults(
  global: GoalDefaults,
  override: WorkspaceGoalDefaultsOverride | null | undefined
): GoalDefaults {
  if (!override) {
    return { ...global };
  }
  // `defaultTurnCap` is itself nullable in the global shape (null = no
  // cap), so an override field of `null` means "inherit", not "no cap".
  // `??` is the right operator: it picks the override only when it's
  // non-null/undefined, otherwise falls back to the global value.
  return normalizeGoalDefaults({
    defaultBudgetCents: override.defaultBudgetCents ?? global.defaultBudgetCents,
    defaultTurnCap: override.defaultTurnCap ?? global.defaultTurnCap,
    alwaysRequireExplicitBudget:
      override.alwaysRequireExplicitBudget ?? global.alwaysRequireExplicitBudget,
  });
}

/**
 * Inputs passed by callers (slash command, command palette, GoalTab) when
 * creating a goal. Each field is optional — defaults fill in the rest.
 *
 * - `budgetCents` is a discriminated tri-state:
 *   - `undefined` → "user did not specify; apply default"
 *   - `null` or `0` → "no budget" (explicit clear)
 *   - positive `number` → explicit cents value
 */
export interface GoalSetIntentInput {
  objective: string;
  budgetCents?: number | null;
  turnCap?: number | null;
  /**
   * Per-goal auto-compaction threshold override. Tri-state same as
   * `budgetCents` / `turnCap`: `undefined` = no opinion (no field on
   * the resolved intent), `null` = explicit clear, number = explicit
   * percent. No workspace-level default exists for this field yet, so
   * the resolver just passes the value through verbatim instead of
   * filling in a default.
   */
  autoCompactionThresholdPct?: number | null;
}

export interface GoalSetIntent {
  objective: string;
  budgetCents: number | null;
  turnCap: number | null;
  // Only present on the resolved intent when the caller actually opted
  // in (slash command flag, create-form input, or inline editor). Keeps
  // omitted-from-input distinguishable from null-from-input so the
  // downstream `setGoal` payload doesn't accidentally clear an existing
  // per-goal override on plain `/goal <objective>` invocations.
  autoCompactionThresholdPct?: number | null;
}

/**
 * Apply goal defaults to a partial goal-creation intent.
 *
 * Defaults are surface-agnostic:
 *   - If the caller omitted `budgetCents`:
 *     - `alwaysRequireExplicitBudget` → fall back to `defaultBudgetCents`.
 *     - Otherwise → `null` (no budget).
 *   - `null` and `0` both become no budget (explicit "no budget" clear).
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
    budgetCents = normalizeGoalBudgetCents(input.budgetCents);
  } else if (defaults.alwaysRequireExplicitBudget) {
    budgetCents = normalizeGoalBudgetCents(defaults.defaultBudgetCents);
  } else {
    budgetCents = null;
  }

  const turnCap = input.turnCap !== undefined ? input.turnCap : defaults.defaultTurnCap;

  return {
    objective: input.objective,
    budgetCents,
    turnCap,
    // Pass through verbatim — including the explicit `null` clear — so
    // the slash command's `--compact default` reaches `setGoal`. Omit
    // the key entirely when the caller didn't set it; otherwise a
    // plain `/goal <objective>` would unintentionally clear an existing
    // override on every replace.
    ...(input.autoCompactionThresholdPct !== undefined
      ? { autoCompactionThresholdPct: input.autoCompactionThresholdPct }
      : {}),
  };
}

/**
 * Load *effective* goal defaults via the API client.
 *
 * When `workspaceId` is provided, the per-workspace override (if any) is
 * layered on top of the global defaults, so callers (slash command, command
 * palette, GoalTab create form) all see the same effective values. When
 * omitted, only the global defaults are returned — this keeps the helper
 * usable from contexts that don't yet know which workspace they're acting
 * against (rare today; mainly tests and the global Settings UI).
 *
 * Falls back to `DEFAULT_GOAL_DEFAULTS` on any error so a missing or
 * disconnected config never blocks goal creation. Errors loading the
 * workspace override are also swallowed — global defaults still apply.
 */
export async function loadGoalDefaults(
  api: APIClient,
  workspaceId?: string
): Promise<GoalDefaults> {
  let globalDefaults: GoalDefaults;
  try {
    const config = await api.config?.getConfig?.();
    globalDefaults = normalizeGoalDefaults(config?.goalDefaults ?? DEFAULT_GOAL_DEFAULTS);
  } catch {
    globalDefaults = { ...DEFAULT_GOAL_DEFAULTS };
  }

  if (!workspaceId) {
    return globalDefaults;
  }

  let override: WorkspaceGoalDefaultsOverride | null = null;
  try {
    override = (await api.workspace?.goalDefaults?.get?.({ workspaceId })) ?? null;
  } catch {
    override = null;
  }
  return mergeGoalDefaults(globalDefaults, override);
}
