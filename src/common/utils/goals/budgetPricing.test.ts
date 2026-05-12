import { describe, expect, test } from "bun:test";
import {
  formatGoalCents,
  hasBudgetedResumableGoal,
  hasGoalBudgetLimit,
  modelHasPricingData,
  normalizeGoalBudgetCents,
} from "./budgetPricing";

describe("formatGoalCents", () => {
  test("formats integer cents as a dollar-prefixed two-decimal string", () => {
    expect(formatGoalCents(0)).toBe("$0.00");
    expect(formatGoalCents(1)).toBe("$0.01");
    expect(formatGoalCents(125)).toBe("$1.25");
    expect(formatGoalCents(10_000)).toBe("$100.00");
  });

  test("rejects negative or non-integer values", () => {
    expect(() => formatGoalCents(-1)).toThrow();
    expect(() => formatGoalCents(1.5)).toThrow();
  });
});

describe("modelHasPricingData", () => {
  test("rejects known models without billable token costs", () => {
    expect(modelHasPricingData("sample_spec")).toBe(false);
  });

  test("resolves provider mapped models before checking pricing", () => {
    expect(
      modelHasPricingData("custom:cheap-alias", {
        custom: {
          models: [{ id: "cheap-alias", mappedToModel: "openai:gpt-4o-mini" }],
        },
      })
    ).toBe(true);
  });
});

describe("goal budget limit helpers", () => {
  test("treat zero cents as no dollar budget limit", () => {
    expect(hasGoalBudgetLimit(0)).toBe(false);
    expect(normalizeGoalBudgetCents(0)).toBeNull();
  });

  test("preserve positive budget limits", () => {
    expect(hasGoalBudgetLimit(1)).toBe(true);
    expect(normalizeGoalBudgetCents(1)).toBe(1);
  });
});

describe("hasBudgetedResumableGoal", () => {
  // Regression: the active-only check let the user pause a budgeted goal,
  // switch to an unpriced model, and resume — the next stream then records
  // 0 cost because the model has no pricing, and budget enforcement breaks.
  test("returns true for any budgeted goal that can resume accounting", () => {
    expect(hasBudgetedResumableGoal({ status: "active", budgetCents: 100 })).toBe(true);
    expect(hasBudgetedResumableGoal({ status: "paused", budgetCents: 100 })).toBe(true);
    expect(hasBudgetedResumableGoal({ status: "budget_limited", budgetCents: 100 })).toBe(true);
  });

  test("returns false for completed budgeted goals (terminal)", () => {
    expect(hasBudgetedResumableGoal({ status: "complete", budgetCents: 100 })).toBe(false);
  });

  test("returns false for zero-dollar budgets", () => {
    expect(hasBudgetedResumableGoal({ status: "active", budgetCents: 0 })).toBe(false);
    expect(hasBudgetedResumableGoal({ status: "paused", budgetCents: 0 })).toBe(false);
    expect(hasBudgetedResumableGoal({ status: "budget_limited", budgetCents: 0 })).toBe(false);
  });

  test("returns false for any goal without a budget", () => {
    expect(hasBudgetedResumableGoal({ status: "active", budgetCents: null })).toBe(false);
    expect(hasBudgetedResumableGoal({ status: "paused", budgetCents: null })).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(hasBudgetedResumableGoal(null)).toBe(false);
    expect(hasBudgetedResumableGoal(undefined)).toBe(false);
  });
});
