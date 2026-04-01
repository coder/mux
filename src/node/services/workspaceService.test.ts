import { describe, expect, test, mock, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { WorkspaceService, generateForkBranchName, generateForkTitle } from "./workspaceService";
import type { AgentSession } from "./agentSession";
import { WorkspaceLifecycleHooks } from "./workspaceLifecycleHooks";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { ProjectsConfig } from "@/common/types/project";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import type { SessionTimingService } from "./sessionTimingService";
import { SessionUsageService } from "./sessionUsageService";
import type { AIService } from "./aiService";
import type { InitStateManager, InitStatus } from "./initStateManager";
import type {
  ExtensionMetadataService,
  ExtensionMetadataStreamingUpdate,
} from "./ExtensionMetadataService";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
  WorkspaceMetadata,
} from "@/common/types/workspace";
import type { TaskService } from "./taskService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { TerminalService } from "@/node/services/terminalService";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import type { WorktreeArchiveSnapshot } from "@/common/schemas/project";
import type { BashToolResult } from "@/common/types/tools";
import { createMuxMessage } from "@/common/types/message";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import * as todoStorageModule from "@/node/services/todos/todoStorage";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as bashToolModule from "@/node/services/tools/bash";
import * as forkOrchestratorModule from "@/node/services/utils/forkOrchestrator";
import * as runtimeExecHelpers from "@/node/utils/runtime/helpers";
import * as removeManagedGitWorktreeModule from "@/node/worktree/removeManagedGitWorktree";
import * as workspaceTitleGenerator from "./workspaceTitleGenerator";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";

// Helper to access private renamingWorkspaces set
function addToRenamingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).renamingWorkspaces.add(workspaceId);
}

// Helper to access private archivingWorkspaces set
function addToArchivingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).archivingWorkspaces.add(workspaceId);
}

async function withTempMuxRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const originalMuxRoot = process.env.MUX_ROOT;
  const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-plan-"));
  process.env.MUX_ROOT = tempRoot;

  try {
    return await fn(tempRoot);
  } finally {
    if (originalMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = originalMuxRoot;
    }
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
}

async function writePlanFile(
  root: string,
  projectName: string,
  workspaceName: string
): Promise<string> {
  const planDir = path.join(root, "plans", projectName);
  await fsPromises.mkdir(planDir, { recursive: true });
  const planFile = path.join(planDir, `${workspaceName}.md`);
  await fsPromises.writeFile(planFile, "# Plan\n");
  return planFile;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// NOTE: This test file uses bun:test mocks (not Jest).

const mockInitStateManager: Partial<InitStateManager> = {
  on: mock(() => undefined as unknown as InitStateManager),
  getInitState: mock(() => undefined),
  waitForInit: mock(() => Promise.resolve()),
  clearInMemoryState: mock(() => undefined),
};
const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {
  setStreaming: mock(() =>
    Promise.resolve({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
    })
  ),
};
const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
  cleanup: mock(() => Promise.resolve()),
};

function createFrontendWorkspaceMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> & Pick<FrontendWorkspaceMetadata, "id" | "name">
): FrontendWorkspaceMetadata {
  return {
    ...overrides,
    id: overrides.id,
    name: overrides.name,
    projectName: overrides.projectName ?? "project",
    projectPath: overrides.projectPath ?? "/tmp/project",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    runtimeConfig: overrides.runtimeConfig ?? { type: "local" },
    namedWorkspacePath: overrides.namedWorkspacePath ?? `/tmp/${overrides.id}`,
  };
}

