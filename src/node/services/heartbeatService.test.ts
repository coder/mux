import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { ProjectConfig, ProjectsConfig, Workspace } from "@/common/types/project";
import { Ok } from "@/common/types/result";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import {
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_DEFAULT_MESSAGE_BODY,
  HEARTBEAT_MIN_INTERVAL_MS,
} from "@/constants/heartbeat";
import type { Config } from "@/node/config";
import { EventEmitter } from "events";
import type { AIService } from "./aiService";
import type { AgentSession } from "./agentSession";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import { HeartbeatService } from "./heartbeatService";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import type { TaskService } from "./taskService";
import { WorkspaceService } from "./workspaceService";

async function waitForCondition(
  condition: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 1_000;
  const intervalMs = options?.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

interface HeartbeatServiceInternals {
  startupTimeout: ReturnType<typeof setTimeout> | null;
  checkInterval: ReturnType<typeof setInterval> | null;
  stopped: boolean;
  nextEligibleAtByWorkspaceId: Map<string, number>;
  trackedIntervalMsByWorkspaceId: Map<string, number>;
  activeWorkspaceIds: Set<string>;
  queuedWorkspaceIds: Set<string>;
  isProcessingQueue: boolean;
  tick(): void;
  resyncFromConfig(now: number): Promise<void>;
  checkAllWorkspaces(now: number): void;
  queueWorkspace(workspaceId: string): void;
}

describe("HeartbeatService", () => {
  let mockConfig: Config;
  let currentProjectsConfig: ProjectsConfig;
  let mockExtensionMetadata: ExtensionMetadataService;
  let mockWorkspaceService: WorkspaceService;
  let mockTaskService: TaskService;
  let service: HeartbeatService;
  let wsEmitter: EventEmitter;

  let loadConfigMock: ReturnType<typeof mock<() => ProjectsConfig>>;
  let getSnapshotMock: ReturnType<
    typeof mock<(workspaceId: string) => Promise<WorkspaceActivitySnapshot | null>>
  >;
  let getAllSnapshotsMock: ReturnType<
    typeof mock<() => Promise<Map<string, WorkspaceActivitySnapshot>>>
  >;
  let getChatHistoryMock: ReturnType<typeof mock<(workspaceId: string) => Promise<MuxMessage[]>>>;
  let executeHeartbeatMock: ReturnType<typeof mock<(workspaceId: string) => Promise<void>>>;
  let hasActiveDescendantTasksMock: ReturnType<typeof mock<(workspaceId: string) => boolean>>;

  const testWorkspaceId = "test-ws";
  const workspace2Id = "workspace-2";
  const testProjectPath = "/test/project";
  const defaultHeartbeatIntervalMs = 300_000;
  const staleTimestamp = Date.now() - 600_000;

  function getInternals(): HeartbeatServiceInternals {
    return service as unknown as HeartbeatServiceInternals;
  }

  function makeWorkspaceEntry(
    overrides: Partial<{
      id: string;
      name: string;
      path: string;
      parentWorkspaceId: string;
      heartbeat: {
        enabled: boolean;
        intervalMs?: number;
        message?: string;
        contextMode?: "normal" | "compact" | "reset";
      };
      archivedAt: string;
      unarchivedAt: string;
    }> = {}
  ): Workspace {
    return {
      id: testWorkspaceId,
      path: "/test/path",
      name: "test",
      heartbeat: { enabled: true, intervalMs: defaultHeartbeatIntervalMs },
      ...overrides,
    } as unknown as Workspace;
  }

  function makeProjectsConfig(workspaces: Workspace[]): ProjectsConfig {
    return {
      projects: new Map<string, ProjectConfig>([
        [testProjectPath, { workspaces } as unknown as ProjectConfig],
      ]),
    };
  }

  function makeSnapshot(
    overrides: Partial<WorkspaceActivitySnapshot> = {}
  ): WorkspaceActivitySnapshot {
    return {
      recency: staleTimestamp,
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      ...overrides,
    };
  }

  function makeSnapshotMap(
    entries: Array<[string, WorkspaceActivitySnapshot]> = []
  ): Map<string, WorkspaceActivitySnapshot> {
    return new Map(entries);
  }

  function makeCompletedTurnHistory(timestamp = staleTimestamp): MuxMessage[] {
    return [
      createMuxMessage("1", "user", "Hello", { timestamp }),
      createMuxMessage("2", "assistant", "Hi!", { timestamp }),
    ];
  }

  function makeInteractiveAssistantMessage(timestamp = staleTimestamp): MuxMessage {
    const assistantMessage = createMuxMessage("2", "assistant", "asking", { timestamp });
    (assistantMessage as unknown as { parts: unknown[] }).parts = [
      { type: "text", text: "Let me ask...", state: "done" },
      {
        type: "dynamic-tool",
        toolName: "ask_user_question",
        state: "input-available",
        toolCallId: "tc1",
        args: {},
        output: undefined,
      },
    ];
    return assistantMessage;
  }

  beforeEach(() => {
    currentProjectsConfig = makeProjectsConfig([makeWorkspaceEntry()]);

    loadConfigMock = mock(() => currentProjectsConfig);
    mockConfig = {
      loadConfigOrDefault: loadConfigMock,
      findWorkspace: mock(() => ({ workspacePath: "/test/path", projectPath: testProjectPath })),
    } as unknown as Config;

    wsEmitter = new EventEmitter();
    getChatHistoryMock = mock(() => Promise.resolve(makeCompletedTurnHistory()));
    executeHeartbeatMock = mock(() => Promise.resolve());
    mockWorkspaceService = Object.assign(wsEmitter, {
      getChatHistory: getChatHistoryMock,
      executeHeartbeat: executeHeartbeatMock,
    }) as unknown as WorkspaceService;

    getSnapshotMock = mock(() => Promise.resolve(makeSnapshot()));
    getAllSnapshotsMock = mock(() => Promise.resolve(makeSnapshotMap()));
    mockExtensionMetadata = {
      getSnapshot: getSnapshotMock,
      getAllSnapshots: getAllSnapshotsMock,
    } as unknown as ExtensionMetadataService;

    hasActiveDescendantTasksMock = mock(() => false);
    mockTaskService = {
      hasActiveDescendantAgentTasksForWorkspace: hasActiveDescendantTasksMock,
    } as unknown as TaskService;

    service = new HeartbeatService(
      mockConfig,
      mockExtensionMetadata,
      mockWorkspaceService,
      mockTaskService
    );
  });

  afterEach(() => {
    service.stop();
  });

  describe("checkEligibility", () => {
    test("returns eligible for valid heartbeat-enabled workspace", async () => {
      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result.eligible).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("returns ineligible when workspace not found in config", async () => {
      currentProjectsConfig = { projects: new Map() };

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("workspace_not_found");
    });

    test("returns ineligible when heartbeat is disabled", async () => {
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({
          heartbeat: { enabled: false, intervalMs: defaultHeartbeatIntervalMs },
        }),
      ]);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("heartbeat_disabled");
    });

    test("returns ineligible when workspace is archived", async () => {
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ archivedAt: new Date().toISOString() }),
      ]);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("archived");
    });

    test("returns ineligible when workspace is a child", async () => {
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ parentWorkspaceId: "parent-ws" }),
      ]);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("child_workspace");
    });

    test("returns ineligible when workspace is streaming", async () => {
      getSnapshotMock.mockResolvedValueOnce(makeSnapshot({ streaming: true }));

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("currently_streaming");
    });

    test("returns ineligible when active descendant tasks exist", async () => {
      hasActiveDescendantTasksMock.mockReturnValueOnce(true);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("active_descendant_tasks");
    });

    test("returns ineligible when no completed turn (empty history)", async () => {
      getChatHistoryMock.mockResolvedValueOnce([]);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("no_completed_turn");
    });

    test("returns ineligible when no assistant message in history", async () => {
      getChatHistoryMock.mockResolvedValueOnce([
        createMuxMessage("1", "user", "Hello", { timestamp: staleTimestamp }),
        createMuxMessage("2", "user", "Still there?", { timestamp: staleTimestamp }),
      ]);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("no_completed_turn");
    });

    test("returns ineligible when last message is from user (awaiting response)", async () => {
      getChatHistoryMock.mockResolvedValueOnce([
        createMuxMessage("1", "user", "Hello", { timestamp: staleTimestamp }),
        createMuxMessage("2", "assistant", "Hi!", { timestamp: staleTimestamp }),
        createMuxMessage("3", "user", "Another question?", { timestamp: staleTimestamp }),
      ]);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("awaiting_response");
    });

    test("returns ineligible when last assistant message has interactive tool input", async () => {
      getChatHistoryMock.mockResolvedValueOnce([
        createMuxMessage("1", "user", "Hello", { timestamp: staleTimestamp }),
        makeInteractiveAssistantMessage(),
      ]);

      const result = await service.checkEligibility(testWorkspaceId, Date.now());

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("awaiting_interactive_input");
    });
  });

  describe("start/stop lifecycle", () => {
    test("starts with correct timer configuration", () => {
      const internals = getInternals();

      expect(internals.stopped).toBe(true);
      expect(wsEmitter.listenerCount("activity")).toBe(0);
      expect(wsEmitter.listenerCount("metadata")).toBe(0);

      service.start();

      expect(internals.stopped).toBe(false);
      expect(internals.startupTimeout).not.toBeNull();
      expect(internals.checkInterval).toBeNull();
      expect(wsEmitter.listenerCount("activity")).toBe(1);
      expect(wsEmitter.listenerCount("metadata")).toBe(1);

      service.stop();

      expect(internals.stopped).toBe(true);
      expect(internals.startupTimeout).toBeNull();
      expect(internals.checkInterval).toBeNull();
      expect(wsEmitter.listenerCount("activity")).toBe(0);
      expect(wsEmitter.listenerCount("metadata")).toBe(0);
    });

    test("stop clears all tracking state", async () => {
      service.start();
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      internals.activeWorkspaceIds.add("active-ws");
      internals.queuedWorkspaceIds.add("queued-ws");
      internals.isProcessingQueue = true;

      expect(internals.nextEligibleAtByWorkspaceId.size).toBe(1);
      expect(internals.activeWorkspaceIds.size).toBe(1);
      expect(internals.queuedWorkspaceIds.size).toBe(1);
      expect(internals.isProcessingQueue).toBe(true);

      service.stop();

      expect(internals.nextEligibleAtByWorkspaceId.size).toBe(0);
      expect(internals.activeWorkspaceIds.size).toBe(0);
      expect(internals.queuedWorkspaceIds.size).toBe(0);
      expect(internals.isProcessingQueue).toBe(false);
    });

    test("stop prevents new scheduling after stop", async () => {
      service.start();
      const internals = getInternals();

      service.stop();
      internals.nextEligibleAtByWorkspaceId.set(testWorkspaceId, 0);
      internals.tick();

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(internals.queuedWorkspaceIds.size).toBe(0);
      expect(executeHeartbeatMock).not.toHaveBeenCalled();
    });
  });

  describe("event handling", () => {
    test("activity event resets countdown for tracked workspace", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      const initialDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      wsEmitter.emit("activity", {
        workspaceId: testWorkspaceId,
        activity: { recency: Date.now(), streaming: false },
      });

      const resetDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      expect(initialDeadline).toBe(defaultHeartbeatIntervalMs);
      expect(resetDeadline).toBeDefined();
      expect(resetDeadline).toBeGreaterThan(initialDeadline!);
    });

    test("activity event ignores streaming=true events", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      const initialDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      wsEmitter.emit("activity", {
        workspaceId: testWorkspaceId,
        activity: { recency: Date.now(), streaming: true },
      });

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(initialDeadline);
    });

    test("activity event ignores null activity", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      const initialDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      wsEmitter.emit("activity", { workspaceId: testWorkspaceId, activity: null });

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(initialDeadline);
    });

    test("activity event ignores untracked workspaces", () => {
      service.start();
      const internals = getInternals();

      wsEmitter.emit("activity", {
        workspaceId: testWorkspaceId,
        activity: { recency: Date.now(), streaming: false },
      });

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
    });

    test("metadata event purges deleted workspace", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      wsEmitter.emit("metadata", { workspaceId: testWorkspaceId, metadata: null });
      internals.checkAllWorkspaces(Number.MAX_SAFE_INTEGER);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
      expect(executeHeartbeatMock).not.toHaveBeenCalled();
    });

    test("metadata event purges archived workspace", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      wsEmitter.emit("metadata", {
        workspaceId: testWorkspaceId,
        metadata: makeWorkspaceEntry({ archivedAt: new Date().toISOString() }),
      });

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
    });

    test("metadata event purges child workspace", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      wsEmitter.emit("metadata", {
        workspaceId: testWorkspaceId,
        metadata: makeWorkspaceEntry({ parentWorkspaceId: "parent-ws" }),
      });

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
    });

    test("metadata event purges a tracked workspace with an invalid interval", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      wsEmitter.emit("metadata", {
        workspaceId: testWorkspaceId,
        metadata: makeWorkspaceEntry({
          heartbeat: { enabled: true, intervalMs: 60_000 },
        }),
      });

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
    });

    test("metadata event updates the tracked deadline when the interval changes", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      const beforeMetadataUpdate = Date.now();
      const updatedIntervalMs = 45 * 60 * 1000;
      wsEmitter.emit("metadata", {
        workspaceId: testWorkspaceId,
        metadata: makeWorkspaceEntry({
          heartbeat: { enabled: true, intervalMs: updatedIntervalMs },
        }),
      });

      const updatedDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      expect(updatedDeadline).toBeDefined();
      expect(updatedDeadline).toBeGreaterThanOrEqual(beforeMetadataUpdate + updatedIntervalMs);
    });

    test("metadata event re-adds unarchived workspace", async () => {
      service.start();
      const internals = getInternals();
      await internals.resyncFromConfig(0);

      wsEmitter.emit("metadata", {
        workspaceId: testWorkspaceId,
        metadata: makeWorkspaceEntry({ archivedAt: new Date().toISOString() }),
      });
      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);

      const beforeReadd = Date.now();
      wsEmitter.emit("metadata", {
        workspaceId: testWorkspaceId,
        metadata: makeWorkspaceEntry({
          heartbeat: { enabled: true, intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS },
          unarchivedAt: new Date().toISOString(),
        }),
      });

      const readdedDeadline = internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId);
      expect(readdedDeadline).toBeDefined();
      expect(readdedDeadline).toBeGreaterThanOrEqual(beforeReadd + HEARTBEAT_DEFAULT_INTERVAL_MS);
    });
  });

  describe("scheduling and dispatch", () => {
    test("enabled workspace dispatches heartbeat after interval elapses", async () => {
      service.start();
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      internals.checkAllWorkspaces(defaultHeartbeatIntervalMs + 1);

      await waitForCondition(() => executeHeartbeatMock.mock.calls.length === 1);
      expect(executeHeartbeatMock).toHaveBeenCalledWith(testWorkspaceId);
    });

    test("dispatches an eligible heartbeat end-to-end through executeHeartbeat", async () => {
      const heartbeatIntervalMs = HEARTBEAT_MIN_INTERVAL_MS;
      const idleDurationMs = 5 * 60_000;
      const idleRecency = Date.now() - idleDurationMs;

      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({
          heartbeat: { enabled: true, intervalMs: heartbeatIntervalMs },
        }),
      ]);
      getSnapshotMock.mockImplementation(() =>
        Promise.resolve(
          makeSnapshot({
            recency: idleRecency,
            streaming: false,
          })
        )
      );

      const sendMessageMock = mock(() => Promise.resolve(Ok(undefined)));
      const getOrCreateSessionMock = mock(
        () =>
          ({
            isBusy: () => false,
            hasQueuedMessages: () => false,
          }) as unknown as AgentSession
      );

      const realWorkspaceService = new WorkspaceService(
        mockConfig,
        {} as HistoryService,
        new EventEmitter() as unknown as AIService,
        new EventEmitter() as unknown as InitStateManager,
        mockExtensionMetadata,
        {} as BackgroundProcessManager
      );
      const executeHeartbeatImpl = realWorkspaceService.executeHeartbeat.bind(realWorkspaceService);
      const executeHeartbeatSpy = mock((workspaceId: string) => executeHeartbeatImpl(workspaceId));

      const workspaceServiceOverrides = realWorkspaceService as unknown as {
        getChatHistory: typeof getChatHistoryMock;
        getOrCreateSession: typeof getOrCreateSessionMock;
        sendMessage: typeof sendMessageMock;
        executeHeartbeat: typeof executeHeartbeatSpy;
      };
      workspaceServiceOverrides.getChatHistory = getChatHistoryMock;
      workspaceServiceOverrides.getOrCreateSession = getOrCreateSessionMock;
      workspaceServiceOverrides.sendMessage = sendMessageMock;
      workspaceServiceOverrides.executeHeartbeat = executeHeartbeatSpy;

      service = new HeartbeatService(
        mockConfig,
        mockExtensionMetadata,
        realWorkspaceService,
        mockTaskService
      );
      service.start();
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      internals.checkAllWorkspaces(heartbeatIntervalMs + 1);

      await waitForCondition(() => sendMessageMock.mock.calls.length === 1);

      expect(executeHeartbeatSpy).toHaveBeenCalledTimes(1);
      expect(executeHeartbeatSpy).toHaveBeenCalledWith(testWorkspaceId);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);

      // `mock.calls` is typed as `any[][]`; pin it to the real sendMessage signature so
      // these assertions stay type-safe without changing the test behavior.
      interface HeartbeatDisplayStatus {
        message?: string;
      }
      interface HeartbeatSendOptions {
        muxMetadata?: {
          type?: string;
          source?: string;
          displayStatus?: HeartbeatDisplayStatus;
        };
      }
      type HeartbeatDispatchOptions = NonNullable<Parameters<WorkspaceService["sendMessage"]>[3]>;
      type HeartbeatSendMessageCall = [
        workspaceId: Parameters<WorkspaceService["sendMessage"]>[0],
        heartbeatPrompt: Parameters<WorkspaceService["sendMessage"]>[1],
        sendOptions: HeartbeatSendOptions,
        dispatchOptions: HeartbeatDispatchOptions,
      ];
      const firstSendMessageCall = sendMessageMock.mock.calls.at(0) as
        | HeartbeatSendMessageCall
        | undefined;
      expect(firstSendMessageCall).toBeDefined();
      if (!firstSendMessageCall) {
        throw new Error("Expected heartbeat sendMessage to be called exactly once");
      }
      const [workspaceId, heartbeatPrompt, sendOptions, dispatchOptions] = firstSendMessageCall;
      expect(workspaceId).toBe(testWorkspaceId);
      expect(heartbeatPrompt).toContain("[Heartbeat]");
      expect(heartbeatPrompt).toContain("idle for approximately 5 minutes");
      expect(heartbeatPrompt).toContain(HEARTBEAT_DEFAULT_MESSAGE_BODY);
      expect(sendOptions.muxMetadata?.type).toBe("heartbeat-request");
      expect(sendOptions.muxMetadata?.source).toBe("heartbeat");
      expect(sendOptions.muxMetadata?.displayStatus?.message).toBe("Heartbeat check...");
      expect(dispatchOptions?.synthetic).toBe(true);
      expect(dispatchOptions?.requireIdle).toBe(true);
      expect(dispatchOptions?.skipAutoResumeReset).toBe(true);
    });

    test("uses the global default heartbeat message when the workspace does not override it", async () => {
      const heartbeatIntervalMs = HEARTBEAT_MIN_INTERVAL_MS;
      const idleDurationMs = 5 * 60_000;
      const idleRecency = Date.now() - idleDurationMs;
      const globalDefaultPrompt =
        "Review the workspace state and suggest the next concrete action.";

      currentProjectsConfig = {
        ...makeProjectsConfig([
          makeWorkspaceEntry({
            heartbeat: {
              enabled: true,
              intervalMs: heartbeatIntervalMs,
            },
          }),
        ]),
        heartbeatDefaultPrompt: globalDefaultPrompt,
      };
      getSnapshotMock.mockImplementation(() =>
        Promise.resolve(
          makeSnapshot({
            recency: idleRecency,
            streaming: false,
          })
        )
      );

      const sendMessageMock = mock(() => Promise.resolve(Ok(undefined)));
      const getOrCreateSessionMock = mock(
        () =>
          ({
            isBusy: () => false,
            hasQueuedMessages: () => false,
          }) as unknown as AgentSession
      );

      const realWorkspaceService = new WorkspaceService(
        mockConfig,
        {} as HistoryService,
        new EventEmitter() as unknown as AIService,
        new EventEmitter() as unknown as InitStateManager,
        mockExtensionMetadata,
        {} as BackgroundProcessManager
      );
      const workspaceServiceOverrides = realWorkspaceService as unknown as {
        getOrCreateSession: typeof getOrCreateSessionMock;
        sendMessage: typeof sendMessageMock;
      };
      workspaceServiceOverrides.getOrCreateSession = getOrCreateSessionMock;
      workspaceServiceOverrides.sendMessage = sendMessageMock;

      await realWorkspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const firstSendMessageCall = sendMessageMock.mock.calls.at(0) as
        | [
            Parameters<WorkspaceService["sendMessage"]>[0],
            Parameters<WorkspaceService["sendMessage"]>[1],
          ]
        | undefined;
      expect(firstSendMessageCall).toBeDefined();
      if (!firstSendMessageCall) {
        throw new Error("Expected heartbeat sendMessage to be called exactly once");
      }
      const [, heartbeatPrompt] = firstSendMessageCall;
      expect(heartbeatPrompt).toContain(globalDefaultPrompt);
      expect(heartbeatPrompt).not.toContain(HEARTBEAT_DEFAULT_MESSAGE_BODY);
    });

    test("prefers the workspace heartbeat message over the global default", async () => {
      const heartbeatIntervalMs = HEARTBEAT_MIN_INTERVAL_MS;
      const idleDurationMs = 5 * 60_000;
      const idleRecency = Date.now() - idleDurationMs;
      const globalDefaultPrompt =
        "Review the workspace state and suggest the next concrete action.";
      const customMessage = "Re-check open work, refresh stale context, and summarize next steps.";

      currentProjectsConfig = {
        ...makeProjectsConfig([
          makeWorkspaceEntry({
            heartbeat: {
              enabled: true,
              intervalMs: heartbeatIntervalMs,
              message: customMessage,
            },
          }),
        ]),
        heartbeatDefaultPrompt: globalDefaultPrompt,
      };
      getSnapshotMock.mockImplementation(() =>
        Promise.resolve(
          makeSnapshot({
            recency: idleRecency,
            streaming: false,
          })
        )
      );

      const sendMessageMock = mock(() => Promise.resolve(Ok(undefined)));
      const getOrCreateSessionMock = mock(
        () =>
          ({
            isBusy: () => false,
            hasQueuedMessages: () => false,
          }) as unknown as AgentSession
      );

      const realWorkspaceService = new WorkspaceService(
        mockConfig,
        {} as HistoryService,
        new EventEmitter() as unknown as AIService,
        new EventEmitter() as unknown as InitStateManager,
        mockExtensionMetadata,
        {} as BackgroundProcessManager
      );
      const workspaceServiceOverrides = realWorkspaceService as unknown as {
        getOrCreateSession: typeof getOrCreateSessionMock;
        sendMessage: typeof sendMessageMock;
      };
      workspaceServiceOverrides.getOrCreateSession = getOrCreateSessionMock;
      workspaceServiceOverrides.sendMessage = sendMessageMock;

      await realWorkspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const firstSendMessageCall = sendMessageMock.mock.calls.at(0) as
        | [
            Parameters<WorkspaceService["sendMessage"]>[0],
            Parameters<WorkspaceService["sendMessage"]>[1],
          ]
        | undefined;
      expect(firstSendMessageCall).toBeDefined();
      if (!firstSendMessageCall) {
        throw new Error("Expected custom heartbeat sendMessage to be called exactly once");
      }
      const [, heartbeatPrompt] = firstSendMessageCall;
      expect(heartbeatPrompt).toContain(customMessage);
      expect(heartbeatPrompt).not.toContain(globalDefaultPrompt);
      expect(heartbeatPrompt).not.toContain(HEARTBEAT_DEFAULT_MESSAGE_BODY);
    });
    test("dispatches a real compaction request before heartbeat when context mode is compact", async () => {
      const heartbeatIntervalMs = HEARTBEAT_MIN_INTERVAL_MS;
      const idleRecency = Date.now() - 5 * 60_000;

      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({
          heartbeat: {
            enabled: true,
            intervalMs: heartbeatIntervalMs,
            contextMode: "compact",
          },
        }),
      ]);
      getSnapshotMock.mockImplementation(() =>
        Promise.resolve(
          makeSnapshot({
            recency: idleRecency,
            streaming: false,
          })
        )
      );

      const sendMessageMock = mock(() => Promise.resolve(Ok(undefined)));
      const getOrCreateSessionMock = mock(
        () =>
          ({
            isBusy: () => false,
            hasQueuedMessages: () => false,
          }) as unknown as AgentSession
      );

      const realWorkspaceService = new WorkspaceService(
        mockConfig,
        {} as HistoryService,
        new EventEmitter() as unknown as AIService,
        new EventEmitter() as unknown as InitStateManager,
        mockExtensionMetadata,
        {} as BackgroundProcessManager
      );
      const workspaceServiceOverrides = realWorkspaceService as unknown as {
        getOrCreateSession: typeof getOrCreateSessionMock;
        sendMessage: typeof sendMessageMock;
      };
      workspaceServiceOverrides.getOrCreateSession = getOrCreateSessionMock;
      workspaceServiceOverrides.sendMessage = sendMessageMock;

      await realWorkspaceService.executeHeartbeat(testWorkspaceId);

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const firstSendMessageCall = sendMessageMock.mock.calls.at(0) as
        | [
            Parameters<WorkspaceService["sendMessage"]>[0],
            Parameters<WorkspaceService["sendMessage"]>[1],
            {
              muxMetadata?: {
                type?: string;
                parsed?: {
                  followUpContent?: {
                    text?: string;
                    dispatchOptions?: { requireIdle?: boolean };
                    muxMetadata?: { type?: string };
                  };
                };
                displayStatus?: { message?: string };
              };
            },
            NonNullable<Parameters<WorkspaceService["sendMessage"]>[3]>,
          ]
        | undefined;
      expect(firstSendMessageCall).toBeDefined();
      if (!firstSendMessageCall) {
        throw new Error("Expected compact heartbeat sendMessage to be called exactly once");
      }
      const [workspaceId, compactionPrompt, sendOptions, dispatchOptions] = firstSendMessageCall;
      expect(workspaceId).toBe(testWorkspaceId);
      expect(compactionPrompt).toContain("The user wants to continue with: [Heartbeat]");
      expect(sendOptions.muxMetadata?.type).toBe("compaction-request");
      expect(sendOptions.muxMetadata?.displayStatus?.message).toBe(
        "Compacting before heartbeat..."
      );
      expect(sendOptions.muxMetadata?.parsed?.followUpContent?.text).toContain("[Heartbeat]");
      expect(sendOptions.muxMetadata?.parsed?.followUpContent?.dispatchOptions?.requireIdle).toBe(
        true
      );
      expect(sendOptions.muxMetadata?.parsed?.followUpContent?.muxMetadata?.type).toBe(
        "heartbeat-request"
      );
      expect(dispatchOptions.synthetic).toBe(true);
      expect(dispatchOptions.requireIdle).toBe(true);
      expect(dispatchOptions.skipAutoResumeReset).toBe(true);
    });

    test("appends a reset boundary before heartbeat when context mode is reset", async () => {
      const heartbeatIntervalMs = HEARTBEAT_MIN_INTERVAL_MS;
      const idleRecency = Date.now() - 5 * 60_000;

      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({
          heartbeat: {
            enabled: true,
            intervalMs: heartbeatIntervalMs,
            contextMode: "reset",
          },
        }),
      ]);
      getSnapshotMock.mockImplementation(() =>
        Promise.resolve(
          makeSnapshot({
            recency: idleRecency,
            streaming: false,
          })
        )
      );

      const appendHeartbeatContextResetBoundary = mock(
        (_params: {
          boundaryText: string;
          pendingFollowUp: {
            text?: string;
            dispatchOptions?: { requireIdle?: boolean };
            muxMetadata?: { type?: string };
          };
        }) => Promise.resolve(Ok({ summaryMessageId: "heartbeat-reset-boundary" }))
      );
      const dispatchPendingCompactionFollowUpIfNeeded = mock(() => Promise.resolve(true));
      const sessionStub = {
        isBusy: () => false,
        hasQueuedMessages: () => false,
        appendHeartbeatContextResetBoundary,
        dispatchPendingCompactionFollowUpIfNeeded,
      };

      const realWorkspaceService = new WorkspaceService(
        mockConfig,
        {} as HistoryService,
        new EventEmitter() as unknown as AIService,
        new EventEmitter() as unknown as InitStateManager,
        mockExtensionMetadata,
        {} as BackgroundProcessManager
      );
      (
        realWorkspaceService as unknown as { getOrCreateSession: () => AgentSession }
      ).getOrCreateSession = mock(() => sessionStub as unknown as AgentSession);

      await realWorkspaceService.executeHeartbeat(testWorkspaceId);

      expect(appendHeartbeatContextResetBoundary).toHaveBeenCalledTimes(1);
      const appendCall = appendHeartbeatContextResetBoundary.mock.calls.at(0)?.[0] as
        | {
            boundaryText: string;
            pendingFollowUp: {
              text?: string;
              dispatchOptions?: { requireIdle?: boolean };
              muxMetadata?: { type?: string };
            };
          }
        | undefined;
      expect(appendCall?.boundaryText).toContain("Heartbeat context reset");
      expect(appendCall?.pendingFollowUp.text).toContain("[Heartbeat]");
      expect(appendCall?.pendingFollowUp.dispatchOptions?.requireIdle).toBe(true);
      expect(appendCall?.pendingFollowUp.muxMetadata?.type).toBe("heartbeat-request");
      expect(dispatchPendingCompactionFollowUpIfNeeded).toHaveBeenCalledTimes(1);
      expect(dispatchPendingCompactionFollowUpIfNeeded).toHaveBeenCalledWith(
        "heartbeat-reset-boundary"
      );
    });

    test("startup does not fire heartbeats immediately", async () => {
      service.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(executeHeartbeatMock).not.toHaveBeenCalled();
    });

    test("concurrency cap of 1", async () => {
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry(),
        makeWorkspaceEntry({ id: workspace2Id, name: "test-2", path: "/test/path-2" }),
      ]);

      service.start();
      const internals = getInternals();

      let releaseFirstHeartbeat: (() => void) | undefined;
      const firstHeartbeatGate = new Promise<void>((resolve) => {
        releaseFirstHeartbeat = resolve;
      });

      const executionOrder: string[] = [];
      executeHeartbeatMock.mockImplementation(async (workspaceId: string) => {
        executionOrder.push(`start:${workspaceId}`);
        if (workspaceId === testWorkspaceId) {
          await firstHeartbeatGate;
        }
        executionOrder.push(`end:${workspaceId}`);
      });

      await internals.resyncFromConfig(0);
      internals.checkAllWorkspaces(defaultHeartbeatIntervalMs + 1);

      await waitForCondition(() => executionOrder.includes(`start:${testWorkspaceId}`));
      expect(executionOrder).toEqual([`start:${testWorkspaceId}`]);
      expect(internals.activeWorkspaceIds.size).toBe(1);

      releaseFirstHeartbeat?.();
      await waitForCondition(() => executionOrder.includes(`end:${workspace2Id}`));

      expect(executionOrder).toEqual([
        `start:${testWorkspaceId}`,
        `end:${testWorkspaceId}`,
        `start:${workspace2Id}`,
        `end:${workspace2Id}`,
      ]);
    });

    test("queue deduplication", async () => {
      service.start();
      const internals = getInternals();

      let releaseHeartbeat: (() => void) | undefined;
      const heartbeatGate = new Promise<void>((resolve) => {
        releaseHeartbeat = resolve;
      });

      executeHeartbeatMock.mockImplementation(async () => {
        await heartbeatGate;
      });

      internals.queueWorkspace(testWorkspaceId);
      internals.queueWorkspace(testWorkspaceId);

      await waitForCondition(() => executeHeartbeatMock.mock.calls.length === 1);
      releaseHeartbeat?.();
      await waitForCondition(() => executeHeartbeatMock.mock.calls.length === 1);

      expect(internals.queuedWorkspaceIds.size).toBe(0);
    });
  });

  describe("config resync", () => {
    test("adds newly enabled workspaces on resync when no persisted snapshot exists", async () => {
      currentProjectsConfig = makeProjectsConfig([]);
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);

      currentProjectsConfig = makeProjectsConfig([makeWorkspaceEntry()]);
      await internals.resyncFromConfig(1);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(
        1 + defaultHeartbeatIntervalMs
      );
    });

    test("keeps the tracked deadline when resync sees the same interval", async () => {
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(
        defaultHeartbeatIntervalMs
      );

      await internals.resyncFromConfig(1);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(
        defaultHeartbeatIntervalMs
      );
    });

    test("skips invalid intervals without blocking valid workspaces", async () => {
      const internals = getInternals();
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs: 60_000 } }),
        makeWorkspaceEntry({
          id: workspace2Id,
          name: "test-2",
          path: "/test/path-2",
          heartbeat: { enabled: true, intervalMs: defaultHeartbeatIntervalMs },
        }),
      ]);

      await internals.resyncFromConfig(0);

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
      expect(internals.nextEligibleAtByWorkspaceId.get(workspace2Id)).toBe(
        defaultHeartbeatIntervalMs
      );
    });

    test("reloads config after awaiting activity snapshots", async () => {
      const internals = getInternals();
      let resolveSnapshots: ((value: Map<string, WorkspaceActivitySnapshot>) => void) | undefined;
      getAllSnapshotsMock.mockImplementationOnce(
        () =>
          new Promise<Map<string, WorkspaceActivitySnapshot>>((resolve) => {
            resolveSnapshots = resolve;
          })
      );

      const resyncPromise = internals.resyncFromConfig(0);
      currentProjectsConfig = makeProjectsConfig([]);
      resolveSnapshots?.(makeSnapshotMap());
      await resyncPromise;

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
    });

    test("rebuilds a restart deadline from persisted activity recency", async () => {
      const internals = getInternals();
      const now = 60 * 60 * 1000;
      const intervalMs = 60 * 60 * 1000;
      const recency = now - 30 * 60 * 1000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs } }),
      ]);
      getAllSnapshotsMock.mockResolvedValueOnce(
        makeSnapshotMap([[testWorkspaceId, makeSnapshot({ recency, streaming: false })]])
      );

      await internals.resyncFromConfig(now);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(recency + intervalMs);
    });

    test("makes overdue workspaces eligible on the first post-start check", async () => {
      service.start();
      const internals = getInternals();
      const now = 60 * 60 * 1000;
      const intervalMs = 30 * 60 * 1000;
      const recency = now - intervalMs - 60_000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs } }),
      ]);
      getAllSnapshotsMock.mockResolvedValueOnce(
        makeSnapshotMap([[testWorkspaceId, makeSnapshot({ recency, streaming: false })]])
      );

      await internals.resyncFromConfig(now);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(now);
      internals.checkAllWorkspaces(now);
      await waitForCondition(() => executeHeartbeatMock.mock.calls.length === 1);
      expect(executeHeartbeatMock).toHaveBeenCalledWith(testWorkspaceId);
    });

    test("ignores persisted recency while the workspace snapshot is still streaming", async () => {
      const internals = getInternals();
      const now = 60 * 60 * 1000;
      const intervalMs = 30 * 60 * 1000;
      const staleRecency = now - intervalMs - 60_000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs } }),
      ]);
      getAllSnapshotsMock.mockResolvedValueOnce(
        makeSnapshotMap([
          [testWorkspaceId, makeSnapshot({ recency: staleRecency, streaming: true })],
        ])
      );

      await internals.resyncFromConfig(now);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(now + intervalMs);
    });

    test("falls back to a fresh interval when persisted recency is in the future", async () => {
      const internals = getInternals();
      const now = 60 * 60 * 1000;
      const intervalMs = 30 * 60 * 1000;
      const futureRecency = now + 5 * 60 * 1000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs } }),
      ]);
      getAllSnapshotsMock.mockResolvedValueOnce(
        makeSnapshotMap([
          [testWorkspaceId, makeSnapshot({ recency: futureRecency, streaming: false })],
        ])
      );

      await internals.resyncFromConfig(now);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(now + intervalMs);
    });

    test("updates the tracked deadline when resync sees a new interval", async () => {
      const internals = getInternals();
      const initialIntervalMs = 15 * 60 * 1000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs: initialIntervalMs } }),
      ]);

      await internals.resyncFromConfig(0);
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(initialIntervalMs);

      const updatedIntervalMs = 45 * 60 * 1000;
      currentProjectsConfig = makeProjectsConfig([
        makeWorkspaceEntry({ heartbeat: { enabled: true, intervalMs: updatedIntervalMs } }),
      ]);
      await internals.resyncFromConfig(1);

      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBe(
        1 + updatedIntervalMs
      );
    });

    test("uses the global default heartbeat interval when a workspace does not set one", async () => {
      const internals = getInternals();
      const globalDefaultIntervalMs = HEARTBEAT_MIN_INTERVAL_MS;
      currentProjectsConfig = {
        ...makeProjectsConfig([
          makeWorkspaceEntry({
            heartbeat: { enabled: true },
          }),
        ]),
        heartbeatDefaultIntervalMs: globalDefaultIntervalMs,
      };

      const beforeResync = Date.now();
      await internals.resyncFromConfig(beforeResync);

      expect(internals.trackedIntervalMsByWorkspaceId.get(testWorkspaceId)).toBe(
        globalDefaultIntervalMs
      );
      expect(internals.nextEligibleAtByWorkspaceId.get(testWorkspaceId)).toBeGreaterThanOrEqual(
        beforeResync + globalDefaultIntervalMs
      );
    });

    test("purges removed workspaces on resync", async () => {
      const internals = getInternals();

      await internals.resyncFromConfig(0);
      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(true);

      currentProjectsConfig = makeProjectsConfig([]);
      await internals.resyncFromConfig(1);

      expect(internals.nextEligibleAtByWorkspaceId.has(testWorkspaceId)).toBe(false);
    });
  });
});
