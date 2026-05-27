import { describe, expect, test } from "bun:test";
import { DEFAULT_GOAL_DEFAULTS, type GoalDefaults } from "@/constants/goals";
import {
  mergeGoalDefaults,
  resolveGoalSetIntent,
  type WorkspaceGoalDefaultsOverride,
} from "./resolveGoalSetIntent";

describe("resolveGoalSetIntent", () => {
  const baseDefaults: GoalDefaults = {
    ...DEFAULT_GOAL_DEFAULTS,
    defaultBudgetCents: 1500,
    defaultTurnCap: 7,
    alwaysRequireExplicitBudget: false,
  };

  test("preserves explicit numeric budget", () => {
    const intent = resolveGoalSetIntent({ objective: "ship", budgetCents: 200 }, baseDefaults);
    expect(intent.budgetCents).toBe(200);
  });

  test("treats explicit zero budget as no budget", () => {
    const intent = resolveGoalSetIntent({ objective: "ship", budgetCents: 0 }, baseDefaults);
    expect(intent.budgetCents).toBeNull();
  });

  test("preserves explicit null budget (user-cleared)", () => {
    const intent = resolveGoalSetIntent({ objective: "ship", budgetCents: null }, baseDefaults);
    expect(intent.budgetCents).toBeNull();
  });

  // Coder-agents-review P3 DEREM-32: pin the false branch so a regression that
  // applied the default budget when the user opted out of mandatory budgets
  // would fail.
  test("alwaysRequireExplicitBudget=false omits the default and yields null", () => {
    const intent = resolveGoalSetIntent({ objective: "ship" }, baseDefaults);
    expect(intent.budgetCents).toBeNull();
  });

  test("alwaysRequireExplicitBudget=true falls back to defaultBudgetCents", () => {
    const intent = resolveGoalSetIntent(
      { objective: "ship" },
      { ...baseDefaults, alwaysRequireExplicitBudget: true }
    );
    expect(intent.budgetCents).toBe(1500);
  });

  test("treats a zero default budget as no budget", () => {
    const intent = resolveGoalSetIntent(
      { objective: "ship" },
      { ...baseDefaults, defaultBudgetCents: 0, alwaysRequireExplicitBudget: true }
    );
    expect(intent.budgetCents).toBeNull();
  });

  test("turnCap falls back to defaultTurnCap when omitted", () => {
    const intent = resolveGoalSetIntent({ objective: "ship" }, baseDefaults);
    expect(intent.turnCap).toBe(7);
  });

  test("turnCap respects explicit null", () => {
    const intent = resolveGoalSetIntent({ objective: "ship", turnCap: null }, baseDefaults);
    expect(intent.turnCap).toBeNull();
  });
});

describe("mergeGoalDefaults", () => {
  // Layer a sparse per-workspace override on top of global defaults. Tests
  // pin the exact precedence rules so the GoalTab override panel and the
  // three create surfaces (slash / palette / in-tab) stay in lockstep with
  // the resolver.
  const globalDefaults: GoalDefaults = {
    defaultBudgetCents: 200, // $2.00
    defaultTurnCap: null, // no cap by default
    alwaysRequireExplicitBudget: true,
  };

  test("null override returns a copy of the global defaults", () => {
    const merged = mergeGoalDefaults(globalDefaults, null);
    expect(merged).toEqual(globalDefaults);
    expect(merged).not.toBe(globalDefaults);
  });

  test("undefined override returns a copy of the global defaults", () => {
    const merged = mergeGoalDefaults(globalDefaults, undefined);
    expect(merged).toEqual(globalDefaults);
  });

  test("all-null override is equivalent to inherit-all", () => {
    const override: WorkspaceGoalDefaultsOverride = {
      defaultBudgetCents: null,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    };
    expect(mergeGoalDefaults(globalDefaults, override)).toEqual(globalDefaults);
  });

  test("non-null override fields win over the global", () => {
    const override: WorkspaceGoalDefaultsOverride = {
      defaultBudgetCents: 1500,
      defaultTurnCap: 8,
      alwaysRequireExplicitBudget: false,
    };
    expect(mergeGoalDefaults(globalDefaults, override)).toEqual({
      defaultBudgetCents: 1500,
      defaultTurnCap: 8,
      alwaysRequireExplicitBudget: false,
    });
  });

  test("partial overrides inherit the remaining fields", () => {
    const override: WorkspaceGoalDefaultsOverride = {
      defaultBudgetCents: 500,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    };
    expect(mergeGoalDefaults(globalDefaults, override)).toEqual({
      defaultBudgetCents: 500,
      // Inherited from global — workspace did not override.
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: true,
    });
  });

  test("override turn cap wins even when global has a non-null cap", () => {
    // Critical regression guard: a naive `value ?? global` could clobber
    // explicit override `null` only when global is also null. Here global
    // *has* a cap and the override pins a different positive value.
    const merged = mergeGoalDefaults(
      { ...globalDefaults, defaultTurnCap: 10 },
      {
        defaultBudgetCents: null,
        defaultTurnCap: 5,
        alwaysRequireExplicitBudget: null,
      }
    );
    expect(merged.defaultTurnCap).toBe(5);
  });

  test("merged value is normalized (rejects invalid override numerics)", () => {
    // `normalizeGoalDefaults` strips negative budgets; mergeGoalDefaults
    // funnels through it so we can't end up with a smuggled-in invalid
    // value even if the override schema is bypassed by a buggy caller.
    const merged = mergeGoalDefaults(globalDefaults, {
      defaultBudgetCents: -5 as unknown as number,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    });
    expect(merged.defaultBudgetCents).toBe(globalDefaults.defaultBudgetCents);
  });
});