describe("WorkspaceService initialize", () => {
  let workspaceService: WorkspaceService;
  let config: Config;

  beforeEach(() => {
    config = {
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
    } as unknown as Config;

    const aiService = {
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = new WorkspaceService(
      config,
      {} as HistoryService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  test("schedules startup recovery for non-task, non-archived chats", async () => {
    const liveWorkspace = createFrontendWorkspaceMetadata({
      id: "live-ws",
      name: "Live Workspace",
    });
    const taskWorkspace = createFrontendWorkspaceMetadata({
      id: "task-ws",
      name: "Task Workspace",
      taskStatus: "running",
    });
    const archivedWorkspace = createFrontendWorkspaceMetadata({
      id: "archived-ws",
      name: "Archived Workspace",
      archivedAt: "2026-03-20T00:00:00.000Z",
    });

    config.getAllWorkspaceMetadata = mock(() =>
      Promise.resolve([liveWorkspace, taskWorkspace, archivedWorkspace])
    ) as unknown as Config["getAllWorkspaceMetadata"];

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    const startStartupRecoverySpy = spyOn(startupAccess, "startStartupRecovery").mockImplementation(
      () => undefined
    );

    await workspaceService.initialize();

    expect(startStartupRecoverySpy).toHaveBeenCalledTimes(1);
    expect(startStartupRecoverySpy).toHaveBeenCalledWith("live-ws");
  });

  test("swallows startup metadata lookup failures", async () => {
    config.getAllWorkspaceMetadata = mock(() =>
      Promise.reject(new Error("config unavailable"))
    ) as unknown as Config["getAllWorkspaceMetadata"];

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    const startStartupRecoverySpy = spyOn(startupAccess, "startStartupRecovery");

    await workspaceService.initialize();

    expect(startStartupRecoverySpy).not.toHaveBeenCalled();
  });

  test("disposes transient startup-recovery sessions that go idle", async () => {
    const dispose = mock(() => undefined);
    const fakeSession = {
      runStartupRecovery: mock(() => Promise.resolve()),
      shouldRetainAfterStartupRecovery: mock(() => false),
      scheduleStartupRecovery: mock(() => undefined),
      dispose,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
      createSession: (workspaceId: string) => AgentSession;
      sessions: Map<string, AgentSession>;
    };
    const createSessionSpy = spyOn(startupAccess, "createSession").mockImplementation(
      () => fakeSession
    );

    startupAccess.startStartupRecovery("live-ws");
    await Promise.resolve();
    await Promise.resolve();

    expect(createSessionSpy).toHaveBeenCalledWith("live-ws");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(startupAccess.sessions.has("live-ws")).toBe(false);
  });

  test("retains transient startup-recovery sessions when recovery stays active", async () => {
    const dispose = mock(() => undefined);
    const onChatEvent = mock(() => () => undefined);
    const onMetadataEvent = mock(() => () => undefined);
    const fakeSession = {
      runStartupRecovery: mock(() => Promise.resolve()),
      shouldRetainAfterStartupRecovery: mock(() => true),
      scheduleStartupRecovery: mock(() => undefined),
      onChatEvent,
      onMetadataEvent,
      dispose,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
      createSession: (workspaceId: string) => AgentSession;
      sessions: Map<string, AgentSession>;
    };
    spyOn(startupAccess, "createSession").mockImplementation(() => fakeSession);

    startupAccess.startStartupRecovery("live-ws");
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).not.toHaveBeenCalled();
    expect(startupAccess.sessions.get("live-ws")).toBe(fakeSession);
  });

  test("claims transient startup-recovery sessions instead of creating duplicates", () => {
    const onChatEvent = mock(() => () => undefined);
    const onMetadataEvent = mock(() => () => undefined);
    const fakeSession = {
      onChatEvent,
      onMetadataEvent,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      transientStartupRecoverySessions: Map<string, AgentSession>;
      sessions: Map<string, AgentSession>;
      getOrCreateSession: (workspaceId: string) => AgentSession;
      createSession: (workspaceId: string) => AgentSession;
    };
    startupAccess.transientStartupRecoverySessions.set("live-ws", fakeSession);
    const createSessionSpy = spyOn(startupAccess, "createSession");

    const claimedSession = startupAccess.getOrCreateSession("live-ws");

    expect(claimedSession).toBe(fakeSession);
    expect(startupAccess.transientStartupRecoverySessions.has("live-ws")).toBe(false);
    expect(startupAccess.sessions.get("live-ws")).toBe(fakeSession);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService rename lock", () => {
  let workspaceService: WorkspaceService;
  let mockAIService: AIService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    // Create minimal mocks for the services
    mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false, error: "not found" })),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("sendMessage returns error when workspace is being renamed", async () => {
    const workspaceId = "test-workspace";

    addToRenamingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.sendMessage(workspaceId, "test message", {
      model: "test-model",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      // Error is SendMessageError which has a discriminated union
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("being renamed");
      }
    }
  });

  test("resumeStream returns error when workspace is being renamed", async () => {
    const workspaceId = "test-workspace";

    addToRenamingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.resumeStream(workspaceId, {
      model: "test-model",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      // Error is SendMessageError which has a discriminated union
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("being renamed");
      }
    }
  });

  test("rename returns error when workspace is streaming", async () => {
    const workspaceId = "test-workspace";

    // Mock isStreaming to return true
    (mockAIService.isStreaming as ReturnType<typeof mock>).mockReturnValue(true);

    const result = await workspaceService.rename(workspaceId, "new-name");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("stream is active");
    }
  });
});

describe("WorkspaceService sendMessage status clearing", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let fakeSession: {
    isBusy: ReturnType<typeof mock>;
    queueMessage: ReturnType<typeof mock>;
    sendMessage: ReturnType<typeof mock>;
    resumeStream: ReturnType<typeof mock>;
  };

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => ({
        workspacePath: "/tmp/test/workspace",
        projectPath: "/tmp/test/project",
      })),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    const mockExtensionMetadata: Partial<ExtensionMetadataService> = {
      updateRecency: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
      setStreaming: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
      setAgentStatus: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadata as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    fakeSession = {
      isBusy: mock(() => true),
      queueMessage: mock(() => "tool-end" as const),
      sendMessage: mock(() => Promise.resolve(Ok(undefined))),
      resumeStream: mock(() => Promise.resolve(Ok({ started: true }))),
    };

    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => fakeSession as unknown as AgentSession);

    (
      workspaceService as unknown as {
        maybePersistAISettingsFromOptions: (
          workspaceId: string,
          options: unknown,
          source: "send" | "resume"
        ) => Promise<void>;
      }
    ).maybePersistAISettingsFromOptions = mock(() => Promise.resolve());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("does not clear persisted agent status directly for non-synthetic sends", async () => {
    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(updateAgentStatus).not.toHaveBeenCalled();
  });

  test("does not clear persisted agent status directly for synthetic sends", async () => {
    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "hello",
      {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      },
      {
        synthetic: true,
      }
    );

    expect(result.success).toBe(true);
    expect(updateAgentStatus).not.toHaveBeenCalled();
  });

  test("sendMessage restores interrupted task status before successful send", async () => {
    fakeSession.isBusy.mockReturnValue(false);

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).not.toHaveBeenCalled();
  });

  test("sendMessage restores interrupted status when accepted edit startup fails later", async () => {
    fakeSession.isBusy.mockReturnValue(false);

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const startupFailureHandled = createDeferred<void>();
    fakeSession.sendMessage.mockImplementation(
      (
        _message: string,
        _options: unknown,
        internal?: {
          onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
        }
      ) => {
        void Promise.resolve().then(async () => {
          await internal?.onAcceptedPreStreamFailure?.({
            type: "runtime_start_failed",
            message: "Runtime is starting",
          });
          startupFailureHandled.resolve();
        });
        return Promise.resolve(Ok(undefined));
      }
    );

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
      editMessageId: "user-123",
    });

    expect(result.success).toBe(true);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");

    await startupFailureHandled.promise;
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith("test-workspace");
  });

  test("resumeStream restores interrupted task status before successful resume", async () => {
    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.resumeStream("test-workspace", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).not.toHaveBeenCalled();
  });

  test("resumeStream keeps interrupted task status when no stream starts", async () => {
    fakeSession.resumeStream.mockResolvedValue(Ok({ started: false }));

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.resumeStream("test-workspace", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.started).toBe(false);
    }
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith("test-workspace");
  });

  test("resumeStream does not start interrupted tasks while still busy", async () => {
    const getAgentTaskStatus = mock(() => "interrupted" as const);
    const markInterruptedTaskRunning = mock(() => Promise.resolve(false));
    workspaceService.setTaskService({
      getAgentTaskStatus,
      markInterruptedTaskRunning,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.resumeStream("test-workspace", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success && result.error.type === "unknown") {
      expect(result.error.raw).toContain("Interrupted task is still winding down");
    }
    expect(getAgentTaskStatus).toHaveBeenCalledWith("test-workspace");
    expect(markInterruptedTaskRunning).not.toHaveBeenCalled();
    expect(fakeSession.resumeStream).not.toHaveBeenCalled();
  });

  test("sendMessage does not queue interrupted tasks while still busy", async () => {
    const getAgentTaskStatus = mock(() => "interrupted" as const);
    const markInterruptedTaskRunning = mock(() => Promise.resolve(false));
    workspaceService.setTaskService({
      getAgentTaskStatus,
      markInterruptedTaskRunning,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success && result.error.type === "unknown") {
      expect(result.error.raw).toContain("Interrupted task is still winding down");
    }
    expect(getAgentTaskStatus).toHaveBeenCalledWith("test-workspace");
    expect(markInterruptedTaskRunning).not.toHaveBeenCalled();
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();
  });

  test("backgrounds foreground task waits when queuing a tool-end message", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const backgroundForegroundWaitsForWorkspace = mock(() => 0);
    workspaceService.setTaskService({
      getAgentTaskStatus: mock(() => "running" as const),
      backgroundForegroundWaitsForWorkspace,
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(backgroundForegroundWaitsForWorkspace).toHaveBeenCalledWith("test-workspace");
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("does not background foreground task waits when queuing a turn-end message", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.queueMessage.mockReturnValue("turn-end");

    const backgroundForegroundWaitsForWorkspace = mock(() => 0);
    workspaceService.setTaskService({
      getAgentTaskStatus: mock(() => "running" as const),
      backgroundForegroundWaitsForWorkspace,
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
      queueDispatchMode: "turn-end",
    });

    expect(result.success).toBe(true);
    expect(backgroundForegroundWaitsForWorkspace).not.toHaveBeenCalled();
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("does not background foreground task waits when queueMessage enqueues nothing", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.queueMessage.mockReturnValue(null);

    const backgroundForegroundWaitsForWorkspace = mock(() => 0);
    workspaceService.setTaskService({
      getAgentTaskStatus: mock(() => "running" as const),
      backgroundForegroundWaitsForWorkspace,
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "   ", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(backgroundForegroundWaitsForWorkspace).not.toHaveBeenCalled();
  });

  test("backgrounds foreground task waits when effective queue mode is tool-end despite incoming turn-end", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    // Incoming mode is turn-end but queue's effective mode is tool-end (sticky from prior enqueue)
    fakeSession.queueMessage.mockReturnValue("tool-end");

    const backgroundForegroundWaitsForWorkspace = mock(() => 0);
    workspaceService.setTaskService({
      getAgentTaskStatus: mock(() => "running" as const),
      backgroundForegroundWaitsForWorkspace,
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
      queueDispatchMode: "turn-end",
    });

    expect(result.success).toBe(true);
    expect(backgroundForegroundWaitsForWorkspace).toHaveBeenCalledWith("test-workspace");
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("sendMessage restores interrupted status when resumed send fails", async () => {
    fakeSession.isBusy.mockReturnValue(false);
    fakeSession.sendMessage.mockResolvedValue(
      Err({
        type: "unknown" as const,
        raw: "runtime startup failed after user turn persisted",
      })
    );

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith("test-workspace");
  });

  test("sendMessage restores interrupted status when resumed send throws", async () => {
    fakeSession.isBusy.mockReturnValue(false);
    fakeSession.sendMessage.mockRejectedValue(new Error("send explode"));

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith("test-workspace");
  });

  test("resumeStream restores interrupted status when resumed stream throws", async () => {
    fakeSession.resumeStream.mockRejectedValue(new Error("resume explode"));

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.resumeStream("test-workspace", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith("test-workspace");
  });

  test("does not clear persisted agent status directly when direct send fails after turn acceptance", async () => {
    fakeSession.isBusy.mockReturnValue(false);
    fakeSession.sendMessage.mockResolvedValue(
      Err({
        type: "unknown" as const,
        raw: "runtime startup failed after user turn persisted",
      })
    );

    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(updateAgentStatus).not.toHaveBeenCalled();
  });

  test("does not clear persisted agent status directly when direct send is rejected pre-acceptance", async () => {
    fakeSession.isBusy.mockReturnValue(false);
    fakeSession.sendMessage.mockResolvedValue(
      Err({
        type: "invalid_model_string" as const,
        message: "invalid model",
      })
    );

    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(updateAgentStatus).not.toHaveBeenCalled();
  });

  test("registerSession clears persisted agent status for accepted user chat events", () => {
    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const workspaceId = "listener-workspace";
    const sessionEmitter = new EventEmitter();
    const listenerSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    workspaceService.registerSession(workspaceId, listenerSession);

    sessionEmitter.emit("chat-event", {
      workspaceId,
      message: {
        type: "message",
        ...createMuxMessage("user-accepted", "user", "hello"),
      },
    });

    expect(updateAgentStatus).toHaveBeenCalledWith(workspaceId, null);
  });

  test("registerSession does not clear persisted agent status for synthetic user chat events", () => {
    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const workspaceId = "synthetic-listener-workspace";
    const sessionEmitter = new EventEmitter();
    const listenerSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    workspaceService.registerSession(workspaceId, listenerSession);

    sessionEmitter.emit("chat-event", {
      workspaceId,
      message: {
        type: "message",
        ...createMuxMessage("user-synthetic", "user", "hello", { synthetic: true }),
      },
    });

    expect(updateAgentStatus).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService pending auto-title", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let config: Config;
  let tempDir: string;
  let workspaceId: string;
  let projectPath: string;
  let workspacePath: string;
  let fakeSession: {
    isBusy: ReturnType<typeof mock>;
    queueMessage: ReturnType<typeof mock>;
    sendMessage: ReturnType<typeof mock>;
    resumeStream: ReturnType<typeof mock>;
  };

  beforeEach(async () => {
    ({
      config,
      tempDir,
      historyService,
      cleanup: cleanupHistory,
    } = await createTestHistoryService());

    workspaceId = "pending-auto-title-workspace";
    projectPath = path.join(tempDir, "project");
    workspacePath = path.join(projectPath, "fork-branch");
    await fsPromises.mkdir(projectPath, { recursive: true });
    await config.addWorkspace(projectPath, {
      id: workspaceId,
      name: "fork-branch",
      title: "Parent title (1)",
      pendingAutoTitle: true,
      projectName: "project",
      projectPath,
      createdAt: new Date().toISOString(),
      runtimeConfig: { type: "local" },
      namedWorkspacePath: workspacePath,
    });

    const metadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "fork-branch",
      title: "Parent title (1)",
      pendingAutoTitle: true,
      projectName: "project",
      projectPath,
      createdAt: new Date().toISOString(),
      runtimeConfig: { type: "local" },
      namedWorkspacePath: workspacePath,
    };
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(metadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockExtensionMetadata: Partial<ExtensionMetadataService> = {
      updateRecency: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
      setStreaming: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
    };

    workspaceService = new WorkspaceService(
      config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadata as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    fakeSession = {
      isBusy: mock(() => false),
      queueMessage: mock(() => "tool-end" as const),
      sendMessage: mock(() => Promise.resolve(Ok(undefined))),
      resumeStream: mock(() => Promise.resolve(Ok({ started: true }))),
    };

    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => fakeSession as unknown as AgentSession);

    (
      workspaceService as unknown as {
        maybePersistAISettingsFromOptions: (
          workspaceId: string,
          options: unknown,
          source: "send" | "resume"
        ) => Promise<void>;
      }
    ).maybePersistAISettingsFromOptions = mock(() => Promise.resolve());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("sendMessage triggers fork auto-title after the first accepted continue message", async () => {
    const autoTitleSpy = spyOn(
      workspaceService as unknown as {
        maybeRunPendingAutoTitleFromMessage: (
          workspaceId: string,
          message: string
        ) => Promise<void>;
      },
      "maybeRunPendingAutoTitleFromMessage"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.sendMessage(workspaceId, "Continue with auth hardening", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(autoTitleSpy).toHaveBeenCalledWith(workspaceId, "Continue with auth hardening");
  });

  test("concurrent sends only claim one pending auto-title generation", async () => {
    const releaseSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementation(() => releaseSend.promise);
    const autoTitleSpy = spyOn(
      workspaceService as unknown as {
        maybeRunPendingAutoTitleFromMessage: (
          workspaceId: string,
          message: string
        ) => Promise<void>;
      },
      "maybeRunPendingAutoTitleFromMessage"
    ).mockResolvedValue(undefined);

    try {
      const firstSend = workspaceService.sendMessage(workspaceId, "First continue message", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });
      const secondSend = workspaceService.sendMessage(workspaceId, "Second continue message", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });

      releaseSend.resolve(Ok(undefined));
      const [firstResult, secondResult] = await Promise.all([firstSend, secondSend]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(autoTitleSpy).toHaveBeenCalledTimes(1);
      expect(autoTitleSpy).toHaveBeenCalledWith(workspaceId, "First continue message");
    } finally {
      autoTitleSpy.mockRestore();
    }
  });

  test("sendMessage only launches one pending auto-title generation at a time", async () => {
    const generationStarted = createDeferred<void>();
    const releaseGeneration = createDeferred<void>();
    const autoTitleSpy = spyOn(
      workspaceService as unknown as {
        maybeRunPendingAutoTitleFromMessage: (
          workspaceId: string,
          message: string
        ) => Promise<void>;
      },
      "maybeRunPendingAutoTitleFromMessage"
    ).mockImplementation(async () => {
      generationStarted.resolve();
      await releaseGeneration.promise;
    });

    try {
      const firstResult = await workspaceService.sendMessage(
        workspaceId,
        "First continue message",
        {
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        }
      );
      expect(firstResult.success).toBe(true);
      await generationStarted.promise;

      const secondResult = await workspaceService.sendMessage(
        workspaceId,
        "Second continue message",
        {
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        }
      );
      expect(secondResult.success).toBe(true);
      expect(autoTitleSpy).toHaveBeenCalledTimes(1);

      releaseGeneration.resolve();
      await Promise.resolve();
    } finally {
      autoTitleSpy.mockRestore();
    }
  });

  test("completing a pending auto-title replaces the fallback title and clears the state", async () => {
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "auth-hardening-a1b2",
        title: "Harden auth flow",
        modelUsed: "openai:gpt-4o-mini",
      })
    );

    try {
      await (
        workspaceService as unknown as {
          maybeRunPendingAutoTitleFromMessage: (
            workspaceId: string,
            message: string
          ) => Promise<void>;
        }
      ).maybeRunPendingAutoTitleFromMessage(workspaceId, "Continue with auth hardening");

      const metadata = (await config.getAllWorkspaceMetadata()).find(
        (entry) => entry.id === workspaceId
      );
      expect(metadata?.title).toBe("Harden auth flow");
      expect(metadata?.pendingAutoTitle).toBeUndefined();
      expect(generateIdentitySpy.mock.calls[0]?.[0]).toBe("Continue with auth hardening");
    } finally {
      generateIdentitySpy.mockRestore();
    }
  });

  test("manual title edits cancel an in-flight auto-title before it can overwrite the title", async () => {
    const generationStarted = createDeferred<void>();
    const autoTitleResult =
      createDeferred<
        Awaited<ReturnType<typeof workspaceTitleGenerator.generateWorkspaceIdentity>>
      >();
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockImplementation((_message, _candidates, _aiService) => {
      generationStarted.resolve();
      return autoTitleResult.promise;
    });

    try {
      const autoTitlePromise = (
        workspaceService as unknown as {
          maybeRunPendingAutoTitleFromMessage: (
            workspaceId: string,
            message: string
          ) => Promise<void>;
        }
      ).maybeRunPendingAutoTitleFromMessage(workspaceId, "Continue with auth hardening");

      await generationStarted.promise;

      const updateTitleResult = await workspaceService.updateTitle(workspaceId, "Manual title");
      expect(updateTitleResult.success).toBe(true);

      autoTitleResult.resolve(
        Ok({
          name: "auth-hardening-a1b2",
          title: "Harden auth flow",
          modelUsed: "openai:gpt-4o-mini",
        })
      );
      await autoTitlePromise;

      const metadata = (await config.getAllWorkspaceMetadata()).find(
        (entry) => entry.id === workspaceId
      );
      expect(metadata?.title).toBe("Manual title");
      expect(metadata?.pendingAutoTitle).toBeUndefined();
    } finally {
      generateIdentitySpy.mockRestore();
    }
  });
});

describe("WorkspaceService idle compaction dispatch", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("marks idle compaction send as synthetic when stream stays active", async () => {
    const workspaceId = "idle-ws";
    const sendMessage = mock(() => Promise.resolve(Ok(undefined)));
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:gpt-4o", agentId: "compact" })
    );

    let busyChecks = 0;
    const session = {
      isBusy: mock(() => {
        busyChecks += 1;
        return busyChecks >= 2;
      }),
    } as unknown as AgentSession;

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = (_workspaceId: string) => session;

    await workspaceService.executeIdleCompaction(workspaceId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      workspaceId,
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        skipAutoResumeReset: true,
        synthetic: true,
        requireIdle: true,
      })
    );

    const idleCompactingWorkspaces = (
      workspaceService as unknown as { idleCompactingWorkspaces: Set<string> }
    ).idleCompactingWorkspaces;
    expect(idleCompactingWorkspaces.has(workspaceId)).toBe(true);
  });

  test("does not mark idle compaction when send succeeds without active stream", async () => {
    const workspaceId = "idle-no-stream-ws";
    const sendMessage = mock(() => Promise.resolve(Ok(undefined)));
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:gpt-4o", agentId: "compact" })
    );

    const session = {
      isBusy: mock(() => false),
    } as unknown as AgentSession;

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = (_workspaceId: string) => session;

    await workspaceService.executeIdleCompaction(workspaceId);

    const idleCompactingWorkspaces = (
      workspaceService as unknown as { idleCompactingWorkspaces: Set<string> }
    ).idleCompactingWorkspaces;
    expect(idleCompactingWorkspaces.has(workspaceId)).toBe(false);
  });

  test("propagates busy-skip errors", async () => {
    const workspaceId = "idle-busy-ws";
    const sendMessage = mock(() =>
      Promise.resolve(
        Err({
          type: "unknown" as const,
          raw: "Workspace is busy; idle-only send was skipped.",
        })
      )
    );
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:gpt-4o", agentId: "compact" })
    );

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;

    let executionError: unknown;
    try {
      await workspaceService.executeIdleCompaction(workspaceId);
    } catch (error) {
      executionError = error;
    }

    expect(executionError).toBeInstanceOf(Error);
    if (!(executionError instanceof Error)) {
      throw new Error("Expected idle compaction to throw when workspace is busy");
    }
    expect(executionError.message).toContain("idle-only send was skipped");
  });
  test("prefers global compact thinking default over exec and activity fallbacks", async () => {
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/project/ws";

    type ThinkingLevel = Parameters<typeof enforceThinkingPolicy>[1];

    interface WorkspaceServiceIdleCompactionAccess {
      buildIdleCompactionSendOptions: (workspaceId: string) => Promise<{
        model: string;
        thinkingLevel: ThinkingLevel;
      }>;
      config: {
        findWorkspace: (
          workspaceId: string
        ) => { projectPath: string; workspacePath: string } | null;
        loadConfigOrDefault: () => {
          projects: Map<string, { workspaces: Array<Record<string, unknown>> }>;
          agentAiDefaults?: {
            compact?: {
              thinkingLevel?: ThinkingLevel;
            };
          };
        };
      };
      extensionMetadata: ExtensionMetadataService;
    }

    const svc = workspaceService as unknown as WorkspaceServiceIdleCompactionAccess;

    svc.config.findWorkspace = mock((workspaceId: string) =>
      workspaceId === "ws" ? { projectPath, workspacePath } : null
    );
    svc.config.loadConfigOrDefault = mock(() => ({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: "ws",
                path: workspacePath,
                name: "ws",
                aiSettingsByAgent: {
                  exec: { model: "openai:gpt-4o-mini", thinkingLevel: "low" },
                },
              },
            ],
          },
        ],
      ]),
      agentAiDefaults: {
        compact: { thinkingLevel: "high" as ThinkingLevel },
      },
    }));

    svc.extensionMetadata = {
      getSnapshot: mock(() => Promise.resolve({ lastThinkingLevel: "off" })),
    } as unknown as ExtensionMetadataService;

    const options = await svc.buildIdleCompactionSendOptions("ws");

    expect(options.thinkingLevel).toBe(enforceThinkingPolicy(options.model, "high"));
  });

  test("does not tag streaming=true snapshots as idle compaction", async () => {
    const workspaceId = "idle-streaming-true-no-tag";
    const snapshot = {
      recency: Date.now(),
      streaming: true,
      lastModel: "claude-sonnet-4",
      lastThinkingLevel: null,
    };

    const setStreaming = mock(() => Promise.resolve(snapshot));
    const emitWorkspaceActivity = mock(
      (_workspaceId: string, _snapshot: typeof snapshot) => undefined
    );

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).emitWorkspaceActivity = emitWorkspaceActivity;

    const internals = workspaceService as unknown as {
      idleCompactingWorkspaces: Set<string>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.updateStreamingStatus(workspaceId, true);

    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, {});
    expect(emitWorkspaceActivity).toHaveBeenCalledTimes(1);
    expect(emitWorkspaceActivity).toHaveBeenCalledWith(workspaceId, snapshot);
    expect(internals.idleCompactingWorkspaces.has(workspaceId)).toBe(true);
  });

  test("passes through stream-start thinkingLevel without re-deriving it from config", async () => {
    const workspaceId = "streaming-thinking-level";
    const snapshot = {
      recency: Date.now(),
      streaming: true,
      lastModel: "claude-sonnet-4",
      lastThinkingLevel: "high" as const,
    };

    const setStreaming = mock(() => Promise.resolve(snapshot));
    const emitWorkspaceActivity = mock(
      (_workspaceId: string, _snapshot: typeof snapshot) => undefined
    );

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).emitWorkspaceActivity = emitWorkspaceActivity;

    const internals = workspaceService as unknown as {
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    await internals.updateStreamingStatus(workspaceId, true, {
      model: "claude-sonnet-4",
      thinkingLevel: "high",
    });

    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, {
      model: "claude-sonnet-4",
      thinkingLevel: "high",
    });
    expect(emitWorkspaceActivity).toHaveBeenCalledWith(workspaceId, snapshot);
  });

  test("clears idle marker when streaming=false metadata update fails", async () => {
    const workspaceId = "idle-streaming-false-failure";

    const setStreaming = mock(() => Promise.reject(new Error("setStreaming failed")));
    const extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
      }
    ).extensionMetadata = extensionMetadata;

    const internals = workspaceService as unknown as {
      idleCompactingWorkspaces: Set<string>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.updateStreamingStatus(workspaceId, false);

    expect(internals.idleCompactingWorkspaces.has(workspaceId)).toBe(false);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, {
      hasTodos: false,
      todoStatus: null,
    });
  });
});

