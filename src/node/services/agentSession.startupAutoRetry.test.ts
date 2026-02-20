import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import type { InitStateManager } from "./initStateManager";
import type { WorkspaceChatMessage, SendMessageOptions } from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { Ok } from "@/common/types/result";

interface SessionBundle {
  session: AgentSession;
  config: Config;
  historyService: HistoryService;
  aiService: AIService;
  initStateManager: InitStateManager;
  backgroundProcessManager: BackgroundProcessManager;
  events: WorkspaceChatMessage[];
  cleanup: () => Promise<void>;
}

async function createSessionBundle(workspaceId: string): Promise<SessionBundle> {
  const { historyService, config, cleanup } = await createTestHistoryService();

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: workspaceId,
    projectName: "project",
    projectPath: "/tmp/project",
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    aiSettingsByAgent: {
      exec: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" },
    },
  };

  const aiService: AIService = {
    on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
      return this;
    },
    off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
      return this;
    },
    stopStream: mock(() => Promise.resolve(Ok(undefined))),
    isStreaming: mock(() => false),
    streamMessage: mock(() => Promise.resolve(Ok(undefined))),
    getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
  } as unknown as AIService;

  const initStateManager: InitStateManager = {
    on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
      return this;
    },
    off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
      return this;
    },
  } as unknown as InitStateManager;

  const backgroundProcessManager: BackgroundProcessManager = {
    cleanup: mock(() => Promise.resolve()),
    setMessageQueued: mock(() => undefined),
  } as unknown as BackgroundProcessManager;

  const session = new AgentSession({
    workspaceId,
    config,
    historyService,
    aiService,
    initStateManager,
    backgroundProcessManager,
  });

  const events: WorkspaceChatMessage[] = [];
  session.onChatEvent(({ message }) => {
    events.push(message);
  });

  return {
    session,
    config,
    historyService,
    aiService,
    initStateManager,
    backgroundProcessManager,
    events,
    cleanup,
  };
}

