import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import type { ToolExecutionOptions } from "ai";

import type { Config } from "@/node/config";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { GoalRecordV1 } from "@/common/types/goal";
import { createCompleteGoalTool } from "./complete_goal";
import { createGetGoalTool } from "./get_goal";

// Goal tools do not touch runtime; ToolFactory config still requires one.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const inertRuntime = {} as never;

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "goal-tool-call",
  messages: [],
};

async function setGoalOk(
  service: WorkspaceGoalService,
  input: Parameters<WorkspaceGoalService["setGoal"]>[0]
): Promise<GoalRecordV1> {
  const result = await service.setGoal(input);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected goal set to succeed, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

function analyticsMock() {
  return { recordGoalLifecycleEvent: mock(() => undefined) };
}

describe("goal tools", () => {
  let config: Config;
  let cleanup: () => Promise<void>;
  let goalService: WorkspaceGoalService;
  let analytics: ReturnType<typeof analyticsMock>;
  const workspaceId = "goal-tool-workspace";

  beforeEach(async () => {
    const testServices = await createTestHistoryService();
    ({ config, cleanup } = testServices);
    await config.addWorkspace("/tmp/mux-goal-tool-test-project", {
      id: workspaceId,
      name: "goal-tool-workspace",
      projectName: "mux-goal-tool-test-project",
      projectPath: "/tmp/mux-goal-tool-test-project",
      runtimeConfig: { type: "local" },
    });
    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    analytics = analyticsMock();
    goalService = new WorkspaceGoalService(
      config,
      testServices.historyService,
      extensionMetadata,
      analytics
    );
  });

  afterEach(async () => {
    await cleanup();
  });

  test("get_goal returns the current goal", async () => {
    const created = await setGoalOk(goalService, { workspaceId, objective: "Read the goal" });
    const tool = createGetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({ goal: created });
  });

  test("complete_goal completes the goal, persists the summary, and emits model telemetry", async () => {
    const created = await setGoalOk(goalService, { workspaceId, objective: "Finish the goal" });
    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ summary: "Implemented and verified." }, mockToolCallOptions)
    );
    const storedRaw = await fs.readFile(
      path.join(config.getSessionDir(workspaceId), "goal.json"),
      "utf-8"
    );
    const storedGoal = JSON.parse(storedRaw) as GoalRecordV1;
    const currentGoal = await goalService.getGoal(workspaceId);

    expect(result).toMatchObject({
      goal: {
        goalId: created.goalId,
        status: "complete",
        completionSummary: "Implemented and verified.",
      },
    });
    expect(storedGoal).toMatchObject({
      goalId: created.goalId,
      status: "complete",
      completionSummary: "Implemented and verified.",
    });
    expect(currentGoal).toMatchObject({
      goalId: created.goalId,
      status: "complete",
      completionSummary: "Implemented and verified.",
    });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_completed",
      expect.objectContaining({ initiator: "model", summaryLengthBucket: "10-49" })
    );
  });

  // ---------------------------------------------------------------------------
  // complete_goal error coverage (Coder-agents-review P3 DEREM-26 + DEREM-44).
  //
  // The happy-path test pinned only the success branch. These tests cover the
  // failure modes the model can hit when goal state changes mid-stream:
  //  - Goal cleared (current=null) → typed `invalid_transition` Result error.
  //    The `setGoal` wrapper (DEREM-36) catches the
  //    `WorkspaceGoalTransitionError` thrown by
  //    `validateStatusTransition(null, "complete", ...)` and surfaces it as a
  //    typed Result error.
  //  - Goal paused → typed `invalid_transition` Result error. Same wrapper
  //    path; `validateStatusTransition("paused", "complete", ...)` throws
  //    "Cannot complete a goal that is not active or budget-limited."
  //  - Forwarded `goalId` mismatch → typed `goal_conflict` Result error.
  // ---------------------------------------------------------------------------
  test("complete_goal returns a typed error when no goal exists", async () => {
    // Coder-agents-review P2 DEREM-34: the previous spelling used a
    // synchronous `() => { ... }` callback with `.toThrow()` against an async
    // `execute`, which never observes the rejection because the lambda
    // returns a Promise. Swapped to an explicit `try`/`catch` around the
    // awaited promise so the rejection is actually observed.
    //
    // The `setGoal` wrapper (DEREM-36) catches `WorkspaceGoalTransitionError`
    // from `validateStatusTransition(null, "complete", ...)` and surfaces it
    // as a typed `invalid_transition` Result error instead of letting the
    // throw escape as the misleading "Goal objective is required." plain
    // Error from below. The complete_goal tool wraps the error.type into the
    // thrown message — assert that wrapping.
    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!({ summary: "Done without a goal." }, mockToolCallOptions)
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("invalid_transition");
  });

  test("complete_goal surfaces a typed error when goal is cleared mid-stream (no goalId forwarded)", async () => {
    // DEREM-35: the omitted-goalId path. When the model does not forward
    // `goalId` AND the user clears the goal mid-stream, the
    // setGoalImmediately code path used to read `current = null`, fall past
    // `conflictForExpectedGoalId(null, null)` (returns null), and throw an
    // unhandled `WorkspaceGoalTransitionError`. Now the outer `setGoal`
    // wrapper (DEREM-36) catches it and returns a typed `invalid_transition`
    // Result error.
    await setGoalOk(goalService, { workspaceId, objective: "Will be cleared" });
    await goalService.clearGoal(workspaceId);

    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(tool.execute!({ summary: "Done after clear." }, mockToolCallOptions));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("invalid_transition");
  });

  test("complete_goal surfaces invalid_transition for a paused goal", async () => {
    // Coder-agents-review P3 DEREM-44: pin the paused-goal failure mode.
    // `validateStatusTransition("paused", "complete", ...)` throws
    // "Cannot complete a goal that is not active or budget-limited."; the
    // setGoal wrapper turns that into a typed `invalid_transition` Result.
    await setGoalOk(goalService, { workspaceId, objective: "Will be paused" });
    await setGoalOk(goalService, { workspaceId, status: "paused" });

    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(tool.execute!({ summary: "Done from paused." }, mockToolCallOptions));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("invalid_transition");
  });

  test("complete_goal surfaces goal_conflict when expected goalId is stale", async () => {
    await setGoalOk(goalService, { workspaceId, objective: "Compete with a stale goalId" });
    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
    });

    // Forwarded `goalId` does not match the actual goal — setGoal returns
    // a typed `goal_conflict` error; the tool surfaces this as a thrown
    // Error rather than the misleading "Goal objective is required."
    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          { summary: "Done.", goalId: "00000000-0000-4000-8000-000000000000" },
          mockToolCallOptions
        )
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("goal_conflict");
  });
});