describe("WorkspaceService streaming generation guard", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let readTodosSpy:
    | ReturnType<typeof spyOn<typeof todoStorageModule, "readTodosForSessionDir">>
    | undefined;

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock((workspaceId: string) => `/tmp/test/sessions/${workspaceId}`),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    readTodosSpy?.mockRestore();
    await cleanupHistory();
  });

  test("stop-side metadata write is skipped when a newer stream has started", async () => {
    const workspaceId = "ws-generation-guard";
    const todoReadDeferred =
      createDeferred<Awaited<ReturnType<typeof todoStorageModule.readTodosForSessionDir>>>();
    let todoReadCalls = 0;
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockImplementation(() => {
      todoReadCalls += 1;
      if (todoReadCalls === 1) {
        return todoReadDeferred.promise;
      }
      return Promise.resolve([]);
    });

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
      }
    ).extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;

    const internals = workspaceService as unknown as {
      streamingGenerations: Map<string, number>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.streamingGenerations.set(workspaceId, 1);
    const staleStopPromise = internals.updateStreamingStatus(workspaceId, false, {
      generation: 1,
    });

    internals.streamingGenerations.set(workspaceId, 2);
    await internals.updateStreamingStatus(workspaceId, true, { model: "openai:gpt-4o" });

    todoReadDeferred.resolve([]);
    await staleStopPromise;

    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, { model: "openai:gpt-4o" });
  });

  test("todo snapshot refreshes run in call order for consecutive updates", async () => {
    const workspaceId = "ws-todo-refresh-order";
    const firstWriteDeferred = createDeferred<WorkspaceActivitySnapshot>();
    const setTodoStatus = mock(
      (
        _workspaceId: string,
        todoStatus: { emoji: string; message: string } | null,
        hasTodos: boolean
      ) => {
        if (todoStatus?.message === "First task") {
          return firstWriteDeferred.promise;
        }
        return Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          todoStatus,
          hasTodos,
        });
      }
    );

    let readCount = 0;
    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockImplementation(() => {
      readCount += 1;
      if (readCount === 1) {
        return Promise.resolve([{ content: "First task", status: "in_progress" }]);
      }
      return Promise.resolve([{ content: "Second task", status: "in_progress" }]);
    });

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
      }
    ).extensionMetadata = {
      setTodoStatus,
    } as unknown as ExtensionMetadataService;

    const internals = workspaceService as unknown as {
      updateTodoStatusFromStorage: (workspaceId: string) => Promise<void>;
    };

    const firstRefresh = internals.updateTodoStatusFromStorage(workspaceId);
    const secondRefresh = internals.updateTodoStatusFromStorage(workspaceId);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setTodoStatus).toHaveBeenCalledTimes(1);
    expect(readCount).toBe(1);

    firstWriteDeferred.resolve({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      todoStatus: { emoji: "🔄", message: "First task" },
      hasTodos: true,
    });

    await Promise.all([firstRefresh, secondRefresh]);

    expect(setTodoStatus).toHaveBeenCalledTimes(2);
    expect(setTodoStatus.mock.calls[0]).toEqual([
      workspaceId,
      { emoji: "🔄", message: "First task" },
      true,
    ]);
    expect(setTodoStatus.mock.calls[1]).toEqual([
      workspaceId,
      { emoji: "🔄", message: "Second task" },
      true,
    ]);
  });

  test("handleStreamCompletion captures generation before awaiting recency updates", async () => {
    const workspaceId = "ws-stream-completion-generation";
    const recencyDeferred = createDeferred<void>();
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);

    const internals = workspaceService as unknown as {
      extensionMetadata: ExtensionMetadataService;
      streamingGenerations: Map<string, number>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
      updateRecencyTimestamp: (workspaceId: string, timestamp?: number) => Promise<void>;
      handleStreamCompletion: (workspaceId: string) => Promise<void>;
    };

    internals.extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    internals.updateRecencyTimestamp = mock(() => recencyDeferred.promise);

    internals.streamingGenerations.set(workspaceId, 1);
    const completionPromise = internals.handleStreamCompletion(workspaceId);

    internals.streamingGenerations.set(workspaceId, 2);
    await internals.updateStreamingStatus(workspaceId, true, { model: "openai:gpt-4o-mini" });

    recencyDeferred.resolve();
    await completionPromise;

    expect(internals.updateRecencyTimestamp).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, { model: "openai:gpt-4o-mini" });
  });
  test("handleStreamCompletion skips recency updates for idle compaction", async () => {
    const workspaceId = "ws-idle-stream-completion";
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);

    const internals = workspaceService as unknown as {
      extensionMetadata: ExtensionMetadataService;
      streamingGenerations: Map<string, number>;
      idleCompactingWorkspaces: Set<string>;
      updateRecencyTimestamp: (workspaceId: string, timestamp?: number) => Promise<void>;
      handleStreamCompletion: (workspaceId: string) => Promise<void>;
    };

    internals.extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    internals.updateRecencyTimestamp = mock(() => Promise.resolve());

    internals.streamingGenerations.set(workspaceId, 7);
    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.handleStreamCompletion(workspaceId);

    expect(internals.updateRecencyTimestamp).not.toHaveBeenCalled();
    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(
      workspaceId,
      false,
      expect.objectContaining({ generation: 7, hasTodos: false })
    );
  });
});

describe("WorkspaceService executeBash archive guards", () => {
  let workspaceService: WorkspaceService;
  let waitForInitMock: ReturnType<typeof mock>;
  let getWorkspaceMetadataMock: ReturnType<typeof mock>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    waitForInitMock = mock(() => Promise.resolve());

    getWorkspaceMetadataMock = mock(() =>
      Promise.resolve({ success: false as const, error: "not found" })
    );

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
      getProjectSecrets: mock(() => []),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      waitForInit: waitForInitMock,
    };

    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("archived workspace => executeBash returns error mentioning archived", async () => {
    const workspaceId = "ws-archived";

    const archivedMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      archivedAt: "2026-01-01T00:00:00.000Z",
    };

    getWorkspaceMetadataMock.mockReturnValue(Promise.resolve(Ok(archivedMetadata)));

    const result = await workspaceService.executeBash(workspaceId, "echo hello");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("archived");
    }

    // This must happen before init/runtime operations.
    expect(waitForInitMock).toHaveBeenCalledTimes(0);
  });

  test("archiving workspace => executeBash returns error mentioning being archived", async () => {
    const workspaceId = "ws-archiving";

    addToArchivingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.executeBash(workspaceId, "echo hello");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }

    expect(waitForInitMock).toHaveBeenCalledTimes(0);
    expect(getWorkspaceMetadataMock).toHaveBeenCalledTimes(0);
  });
});

