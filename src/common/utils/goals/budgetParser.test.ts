import { describe, expect, test } from "bun:test";
import { parseGoalBudgetInputCents } from "./budgetParser";

describe("parseGoalBudgetInputCents", () => {
  test("returns null for empty / whitespace input (= no budget)", () => {
    expect(parseGoalBudgetInputCents("")).toBeNull();
    expect(parseGoalBudgetInputCents("   ")).toBeNull();
    expect(parseGoalBudgetInputCents("\t\n")).toBeNull();
  });

  test("parses dollar-prefixed dollar amounts", () => {
    expect(parseGoalBudgetInputCents("$5")).toBe(500);
    expect(parseGoalBudgetInputCents("$5.00")).toBe(500);
    expect(parseGoalBudgetInputCents("$5.25")).toBe(525);
    expect(parseGoalBudgetInputCents("$100.99")).toBe(10099);
  });

  test("parses bare dollar amounts (no prefix)", () => {
    // Pre-DEREM-21 the slash command rejected bare numbers while GoalTab
    // accepted them — the canonical parser unifies on the permissive form.
    expect(parseGoalBudgetInputCents("5")).toBe(500);
    expect(parseGoalBudgetInputCents("5.00")).toBe(500);
    expect(parseGoalBudgetInputCents("5.25")).toBe(525);
  });

  test("parses cents suffix (case-insensitive)", () => {
    expect(parseGoalBudgetInputCents("1c")).toBe(1);
    expect(parseGoalBudgetInputCents("100c")).toBe(100);
    expect(parseGoalBudgetInputCents("100C")).toBe(100);
  });

  test("parses zero dollar inputs", () => {
    expect(parseGoalBudgetInputCents("0")).toBe(0);
    expect(parseGoalBudgetInputCents("$0")).toBe(0);
    expect(parseGoalBudgetInputCents("$0.00")).toBe(0);
    expect(parseGoalBudgetInputCents("0c")).toBe(0);
  });

  test("returns undefined for invalid input", () => {
    expect(parseGoalBudgetInputCents("abc")).toBeUndefined();
    expect(parseGoalBudgetInputCents("$")).toBeUndefined();
    expect(parseGoalBudgetInputCents("5.000")).toBeUndefined();
    expect(parseGoalBudgetInputCents("-5")).toBeUndefined();
    expect(parseGoalBudgetInputCents("$5.5.5")).toBeUndefined();
  });
});
