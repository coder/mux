import { describe, expect, test } from "bun:test";
import type { GoalRecordV1, GoalSnapshot } from "@/common/types/goal";
import { getCompleteGoalDisplayGoal } from "./CompleteGoalToolCall";

const goalId = "00000000-0000-4000-8000-000000000001";

function resultGoal(overrides: Partial<GoalRecordV1> = {}): GoalRecordV1 {
  return {
    version: 1,
    goalId,
    objective: "Ship goal accounting UI",
    status: "complete",
    budgetCents: 100_000,
    turnCap: 3,
    costCents: 0,
    costMicroCents: 0,
    turnsUsed: 0,
    attributedChildren: [],
    budgetLimitInjectedForGoalId: null,
    budgetLimitOriginKind: null,
    requireUserAcknowledgmentSinceMs: null,
    lastContinuationFiredAtMs: null,
    completionSummary: "Done.",
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    ...overrides,
  };
}

function liveGoal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId,
    objective: "Ship goal accounting UI",
    status: "complete",
    budgetCents: 100_000,
    costCents: 4_040,
    turnsUsed: 1,
    turnCap: 3,
    completionSummary: "Done with final accounting.",
    startedAtMs: 1_000,
    ...overrides,
  };
}

describe("getCompleteGoalDisplayGoal", () => {
  test("uses same-goal live accounting over stale complete_goal result accounting", () => {
    const displayGoal = getCompleteGoalDisplayGoal(resultGoal(), liveGoal());

    expect(displayGoal).toMatchObject({
      goalId,
      costCents: 4_040,
      turnsUsed: 1,
      completionSummary: "Done with final accounting.",
    });
  });

  test("keeps retained same-goal live accounting after the current goal is cleared", () => {
    const displayGoal = getCompleteGoalDisplayGoal(resultGoal(), null, liveGoal());

    expect(displayGoal).toMatchObject({
      goalId,
      costCents: 4_040,
      turnsUsed: 1,
      completionSummary: "Done with final accounting.",
    });
  });

  test("keeps the tool result when the live sidebar snapshot is for another goal", () => {
    const displayGoal = getCompleteGoalDisplayGoal(
      resultGoal({ costCents: 0, turnsUsed: 0 }),
      liveGoal({
        goalId: "00000000-0000-4000-8000-000000000002",
        costCents: 4_040,
        turnsUsed: 1,
      })
    );

    expect(displayGoal).toMatchObject({
      goalId,
      costCents: 0,
      turnsUsed: 0,
      completionSummary: "Done.",
    });
  });
});