describe("WorkspaceService executeBash workspace path resolution", () => {
  let workspaceService: WorkspaceService;
  let waitForInitMock: ReturnType<typeof mock>;
  let getWorkspaceMetadataMock: ReturnType<typeof mock>;
  let findWorkspaceMock: ReturnType<typeof mock>;
  let getEffectiveSecretsMock: ReturnType<typeof mock>;
  let createRuntimeSpy: Mock<typeof runtimeFactory.createRuntime>;
  let createBashToolSpy: Mock<typeof bashToolModule.createBashTool>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    waitForInitMock = mock(() => Promise.resolve());
    findWorkspaceMock = mock(() => ({
      workspacePath: "/persisted/workspace-root",
      projectPath: "/tmp/proj",
      workspaceName: "ws",
    }));
    getEffectiveSecretsMock = mock(() => []);
    getWorkspaceMetadataMock = mock(() =>
      Promise.resolve(
        Ok({
          id: "ws-path",
          name: "ws",
          projectName: "proj",
          projectPath: "/tmp/proj",
          runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/runtime-src" },
        } satisfies WorkspaceMetadata)
      )
    );

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: findWorkspaceMock,
      getEffectiveSecrets: getEffectiveSecretsMock,
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      waitForInit: waitForInitMock,
    };
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      ensureReady: mock(() => Promise.resolve({ ready: true })),
      getWorkspacePath: mock(() => "/runtime/workspace-root"),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    createBashToolSpy = spyOn(bashToolModule, "createBashTool").mockReturnValue({
      execute: mock(() =>
        Promise.resolve({
          success: true,
          output: "ok",
          exitCode: 0,
          wall_duration_ms: 1,
        } satisfies BashToolResult)
      ),
    } as unknown as ReturnType<typeof bashToolModule.createBashTool>);
  });

  afterEach(async () => {
    createRuntimeSpy.mockRestore();
    createBashToolSpy.mockRestore();
    await cleanupHistory();
  });

  test("uses persisted workspace root for path-addressable runtimes", async () => {
    const result = await workspaceService.executeBash("ws-path", "pwd");

    expect(result.success).toBe(true);
    expect(createRuntimeSpy).toHaveBeenCalled();
    expect(createBashToolSpy).toHaveBeenCalledTimes(1);
    expect(createBashToolSpy.mock.calls[0]?.[0]?.cwd).toBe("/persisted/workspace-root");
    expect(waitForInitMock).toHaveBeenCalledWith("ws-path");
  });

  test("keeps docker executeBash rooted in the translated runtime path", async () => {
    getWorkspaceMetadataMock.mockReturnValue(
      Promise.resolve(
        Ok({
          id: "ws-path",
          name: "ws",
          projectName: "proj",
          projectPath: "/tmp/proj",
          runtimeConfig: { type: "docker", image: "node:20" },
        } satisfies WorkspaceMetadata)
      )
    );

    const result = await workspaceService.executeBash("ws-path", "pwd");

    expect(result.success).toBe(true);
    expect(createBashToolSpy).toHaveBeenCalledTimes(1);
    expect(createBashToolSpy.mock.calls[0]?.[0]?.cwd).toBe("/runtime/workspace-root");
  });
});

describe("WorkspaceService getFileCompletions", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let createRuntimeSpy: Mock<typeof runtimeFactory.createRuntime>;
  let execBufferedSpy: Mock<typeof runtimeExecHelpers.execBuffered>;

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
      (_runtimeConfig, options) => {
        if (!options?.projectPath) {
          throw new Error("Expected createRuntime projectPath in getFileCompletions test");
        }
        const runtimeProjectPath = options.projectPath;

        return {
          getWorkspacePath: (_projectPath: string, workspaceName: string) =>
            `/runtime/${path.basename(runtimeProjectPath)}/${workspaceName}`,
        } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
      }
    );

    execBufferedSpy = spyOn(runtimeExecHelpers, "execBuffered").mockImplementation(
      (_runtime, _command, options) =>
        Promise.reject(new Error(`Unexpected execBuffered call for ${options.cwd}`))
    );
  });

  afterEach(async () => {
    createRuntimeSpy.mockRestore();
    execBufferedSpy.mockRestore();
    await cleanupHistory();
  });

  test("keeps single-project completions unchanged", async () => {
    interface WorkspaceServiceTestAccess {
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.getInfo = mock(() =>
      Promise.resolve({
        id: "ws-single",
        name: "ws",
        projectName: "project-a",
        projectPath: "/tmp/project-a",
        namedWorkspacePath: "/persisted/project-a/ws",
        runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
      } satisfies FrontendWorkspaceMetadata)
    );

    execBufferedSpy.mockResolvedValue({
      stdout: "src/single.ts\n",
      stderr: "",
      exitCode: 0,
      duration: 1,
    });

    const result = await workspaceService.getFileCompletions("ws-single", "src/");

    expect(result.paths).toEqual(["src/single.ts"]);
    expect(execBufferedSpy).toHaveBeenCalledTimes(1);
    expect(execBufferedSpy.mock.calls[0]?.[2].cwd).toBe("/persisted/project-a/ws");
  });

  test("aggregates multi-project completions using project-prefixed paths", async () => {
    interface WorkspaceServiceTestAccess {
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.getInfo = mock(() =>
      Promise.resolve({
        id: "ws-multi",
        name: "ws",
        projectName: "project-a",
        projectPath: "/tmp/project-a",
        namedWorkspacePath: "/persisted/container/ws",
        runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
        projects: [
          { projectPath: "/tmp/project-a", projectName: "project-a" },
          { projectPath: "/tmp/project-b", projectName: "project-b" },
        ],
      } satisfies FrontendWorkspaceMetadata)
    );

    execBufferedSpy.mockImplementation((_runtime, _command, options) => {
      if (options.cwd === "/runtime/project-a/ws") {
        return Promise.resolve({
          stdout: "README.md\nsrc/a.ts\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }

      if (options.cwd === "/runtime/project-b/ws") {
        return Promise.resolve({
          stdout: "src/b.ts\nnested/keep.ts\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }

      return Promise.reject(new Error(`Unexpected cwd ${options.cwd}`));
    });

    const result = await workspaceService.getFileCompletions("ws-multi", "", 10);

    expect(result.paths).toContain("project-a/README.md");
    expect(result.paths).toContain("project-a/src/a.ts");
    expect(result.paths).toContain("project-b/src/b.ts");
    expect(result.paths).toContain("project-b/nested/keep.ts");
    expect(result.paths).not.toContain("src/a.ts");
    expect(result.paths).toHaveLength(4);

    const completionCwds = execBufferedSpy.mock.calls
      .map((call) => call[2].cwd)
      .sort((left, right) => left.localeCompare(right));
    expect(completionCwds).toEqual(["/runtime/project-a/ws", "/runtime/project-b/ws"]);
  });
});

describe("WorkspaceService getProjectGitStatuses", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  function createGitStatusOutput(params?: {
    headBranch?: string;
    primaryBranch?: string;
    ahead?: number;
    behind?: number;
    dirtyCount?: number;
    outgoingAdditions?: number;
    outgoingDeletions?: number;
    incomingAdditions?: number;
    incomingDeletions?: number;
  }): string {
    return [
      "---HEAD_BRANCH---",
      params?.headBranch ?? "feature/test",
      "---PRIMARY---",
      params?.primaryBranch ?? "main",
      "---AHEAD_BEHIND---",
      `${params?.ahead ?? 1} ${params?.behind ?? 0}`,
      "---DIRTY---",
      String(params?.dirtyCount ?? 0),
      "---LINE_DELTA---",
      `${params?.outgoingAdditions ?? 5} ${params?.outgoingDeletions ?? 2} ${params?.incomingAdditions ?? 3} ${params?.incomingDeletions ?? 1}`,
      "",
    ].join("\n");
  }

  function bashOk(output: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: 0,
      },
    };
  }

  function createServiceHarness(params: {
    metadata: WorkspaceMetadata;
    executeBashImpl: (
      workspaceId: string,
      script: string,
      options?: {
        timeout_secs?: number | null;
        cwdMode?: "default" | "repo-root" | null;
        repoRootProjectPath?: string | null;
      }
    ) => Promise<Result<BashToolResult>>;
  }): {
    workspaceService: WorkspaceService;
    executeBashMock: ReturnType<typeof mock>;
    getWorkspaceMetadataMock: ReturnType<typeof mock>;
  } {
    const getWorkspaceMetadataMock = mock(() => Promise.resolve(Ok(params.metadata)));
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const executeBashMock = mock(params.executeBashImpl);

    interface WorkspaceServiceTestAccess {
      executeBash: typeof executeBashMock;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.executeBash = executeBashMock;

    return { workspaceService, executeBashMock, getWorkspaceMetadataMock };
  }

  test("returns a single entry for single-project workspaces", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-single",
      name: "ws-single",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
    };

    const { workspaceService, executeBashMock, getWorkspaceMetadataMock } = createServiceHarness({
      metadata,
      executeBashImpl: () => Promise.resolve(bashOk(createGitStatusOutput({ dirtyCount: 2 }))),
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: {
          branch: "feature/test",
          ahead: 1,
          behind: 0,
          dirty: true,
          outgoingAdditions: 5,
          outgoingDeletions: 2,
          incomingAdditions: 3,
          incomingDeletions: 1,
        },
        error: null,
      },
    ]);
    expect(getWorkspaceMetadataMock).toHaveBeenCalledWith(metadata.id);
    expect(executeBashMock).toHaveBeenCalledTimes(1);
    expect(executeBashMock).toHaveBeenNthCalledWith(
      1,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH=''"),
      expect.objectContaining({
        cwdMode: "repo-root",
        repoRootProjectPath: "/tmp/project-a",
        timeout_secs: 5,
      })
    );
    expect(executeBashMock.mock.calls.some(([, script]) => script === "git fetch --quiet")).toBe(
      false
    );
  });

  test("returns one entry per project in stable order for multi-project workspaces", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-multi",
      name: "ws-multi",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
    };

    const { workspaceService, executeBashMock } = createServiceHarness({
      metadata,
      executeBashImpl: (_workspaceId, _script, options) => {
        const repoRootProjectPath = options?.repoRootProjectPath;
        if (repoRootProjectPath === "/tmp/project-a") {
          return Promise.resolve(
            bashOk(createGitStatusOutput({ headBranch: "feature/a", ahead: 2 }))
          );
        }
        if (repoRootProjectPath === "/tmp/project-b") {
          return Promise.resolve(
            bashOk(createGitStatusOutput({ headBranch: "feature/b", behind: 3 }))
          );
        }
        throw new Error(`Unexpected repoRootProjectPath: ${String(repoRootProjectPath)}`);
      },
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id, "origin/release");

    expect(result.map((entry) => entry.projectName)).toEqual(["project-a", "project-b"]);
    expect(result[0]?.gitStatus?.branch).toBe("feature/a");
    expect(result[0]?.gitStatus?.ahead).toBe(2);
    expect(result[1]?.gitStatus?.branch).toBe("feature/b");
    expect(result[1]?.gitStatus?.behind).toBe(3);
    expect(executeBashMock).toHaveBeenCalledTimes(2);
    expect(executeBashMock).toHaveBeenNthCalledWith(
      1,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH='release'"),
      expect.objectContaining({ repoRootProjectPath: "/tmp/project-a", timeout_secs: 5 })
    );
    expect(executeBashMock).toHaveBeenNthCalledWith(
      2,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH='release'"),
      expect.objectContaining({ repoRootProjectPath: "/tmp/project-b", timeout_secs: 5 })
    );
    expect(executeBashMock.mock.calls.some(([, script]) => script === "git fetch --quiet")).toBe(
      false
    );
  });

  test("continues when one project bash execution fails", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-multi-failure",
      name: "ws-multi-failure",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
    };

    const { workspaceService } = createServiceHarness({
      metadata,
      executeBashImpl: (_workspaceId, _script, options) => {
        if (options?.repoRootProjectPath === "/tmp/project-a") {
          return Promise.resolve(bashOk(createGitStatusOutput()));
        }
        return Promise.resolve(Err("git failed for project-b"));
      },
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: {
          branch: "feature/test",
          ahead: 1,
          behind: 0,
          dirty: false,
          outgoingAdditions: 5,
          outgoingDeletions: 2,
          incomingAdditions: 3,
          incomingDeletions: 1,
        },
        error: null,
      },
      {
        projectPath: "/tmp/project-b",
        projectName: "project-b",
        gitStatus: null,
        error: "git failed for project-b",
      },
    ]);
  });

  test("returns gitStatus null with an error when output cannot be parsed", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-unparsable",
      name: "ws-unparsable",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
    };

    const { workspaceService } = createServiceHarness({
      metadata,
      executeBashImpl: () => Promise.resolve(bashOk("definitely not git status output")),
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: null,
        error: "Failed to parse git status script output",
      },
    ]);
  });
});

