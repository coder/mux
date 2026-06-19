import type { GoalSetError } from "@/common/types/goal";

export function formatGoalSetError(error: GoalSetError): string {
  switch (error.type) {
    case "goal_conflict":
      return `goal_conflict (expected ${error.expectedGoalId ?? "no goal"}, actual ${error.actualGoalId ?? "no goal"})`;
    case "child_workspace":
    case "invalid_transition":
      return `${error.type}: ${error.message}`;
  }
}