describe("AgentSession startup auto-retry recovery", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  test("schedules startup auto-retry for interrupted user tail", async () => {
    const workspaceId = "startup-retry-user-tail";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Hello from interrupted turn", {
        timestamp: Date.now(),
        toolPolicy: [{ regex_match: ".*", action: "disable" }],
        disableWorkspaceAgents: true,
      })
    );
    expect(appendResult.success).toBe(true);

    const appendSnapshotResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("snapshot-1", "user", "<snapshot>", {
        timestamp: Date.now(),
        synthetic: true,
        fileAtMentionSnapshot: ["token"],
      })
    );
    expect(appendSnapshotResult.success).toBe(true);

    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    const scheduledEvent = events.find((event) => event.type === "auto-retry-scheduled");
    expect(scheduledEvent).toBeDefined();

    const retryOptions = (session as unknown as { lastAutoRetryOptions?: SendMessageOptions })
      .lastAutoRetryOptions;
    expect(retryOptions).toBeDefined();
    if (!retryOptions) {
      throw new Error("Expected startup auto-retry options to be captured");
    }
    expect(retryOptions.model).toBe("anthropic:claude-sonnet-4-5");
    expect(retryOptions.agentId).toBe("exec");
    expect(retryOptions.toolPolicy).toEqual([{ regex_match: ".*", action: "disable" }]);
    expect(retryOptions.disableWorkspaceAgents).toBe(true);

    session.dispose();
  });

  test("re-runs startup auto-retry check after busy startup state clears", async () => {
    const workspaceId = "startup-retry-busy-rerun";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted while startup was busy", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    const privateSession = session as unknown as {
      setTurnPhase: (phase: "idle" | "preparing" | "streaming" | "completing") => void;
      startupAutoRetryCheckPromise: Promise<void> | null;
      startupAutoRetryCheckScheduled: boolean;
    };

    privateSession.setTurnPhase("preparing");
    session.ensureStartupAutoRetryCheck();

    const firstCheckPromise = privateSession.startupAutoRetryCheckPromise;
    await firstCheckPromise;

    expect(privateSession.startupAutoRetryCheckScheduled).toBe(false);
    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    privateSession.setTurnPhase("idle");

    const deadline = Date.now() + 1500;
    while (
      !events.some((event) => event.type === "auto-retry-scheduled") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(true);
    expect(privateSession.startupAutoRetryCheckScheduled).toBe(true);

    session.dispose();
  });

  test("re-runs startup auto-retry check after transient history read failures", async () => {
    const workspaceId = "startup-retry-history-read-rerun";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted while history read failed", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    const originalGetLastMessages = historyService.getLastMessages.bind(historyService);
    let getLastMessagesCalls = 0;
    historyService.getLastMessages = mock((id: string, count: number) => {
      getLastMessagesCalls += 1;
      if (getLastMessagesCalls === 1) {
        return Promise.resolve({
          success: false as const,
          error: "temporary history read failure",
        });
      }

      return originalGetLastMessages(id, count);
    }) as unknown as HistoryService["getLastMessages"];

    const privateSession = session as unknown as {
      startupAutoRetryCheckPromise: Promise<void> | null;
      startupAutoRetryCheckScheduled: boolean;
    };

    session.ensureStartupAutoRetryCheck();

    const firstCheckPromise = privateSession.startupAutoRetryCheckPromise;
    await firstCheckPromise;

    expect(getLastMessagesCalls).toBeGreaterThanOrEqual(1);

    const deadline = Date.now() + 3000;
    while (
      !events.some((event) => event.type === "auto-retry-scheduled") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(getLastMessagesCalls).toBeGreaterThanOrEqual(2);
    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(true);
    expect(privateSession.startupAutoRetryCheckScheduled).toBe(true);

    session.dispose();
  });

  test("backs off reruns after repeated startup history read failures", async () => {
    const workspaceId = "startup-retry-history-read-backoff";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted while history is unavailable", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    let getLastMessagesCalls = 0;
    historyService.getLastMessages = mock(() => {
      getLastMessagesCalls += 1;
      return Promise.resolve({
        success: false as const,
        error: "persistent history read failure",
      });
    }) as unknown as HistoryService["getLastMessages"];

    const privateSession = session as unknown as {
      startupAutoRetryCheckPromise: Promise<void> | null;
    };

    session.ensureStartupAutoRetryCheck();
    await privateSession.startupAutoRetryCheckPromise;

    expect(getLastMessagesCalls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(getLastMessagesCalls).toBe(1);

    const deadline = Date.now() + 2500;
    while (getLastMessagesCalls < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(getLastMessagesCalls).toBeGreaterThanOrEqual(2);

    session.dispose();
  });

  test("waits for AI streaming to settle before rerunning deferred startup checks", async () => {
    const workspaceId = "startup-retry-wait-stream-settle";
    const { historyService, config, cleanup } = await createTestHistoryService();
    cleanups.push(cleanup);

    let aiStreaming = true;
    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => aiStreaming),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: mock(() => Promise.resolve(Ok(undefined))),
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;
    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const privateSession = session as unknown as {
      scheduleStartupAutoRetryIfNeeded: () => Promise<"completed" | "deferred">;
      startupAutoRetryCheckPromise: Promise<void> | null;
      startupAutoRetryCheckScheduled: boolean;
    };

    let scheduleCalls = 0;
    privateSession.scheduleStartupAutoRetryIfNeeded = mock(() => {
      scheduleCalls += 1;
      const outcome: "completed" | "deferred" = scheduleCalls === 1 ? "deferred" : "completed";
      return Promise.resolve(outcome);
    });

    session.ensureStartupAutoRetryCheck();

    const firstCheckPromise = privateSession.startupAutoRetryCheckPromise;
    await firstCheckPromise;

    expect(scheduleCalls).toBe(1);
    expect(privateSession.startupAutoRetryCheckScheduled).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(scheduleCalls).toBe(1);

    aiStreaming = false;
    aiEmitter.emit("stream-abort", {
      type: "stream-abort",
      workspaceId,
      messageId: "assistant-1",
      abortReason: "system",
    });

    const deadline = Date.now() + 1000;
    while (scheduleCalls < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(scheduleCalls).toBe(2);
    expect(privateSession.startupAutoRetryCheckScheduled).toBe(true);

    session.dispose();
  });

  test("restores persisted retry send options for startup auto-retry", async () => {
    const workspaceId = "startup-retry-preserve-options";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted with custom send options", {
        timestamp: Date.now(),
        retrySendOptions: {
          model: "anthropic:claude-sonnet-4-5",
          agentId: "exec",
          thinkingLevel: "high",
          system1ThinkingLevel: "low",
          system1Model: "openai:gpt-4o-mini",
          toolPolicy: [{ regex_match: "bash", action: "disable" }],
          additionalSystemInstructions: "Use one sentence.",
          maxOutputTokens: 2048,
          providerOptions: {
            anthropic: {
              use1MContext: true,
              use1MContextModels: ["anthropic:claude-sonnet-4-5"],
            },
          },
          experiments: { system1: true },
          disableWorkspaceAgents: true,
        },
      })
    );
    expect(appendResult.success).toBe(true);

    const startupRetryModelHint = await session.getStartupAutoRetryModelHint();
    expect(startupRetryModelHint).toBe("anthropic:claude-sonnet-4-5");

    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    const retryOptions = (session as unknown as { lastAutoRetryOptions?: SendMessageOptions })
      .lastAutoRetryOptions;
    expect(retryOptions).toBeDefined();
    if (!retryOptions) {
      throw new Error("Expected startup retry options");
    }

    expect(retryOptions.model).toBe("anthropic:claude-sonnet-4-5");
    expect(retryOptions.agentId).toBe("exec");
    expect(retryOptions.thinkingLevel).toBe("high");
    expect(retryOptions.system1ThinkingLevel).toBe("low");
    expect(retryOptions.system1Model).toBe("openai:gpt-4o-mini");
    expect(retryOptions.additionalSystemInstructions).toBe("Use one sentence.");
    expect(retryOptions.maxOutputTokens).toBe(2048);
    expect(retryOptions.toolPolicy).toEqual([{ regex_match: "bash", action: "disable" }]);
    expect(retryOptions.disableWorkspaceAgents).toBe(true);
    expect(retryOptions.experiments?.system1).toBe(true);
    expect(retryOptions.providerOptions?.anthropic?.use1MContext).toBe(true);

    session.dispose();
  });

  test("replays pending auto-retry schedule during reconnect catch-up", async () => {
    const workspaceId = "startup-retry-replay-snapshot";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before reconnect", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    const replayEvents: WorkspaceChatMessage[] = [];
    await session.replayHistory(({ message }) => {
      replayEvents.push(message);
    });

    const scheduledIndex = replayEvents.findIndex((event) => event.type === "auto-retry-scheduled");
    const caughtUpIndex = replayEvents.findIndex((event) => event.type === "caught-up");

    expect(scheduledIndex).toBeGreaterThanOrEqual(0);
    expect(caughtUpIndex).toBeGreaterThanOrEqual(0);
    expect(scheduledIndex).toBeLessThan(caughtUpIndex);

    session.dispose();
  });

  test("respects persisted auto-retry opt-out across restart", async () => {
    const workspaceId = "startup-retry-opt-out";
    const {
      session: firstSession,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      cleanup,
    } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before restart", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    await firstSession.setAutoRetryEnabled(false);
    firstSession.dispose();

    const secondSession = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const events: WorkspaceChatMessage[] = [];
    secondSession.onChatEvent(({ message }) => {
      events.push(message);
    });

    secondSession.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      secondSession as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    secondSession.dispose();
  });

  test("respects legacy auto-retry opt-out hint when backend preference is missing", async () => {
    const workspaceId = "startup-retry-legacy-opt-out";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before migration", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    session.setLegacyAutoRetryEnabledHint(false);
    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    const preferencePath = (
      session as unknown as {
        getAutoRetryPreferencePath: () => string;
      }
    ).getAutoRetryPreferencePath();
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      enabled?: unknown;
    };
    expect(persisted.enabled).toBe(false);

    session.dispose();
  });

  test("does not persist temporary auto-retry enable across restart", async () => {
    const workspaceId = "startup-retry-temporary-enable";
    const {
      session: firstSession,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      cleanup,
    } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before restart", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    await firstSession.setAutoRetryEnabled(false);
    await firstSession.setAutoRetryEnabled(true, { persist: false });
    firstSession.dispose();

    const secondSession = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const events: WorkspaceChatMessage[] = [];
    secondSession.onChatEvent(({ message }) => {
      events.push(message);
    });

    secondSession.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      secondSession as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    secondSession.dispose();
  });

  test("does not reschedule startup retries after persisted non-retryable failure", async () => {
    const workspaceId = "startup-retry-non-retryable";
    const {
      session: firstSession,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      cleanup,
    } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted prompt", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    await (
      firstSession as unknown as {
        persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      }
    ).persistStartupAutoRetryAbandon("runtime_not_ready", "user-1");

    firstSession.dispose();

    const secondSession = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const events: WorkspaceChatMessage[] = [];
    secondSession.onChatEvent(({ message }) => {
      events.push(message);
    });

    secondSession.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      secondSession as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    secondSession.dispose();
  });

  test("clears persisted startup abandon state once retry resumes successfully", async () => {
    const workspaceId = "startup-retry-clear-abandon-on-resume";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      retryActiveStream: () => Promise<void>;
      getAutoRetryPreferencePath: () => string;
      lastAutoRetryOptions?: SendMessageOptions;
      resumeStream: (
        options: SendMessageOptions
      ) => Promise<{ success: true; data: { started: boolean } }>;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };

    await privateSession.persistStartupAutoRetryAbandon("runtime_not_ready", "user-1");

    const preferencePath = privateSession.getAutoRetryPreferencePath();
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    privateSession.lastAutoRetryOptions = {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    };

    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({ success: true as const, data: { started: true } })
    );
    privateSession.resumeStream = resumeStreamMock;

    await privateSession.retryActiveStream();

    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(privateSession.startupAutoRetryAbandon).toBeNull();
    expect(await Bun.file(preferencePath).exists()).toBe(false);

    session.dispose();
  });

  test("reschedules retry when resumeStream defers without starting a stream", async () => {
    const workspaceId = "startup-retry-resume-deferred";
    const { session, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      lastAutoRetryOptions?: SendMessageOptions;
      resumeStream: (
        options: SendMessageOptions
      ) => Promise<{ success: true; data: { started: boolean } }>;
    };

    privateSession.lastAutoRetryOptions = {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    };

    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({
        success: true as const,
        data: { started: false },
      })
    );
    privateSession.resumeStream = resumeStreamMock;

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await privateSession.retryActiveStream();

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore + 1);

    session.dispose();
  });

  test("does not re-process retry failures already handled by resumeStream", async () => {
    const workspaceId = "startup-retry-no-double-process-failure";
    const { session, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      lastAutoRetryOptions?: SendMessageOptions;
      activeStreamFailureHandled: boolean;
      resumeStream: (
        options: SendMessageOptions
      ) => Promise<
        | { success: true; data: { started: boolean } }
        | { success: false; error: { type: "runtime_start_failed"; message: string } }
      >;
    };

    privateSession.lastAutoRetryOptions = {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    };

    privateSession.activeStreamFailureHandled = true;
    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({
        success: false as const,
        error: {
          type: "runtime_start_failed" as const,
          message: "runtime is still starting",
        },
      })
    );
    privateSession.resumeStream = resumeStreamMock;

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await privateSession.retryActiveStream();

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore);

    session.dispose();
  });

  test("handles unprocessed resume failures by scheduling the next retry", async () => {
    const workspaceId = "startup-retry-process-unhandled-failure";
    const { session, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      lastAutoRetryOptions?: SendMessageOptions;
      activeStreamFailureHandled: boolean;
      resumeStream: (
        options: SendMessageOptions
      ) => Promise<
        | { success: true; data: { started: boolean } }
        | { success: false; error: { type: "runtime_start_failed"; message: string } }
      >;
    };

    privateSession.lastAutoRetryOptions = {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    };

    privateSession.activeStreamFailureHandled = false;
    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({
        success: false as const,
        error: {
          type: "runtime_start_failed" as const,
          message: "runtime is still starting",
        },
      })
    );
    privateSession.resumeStream = resumeStreamMock;

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await privateSession.retryActiveStream();

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore + 1);

    session.dispose();
  });

  test("persists startup abandon marker for pre-stream user aborts", async () => {
    const workspaceId = "startup-retry-pre-stream-abort";
    const { historyService, config, cleanup } = await createTestHistoryService();
    cleanups.push(cleanup);

    const workspaceMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: workspaceId,
      projectName: "project",
      projectPath: "/tmp/project",
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      aiSettingsByAgent: {
        exec: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" },
      },
    };

    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
    }) as unknown as AIService;

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const privateSession = session as unknown as {
      setTurnPhase: (phase: "idle" | "preparing" | "streaming" | "completing") => void;
      activeStreamUserMessageId?: string;
      getAutoRetryPreferencePath: () => string;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };

    privateSession.activeStreamUserMessageId = "user-1";
    privateSession.setTurnPhase("preparing");

    aiEmitter.emit("stream-abort", {
      type: "stream-abort",
      workspaceId,
      messageId: "assistant-1",
      abortReason: "user",
      metadata: {},
    });

    const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (condition()) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    };

    const abandonPersisted = await waitUntil(() => privateSession.startupAutoRetryAbandon !== null);
    expect(abandonPersisted).toBe(true);

    expect(privateSession.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });

    const preferencePath = privateSession.getAutoRetryPreferencePath();
    const waitForPreferenceFile = async (timeoutMs = 2000): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await Bun.file(preferencePath).exists()) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    };

    expect(await waitForPreferenceFile()).toBe(true);

    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      startupAutoRetryAbandon?: { reason?: string; userMessageId?: string };
    };
    expect(persisted.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });

    session.dispose();
  });

  test("skips persisting startup abandon marker for non-user abort reasons", async () => {
    const workspaceId = "startup-retry-system-abort-skip";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      getAutoRetryPreferencePath: () => string;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      updateStartupAutoRetryAbandonFromAbort: (
        abortReason: "user" | "startup" | "system" | undefined,
        userMessageId?: string
      ) => Promise<void>;
    };

    const preferencePath = privateSession.getAutoRetryPreferencePath();

    await privateSession.updateStartupAutoRetryAbandonFromAbort("system", "user-1");

    expect(privateSession.startupAutoRetryAbandon).toBeNull();
    expect(await Bun.file(preferencePath).exists()).toBe(false);

    await privateSession.updateStartupAutoRetryAbandonFromAbort("user", "user-1");

    expect(privateSession.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });
    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      startupAutoRetryAbandon?: { reason?: string; userMessageId?: string };
    };
    expect(persisted.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });

    session.dispose();
  });

  test("does not schedule startup auto-retry while ask_user_question is waiting", async () => {
    const workspaceId = "startup-retry-ask-user";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const writePartialResult = await historyService.writePartial(
      workspaceId,
      createMuxMessage(
        "assistant-1",
        "assistant",
        "",
        {
          timestamp: Date.now(),
          model: "anthropic:claude-sonnet-4-5",
          partial: true,
          agentId: "exec",
        },
        [
          {
            type: "dynamic-tool",
            state: "input-available",
            toolCallId: "tool-1",
            toolName: "ask_user_question",
            input: { question: "Name?" },
          },
        ]
      )
    );
    expect(writePartialResult.success).toBe(true);

    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    session.dispose();
  });
});
