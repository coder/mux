import { describe, expect, test } from "bun:test";
import { DEFAULT_GOAL_DEFAULTS, type GoalDefaults } from "@/constants/goals";
import { resolveGoalSetIntent } from "./resolveGoalSetIntent";

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
