import { describe, expect, test } from "bun:test";

import { getGoalToolAvailability, getToolAvailabilityOptions } from "./toolAvailability";
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
  goalStatus: GoalStatus | null;
  editingCapable: boolean;
}): string[] {
  const availability = getGoalToolAvailability({
    goalStatus: input.goalStatus,
    agentInheritanceChain: input.editingCapable ? [execAgent] : [exploreAgent, execBaseForExplore],
  });

  return [
    ...(availability.getGoal ? ["get_goal"] : []),
    ...(availability.completeGoal ? ["complete_goal"] : []),
  ];
}

describe("goal tool availability", () => {
  test("omits goal tools when no goal is set", () => {
    expect(
      availableGoalToolNames({
        goalStatus: null,
        editingCapable: true,
      })
    ).toEqual([]);
  });

  test.each(["paused", "complete"] as const)("omits goal tools for %s goals", (goalStatus) => {
    expect(
      availableGoalToolNames({
        goalStatus,
        editingCapable: true,
      })
    ).toEqual([]);
  });

  test("allows get_goal only for active goals with a non-editing agent", () => {
    expect(
      availableGoalToolNames({
        goalStatus: "active",
        editingCapable: false,
      })
    ).toEqual(["get_goal"]);
  });

  test("allows both goal tools for active goals with an editing agent", () => {
    expect(
      availableGoalToolNames({
        goalStatus: "active",
        editingCapable: true,
      })
    ).toEqual(["get_goal", "complete_goal"]);
  });

  test("allows both goal tools for budget-limited goals with an editing agent", () => {
    expect(
      availableGoalToolNames({
        goalStatus: "budget_limited",
        editingCapable: true,
      })
    ).toEqual(["get_goal", "complete_goal"]);
  });
});

describe("getToolAvailabilityOptions", () => {
  test("enables the Review pane for top-level workspaces", () => {
    const options = getToolAvailabilityOptions({ workspaceId: "ws-1" });
    expect(options.enableReviewPane).toBe(true);
    expect(options.enableAgentReport).toBe(false);
  });

  test("withholds the Review pane (and enables agent_report) for sub-agents", () => {
    const options = getToolAvailabilityOptions({
      workspaceId: "ws-child",
      parentWorkspaceId: "ws-parent",
    });
    expect(options.enableReviewPane).toBe(false);
    expect(options.enableAgentReport).toBe(true);
  });
});
