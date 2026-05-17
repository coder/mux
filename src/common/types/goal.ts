import type { z } from "zod";
import type {
  GoalHistoryEndReasonSchema,
  GoalHistoryEntrySchema,
  GoalRecordV1Schema,
  GoalSetErrorSchema,
  GoalSnapshotSchema,
  GoalStatusSchema,
} from "@/common/orpc/schemas/goal";

export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type GoalRecordV1 = z.infer<typeof GoalRecordV1Schema>;
export type GoalSnapshot = z.infer<typeof GoalSnapshotSchema>;
export type GoalHistoryEndReason = z.infer<typeof GoalHistoryEndReasonSchema>;
export type GoalHistoryEntry = z.infer<typeof GoalHistoryEntrySchema>;

export type GoalSetError = z.infer<typeof GoalSetErrorSchema>;

/**
 * Conceptual lifecycle of a goal as seen on the goal-board UI. This is the
 * "where does this card live?" question, distinct from runtime mode:
 *
 *   - `active`   — the (at most one) goal the agent is currently driving.
 *                  May itself be running / paused / budget-limited — see
 *                  `GoalActiveMode` below for that sub-status.
 *   - `complete` — agent or user marked it done.
 *
 * `upcoming` / `archived` are reserved for the multi-goal queue model.
 *
 * The storage enum (`GoalStatus`) flattens these two axes (lifecycle +
 * active-mode) into one string because it predates the conceptual split.
 * `goalLifecycle()` maps from storage → lifecycle so the UI can group
 * goals on the board without learning the legacy flat-enum vocabulary.
 */
export type GoalLifecycle = "active" | "complete";

/**
 * When a goal is lifecycle-`active`, its sub-status describes what the
 * agent is doing with it right now:
 *
 *   - `running`        — the agent may auto-continue this goal.
 *   - `paused`         — explicit user pause, OR auto-pause (e.g., when the
 *                        user sends a fresh message mid-stream). Continuations
 *                        are suppressed until the user resumes.
 *   - `budget_limited` — internal-only transient state set by the budget
 *                        gate when cost or turn caps are hit.
 *
 * `null` when the goal is not lifecycle-active.
 */
export type GoalActiveMode = "running" | "paused" | "budget_limited";

export function goalLifecycle(status: GoalStatus): GoalLifecycle {
  switch (status) {
    case "active":
    case "paused":
    case "budget_limited":
      return "active";
    case "complete":
      return "complete";
  }
}

export function goalActiveMode(status: GoalStatus): GoalActiveMode | null {
  switch (status) {
    case "active":
      return "running";
    case "paused":
      return "paused";
    case "budget_limited":
      return "budget_limited";
    case "complete":
      return null;
  }
}

/**
 * True when the goal is the workspace's lifecycle-active goal (regardless
 * of whether it is currently running, paused, or budget-limited).
 *
 * Prefer this over `status === "active"` at every UI gate: the latter
 * silently treats a paused goal as "not active" even though paused is a
 * sub-status of active, which has caused bugs like the Resume button
 * disappearing when a budget cap is hit.
 */
export function isGoalLifecycleActive(status: GoalStatus): boolean {
  return goalLifecycle(status) === "active";
}

export function isGoalRunning(status: GoalStatus): boolean {
  return goalActiveMode(status) === "running";
}

export function isGoalPaused(status: GoalStatus): boolean {
  return goalActiveMode(status) === "paused";
}

export function isGoalBudgetLimited(status: GoalStatus): boolean {
  return goalActiveMode(status) === "budget_limited";
}

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
