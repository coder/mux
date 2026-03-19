import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "fs/promises";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import { Ok } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";

import type { AIService } from "./aiService";
import { AgentSession } from "./agentSession";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { createTestHistoryService } from "./testHistoryService";
import { DisposableTempDir } from "./tempDir";
import { getTodoFilePath } from "./todos/todoStorage";

const WORKSPACE_ID = "workspace-todo-nudge";
const MODEL = "openai:gpt-4o-mini";
const TODO_NUDGE_TEXT =
  "You still have unfinished items in your TODO list. Continue the remaining work now, or update the TODO list if it is stale, blocked, or no longer applicable before ending your turn.";

interface SessionInternals {
  currentRealUserTurnOrdinal: number;
  todoNudgeSentForRealUserTurnOrdinal: number;
  turnPhase: "idle" | "preparing" | "streaming" | "completing";
  sendMessage: (
    message: string,
    options?: SendMessageOptions,
    internal?: { synthetic?: boolean; agentInitiated?: boolean }
  ) => Promise<{ success: boolean }>;
  dispatchAgentSwitch: (
    switchResult: { agentId: string; reason?: string; followUp?: string },
    currentOptions: SendMessageOptions | undefined,
    fallbackModel: string
  ) => Promise<boolean>;
}

interface SessionHarness {
  session: AgentSession;
  aiEmitter: EventEmitter;
  streamMessageMock: ReturnType<typeof mock>;
}

function createAiService(
  projectPath: string,
  aiEmitter: EventEmitter,
  streamMessageMock: ReturnType<typeof mock>,
  metadataOverrides?: Partial<WorkspaceMetadata>,
  providersConfig?: ProvidersConfigMap | null
): AIService {
  const workspaceMetadata: WorkspaceMetadata = {
    id: WORKSPACE_ID,
    name: "workspace-todo-nudge-name",
    projectName: "workspace-todo-nudge-project",
    projectPath,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    ...metadataOverrides,
  };

  return Object.assign(aiEmitter, {
    getWorkspaceMetadata: mock(() =>
      Promise.resolve({
        success: true as const,
        data: workspaceMetadata,
      })
    ),
    getProvidersConfig: mock(() => providersConfig ?? null),
    isStreaming: mock(() => false),
    stopStream: mock(() => Promise.resolve(Ok(undefined))),
    streamMessage: streamMessageMock as unknown as AIService["streamMessage"],
  }) as unknown as AIService;
}

function createSessionHarness(
  historyService: HistoryService,
  sessionDir: string,
  projectPath: string,
  metadataOverrides?: Partial<WorkspaceMetadata>,
  providersConfig?: ProvidersConfigMap | null
): SessionHarness {
  const aiEmitter = new EventEmitter();
  const streamMessageMock = mock(() => Promise.resolve(Ok(undefined)));
  const initStateManager: InitStateManager = {
    on() {
      return this;
    },
    off() {
      return this;
    },
  } as unknown as InitStateManager;

  const backgroundProcessManager: BackgroundProcessManager = {
    setMessageQueued: mock(() => undefined),
    cleanup: mock(() => Promise.resolve()),
  } as unknown as BackgroundProcessManager;

  const config: Config = {
    srcDir: sessionDir,
    getSessionDir: mock(() => sessionDir),
    loadConfigOrDefault: mock(() => ({})),
    loadProvidersConfig: mock(() => providersConfig ?? null),
  } as unknown as Config;

  const session = new AgentSession({
    workspaceId: WORKSPACE_ID,
    config,
    historyService,
    aiService: createAiService(
      projectPath,
      aiEmitter,
      streamMessageMock,
      metadataOverrides,
      providersConfig
    ),
    initStateManager,
    backgroundProcessManager,
  });

  return { session, aiEmitter, streamMessageMock };
}

async function seedTodos(
  sessionDir: string,
  todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>
): Promise<void> {
  await fs.writeFile(getTodoFilePath(sessionDir), JSON.stringify(todos), "utf-8");
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 1_500,
  errorMessage = "Timed out waiting for condition"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(errorMessage);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function emitStreamStart(aiEmitter: EventEmitter): void {
  aiEmitter.emit("stream-start", {
    type: "stream-start",
    workspaceId: WORKSPACE_ID,
    messageId: "assistant-todo-nudge",
    model: MODEL,
    historySequence: 1,
    startTime: Date.now(),
    agentId: "exec",
  });
}

function emitStreamEnd(aiEmitter: EventEmitter, parts: Array<Record<string, unknown>> = []): void {
  aiEmitter.emit("stream-end", {
    type: "stream-end",
    workspaceId: WORKSPACE_ID,
    messageId: "assistant-todo-nudge",
    parts,
    metadata: {
      model: MODEL,
      contextUsage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
      },
      providerMetadata: {},
    },
  });
}