describe("WorkspaceService post-compaction metadata refresh", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("returns expanded plan path for local runtimes", async () => {
    await withTempMuxRoot(async (muxRoot) => {
      const workspaceId = "ws-plan-path";
      const workspaceName = "plan-workspace";
      const projectName = "cmux";
      const planFile = await writePlanFile(muxRoot, projectName, workspaceName);

      interface WorkspaceServiceTestAccess {
        getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
      }

      const fakeMetadata: FrontendWorkspaceMetadata = {
        id: workspaceId,
        name: workspaceName,
        projectName,
        projectPath: "/tmp/proj",
        namedWorkspacePath: "/tmp/proj/plan-workspace",
        runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      };

      const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
      svc.getInfo = mock(() => Promise.resolve(fakeMetadata));

      const result = await workspaceService.getPostCompactionState(workspaceId);

      expect(result.planPath).toBe(planFile);
      expect(result.planPath?.startsWith("~")).toBe(false);
    });
  });

  test("debounces multiple refresh requests into a single metadata emit", async () => {
    const workspaceId = "ws-post-compaction";

    const emitMetadata = mock(() => undefined);

    interface WorkspaceServiceTestAccess {
      sessions: Map<string, { emitMetadata: (metadata: unknown) => void }>;
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
      getPostCompactionState: (workspaceId: string) => Promise<{
        planPath: string | null;
        trackedFilePaths: string[];
        excludedItems: string[];
      }>;
      schedulePostCompactionMetadataRefresh: (workspaceId: string) => void;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.sessions.set(workspaceId, { emitMetadata });

    const fakeMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      namedWorkspacePath: "/tmp/proj/ws",
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    };

    const getInfoMock: WorkspaceServiceTestAccess["getInfo"] = mock(() =>
      Promise.resolve(fakeMetadata)
    );

    const postCompactionState = {
      planPath: "~/.mux/plans/cmux/plan.md",
      trackedFilePaths: ["/tmp/proj/file.ts"],
      excludedItems: [],
    };

    const getPostCompactionStateMock: WorkspaceServiceTestAccess["getPostCompactionState"] = mock(
      () => Promise.resolve(postCompactionState)
    );

    svc.getInfo = getInfoMock;
    svc.getPostCompactionState = getPostCompactionStateMock;

    svc.schedulePostCompactionMetadataRefresh(workspaceId);
    svc.schedulePostCompactionMetadataRefresh(workspaceId);
    svc.schedulePostCompactionMetadataRefresh(workspaceId);

    // Debounce is short, but use a safe buffer.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(getInfoMock).toHaveBeenCalledTimes(1);
    expect(getPostCompactionStateMock).toHaveBeenCalledTimes(1);
    expect(emitMetadata).toHaveBeenCalledTimes(1);

    const enriched = (emitMetadata as ReturnType<typeof mock>).mock.calls[0][0] as {
      postCompaction?: { planPath: string | null };
    };
    expect(enriched.postCompaction?.planPath).toBe(postCompactionState.planPath);
  });
});

describe("WorkspaceService maybePersistAISettingsFromOptions", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "nope" })),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const workspacePath = "/tmp/proj/ws";
    const projectPath = "/tmp/proj";
    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((workspaceId: string) =>
        workspaceId === "ws" ? { projectPath, workspacePath } : null
      ),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [
                {
                  id: "ws",
                  path: workspacePath,
                  name: "ws",
                },
              ],
            },
          ],
        ]),
      })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("persists agent AI settings for custom agent", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (
        workspaceId: string,
        options: unknown,
        context: "send" | "resume"
      ) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    await svc.maybePersistAISettingsFromOptions(
      "ws",
      {
        agentId: "reviewer",
        model: "openai:gpt-4o-mini",
        thinkingLevel: "off",
      },
      "send"
    );

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists agent AI settings when agentId matches", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (
        workspaceId: string,
        options: unknown,
        context: "send" | "resume"
      ) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    await svc.maybePersistAISettingsFromOptions(
      "ws",
      {
        agentId: "exec",
        model: "openai:gpt-4o-mini",
        thinkingLevel: "off",
      },
      "send"
    );

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists AI settings for sub-agent workspaces so auto-resume can use latest model", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (
        workspaceId: string,
        options: unknown,
        context: "send" | "resume"
      ) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
      config: {
        findWorkspace: (
          workspaceId: string
        ) => { projectPath: string; workspacePath: string } | null;
        loadConfigOrDefault: () => {
          projects: Map<string, { workspaces: Array<Record<string, unknown>> }>;
        };
      };
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    const projectPath = "/tmp/proj";
    const workspacePath = "/tmp/proj/ws";
    svc.config.findWorkspace = mock((workspaceId: string) =>
      workspaceId === "ws" ? { projectPath, workspacePath } : null
    );
    svc.config.loadConfigOrDefault = mock(() => ({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: "ws",
                path: workspacePath,
                name: "ws",
                parentWorkspaceId: "parent-ws",
              },
            ],
          },
        ],
      ]),
    }));

    await svc.maybePersistAISettingsFromOptions(
      "ws",
      {
        agentId: "exec",
        model: "openai:gpt-4o-mini",
        thinkingLevel: "off",
      },
      "send"
    );

    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith(
      "ws",
      "exec",
      { model: "openai:gpt-4o-mini", thinkingLevel: "off" },
      { persistSelectedAgentId: true }
    );
  });
});
describe("WorkspaceService remove timing rollup", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("waits for stream-abort before rolling up session timing", async () => {
    const workspaceId = "child-ws";
    const parentWorkspaceId = "parent-ws";

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-remove-"));
    try {
      const sessionRoot = path.join(tempRoot, "sessions");
      await fsPromises.mkdir(path.join(sessionRoot, workspaceId), { recursive: true });

      let abortEmitted = false;
      let rollUpSawAbort = false;

      class FakeAIService extends EventEmitter {
        isStreaming = mock(() => true);

        stopStream = mock(() => {
          setTimeout(() => {
            abortEmitted = true;
            this.emit("stream-abort", {
              type: "stream-abort",
              workspaceId,
              messageId: "msg",
              abortReason: "system",
              metadata: { duration: 123 },
              abandonPartial: true,
            });
          }, 0);

          return Promise.resolve({ success: true as const, data: undefined });
        });

        getWorkspaceMetadata = mock(() =>
          Promise.resolve({
            success: true as const,
            data: {
              id: workspaceId,
              name: "child",
              projectPath: "/tmp/proj",
              runtimeConfig: { type: "local" },
              parentWorkspaceId,
            },
          })
        );
      }

      const aiService = new FakeAIService() as unknown as AIService;
      const mockConfig: Partial<Config> = {
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(sessionRoot, id)),
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => null),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      };

      const timingService: Partial<SessionTimingService> = {
        waitForIdle: mock(() => Promise.resolve()),
        rollUpTimingIntoParent: mock(() => {
          rollUpSawAbort = abortEmitted;
          return Promise.resolve({ didRollUp: true });
        }),
      };

      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        aiService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager,
        undefined, // sessionUsageService
        undefined, // policyService
        undefined, // telemetryService
        undefined, // experimentsService
        timingService as SessionTimingService
      );

      const removeResult = await workspaceService.remove(workspaceId, true);
      expect(removeResult.success).toBe(true);
      expect(mockInitStateManager.clearInMemoryState).toHaveBeenCalledWith(workspaceId);
      expect(rollUpSawAbort).toBe(true);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceService remove desktop session cleanup", () => {
  const workspaceId = "ws-remove-desktop";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;
  let removeWorkspaceMock: ReturnType<typeof mock>;
  let tempRoot: string;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
    tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-remove-desktop-"));
    removeWorkspaceMock = mock(() => Promise.resolve());

    const aiService: AIService = {
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(() => Promise.resolve(Err("not found"))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock((id: string) => path.join(tempRoot, "sessions", id)),
      removeWorkspace: removeWorkspaceMock,
      findWorkspace: mock(() => null),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
    await cleanupHistory();
  });

  test("remove() closes desktop sessions on success", async () => {
    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
  });

  test("remove() continues when desktop session cleanup fails", async () => {
    const close = mock(() => Promise.reject(new Error("close failed")));
    const desktopSessionManager = {
      close,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
    expect(removeWorkspaceMock).toHaveBeenCalledWith(workspaceId);
  });
});

describe("WorkspaceService metadata listeners", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("error events clear streaming metadata", async () => {
    const workspaceId = "ws-error";
    const setStreaming = mock(() =>
      Promise.resolve({
        recency: Date.now(),
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
        agentStatus: null,
      })
    );

    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      );
    }

    const aiService = new FakeAIService() as unknown as AIService;
    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockExtensionMetadata: Partial<ExtensionMetadataService> = { setStreaming };

    new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadata as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    aiService.emit("error", {
      workspaceId,
      messageId: "msg-1",
      error: "rate limited",
      errorType: "rate_limit",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, {
      hasTodos: false,
      todoStatus: null,
      generation: 0,
    });
  });

  test("todo_write events publish todo-derived sidebar status", async () => {
    const workspaceId = "ws-todo-status";
    const setTodoStatus = mock(() =>
      Promise.resolve({
        recency: Date.now(),
        streaming: true,
        lastModel: null,
        lastThinkingLevel: null,
        agentStatus: null,
      })
    );
    const readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([
      { content: "Run typecheck", status: "in_progress" },
      { content: "Add tests", status: "pending" },
    ]);

    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      );
    }

    const aiService = new FakeAIService() as unknown as AIService;
    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockExtensionMetadata: Partial<ExtensionMetadataService> = { setTodoStatus };

    new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadata as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    try {
      aiService.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId,
        messageId: "msg-1",
        toolCallId: "tool-1",
        toolName: "todo_write",
        result: { success: true, count: 2 },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(readTodosSpy).toHaveBeenCalledWith("/tmp/test/sessions");
      expect(setTodoStatus).toHaveBeenCalledWith(
        workspaceId,
        { emoji: "🔄", message: "Run typecheck" },
        true
      );
    } finally {
      readTodosSpy.mockRestore();
    }
  });
});

describe("WorkspaceService archive lifecycle hooks", () => {
  const workspaceId = "ws-archive";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-archive";

  let workspaceService: WorkspaceService;
  let mockAIService: AIService;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-archive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
  };

  beforeEach(async () => {
    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
              },
            ],
          },
        ],
      ]),
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("returns Err and does not persist archivedAt when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("hook failed");
    }

    expect(editConfigSpy).toHaveBeenCalledTimes(0);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();
  });

  test("does not interrupt an active stream when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    (mockAIService.isStreaming as ReturnType<typeof mock>).mockReturnValue(true);

    const interruptStreamSpy = mock(() => Promise.resolve(Ok(undefined)));
    workspaceService.interruptStream =
      interruptStreamSpy as unknown as typeof workspaceService.interruptStream;

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(interruptStreamSpy).toHaveBeenCalledTimes(0);
  });

  test("archive() stays successful when post-persist terminal teardown fails", async () => {
    const closeWorkspaceSessions = mock(() => {
      throw new Error("terminal close failed");
    });
    const terminalService = {
      closeWorkspaceSessions,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
  });

  test("archive() closes workspace terminal sessions on success", async () => {
    const closeWorkspaceSessions = mock(() => undefined);
    const terminalService = {
      closeWorkspaceSessions,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(closeWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(closeWorkspaceSessions).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() does not close terminal sessions when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const closeWorkspaceSessions = mock(() => undefined);
    const terminalService = {
      closeWorkspaceSessions,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(closeWorkspaceSessions).not.toHaveBeenCalled();
  });

  test("archive() closes desktop sessions on success", async () => {
    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() does not close desktop sessions when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  test("persists archivedAt when beforeArchive hooks succeed", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Ok(undefined)));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(editConfigSpy).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  test("persists archivedAt before afterArchive hooks run and treats hook failures as best-effort", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    const afterHook = mock(() => {
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.archivedAt).toBeTruthy();
      return Promise.resolve(Err("hook failed"));
    });
    hooks.registerAfterArchive(afterHook);

    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("WorkspaceService archive init cancellation", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("emits metadata when it cancels init but beforeArchive hook fails", async () => {
    const workspaceId = "ws-archive-init-cancel";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/project/ws-archive-init-cancel";

    const initStates = new Map<string, InitStatus>([
      [
        workspaceId,
        {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        },
      ],
    ]);

    const clearInMemoryStateMock = mock((id: string) => {
      initStates.delete(id);
    });

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: clearInMemoryStateMock,
    };

    let configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
              },
            ],
          },
        ],
      ]),
    };

    const editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const frontendMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws-archive-init-cancel",
      projectName: "proj",
      projectPath,
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      namedWorkspacePath: workspacePath,
    };

    const workspaceMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "ws-archive-init-cancel",
      projectName: "proj",
      projectPath,
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([frontendMetadata])),
      loadConfigOrDefault: mock(() => configState),
    };

    const mockAIService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      {} as ExtensionMetadataService,
      { cleanup: mock(() => Promise.resolve()) } as unknown as BackgroundProcessManager
    );

    // Seed abort controller so archive() can cancel init.
    const abortController = new AbortController();
    const initAbortControllers = (
      workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
    ).initAbortControllers;
    initAbortControllers.set(workspaceId, abortController);

    const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
    workspaceService.on("metadata", (event: unknown) => {
      if (!event || typeof event !== "object") {
        return;
      }
      const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
      if (parsed.workspaceId === workspaceId) {
        metadataEvents.push(parsed.metadata);
      }
    });

    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("hook failed");
    }

    // Ensure we didn't persist archivedAt on hook failure.
    expect(editConfigSpy).toHaveBeenCalledTimes(0);
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();

    expect(abortController.signal.aborted).toBe(true);
    expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

    expect(metadataEvents.length).toBeGreaterThanOrEqual(1);
    expect(metadataEvents.at(-1)?.isInitializing).toBe(undefined);
  });
});

