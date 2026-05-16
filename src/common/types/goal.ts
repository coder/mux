import type { z } from "zod";
import type {
  GoalRecordV1Schema,
  GoalSetErrorSchema,
  GoalSnapshotSchema,
  GoalStatusSchema,
} from "@/common/orpc/schemas/goal";

export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type GoalRecordV1 = z.infer<typeof GoalRecordV1Schema>;
export type GoalSnapshot = z.infer<typeof GoalSnapshotSchema>;

export type GoalSetError = z.infer<typeof GoalSetErrorSchema>;

export function isGoalPendingPersistence(goal: GoalSnapshot | null | undefined): boolean {
  return goal?.pendingPersistence === true;
}

export function toGoalSnapshot(goal: GoalRecordV1): GoalSnapshot {
  return {
    goalId: goal.goalId,
    status: goal.status,
    objective: goal.objective,
    budgetCents: goal.budgetCents,
    costCents: goal.costCents,
    turnsUsed: goal.turnsUsed,
    turnCap: goal.turnCap,
    ...(goal.completionSummary != null ? { completionSummary: goal.completionSummary } : {}),
    startedAtMs: goal.createdAtMs,
  };
}

export function toPendingGoalSnapshot(goal: GoalRecordV1): GoalSnapshot {
  return { ...toGoalSnapshot(goal), pendingPersistence: true };
}
