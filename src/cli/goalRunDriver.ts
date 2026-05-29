import assert from "@/common/utils/assert";
import type { GoalRecordV1 } from "@/common/types/goal";
import type { SendMessageOptions } from "@/common/orpc/types";
import { CLI_GOAL_CONTINUATION_SAFETY_LIMIT } from "@/constants/goals";

interface EligibilityHint {
  reason?: string | null;
}

interface GoalContinuationRequest {
  sendOptions: SendMessageOptions;
  streamEndedAtMs: number;
}

export interface DriveCliGoalUntilTerminalOptions {
  workspaceId: string;
  getGoal: () => Promise<GoalRecordV1 | null>;
  buildExecSendOptions: () => SendMessageOptions;
  requestContinuationAfterStreamEnd: (input: GoalContinuationRequest) => Promise<void>;
  requestDispatch: () => Promise<void>;
  checkGoalContinuationEligibility: (nowMs: number) => Promise<EligibilityHint>;
  prepareForContinuation: () => void;
  waitForStreamStarted: (timeoutMs?: number) => Promise<void>;
  waitForCompletion: () => Promise<void>;
  isSessionBudgetExceeded: () => boolean;
  nowMs: () => number;
  emitJsonLine: (payload: unknown) => void;
  writeHumanLineClosed: (text?: string) => void;
  setGoalStopReason: (reason: string) => void;
  describeError: (error: unknown) => string;
  continuationSafetyLimit?: number;
  streamStartTimeoutMs?: number;
}

/** Records the same terminal completion event regardless of where the loop observes it. */
function recordCliGoalCompleted(
  opts: DriveCliGoalUntilTerminalOptions,
  goal: GoalRecordV1
): GoalRecordV1 {
  opts.setGoalStopReason("complete");
  opts.emitJsonLine({
    type: "goal-completed",
    workspaceId: opts.workspaceId,
    goalId: goal.goalId,
    completionSummary: goal.completionSummary ?? null,
  });
  opts.writeHumanLineClosed(`[goal] completed: ${goal.completionSummary ?? "complete"}`);
  return goal;
}

/** Returns the stable stop-reason string surfaced in CLI JSON and human output. */
export function describeCliGoalStop(goal: GoalRecordV1 | null): string {
  if (!goal) return "goal missing";
  if (goal.status === "budget_limited") {
    const hitTurnCap = goal.turnCap != null && goal.turnsUsed >= goal.turnCap;
    const hitBudget = goal.budgetCents != null && goal.costCents >= goal.budgetCents;
    if (hitBudget && hitTurnCap) return "goal budget and turn caps reached";
    if (hitBudget) return "goal budget reached";
    if (hitTurnCap) return "goal turn cap reached";
    return "goal limit reached";
  }
  return `goal ${goal.status}`;
}

/**
 * Drives a CLI goal by requesting continuations until the persisted goal reaches
 * a terminal state. Returns the last goal record, or null if the goal disappears;
 * throws only when continuation dispatch fails before a terminal goal state exists.
 */
export async function driveCliGoalUntilTerminal(
  opts: DriveCliGoalUntilTerminalOptions
): Promise<GoalRecordV1 | null> {
  const continuationSafetyLimit =
    opts.continuationSafetyLimit ?? CLI_GOAL_CONTINUATION_SAFETY_LIMIT;
  const streamStartTimeoutMs = opts.streamStartTimeoutMs;
  let continuationCount = 0;

  while (true) {
    const goal = await opts.getGoal();
    if (goal?.status === "complete") {
      return recordCliGoalCompleted(opts, goal);
    }
    if (!goal || goal.status === "paused") {
      opts.setGoalStopReason(describeCliGoalStop(goal));
      return goal;
    }
    if (goal.status === "budget_limited" && goal.budgetLimitInjectedForGoalId === goal.goalId) {
      opts.setGoalStopReason(describeCliGoalStop(goal));
      return goal;
    }

    continuationCount += 1;
    assert(
      continuationCount < continuationSafetyLimit,
      "CLI Goal Run exceeded the continuation safety guard"
    );
    opts.prepareForContinuation();
    const phase = goal.status === "budget_limited" ? "budget wrap-up" : "continuing";
    opts.emitJsonLine({
      type: "goal-continuing",
      workspaceId: opts.workspaceId,
      goalId: goal.goalId,
      status: goal.status,
      continuation: continuationCount,
    });
    opts.writeHumanLineClosed(`[goal] ${phase}...`);
    await opts.requestContinuationAfterStreamEnd({
      sendOptions: opts.buildExecSendOptions(),
      streamEndedAtMs: opts.nowMs(),
    });
    await opts.requestDispatch();
    try {
      await opts.waitForStreamStarted(streamStartTimeoutMs);
    } catch (error) {
      const eligibility = await opts.checkGoalContinuationEligibility(opts.nowMs());
      throw new Error(
        `CLI Goal Run made no progress (${eligibility.reason ?? opts.describeError(error)})`
      );
    }
    await opts.waitForCompletion();
    if (opts.isSessionBudgetExceeded()) {
      const latestGoal = await opts.getGoal();
      if (latestGoal?.status === "complete") {
        return recordCliGoalCompleted(opts, latestGoal);
      }
      opts.setGoalStopReason("session budget exceeded");
      return latestGoal;
    }
  }
}