describe("WorkspaceService unarchive lifecycle hooks", () => {
  const workspaceId = "ws-unarchive";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-unarchive";

  let workspaceService: WorkspaceService;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  const workspaceMetadata: FrontendWorkspaceMetadata = {
    id: workspaceId,
    name: "ws-unarchive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    archivedAt: "2020-01-01T00:00:00.000Z",
    namedWorkspacePath: workspacePath,
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                archivedAt: "2020-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      ]),
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([workspaceMetadata])),
    };
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("persists unarchivedAt and runs afterUnarchive hooks (best-effort)", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    const afterHook = mock(() => {
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.unarchivedAt).toBeTruthy();
      return Promise.resolve(Err("hook failed"));
    });
    hooks.registerAfterUnarchive(afterHook);

    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.unarchivedAt).toBeTruthy();
    expect(entry?.unarchivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("does not run afterUnarchive hooks when workspace is not archived", async () => {
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    if (!entry) {
      throw new Error("Missing workspace entry");
    }
    entry.archivedAt = undefined;

    const hooks = new WorkspaceLifecycleHooks();
    const afterHook = mock(() => Promise.resolve(Ok(undefined)));
    hooks.registerAfterUnarchive(afterHook);
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(0);
  });
  test("unarchiving with missing managed worktree does not recreate the directory", async () => {
    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.unarchivedAt).toBeTruthy();
    expect(entry?.unarchivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(
      await fsPromises
        .access(workspacePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
    expect(entry?.path).toBe(workspacePath);
  });
});

describe("WorkspaceService archive snapshots", () => {
  const workspaceId = "ws-archive-snapshot";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-archive-snapshot";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-archive-snapshot",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-archive-snapshot",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
              },
            ],
          },
        ],
      ]),
      worktreeArchiveBehavior: "snapshot",
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("archive() persists captured snapshot metadata together with archivedAt", async () => {
    const snapshot = {
      version: 1 as const,
      capturedAt: "2026-03-30T00:00:00.000Z",
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-archive-snapshot",
          trunkBranch: "main",
          baseSha: "base-sha",
          headSha: "head-sha",
        },
      ],
    };
    const captureSnapshotForArchive = mock(() => Promise.resolve(Ok(snapshot)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.worktreeArchiveSnapshot).toEqual(snapshot);
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: undefined,
    });
  });

  test("archive() does not close live sessions when archive readiness checks fail", async () => {
    const closeWorkspaceSessions = mock(() => undefined);
    workspaceService.setTerminalService({
      closeWorkspaceSessions,
    } as unknown as TerminalService);

    const closeDesktopSession = mock(() => Promise.resolve(undefined));
    workspaceService.setDesktopSessionManager({
      close: closeDesktopSession,
    } as unknown as DesktopSessionManager);

    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Err("snapshot failed"))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Err("snapshot failed"));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
    expect(closeWorkspaceSessions).not.toHaveBeenCalled();
    expect(closeDesktopSession).not.toHaveBeenCalled();
  });

  test("archive() skips snapshot capture for multi-project workspaces", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const multiProjectMetadata = {
      ...workspaceMetadata,
      projects: [
        { projectPath, projectName: "proj" },
        { projectPath: "/tmp/project-b", projectName: "proj-b" },
      ],
    } satisfies WorkspaceMetadata;
    const aiService = workspaceService as unknown as { aiService: AIService };
    aiService.aiService.getWorkspaceMetadata = mock(() =>
      Promise.resolve(Ok(multiProjectMetadata))
    );

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });

  test("archive() aborts when snapshot capture fails", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("snapshot failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("snapshot failed");
    }
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();
    expect(entry?.worktreeArchiveSnapshot).toBeUndefined();
    expect(editConfigSpy).toHaveBeenCalledTimes(0);
  });
});

describe("WorkspaceService preflightArchive and acknowledged archive", () => {
  const workspaceId = "ws-preflight-archive";
  const projectPath = "/tmp/project-preflight";
  const workspacePath = "/tmp/project-preflight/ws-preflight-archive";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-preflight-archive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-preflight-archive",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
              },
            ],
          },
        ],
      ]),
      worktreeArchiveBehavior: "snapshot",
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) return null;
        return { projectPath, workspacePath };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        fn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("preflightArchive returns ready when no untracked files", async () => {
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: "ready" });
    }
  });

  test("preflightArchive returns confirm-lossy-untracked-files with paths", async () => {
    const untrackedPaths = [".ruff_cache/", "tmp/scratch.txt"];
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok(untrackedPaths))),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        kind: "confirm-lossy-untracked-files",
        paths: untrackedPaths,
      });
    }
  });

  test("preflightArchive returns error when getUnsupportedUntrackedPaths fails", async () => {
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() =>
        Promise.resolve(Err("Failed to check: dirty submodule"))
      ),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("dirty submodule");
    }
  });

  test("archive with matching acknowledgedUntrackedPaths succeeds", async () => {
    const untrackedPaths = [".cache/", "temp.txt"];
    const snapshot: WorktreeArchiveSnapshot = {
      version: 1,
      capturedAt: new Date().toISOString(),
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-preflight-archive",
          headSha: "abc123",
          baseSha: "def456",
          trunkBranch: "main",
        },
      ],
    };
    const captureSnapshotForArchive = mock(() => Promise.resolve(Ok(snapshot)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok(untrackedPaths))),
    });

    const result = await workspaceService.archive(workspaceId, untrackedPaths);

    expect(result).toEqual(Ok({ kind: "archived" }));
    // The capture should have been called with acknowledgedUntrackedPaths.
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: untrackedPaths,
    });
  });

  test("archive returns refreshed confirmation when capture detects new untracked files", async () => {
    const captureSnapshotForArchive = mock(() =>
      Promise.resolve(
        Err({
          kind: "confirm-lossy-untracked-files" as const,
          paths: [".cache/", "new-file.txt"],
        })
      )
    );
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([".cache/", "temp.txt"]))),
    });

    const result = await workspaceService.archive(workspaceId, [".cache/", "temp.txt"]);

    expect(result).toEqual(
      Ok({
        kind: "confirm-lossy-untracked-files",
        paths: [".cache/", "new-file.txt"],
      })
    );
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: [".cache/", "temp.txt"],
    });
  });

  test("archive returns refreshed confirmation when acknowledged paths drift before capture", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() =>
        Promise.resolve(Ok([".cache/", "new-file.txt", "temp.txt"]))
      ),
    });

    const result = await workspaceService.archive(workspaceId, [".cache/", "temp.txt"]);

    expect(result).toEqual(
      Ok({
        kind: "confirm-lossy-untracked-files",
        paths: [".cache/", "new-file.txt", "temp.txt"],
      })
    );
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });

  test("archive without acknowledgedUntrackedPaths returns confirmation for untracked files", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([".cache/"]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "confirm-lossy-untracked-files", paths: [".cache/"] }));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService unarchive snapshot restore", () => {
  const workspaceId = "ws-unarchive-snapshot";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-unarchive-snapshot";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: FrontendWorkspaceMetadata = {
    id: workspaceId,
    name: "ws-unarchive-snapshot",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
    archivedAt: "2020-01-01T00:00:00.000Z",
    namedWorkspacePath: workspacePath,
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    let configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-unarchive-snapshot",
                archivedAt: "2020-01-01T00:00:00.000Z",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
                worktreeArchiveSnapshot: {
                  version: 1,
                  capturedAt: "2026-03-30T00:00:00.000Z",
                  stateDirPath: "archive-state",
                  projects: [
                    {
                      projectPath,
                      projectName: "proj",
                      storageKey: "proj",
                      branchName: "ws-unarchive-snapshot",
                      trunkBranch: "main",
                      baseSha: "base-sha",
                      headSha: "head-sha",
                    },
                  ],
                },
              },
            ],
          },
        ],
      ]),
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        configState = fn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([workspaceMetadata])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("unarchive() returns Err when snapshot restore fails", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Err("restore failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Err("restore failed"));
  });

  test("unarchive() rolls back unarchivedAt when snapshot restore fails", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Err("restore failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Err("restore failed"));
  });

  test("unarchive() rolls back legacy path-only entries when snapshot restore fails", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Err("restore failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const config = workspaceService as unknown as { config: Config };
    await config.config.editConfig((currentConfig) => {
      const workspaceEntry = currentConfig.projects.get(projectPath)?.workspaces[0];
      if (!workspaceEntry) {
        throw new Error("Missing workspace entry");
      }
      delete workspaceEntry.id;
      return currentConfig;
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Err("restore failed"));
  });

  test("unarchive() invokes snapshot restore when snapshot metadata is present", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Ok("restored" as const)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(restoreSnapshotAfterUnarchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
    });
  });
});

describe("WorkspaceService deleteWorktree", () => {
  const workspaceId = "ws-delete-worktree";
  const projectName = "proj";
  const projectPath = "/tmp/project";
  const workspaceName = "ws-delete-worktree";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let tempSrcBaseDir: string;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
    tempSrcBaseDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-delete-worktree-"));
  });

  afterEach(async () => {
    mock.restore();
    await cleanupHistory();
    await fsPromises.rm(tempSrcBaseDir, { recursive: true, force: true });
  });

  function createHarness(options?: {
    archivedAt?: string;
    runtimeConfig?: FrontendWorkspaceMetadata["runtimeConfig"];
  }): {
    workspaceService: WorkspaceService;
    metadataEvents: Array<FrontendWorkspaceMetadata | null>;
    managedPath: string;
  } {
    const runtimeConfig = options?.runtimeConfig ?? {
      type: "worktree",
      srcBaseDir: tempSrcBaseDir,
    };
    const managedPath = path.join(tempSrcBaseDir, "_workspaces", workspaceName);

    const getCurrentMetadata = async (): Promise<FrontendWorkspaceMetadata> => {
      const transcriptOnly = await fsPromises
        .access(managedPath)
        .then(() => false)
        .catch(() => true);

      return {
        id: workspaceId,
        name: workspaceName,
        projectName,
        projectPath,
        runtimeConfig,
        archivedAt: options?.archivedAt,
        transcriptOnly,
        namedWorkspacePath: managedPath,
      };
    };

    const mockConfig: Partial<Config> = {
      srcDir: tempSrcBaseDir,
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      getAllWorkspaceMetadata: mock(async () => [await getCurrentMetadata()]),
    };

    const aiService = {
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
    workspaceService.on("metadata", (event: unknown) => {
      if (!event || typeof event !== "object") {
        return;
      }
      const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
      if (parsed.workspaceId === workspaceId) {
        metadataEvents.push(parsed.metadata);
      }
    });

    return { workspaceService, metadataEvents, managedPath };
  }

  test("deletes an archived managed worktree and emits transcript-only metadata", async () => {
    const { workspaceService, metadataEvents, managedPath } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
    });
    await fsPromises.mkdir(managedPath, { recursive: true });
    const removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    ).mockImplementation(async (_projectPath, worktreePath) => {
      await fsPromises.rm(worktreePath, { recursive: true, force: true });
    });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(removeManagedGitWorktreeSpy).toHaveBeenCalledWith(projectPath, managedPath);
    expect(
      await fsPromises
        .access(managedPath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
    expect(metadataEvents.at(-1)?.transcriptOnly).toBe(true);
  });

  test("returns success when the managed worktree is already missing", async () => {
    const { workspaceService, metadataEvents, managedPath } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
    });
    const removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(removeManagedGitWorktreeSpy).toHaveBeenCalledWith(projectPath, managedPath);
    expect(metadataEvents.at(-1)?.transcriptOnly).toBe(true);
  });

  test("rejects deleting a worktree for a non-archived workspace", async () => {
    const { workspaceService, managedPath } = createHarness({
      archivedAt: undefined,
    });
    await fsPromises.mkdir(managedPath, { recursive: true });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Only archived workspaces can delete their managed worktree");
    }
    expect(
      await fsPromises
        .access(managedPath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test("rejects deleting a worktree for non-worktree runtimes", async () => {
    const { workspaceService } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
      runtimeConfig: { type: "local" },
    });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe(
        "Deleting a managed worktree is only supported for worktree runtimes"
      );
    }
  });
});