describe("AgentSession TODO nudge", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  let activeSession: AgentSession | undefined;

  afterEach(async () => {
    activeSession?.dispose();
    activeSession = undefined;
    await historyCleanup?.();
    historyCleanup = undefined;
  });

  test("unfinished TODOs after a real user turn send exactly one synthetic TODO nudge", async () => {
    using projectDir = new DisposableTempDir("agent-session-todo-nudge-unfinished");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const { session, aiEmitter, streamMessageMock } = createSessionHarness(
      historyService,
      projectDir.path,
      projectDir.path
    );
    activeSession = session;

    let streamMessageCallCount = 0;
    streamMessageMock.mockImplementation(() => {
      streamMessageCallCount += 1;
      if (streamMessageCallCount === 1) {
        emitStreamStart(aiEmitter);
      }
      return Promise.resolve(Ok(undefined));
    });

    const initialSendResult = await session.sendMessage("Please finish the remaining work.", {
      model: MODEL,
      agentId: "exec",
    });
    expect(initialSendResult.success).toBe(true);

    const internals = session as unknown as SessionInternals;
    expect(internals.currentRealUserTurnOrdinal).toBe(1);
    expect(internals.todoNudgeSentForRealUserTurnOrdinal).toBe(0);

    await seedTodos(projectDir.path, [
      { content: "Ship the first change", status: "completed" },
      { content: "Finish the second change", status: "in_progress" },
    ]);

    const originalSendMessage = session.sendMessage.bind(session);
    const sendMessageSpy = mock(
      (
        message: string,
        options?: SendMessageOptions,
        internal?: { synthetic?: boolean; agentInitiated?: boolean }
      ) => originalSendMessage(message, options, internal)
    );
    internals.sendMessage = sendMessageSpy as unknown as SessionInternals["sendMessage"];

    emitStreamEnd(aiEmitter);

    await waitForCondition(
      () => internals.turnPhase === "idle" && sendMessageSpy.mock.calls.length === 1,
      1_500,
      "Expected synthetic TODO nudge to be dispatched"
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[0]).toBe(TODO_NUDGE_TEXT);
    expect(sendMessageSpy.mock.calls[0]?.[2]).toMatchObject({ synthetic: true });
    expect(internals.currentRealUserTurnOrdinal).toBe(1);
    expect(internals.todoNudgeSentForRealUserTurnOrdinal).toBe(1);
  });

  test("completed TODO lists do not trigger a synthetic TODO nudge", async () => {
    using projectDir = new DisposableTempDir("agent-session-todo-nudge-complete");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const { session, aiEmitter, streamMessageMock } = createSessionHarness(
      historyService,
      projectDir.path,
      projectDir.path
    );
    activeSession = session;

    let streamMessageCallCount = 0;
    streamMessageMock.mockImplementation(() => {
      streamMessageCallCount += 1;
      if (streamMessageCallCount === 1) {
        emitStreamStart(aiEmitter);
      }
      return Promise.resolve(Ok(undefined));
    });

    const initialSendResult = await session.sendMessage("Please finish the remaining work.", {
      model: MODEL,
      agentId: "exec",
    });
    expect(initialSendResult.success).toBe(true);

    await seedTodos(projectDir.path, [
      { content: "Done one", status: "completed" },
      { content: "Done two", status: "completed" },
    ]);

    const internals = session as unknown as SessionInternals;
    const originalSendMessage = session.sendMessage.bind(session);
    const sendMessageSpy = mock(
      (
        message: string,
        options?: SendMessageOptions,
        internal?: { synthetic?: boolean; agentInitiated?: boolean }
      ) => originalSendMessage(message, options, internal)
    );
    internals.sendMessage = sendMessageSpy as unknown as SessionInternals["sendMessage"];

    emitStreamEnd(aiEmitter);

    await waitForCondition(() => internals.turnPhase === "idle");

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(internals.todoNudgeSentForRealUserTurnOrdinal).toBe(0);
  });

  test("missing TODO file does not trigger a synthetic TODO nudge", async () => {
    using projectDir = new DisposableTempDir("agent-session-todo-nudge-empty");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const { session, aiEmitter, streamMessageMock } = createSessionHarness(
      historyService,
      projectDir.path,
      projectDir.path
    );
    activeSession = session;

    let streamMessageCallCount = 0;
    streamMessageMock.mockImplementation(() => {
      streamMessageCallCount += 1;
      if (streamMessageCallCount === 1) {
        emitStreamStart(aiEmitter);
      }
      return Promise.resolve(Ok(undefined));
    });

    const initialSendResult = await session.sendMessage("Please finish the remaining work.", {
      model: MODEL,
      agentId: "exec",
    });
    expect(initialSendResult.success).toBe(true);

    const internals = session as unknown as SessionInternals;
    const originalSendMessage = session.sendMessage.bind(session);
    const sendMessageSpy = mock(
      (
        message: string,
        options?: SendMessageOptions,
        internal?: { synthetic?: boolean; agentInitiated?: boolean }
      ) => originalSendMessage(message, options, internal)
    );
    internals.sendMessage = sendMessageSpy as unknown as SessionInternals["sendMessage"];

    emitStreamEnd(aiEmitter);

    await waitForCondition(() => internals.turnPhase === "idle");

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(internals.todoNudgeSentForRealUserTurnOrdinal).toBe(0);
  });

  test("synthetic TODO nudge does not advance the real-user turn counter", async () => {
    using projectDir = new DisposableTempDir("agent-session-todo-nudge-synthetic");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const { session, aiEmitter, streamMessageMock } = createSessionHarness(
      historyService,
      projectDir.path,
      projectDir.path
    );
    activeSession = session;

    let streamMessageCallCount = 0;
    streamMessageMock.mockImplementation(() => {
      streamMessageCallCount += 1;
      if (streamMessageCallCount === 1) {
        emitStreamStart(aiEmitter);
      }
      return Promise.resolve(Ok(undefined));
    });

    const initialSendResult = await session.sendMessage("Please finish the remaining work.", {
      model: MODEL,
      agentId: "exec",
    });
    expect(initialSendResult.success).toBe(true);

    await seedTodos(projectDir.path, [{ content: "Still pending", status: "pending" }]);

    const internals = session as unknown as SessionInternals;
    const originalSendMessage = session.sendMessage.bind(session);
    const sendMessageSpy = mock(
      (
        message: string,
        options?: SendMessageOptions,
        internal?: { synthetic?: boolean; agentInitiated?: boolean }
      ) => originalSendMessage(message, options, internal)
    );
    internals.sendMessage = sendMessageSpy as unknown as SessionInternals["sendMessage"];

    emitStreamEnd(aiEmitter);

    await waitForCondition(
      () => internals.turnPhase === "idle" && sendMessageSpy.mock.calls.length === 1,
      1_500,
      "Expected synthetic TODO nudge to be dispatched"
    );

    expect(internals.currentRealUserTurnOrdinal).toBe(1);
    expect(internals.todoNudgeSentForRealUserTurnOrdinal).toBe(1);
  });

  test("higher-priority stream-end follow-ups suppress the TODO nudge", async () => {
    using projectDir = new DisposableTempDir("agent-session-todo-nudge-switch");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const { session, aiEmitter, streamMessageMock } = createSessionHarness(
      historyService,
      projectDir.path,
      projectDir.path
    );
    activeSession = session;

    let streamMessageCallCount = 0;
    streamMessageMock.mockImplementation(() => {
      streamMessageCallCount += 1;
      if (streamMessageCallCount === 1) {
        emitStreamStart(aiEmitter);
      }
      return Promise.resolve(Ok(undefined));
    });

    const initialSendResult = await session.sendMessage("Please finish the remaining work.", {
      model: MODEL,
      agentId: "exec",
    });
    expect(initialSendResult.success).toBe(true);

    await seedTodos(projectDir.path, [{ content: "Still pending", status: "pending" }]);

    const internals = session as unknown as SessionInternals;
    const originalSendMessage = session.sendMessage.bind(session);
    const sendMessageSpy = mock(
      (
        message: string,
        options?: SendMessageOptions,
        internal?: { synthetic?: boolean; agentInitiated?: boolean }
      ) => originalSendMessage(message, options, internal)
    );
    internals.sendMessage = sendMessageSpy as unknown as SessionInternals["sendMessage"];
    internals.dispatchAgentSwitch = mock(() =>
      Promise.resolve(true)
    ) as unknown as SessionInternals["dispatchAgentSwitch"];

    emitStreamEnd(aiEmitter, [
      {
        type: "dynamic-tool",
        state: "output-available",
        toolCallId: "tool-switch-agent",
        toolName: "switch_agent",
        input: { agentId: "plan", followUp: "Continue." },
        output: { ok: true, agentId: "plan", followUp: "Continue." },
      },
    ]);

    await waitForCondition(() => internals.turnPhase === "idle");

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(internals.todoNudgeSentForRealUserTurnOrdinal).toBe(0);
  });
});
