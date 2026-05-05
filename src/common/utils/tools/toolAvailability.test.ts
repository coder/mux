import { describe, expect, test } from "bun:test";

import { getGoalToolAvailability } from "./toolAvailability";
import type { GoalStatus } from "@/common/types/goal";

const execAgent = {
  id: "exec" as const,
  tools: { add: [".*"], remove: ["propose_plan"] },
};
const exploreAgent = {
  id: "explore" as const,
  tools: { remove: ["file_edit_.*", "task_apply_git_patch"] },
};
const execBaseForExplore = {
  id: "exec" as const,
  tools: { add: [".*"], remove: ["propose_plan"] },
};

function availableGoalToolNames(input: {
  goalsExperimentEnabled: boolean;
  goalStatus: GoalStatus | null;
  editingCapable: boolean;
}): string[] {
  const availability = getGoalToolAvailability({
    goalsExperimentEnabled: input.goalsExperimentEnabled,
    goalStatus: input.goalStatus,
    agentInheritanceChain: input.editingCapable ? [execAgent] : [exploreAgent, execBaseForExplore],
  });

  return [
    ...(availability.getGoal ? ["get_goal"] : []),
    ...(availability.completeGoal ? ["complete_goal"] : []),
  ];
}

describe("goal tool availability", () => {
  test("omits goal tools when the experiment is off", () => {
    expect(
      availableGoalToolNames({
        goalsExperimentEnabled: false,
        goalStatus: "active",
        editingCapable: true,
      })
    ).toEqual([]);
  });

  test("omits goal tools when no goal is set", () => {
    expect(
      availableGoalToolNames({
        goalsExperimentEnabled: true,
        goalStatus: null,
        editingCapable: true,
      })
    ).toEqual([]);
  });

  test.each(["paused", "complete"] as const)("omits goal tools for %s goals", (goalStatus) => {
    expect(
      availableGoalToolNames({
        goalsExperimentEnabled: true,
        goalStatus,
        editingCapable: true,
      })
    ).toEqual([]);
  });

  test("allows get_goal only for active goals with a non-editing agent", () => {
    expect(
      availableGoalToolNames({
        goalsExperimentEnabled: true,
        goalStatus: "active",
        editingCapable: false,
      })
    ).toEqual(["get_goal"]);
  });

  test("allows both goal tools for active goals with an editing agent", () => {
    expect(
      availableGoalToolNames({
        goalsExperimentEnabled: true,
        goalStatus: "active",
        editingCapable: true,
      })
    ).toEqual(["get_goal", "complete_goal"]);
  });

  test("allows both goal tools for budget-limited goals with an editing agent", () => {
    expect(
      availableGoalToolNames({
        goalsExperimentEnabled: true,
        goalStatus: "budget_limited",
        editingCapable: true,
      })
    ).toEqual(["get_goal", "complete_goal"]);
  });
});
