import { describe, expect, test } from "bun:test";
import type { GoalRecordV1 } from "@/common/types/goal";
import type { SendMessageOptions } from "@/common/orpc/types";
import {
  describeCliGoalStop,
  driveCliGoalUntilTerminal,
  type DriveCliGoalUntilTerminalOptions,
} from "./goalRunDriver";

function goal(overrides: Partial<GoalRecordV1> = {}): GoalRecordV1 {
  return {
    version: 1,
    goalId: "goal-1",
    objective: "finish",
    status: "active",
    budgetCents: null,
    costCents: 0,
    costMicroCents: 0,
    turnCap: null,
    turnsUsed: 0,
    attributedChildren: [],
    budgetLimitInjectedForGoalId: null,
    requireUserAcknowledgmentSinceMs: null,
    lastContinuationFiredAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function sendOptions(): SendMessageOptions {
  return { model: "openai:gpt-4o", agentId: "exec" };
}

function options(
  overrides: Partial<DriveCliGoalUntilTerminalOptions> = {}
): DriveCliGoalUntilTerminalOptions {
  return {
    workspaceId: "workspace-1",
    getGoal: () => Promise.resolve(goal()),
    buildExecSendOptions: sendOptions,
    requestContinuationAfterStreamEnd: () => Promise.resolve(),
    requestDispatch: () => Promise.resolve(),
    checkGoalContinuationEligibility: () => Promise.resolve({}),
    prepareForContinuation: () => undefined,
    waitForStreamStarted: () => Promise.resolve(),
    waitForCompletion: () => Promise.resolve(),
    isSessionBudgetExceeded: () => false,
    nowMs: () => 123,
    emitJsonLine: () => undefined,
    writeHumanLineClosed: () => undefined,
    setGoalStopReason: () => undefined,
    describeError: String,
    ...overrides,
  };
}

describe("driveCliGoalUntilTerminal", () => {
  test("continues an active goal until completion", async () => {
    const goals = [goal(), goal({ status: "complete", completionSummary: "done" })];
    const events: unknown[] = [];
    const lines: string[] = [];
    const reasons: string[] = [];
    const continuations: Array<{ streamEndedAtMs: number; sendOptions: SendMessageOptions }> = [];
    let dispatches = 0;
    let waitStarts = 0;
    let waitCompletions = 0;

    const result = await driveCliGoalUntilTerminal(
      options({
        getGoal: () => Promise.resolve(goals.shift() ?? goals[goals.length - 1] ?? null),
        requestContinuationAfterStreamEnd: (input) => {
          continuations.push(input);
          return Promise.resolve();
        },
        requestDispatch: () => {
          dispatches += 1;
          return Promise.resolve();
        },
        waitForStreamStarted: () => {
          waitStarts += 1;
          return Promise.resolve();
        },
        waitForCompletion: () => {
          waitCompletions += 1;
          return Promise.resolve();
        },
        emitJsonLine: (event) => events.push(event),
        writeHumanLineClosed: (line = "") => lines.push(line),
        setGoalStopReason: (reason) => reasons.push(reason),
      })
    );

    expect(result?.status).toBe("complete");
    expect(continuations).toHaveLength(1);
    expect(continuations[0]?.streamEndedAtMs).toBe(123);
    expect(dispatches).toBe(1);
    expect(waitStarts).toBe(1);
    expect(waitCompletions).toBe(1);
    expect(events).toMatchObject([{ type: "goal-continuing" }, { type: "goal-completed" }]);
    expect(lines).toEqual(["[goal] continuing...", "[goal] completed: done"]);
    expect(reasons).toEqual(["complete"]);
  });

  test("passes the stream-start timeout to continuation waits", async () => {
    const goals = [goal(), goal({ status: "complete" })];
    const timeouts: Array<number | undefined> = [];

    await driveCliGoalUntilTerminal(
      options({
        getGoal: () => Promise.resolve(goals.shift() ?? goals[goals.length - 1] ?? null),
        streamStartTimeoutMs: 123,
        waitForStreamStarted: (timeoutMs) => {
          timeouts.push(timeoutMs);
          return Promise.resolve();
        },
      })
    );

    expect(timeouts).toEqual([123]);
  });

  test("drives a budget-limited goal through its wrap-up", async () => {
    const goals = [
      goal({ status: "budget_limited", budgetCents: 100, costCents: 100 }),
      goal({ status: "complete", completionSummary: "wrapped" }),
    ];
    const lines: string[] = [];
    const result = await driveCliGoalUntilTerminal(
      options({
        getGoal: () => Promise.resolve(goals.shift() ?? goals[goals.length - 1] ?? null),
        writeHumanLineClosed: (line = "") => lines.push(line),
      })
    );

    expect(result?.status).toBe("complete");
    expect(lines).toEqual(["[goal] budget wrap-up...", "[goal] completed: wrapped"]);
  });

  test("stops when a budget wrap-up already fired", async () => {
    const reasons: string[] = [];
    const result = await driveCliGoalUntilTerminal(
      options({
        getGoal: () =>
          Promise.resolve(
            goal({
              status: "budget_limited",
              budgetCents: 100,
              costCents: 100,
              budgetLimitInjectedForGoalId: "goal-1",
            })
          ),
        requestContinuationAfterStreamEnd: () => Promise.reject(new Error("should not continue")),
        requestDispatch: () => Promise.reject(new Error("should not dispatch")),
        prepareForContinuation: () => {
          throw new Error("should not prepare");
        },
        setGoalStopReason: (reason) => reasons.push(reason),
      })
    );

    expect(result?.status).toBe("budget_limited");
    expect(reasons).toEqual(["goal budget reached"]);
  });

  test("returns the latest goal when session budget stops after a continuation", async () => {
    const goals = [goal(), goal({ turnsUsed: 1 })];
    const reasons: string[] = [];
    const result = await driveCliGoalUntilTerminal(
      options({
        getGoal: () => Promise.resolve(goals.shift() ?? null),
        isSessionBudgetExceeded: () => true,
        setGoalStopReason: (reason) => reasons.push(reason),
      })
    );

    expect(result?.turnsUsed).toBe(1);
    expect(reasons).toEqual(["session budget exceeded"]);
  });

  test("reports completion when the goal completes during a session-budgeted continuation", async () => {
    const goals = [goal(), goal({ status: "complete", completionSummary: "finished" })];
    const events: unknown[] = [];
    const lines: string[] = [];
    const reasons: string[] = [];

    const result = await driveCliGoalUntilTerminal(
      options({
        getGoal: () => Promise.resolve(goals.shift() ?? goals[goals.length - 1] ?? null),
        isSessionBudgetExceeded: () => true,
        emitJsonLine: (event) => events.push(event),
        writeHumanLineClosed: (line = "") => lines.push(line),
        setGoalStopReason: (reason) => reasons.push(reason),
      })
    );

    expect(result?.status).toBe("complete");
    expect(reasons).toEqual(["complete"]);
    expect(events).toMatchObject([{ type: "goal-continuing" }, { type: "goal-completed" }]);
    expect(lines).toEqual(["[goal] continuing...", "[goal] completed: finished"]);
  });

  test("throws when the continuation safety limit is reached", () =>
    expect(driveCliGoalUntilTerminal(options({ continuationSafetyLimit: 1 }))).rejects.toThrow(
      "continuation safety guard"
    ));

  test("returns null when the goal disappears", async () => {
    const reasons: string[] = [];
    const result = await driveCliGoalUntilTerminal(
      options({
        getGoal: () => Promise.resolve(null),
        setGoalStopReason: (reason) => reasons.push(reason),
      })
    );

    expect(result).toBeNull();
    expect(reasons).toEqual(["goal missing"]);
  });

  test("returns paused goals without requesting another continuation", async () => {
    const reasons: string[] = [];
    const result = await driveCliGoalUntilTerminal(
      options({
        getGoal: () => Promise.resolve(goal({ status: "paused" })),
        requestContinuationAfterStreamEnd: () => Promise.reject(new Error("should not continue")),
        setGoalStopReason: (reason) => reasons.push(reason),
      })
    );

    expect(result?.status).toBe("paused");
    expect(reasons).toEqual(["goal paused"]);
  });

  test("reports continuation eligibility when no stream starts", () =>
    expect(
      driveCliGoalUntilTerminal(
        options({
          checkGoalContinuationEligibility: () => Promise.resolve({ reason: "cooldown" }),
          waitForStreamStarted: () => Promise.reject(new Error("timeout")),
          waitForCompletion: () => Promise.reject(new Error("should not wait for completion")),
        })
      )
    ).rejects.toThrow("CLI Goal Run made no progress (cooldown)"));
});

describe("describeCliGoalStop", () => {
  const cases: Array<[string, GoalRecordV1 | null, string]> = [
    ["missing goal", null, "goal missing"],
    [
      "budget and turn caps reached",
      goal({
        status: "budget_limited",
        budgetCents: 100,
        costCents: 100,
        turnCap: 2,
        turnsUsed: 2,
      }),
      "goal budget and turn caps reached",
    ],
    [
      "budget cap reached",
      goal({ status: "budget_limited", budgetCents: 100, costCents: 100 }),
      "goal budget reached",
    ],
    [
      "turn cap reached",
      goal({ status: "budget_limited", turnCap: 2, turnsUsed: 2 }),
      "goal turn cap reached",
    ],
    ["generic limit reached", goal({ status: "budget_limited" }), "goal limit reached"],
    ["paused goal", goal({ status: "paused" }), "goal paused"],
  ];

  test.each(cases)("describes %s", (_name, input, expected) => {
    expect(describeCliGoalStop(input)).toBe(expected);
  });
});
