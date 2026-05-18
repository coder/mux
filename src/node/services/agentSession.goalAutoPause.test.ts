import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { createMuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { GoalRecordV1, GoalStatus } from "@/common/types/goal";
import { GOAL_CONTINUATION_IDLE_CONSUMER_NAME } from "@/constants/goals";
import { waitForCondition } from "./testDispatchHelpers";
import { IdleDispatcher } from "./idleDispatcher";

const PROJECT_PATH = "/tmp/mux-agent-session-goal-test-project";
const SEND_OPTIONS: SendMessageOptions = { model: "openai:gpt-4o", agentId: "exec" };

interface SessionHarness {
  historyService: HistoryService;
  session: AgentSession;
  goalService: WorkspaceGoalService;
  extensionMetadata: ExtensionMetadataService;
  aiService: AIService & EventEmitter;
  analytics: { recordGoalLifecycleEvent: ReturnType<typeof mock> };
  cleanup: () => Promise<void>;
}

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

function createAiService(workspaceId: string): AIService & EventEmitter {
  const aiEmitter = new EventEmitter();
  return Object.assign(aiEmitter, {
    isStreaming: mock((_workspaceId: string) => false),
    stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    streamMessage: mock((_request: unknown) => Promise.resolve(Ok(undefined))),
    getStreamInfo: mock((_workspaceId: string) => null),
    getProvidersConfig: mock(() => null),
    getWorkspaceMetadata: mock((_workspaceId: string) =>
      Promise.resolve(
        Ok({
          id: workspaceId,
          name: workspaceId,
          projectName: "project",
          projectPath: PROJECT_PATH,
          runtimeConfig: { type: "local" },
        })
      )
    ),
    replayStream: mock((_workspaceId: string) => Promise.resolve()),
  }) as unknown as AIService & EventEmitter;
}

async function createSessionHarness(workspaceId: string): Promise<SessionHarness> {
  const { historyService, config, cleanup } = await createTestHistoryService();
  await config.addWorkspace(PROJECT_PATH, {
    id: workspaceId,
    name: workspaceId,
    projectName: "mux-agent-session-goal-test-project",
    projectPath: PROJECT_PATH,
    runtimeConfig: { type: "local" },
  });

  const extensionMetadata = new ExtensionMetadataService(
    `${config.rootDir}/agent-session-goal-extension-metadata.json`
  );
  const analytics = { recordGoalLifecycleEvent: mock(() => undefined) };
  const goalService = new WorkspaceGoalService(
    config,
    historyService,
    extensionMetadata,
    analytics
  );
  const initStateManager = Object.assign(new EventEmitter(), {
    replayInit: mock((_workspaceId: string) => Promise.resolve()),
  }) as unknown as InitStateManager;
  const backgroundProcessManager = {
    cleanup: mock((_workspaceId: string) => Promise.resolve()),
    setMessageQueued: mock((_workspaceId: string, _queued: boolean) => undefined),
  } as unknown as BackgroundProcessManager;

  const aiService = createAiService(workspaceId);
  const session = new AgentSession({
    workspaceId,
    config,
    historyService,
    aiService,
    initStateManager,
    backgroundProcessManager,
    workspaceGoalService: goalService,
  });

  return { historyService, session, goalService, extensionMetadata, aiService, analytics, cleanup };
}

describe("AgentSession goal safety hooks", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  test("manual user messages steer active goals by default", async () => {
    const workspaceId = "manual-steers-active-goal";
    const { session, goalService, analytics, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Keep working" });

    const result = await session.sendMessage("I need to steer this goal", SEND_OPTIONS);

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });
    expect(analytics.recordGoalLifecycleEvent).not.toHaveBeenCalledWith(
      "goal_paused",
      expect.anything()
    );
    session.dispose();
  });

  test("manual user messages can explicitly pause active goals", async () => {
    const workspaceId = "manual-pauses-active-goal";
    const { session, goalService, analytics, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Keep working" });

    const result = await session.sendMessage("I need to pause this goal", {
      ...SEND_OPTIONS,
      goalInterventionPolicy: "pause",
    });

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "paused" });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_paused",
      expect.objectContaining({ initiator: "auto" })
    );
    session.dispose();
  });

  for (const status of [
    "paused",
    "budget_limited",
    "complete",
  ] as const satisfies readonly GoalStatus[]) {
    test(`manual user messages leave ${status} goals unchanged`, async () => {
      const workspaceId = `manual-leaves-${status.replace("_", "-")}`;
      const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
      cleanups.push(cleanup);
      const seeded = await setGoalOk(goalService, {
        workspaceId,
        objective: `Goal already ${status}`,
        status,
        ...(status === "budget_limited" ? { budgetCents: 100 } : {}),
        ...(status === "complete" ? { completionSummary: "Finished already." } : {}),
      });
      if (status === "budget_limited") {
        await goalService.recordStreamAccounting({
          workspaceId,
          costUsd: 1,
          streamStartedAtMs: seeded.createdAtMs + 1,
          streamOriginKind: "goal_continuation",
        });
      }

      const result = await session.sendMessage("Manual follow-up", SEND_OPTIONS);

      expect(result.success).toBe(true);
      expect(await goalService.getGoal(workspaceId)).toMatchObject({ status });
      session.dispose();
    });
  }

  test("synthetic messages do not auto-pause active goals", async () => {
    const workspaceId = "synthetic-does-not-pause";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Keep looping" });

    const result = await session.sendMessage("Synthetic continuation", SEND_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "active" });
    session.dispose();
  });

  test("manual user messages are no-ops when no goal exists", async () => {
    const workspaceId = "manual-no-goal";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);

    const result = await session.sendMessage("No goal yet", SEND_OPTIONS);

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toBeNull();
    session.dispose();
  });

  test("manual user messages clear acknowledgment flags while steering by default", async () => {
    const workspaceId = "manual-clears-ack";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Wait for acknowledgment" });
    await goalService.requireUserAcknowledgment(workspaceId, 55_000);

    const result = await session.sendMessage("Acknowledged", SEND_OPTIONS);

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      status: "active",
      requireUserAcknowledgmentSinceMs: null,
    });
    session.dispose();
  });

  test("synthetic messages do not clear acknowledgment flags", async () => {
    const workspaceId = "synthetic-does-not-clear-ack";
    const { session, goalService, cleanup } = await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Still needs acknowledgment" });
    await goalService.requireUserAcknowledgment(workspaceId, 66_000);

    const result = await session.sendMessage("Synthetic continuation", SEND_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });

    expect(result.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      status: "active",
      requireUserAcknowledgmentSinceMs: 66_000,
    });
    session.dispose();
  });

  test("stream errors restore durable goal snapshot after live cost preview", async () => {
    const workspaceId = "stream-error-restores-goal-preview";
    const { session, goalService, extensionMetadata, aiService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    goalService.registerGoalContinuationConsumer(new IdleDispatcher(), {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: () => Promise.resolve(true),
    });
    const created = await setGoalOk(goalService, {
      workspaceId,
      objective: "Restore preview on error",
      budgetCents: 1_000,
    });
    await goalService.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 125 },
    });

    aiService.streamMessage = mock(() => {
      aiService.emit("error", {
        workspaceId,
        messageId: "assistant-stream-error",
        error: "boom",
        errorType: "unknown",
      });
      return Promise.resolve(Ok(undefined));
    }) as unknown as AIService["streamMessage"];
    const eventTypes: string[] = [];
    session.onChatEvent((event) => {
      eventTypes.push(event.message.type);
    });

    await session.sendMessage("Synthetic continuation", SEND_OPTIONS, {
      synthetic: true,
      goalContinuation: true,
    });
    await waitForCondition(() => eventTypes.includes("stream-error"), { timeoutMs: 1_000 });

    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 0, budgetCents: 1_000 },
    });
    session.dispose();
  });

  test("startup recovery gates goal continuations when an assistant partial is restored", async () => {
    const workspaceId = "crash-gates-goal";
    const { session, goalService, historyService, analytics, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Recover safely" });
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-before-crash", "user", "Start risky work", {
        timestamp: 1,
        retrySendOptions: SEND_OPTIONS,
      })
    );
    await historyService.writePartial(
      workspaceId,
      createMuxMessage("assistant-partial", "assistant", "Partial answer", { historySequence: 1 })
    );

    await session.runStartupRecovery();

    const recoveredGoal = await goalService.getGoal(workspaceId);
    expect(typeof recoveredGoal?.requireUserAcknowledgmentSinceMs).toBe("number");
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_crash_gate_set",
      expect.objectContaining({ workspaceIdLengthBucket: "10-49" })
    );
    session.dispose();
  });

  test("startup recovery ignores restored assistant partials when no goal exists", async () => {
    const workspaceId = "crash-no-goal";
    const { session, goalService, historyService, analytics, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await historyService.writePartial(
      workspaceId,
      createMuxMessage("assistant-partial", "assistant", "Partial answer", { historySequence: 0 })
    );

    await session.runStartupRecovery();

    expect(await goalService.getGoal(workspaceId)).toBeNull();
    expect(analytics.recordGoalLifecycleEvent).not.toHaveBeenCalledWith(
      "goal_crash_gate_set",
      expect.any(Object)
    );
    session.dispose();
  });

  test("manual acknowledgment clears stale gated continuations after restart", async () => {
    const workspaceId = "restart-gated-continuation";
    const { session, goalService, historyService, cleanup } =
      await createSessionHarness(workspaceId);
    cleanups.push(cleanup);
    await setGoalOk(goalService, { workspaceId, objective: "Continue after restart" });
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-before-crash", "user", "Start work", {
        timestamp: 1,
        retrySendOptions: SEND_OPTIONS,
      })
    );
    await historyService.writePartial(
      workspaceId,
      createMuxMessage("assistant-partial", "assistant", "Partial answer", { historySequence: 1 })
    );
    await session.runStartupRecovery();

    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    goalService.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: execute,
    });

    await goalService.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: SEND_OPTIONS,
      streamEndedAtMs: 100_000,
    });
    expect(execute).not.toHaveBeenCalled();

    const manualResult = await session.sendMessage("I saw the recovered response", SEND_OPTIONS);
    expect(manualResult.success).toBe(true);
    expect(await goalService.getGoal(workspaceId)).toMatchObject({
      status: "active",
      requireUserAcknowledgmentSinceMs: null,
    });

    await dispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME);

    expect(execute).not.toHaveBeenCalled();
    session.dispose();
  });
});