describe("WorkspaceService archiveMergedInProject", () => {
  const TARGET_PROJECT_PATH = "/tmp/project";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  function createMetadata(
    id: string,
    options?: { projectPath?: string; archivedAt?: string; unarchivedAt?: string }
  ): FrontendWorkspaceMetadata {
    const projectPath = options?.projectPath ?? TARGET_PROJECT_PATH;

    return {
      id,
      name: id,
      projectName: "test-project",
      projectPath,
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(projectPath, id),
      archivedAt: options?.archivedAt,
      unarchivedAt: options?.unarchivedAt,
    };
  }

  function bashOk(output: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: 0,
      },
    };
  }

  function bashToolFailure(error: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: false,
        error,
        exitCode: 1,
        wall_duration_ms: 0,
      },
    };
  }

  function executeBashFailure(error: string): Result<BashToolResult> {
    return { success: false, error };
  }

  type ExecuteBashFn = (
    workspaceId: string,
    script: string,
    options?: {
      timeout_secs?: number;
    }
  ) => Promise<Result<BashToolResult>>;

  type ArchiveFn = (workspaceId: string) => Promise<Result<{ kind: "archived" }>>;

  function archiveSuccess(): Promise<Result<{ kind: "archived" }>> {
    return Promise.resolve(Ok({ kind: "archived" }));
  }

  function createServiceHarness(
    allMetadata: FrontendWorkspaceMetadata[],
    executeBashImpl: ExecuteBashFn,
    archiveImpl: ArchiveFn
  ): {
    workspaceService: WorkspaceService;
    executeBashMock: ReturnType<typeof mock>;
    archiveMock: ReturnType<typeof mock>;
  } {
    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
      getAllWorkspaceMetadata: mock(() => Promise.resolve(allMetadata)),
    };

    const aiService: AIService = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;
    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const executeBashMock = mock(executeBashImpl);
    const archiveMock = mock(archiveImpl);

    interface WorkspaceServiceTestAccess {
      executeBash: typeof executeBashMock;
      archive: typeof archiveMock;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.executeBash = executeBashMock;
    svc.archive = archiveMock;

    return { workspaceService, executeBashMock, archiveMock };
  }

  test("excludes MUX_HELP_CHAT_WORKSPACE_ID workspaces", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata(MUX_HELP_CHAT_WORKSPACE_ID),
      createMetadata("ws-merged"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-merged": bashOk('{"state":"MERGED"}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged"]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged");

    // Should only query GitHub for the eligible non-mux-chat workspace.
    expect(executeBashMock).toHaveBeenCalledTimes(1);
  });

  test("treats workspaces with later unarchivedAt as eligible", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-merged-unarchived", {
        archivedAt: "2025-01-01T00:00:00.000Z",
        unarchivedAt: "2025-02-01T00:00:00.000Z",
      }),
      createMetadata("ws-still-archived", {
        archivedAt: "2025-03-01T00:00:00.000Z",
        unarchivedAt: "2025-02-01T00:00:00.000Z",
      }),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-merged-unarchived": bashOk('{"state":"MERGED"}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged-unarchived"]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged-unarchived");

    // Should only query GitHub for the workspace that is considered unarchived.
    expect(executeBashMock).toHaveBeenCalledTimes(1);
  });
  test("archives only MERGED workspaces", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-open"),
      createMetadata("ws-merged"),
      createMetadata("ws-no-pr"),
      createMetadata("ws-other-project", { projectPath: "/tmp/other" }),
      createMetadata("ws-already-archived", { archivedAt: "2025-01-01T00:00:00.000Z" }),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-open": bashOk('{"state":"OPEN"}'),
      "ws-merged": bashOk('{"state":"MERGED"}'),
      "ws-no-pr": bashOk('{"no_pr":true}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId, script, options) => {
        expect(script).toContain("gh pr view --json state");
        expect(options?.timeout_secs).toBe(15);

        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged"]);
    expect(result.data.skippedWorkspaceIds).toEqual(["ws-no-pr", "ws-open"]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged");

    expect(executeBashMock).toHaveBeenCalledTimes(3);
  });

  test("skips no_pr and non-merged states", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-open"),
      createMetadata("ws-closed"),
      createMetadata("ws-no-pr"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-open": bashOk('{"state":"OPEN"}'),
      "ws-closed": bashOk('{"state":"CLOSED"}'),
      "ws-no-pr": bashOk('{"no_pr":true}'),
    };

    const { workspaceService, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual([]);
    expect(result.data.skippedWorkspaceIds).toEqual(["ws-closed", "ws-no-pr", "ws-open"]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(0);
  });

  test("records errors for malformed JSON and executeBash failures", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-bad-json"),
      createMetadata("ws-exec-failed"),
      createMetadata("ws-bash-failed"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-bad-json": bashOk("not-json"),
      "ws-exec-failed": executeBashFailure("executeBash failed"),
      "ws-bash-failed": bashToolFailure("gh failed"),
    };

    const { workspaceService, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual([]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toHaveLength(3);

    const badJsonError = result.data.errors.find((e) => e.workspaceId === "ws-bad-json");
    expect(badJsonError).toBeDefined();
    expect(badJsonError?.error).toContain("Failed to parse gh output");

    const execFailedError = result.data.errors.find((e) => e.workspaceId === "ws-exec-failed");
    expect(execFailedError).toBeDefined();
    expect(execFailedError?.error).toBe("executeBash failed");

    const bashFailedError = result.data.errors.find((e) => e.workspaceId === "ws-bash-failed");
    expect(bashFailedError).toBeDefined();
    expect(bashFailedError?.error).toBe("gh failed");

    expect(archiveMock).toHaveBeenCalledTimes(0);
  });
});

describe("WorkspaceService init cancellation", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("create() rejects untrusted projects", async () => {
    const projectPath = "/tmp/proj";
    const generateStableIdMock = mock(() => "ws-untrusted");

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: generateStableIdMock,
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [],
              trusted: false,
            },
          ],
        ]),
      })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const result = await workspaceService.create(projectPath, "ws-branch", undefined, "title", {
      type: "local",
    });

    expect(result).toEqual(
      Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      )
    );
    expect(generateStableIdMock).not.toHaveBeenCalled();
  });

  test("archive() aborts init and still archives when init is running", async () => {
    const workspaceId = "ws-init-running";

    const removeMock = mock(() => Promise.resolve({ success: true as const, data: undefined }));
    const editConfigMock = mock(() => Promise.resolve());
    const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      editConfig: editConfigMock,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(
        (): InitStatus => ({
          status: "running",
          hookPath: "/tmp/proj",
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        })
      ),
      clearInMemoryState: clearInMemoryStateMock,
    };
    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    // Make it obvious if archive() incorrectly chooses deletion.
    workspaceService.remove = removeMock as unknown as typeof workspaceService.remove;

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(editConfigMock).toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() uses normal archive flow when init is complete", async () => {
    const workspaceId = "ws-init-complete";

    const removeMock = mock(() => Promise.resolve({ success: true as const, data: undefined }));
    const editConfigMock = mock(() => Promise.resolve());

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      editConfig: editConfigMock,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(
        (): InitStatus => ({
          status: "success",
          hookPath: "/tmp/proj",
          startTime: 0,
          lines: [],
          exitCode: 0,
          endTime: 1,
        })
      ),
      clearInMemoryState: mock((_workspaceId: string) => undefined),
    };
    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    // Make it obvious if archive() incorrectly chooses deletion.
    workspaceService.remove = removeMock as unknown as typeof workspaceService.remove;

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(editConfigMock).toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  test("list() includes isInitializing when init state is running", async () => {
    const workspaceId = "ws-list-initializing";

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: "/tmp/proj/ws",
      runtimeConfig: { type: "local" },
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock((id: string): InitStatus | undefined =>
        id === workspaceId
          ? {
              status: "running",
              hookPath: "/tmp/proj",
              startTime: 0,
              lines: [],
              exitCode: null,
              endTime: null,
            }
          : undefined
      ),
    };
    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const list = await workspaceService.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.isInitializing).toBe(true);
  });

  test("create() clears init state + emits updated metadata when skipping background init", async () => {
    const workspaceId = "ws-skip-init";
    const projectPath = "/tmp/proj";
    const branchName = "ws_branch";
    const workspacePath = "/tmp/proj/ws_branch";

    const initStates = new Map<string, InitStatus>();
    const clearInMemoryStateMock = mock((id: string) => {
      initStates.delete(id);
    });

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      startInit: mock((id: string) => {
        initStates.set(id, {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        });
      }),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: clearInMemoryStateMock,
    };

    const configState: ProjectsConfig = { projects: new Map() };

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: branchName,
      title: "title",
      projectName: "proj",
      projectPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: workspacePath,
      runtimeConfig: { type: "local" },
    };

    const mockConfig: Partial<Config> = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      generateStableId: mock(() => workspaceId),
      editConfig: mock((editFn: (config: ProjectsConfig) => ProjectsConfig) => {
        editFn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      getEffectiveSecrets: mock(() => [{ key: "GH_TOKEN", value: "token" }]),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [],
              trusted: true,
            },
          ],
        ]),
      })),
    };

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;
    const createWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, workspacePath })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      createWorkspace: createWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const sessionEmitter = new EventEmitter();
    const fakeSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      emitMetadata: (metadata: FrontendWorkspaceMetadata | null) => {
        sessionEmitter.emit("metadata-event", { workspaceId, metadata });
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    try {
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
      workspaceService.on("metadata", (event: unknown) => {
        if (!event || typeof event !== "object") {
          return;
        }
        const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
        if (parsed.workspaceId === workspaceId) {
          metadataEvents.push(parsed.metadata);
        }
      });

      workspaceService.registerSession(workspaceId, fakeSession);

      const removingWorkspaces = (
        workspaceService as unknown as { removingWorkspaces: Set<string> }
      ).removingWorkspaces;
      removingWorkspaces.add(workspaceId);

      const result = await workspaceService.create(projectPath, branchName, undefined, "title", {
        type: "local",
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(createWorkspaceMock).toHaveBeenCalledWith(
        expect.objectContaining({ env: { GH_TOKEN: "token" } })
      );
      expect(result.data.metadata.isInitializing).toBe(undefined);
      expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

      expect(metadataEvents).toHaveLength(2);
      expect(metadataEvents[0]?.isInitializing).toBe(true);
      expect(metadataEvents[1]?.isInitializing).toBe(undefined);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });
  test("remove() aborts init and clears state before teardown", async () => {
    const workspaceId = "ws-remove-aborts";

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-"));
    try {
      const abortController = new AbortController();
      const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);
      const mockInitStateManager = {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        clearInMemoryState: clearInMemoryStateMock,
      } as unknown as InitStateManager;

      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "na" })),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: Partial<Config> = {
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(tempRoot, id)),
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => null),
      };
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        mockInitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      // Inject an in-progress init AbortController.
      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      initAbortControllers.set(workspaceId, abortController);

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
      expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

      expect(initAbortControllers.has(workspaceId)).toBe(false);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("remove() does not clear init state when runtime deletion fails with force=false", async () => {
    const workspaceId = "ws-remove-runtime-delete-fails";
    const projectPath = "/tmp/proj";

    const abortController = new AbortController();
    const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);
    const mockInitStateManager = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      clearInMemoryState: clearInMemoryStateMock,
    } as unknown as InitStateManager;
    const removeWorkspaceMock = mock(() => Promise.resolve());

    const deleteWorkspaceMock = mock(() =>
      Promise.resolve({ success: false as const, error: "dirty" })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-fail-"));
    try {
      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: Partial<Config> = {
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(tempRoot, id)),
        removeWorkspace: removeWorkspaceMock,
        findWorkspace: mock(() => null),
      };
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        mockInitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      // Inject an in-progress init AbortController.
      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      initAbortControllers.set(workspaceId, abortController);

      const result = await workspaceService.remove(workspaceId, false);
      expect(result.success).toBe(false);
      expect(abortController.signal.aborted).toBe(true);

      // If runtime deletion fails with force=false, removal returns early and the workspace remains.
      // Keep init state intact so init-end can refresh metadata and clear isInitializing.
      expect(clearInMemoryStateMock).not.toHaveBeenCalled();
      expect(removeWorkspaceMock).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
  test("remove() calls runtime.deleteWorkspace when force=true", async () => {
    const workspaceId = "ws-remove-runtime-delete";
    const projectPath = "/tmp/proj";

    const deleteWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-runtime-"));
    try {
      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: Partial<Config> = {
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(tempRoot, id)),
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      };
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      // trusted defaults to false (no project config), so deleteWorkspace gets (path, name, force, undefined, false)
      expect(deleteWorkspaceMock).toHaveBeenCalledWith(projectPath, "ws", true, undefined, false);
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceService regenerateTitle", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "workspace metadata unavailable" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("returns updateTitle error when persisting generated title fails", async () => {
    const workspaceId = "ws-regenerate-title";

    await historyService.appendToHistory(workspaceId, createMuxMessage("user-1", "user", "Fix CI"));

    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "ci-fix-a1b2",
        title: "Fix CI",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Err("Failed to update workspace title: disk full")
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Failed to update workspace title: disk full");
      }
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      expect(call?.[3]).toBeUndefined();
      expect(call?.[4]).toBe("Fix CI");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "Fix CI");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
    }
  });
  test("falls back to full history when latest compaction epoch has no user message", async () => {
    const workspaceId = "ws-regenerate-title-compacted";

    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-before-boundary", "user", "Refactor sidebar loading")
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary-boundary", "assistant", "Compacted summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-after-boundary", "assistant", "No new user messages yet")
    );

    const iterateSpy = spyOn(historyService, "iterateFullHistory");
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "sidebar-refactor-a1b2",
        title: "Refactor sidebar loading",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Ok(undefined)
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe("Refactor sidebar loading");
      }
      expect(iterateSpy).toHaveBeenCalledTimes(1);
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      expect(call?.[0]).toBe("Refactor sidebar loading");
      const context = call?.[3];
      expect(typeof context).toBe("string");
      if (typeof context === "string") {
        expect(context).toContain("Refactor sidebar loading");
        expect(context).toContain("Compacted summary");
        expect(context).toContain("No new user messages yet");
        expect(context).not.toContain("omitted for brevity");
      }
      expect(call?.[4]).toBe("Refactor sidebar loading");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "Refactor sidebar loading");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
      iterateSpy.mockRestore();
    }
  });
  test("uses first user turn + latest 3 turns and flags omitted context", async () => {
    const workspaceId = "ws-regenerate-title-first-plus-last-three";

    for (let turn = 1; turn <= 12; turn++) {
      const role: "user" | "assistant" = turn % 2 === 1 ? "user" : "assistant";
      const text = `${role === "user" ? "User" : "Assistant"} turn ${turn}`;
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(`${role}-${turn}`, role, text)
      );
    }

    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "title-refresh-a1b2",
        title: "User turn 1",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Ok(undefined)
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(true);
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      expect(call?.[0]).toBe("User turn 1");
      const context = call?.[3];
      expect(typeof context).toBe("string");
      expect(call?.[4]).toBe("User turn 11");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "User turn 1");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
    }
  });
});

describe("WorkspaceService fork", () => {
  let config: Config;
  let tempDir: string;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({
      config,
      tempDir,
      historyService,
      cleanup: cleanupHistory,
    } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("cleans up init state when orchestrateFork rejects", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = "/tmp/project";

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve(
          Ok({
            id: sourceWorkspaceId,
            name: "source-branch",
            projectPath: sourceProjectPath,
            projectName: "project",
            runtimeConfig: { type: "local" },
          })
        )
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const startInitMock = mock(() => undefined);
    const endInitMock = mock(() => Promise.resolve());
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: startInitMock,
      endInit: endInitMock,
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      generateStableId: mock(() => newWorkspaceId),
      findWorkspace: mock(() => null),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      getEffectiveSecrets: mock(() => []),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([[sourceProjectPath, { workspaces: [], trusted: true }]]),
      })),
    };

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockRejectedValue(
      new Error("runtime explosion")
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Failed to fork workspace: runtime explosion");
      }

      expect(startInitMock).toHaveBeenCalledWith(newWorkspaceId, sourceProjectPath);
      expect(endInitMock).toHaveBeenCalledWith(newWorkspaceId, -1);

      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      expect(initAbortControllers.has(newWorkspaceId)).toBe(false);
    } finally {
      orchestrateForkSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
    }
  });
  test("resets forked session usage while preserving copied history", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    // Seed source history with assistant usage so the source cost ledger is non-empty
    // before we fork. The fork should keep this history but not inherit its costs.
    await historyService.appendToHistory(
      sourceWorkspaceId,
      createMuxMessage("assistant-1", "assistant", "Hello", {
        model: "claude-sonnet-4-20250514",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      })
    );

    const sessionUsageService = new SessionUsageService(config, historyService);
    const sourceUsage = await sessionUsageService.getSessionUsage(sourceWorkspaceId);
    expect(sourceUsage?.byModel["claude-sonnet-4-20250514"]?.input.tokens).toBe(100);

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager,
      sessionUsageService
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => path.join(sourceProjectPath, "fork-child")),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(
      () => undefined
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: path.join(sourceProjectPath, "fork-child"),
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }
      expect(result.data.metadata.forkFamilyBaseName).toBeUndefined();

      const forkedUsage = await sessionUsageService.getSessionUsage(newWorkspaceId);
      expect(forkedUsage).toEqual({ byModel: {}, version: 1 });

      const forkedMessages: string[] = [];
      const historyResult = await historyService.iterateFullHistory(
        newWorkspaceId,
        "forward",
        (chunk) => {
          forkedMessages.push(...chunk.map((message) => message.id));
        }
      );
      expect(historyResult.success).toBe(true);
      expect(forkedMessages).toContain("assistant-1");
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
  test("auto-generated fork names normalize legacy fork families before the validation fallback", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "Feature-fork-2",
      title: "Feature branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "Feature-fork-2"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "feature-1");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(
      () => undefined
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId);

      expect(orchestrateForkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceWorkspaceName: sourceMetadata.name,
          newWorkspaceName: "feature-1",
        })
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.name).toBe("feature-1");
      expect(result.data.metadata.forkFamilyBaseName).toBe("Feature");
      expect(result.data.metadata.namedWorkspacePath).toBe(forkedWorkspacePath);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  test("auto-generated fork names increment existing fork suffixes instead of nesting them", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch-2",
      title: "Source branch (2)",
      forkFamilyBaseName: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch-2"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "source-branch-3");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(
      () => undefined
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId);

      expect(orchestrateForkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceWorkspaceName: sourceMetadata.name,
          newWorkspaceName: "source-branch-3",
        })
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.name).toBe("source-branch-3");
      expect(result.data.metadata.title).toBe("Source branch (3)");
      expect(result.data.metadata.forkFamilyBaseName).toBe("source-branch");
      expect(result.data.metadata.namedWorkspacePath).toBe(forkedWorkspacePath);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
  test("fork marks the new workspace as pending auto-title when a continue message is queued", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      title: "Source branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "source-branch-1");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(
      () => undefined
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, undefined, undefined, true);

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.pendingAutoTitle).toBe(true);
      const persistedMetadata = (await config.getAllWorkspaceMetadata()).find(
        (metadata) => metadata.id === newWorkspaceId
      );
      expect(persistedMetadata?.pendingAutoTitle).toBe(true);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
});

describe("WorkspaceService interruptStream", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("sendQueuedImmediately clears hard-interrupt suppression before queued resend", async () => {
    const workspaceId = "ws-interrupt-queue-111";

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    const mockAIService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false, error: "not found" })),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const resetAutoResumeCount = mock(() => undefined);
    const markParentWorkspaceInterrupted = mock(() => undefined);
    const terminateAllDescendantAgentTasks = mock(() => Promise.resolve([] as string[]));
    workspaceService.setTaskService({
      resetAutoResumeCount,
      markParentWorkspaceInterrupted,
      terminateAllDescendantAgentTasks,
    } as unknown as TaskService);

    const sendQueuedMessages = mock(() => undefined);
    const restoreQueueToInput = mock(() => undefined);
    const interruptStream = mock(() => Promise.resolve(Ok(undefined)));
    const fakeSession = {
      interruptStream,
      sendQueuedMessages,
      restoreQueueToInput,
    };
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue(
      fakeSession as unknown as AgentSession
    );

    try {
      const result = await workspaceService.interruptStream(workspaceId, {
        sendQueuedImmediately: true,
      });

      expect(result.success).toBe(true);
      expect(markParentWorkspaceInterrupted).toHaveBeenCalledWith(workspaceId);
      expect(terminateAllDescendantAgentTasks).toHaveBeenCalledWith(workspaceId);
      expect(resetAutoResumeCount).toHaveBeenCalledTimes(2);
      expect(sendQueuedMessages).toHaveBeenCalledTimes(1);
      expect(restoreQueueToInput).not.toHaveBeenCalled();
    } finally {
      getOrCreateSessionSpy.mockRestore();
    }
  });
});

// --- Pure helper tests (no mocks needed) ---

describe("generateForkBranchName", () => {
  test("returns -1 when no existing forks", () => {
    expect(generateForkBranchName("sidebar-a1b2", [])).toBe("sidebar-a1b2-1");
  });

  test("increments past the highest existing fork number", () => {
    expect(
      generateForkBranchName("sidebar-a1b2", [
        "sidebar-a1b2-1",
        "sidebar-a1b2-3",
        "other-workspace",
      ])
    ).toBe("sidebar-a1b2-4");
  });

  test("continues numbering for generated forks when given the stable family base name", () => {
    expect(generateForkBranchName("ws", ["ws-1", "ws-2"])).toBe("ws-3");
  });

  test("preserves numeric suffixes for non-fork names", () => {
    expect(generateForkBranchName("release-2024", ["release-1"])).toBe("release-2024-1");
  });

  test("continues numbering across legacy and new fork name patterns", () => {
    expect(generateForkBranchName("ws", ["ws-fork-1", "ws-2", "ws-fork-3"])).toBe("ws-4");
  });

  test("ignores non-matching workspace names", () => {
    expect(generateForkBranchName("feature", ["feature-branch", "feature-impl", "other-1"])).toBe(
      "feature-1"
    );
  });

  test("handles gaps in numbering", () => {
    expect(generateForkBranchName("ws", ["ws-1", "ws-5"])).toBe("ws-6");
  });

  test("ignores non-numeric suffixes", () => {
    expect(generateForkBranchName("ws", ["ws-abc", "ws-fork-"])).toBe("ws-1");
  });

  test("ignores partially numeric suffixes", () => {
    expect(generateForkBranchName("ws", ["ws-1abc", "ws-fork-02x", "ws-3"])).toBe("ws-4");
  });
});

describe("generateForkTitle", () => {
  test("returns (1) when no existing forks", () => {
    expect(generateForkTitle("Fix sidebar layout", [])).toBe("Fix sidebar layout (1)");
  });

  test("increments past the highest existing suffix", () => {
    expect(
      generateForkTitle("Fix sidebar layout", [
        "Fix sidebar layout",
        "Fix sidebar layout (1)",
        "Fix sidebar layout (3)",
      ])
    ).toBe("Fix sidebar layout (4)");
  });

  test("strips existing suffix from parent before computing base", () => {
    // Forking "Fix sidebar (2)" should produce "Fix sidebar (3)", not "Fix sidebar (2) (1)"
    expect(generateForkTitle("Fix sidebar (2)", ["Fix sidebar (1)", "Fix sidebar (2)"])).toBe(
      "Fix sidebar (3)"
    );
  });

  test("ignores non-matching titles", () => {
    expect(generateForkTitle("Refactor auth", ["Fix sidebar layout (1)", "Other task (2)"])).toBe(
      "Refactor auth (1)"
    );
  });

  test("handles gaps in numbering", () => {
    expect(generateForkTitle("Task", ["Task (1)", "Task (5)"])).toBe("Task (6)");
  });

  test("ignores non-numeric suffixes when selecting the next title number", () => {
    expect(generateForkTitle("Task", ["Task (2025 roadmap)", "Task (12abc)", "Task (2)"])).toBe(
      "Task (3)"
    );
  });
});
