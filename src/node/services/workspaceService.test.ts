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
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import type { TaskService } from "./taskService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { TerminalService } from "@/node/services/terminalService";
import type { BashToolResult } from "@/common/types/tools";
import { createMuxMessage } from "@/common/types/message";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import * as todoStorageModule from "@/node/services/todos/todoStorage";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as bashToolModule from "@/node/services/tools/bash";
import * as forkOrchestratorModule from "@/node/services/utils/forkOrchestrator";
import * as runtimeExecHelpers from "@/node/utils/runtime/helpers";
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
const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
  cleanup: mock(() => Promise.resolve()),
};

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
  test("rename succeeds even if Flow Prompting migration fails after config is updated", async () => {
    const workspaceId = "rename-workspace";
    const projectPath = "/tmp/test-project";
    const oldMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "old-name",
      projectName: "test-project",
      projectPath,
      runtimeConfig: {
        type: "worktree",
        srcBaseDir: "/tmp/src",
      },
    };
    const updatedMetadata: WorkspaceMetadata = {
      ...oldMetadata,
      name: "new-name",
    };

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: true as const, data: oldMetadata })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const loadedProjectsConfig: ProjectsConfig = {
      projects: new Map([[projectPath, { trusted: false, workspaces: [] }]]),
    };
    let metadataCalls = 0;
    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => ({
        projectPath,
        workspacePath: "/tmp/src/test-project/old-name",
        runtimeConfig: oldMetadata.runtimeConfig,
      })),
      getAllWorkspaceMetadata: mock(() =>
        Promise.resolve(
          (metadataCalls++ === 0 ? [oldMetadata] : [updatedMetadata]) as unknown as Awaited<
            ReturnType<Config["getAllWorkspaceMetadata"]>
          >
        )
      ),
      editConfig: mock(() => Promise.resolve(undefined)),
      loadConfigOrDefault: mock(() => loadedProjectsConfig),
    };

    const renameRuntime = {
      getMuxHome: () => "/tmp/mux-home",
      stat: mock(() => Promise.reject(new Error("plan file missing"))),
      renameWorkspace: mock(() =>
        Promise.resolve({
          success: true as const,
          oldPath: "/tmp/src/test-project/old-name",
          newPath: "/tmp/src/test-project/new-name",
        })
      ),
    };
    spyOn(runtimeFactory, "createRuntime").mockReturnValue(renameRuntime as never);

    const renameService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
    const renamePromptFile = spyOn(
      (
        renameService as unknown as {
          flowPromptService: {
            renamePromptFile: (
              workspaceId: string,
              oldMetadata: WorkspaceMetadata,
              newMetadata: WorkspaceMetadata
            ) => Promise<void>;
          };
        }
      ).flowPromptService,
      "renamePromptFile"
    ).mockRejectedValue(new Error("transient flow prompt error"));

    try {
      const result = await renameService.rename(workspaceId, "new-name");

      expect(result).toEqual(Ok({ newWorkspaceId: workspaceId }));
      expect(renamePromptFile).toHaveBeenCalledWith(workspaceId, oldMetadata, updatedMetadata);
    } finally {
      mock.restore();
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
  test("registerSession finalizes Flow Prompting updates using the chat event workspaceId", () => {
    const markAcceptedUpdateByFingerprint = spyOn(
      (
        workspaceService as unknown as {
          flowPromptService: {
            markAcceptedUpdateByFingerprint: (
              workspaceId: string,
              fingerprint: string
            ) => Promise<void>;
          };
        }
      ).flowPromptService,
      "markAcceptedUpdateByFingerprint"
    ).mockResolvedValue(undefined);

    const workspaceId = "flow-prompt-listener-workspace";
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

    const acceptedMessage = createMuxMessage(
      "flow-prompt-accepted",
      "user",
      "Re the live prompt in /tmp/workspace/.mux/prompts/feature.md:"
    );

    sessionEmitter.emit("chat-event", {
      workspaceId,
      message: {
        type: "message",
        ...acceptedMessage,
        metadata: {
          ...(acceptedMessage.metadata ?? {}),
          muxMetadata: {
            type: "normal",
            flowPromptAttachment: {
              path: "/tmp/workspace/.mux/prompts/feature.md",
              fingerprint: "flow-prompt-fingerprint",
            },
          },
        },
      },
    });

    expect(markAcceptedUpdateByFingerprint).toHaveBeenCalledWith(
      workspaceId,
      "flow-prompt-fingerprint"
    );
  });
  test("registerSession clears in-flight Flow Prompting state when the turn fails", () => {
    const clearInFlightUpdate = spyOn(
      (
        workspaceService as unknown as {
          flowPromptService: {
            clearInFlightUpdate: (workspaceId: string) => void;
          };
        }
      ).flowPromptService,
      "clearInFlightUpdate"
    ).mockImplementation(() => undefined);

    const workspaceId = "flow-prompt-failure-workspace";
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
        type: "stream-error",
        messageId: "assistant-error",
        error: "context exceeded",
        errorType: "context_exceeded",
      },
    });

    expect(clearInFlightUpdate).toHaveBeenCalledWith(workspaceId);
  });
});

describe("WorkspaceService Flow Prompting update ordering", () => {
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
      findWorkspace: mock(() => ({
        workspacePath: "/tmp/test/workspace",
        projectPath: "/tmp/test/project",
      })),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
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

  test("drops stale revisions after awaiting send options", async () => {
    const flowPromptSession = {
      isBusy: mock(() => false),
      getFlowPromptSendOptions: mock(() =>
        Promise.resolve({
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        })
      ),
      queueFlowPromptUpdate: mock(() => undefined),
    };
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => flowPromptSession as unknown as AgentSession);

    const flowPromptService = (
      workspaceService as unknown as {
        flowPromptService: {
          isCurrentFingerprint: (workspaceId: string, fingerprint: string) => Promise<boolean>;
          forgetUpdate: (workspaceId: string, fingerprint: string) => void;
        };
      }
    ).flowPromptService;
    const isCurrentFingerprint = spyOn(flowPromptService, "isCurrentFingerprint").mockResolvedValue(
      false
    );
    const forgetUpdate = spyOn(flowPromptService, "forgetUpdate").mockImplementation(
      () => undefined
    );
    const sendMessage = spyOn(workspaceService, "sendMessage");

    await (
      workspaceService as unknown as {
        handleFlowPromptUpdate: (event: {
          workspaceId: string;
          path: string;
          nextContent: string;
          nextFingerprint: string;
          text: string;
        }) => Promise<void>;
      }
    ).handleFlowPromptUpdate({
      workspaceId: "test-workspace",
      path: "/tmp/test/workspace/.mux/prompts/test-workspace.md",
      nextContent: "stale flow prompt revision",
      nextFingerprint: "stale-fingerprint",
      text: "[Flow prompt updated. Follow current agent instructions.]",
    });

    expect(isCurrentFingerprint).toHaveBeenCalledWith("test-workspace", "stale-fingerprint");
    expect(forgetUpdate).toHaveBeenCalledWith("test-workspace", "stale-fingerprint");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(flowPromptSession.queueFlowPromptUpdate).not.toHaveBeenCalled();
  });

  test("clears any restored queued Flow Prompt update before immediately dispatching a newer revision", async () => {
    const workspaceId = "flow-stale-queued-workspace";
    const flowPromptSession = {
      isBusy: mock(() => false),
      clearFlowPromptUpdate: mock(() => undefined),
      getFlowPromptSendOptions: mock(() =>
        Promise.resolve({
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        })
      ),
      queueFlowPromptUpdate: mock(() => undefined),
    };
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => flowPromptSession as unknown as AgentSession);

    const flowPromptService = (
      workspaceService as unknown as {
        flowPromptService: {
          isCurrentFingerprint: (workspaceId: string, fingerprint: string) => Promise<boolean>;
          rememberUpdate: (workspaceId: string, fingerprint: string, nextContent: string) => void;
          clearPendingUpdate: (workspaceId: string, fingerprint?: string) => void;
          markInFlightUpdate: (workspaceId: string, fingerprint: string) => void;
        };
      }
    ).flowPromptService;
    spyOn(flowPromptService, "rememberUpdate").mockImplementation(() => undefined);
    spyOn(flowPromptService, "isCurrentFingerprint").mockResolvedValue(true);
    const clearPendingUpdate = spyOn(flowPromptService, "clearPendingUpdate").mockImplementation(
      () => undefined
    );
    const markInFlightUpdate = spyOn(flowPromptService, "markInFlightUpdate").mockImplementation(
      () => undefined
    );
    const sendMessage = spyOn(workspaceService, "sendMessage").mockResolvedValue(Ok(undefined));

    await (
      workspaceService as unknown as {
        handleFlowPromptUpdate: (event: {
          workspaceId: string;
          path: string;
          nextContent: string;
          nextFingerprint: string;
          text: string;
        }) => Promise<void>;
      }
    ).handleFlowPromptUpdate({
      workspaceId,
      path: "/tmp/test/workspace/.mux/prompts/test-workspace.md",
      nextContent: "newest flow prompt revision",
      nextFingerprint: "newest-fingerprint",
      text: "[Flow prompt updated. Follow current agent instructions.]",
    });

    expect(flowPromptSession.clearFlowPromptUpdate).toHaveBeenCalledTimes(1);
    expect(clearPendingUpdate).toHaveBeenCalledWith(workspaceId);
    expect(markInFlightUpdate).toHaveBeenCalledWith(workspaceId, "newest-fingerprint");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("marks immediately dispatched Flow Prompting revisions as in flight", async () => {
    const workspaceId = "flow-in-flight-workspace";
    const flowPromptSession = {
      isBusy: mock(() => false),
      clearFlowPromptUpdate: mock(() => undefined),
      getFlowPromptSendOptions: mock(() =>
        Promise.resolve({
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        })
      ),
      queueFlowPromptUpdate: mock(() => undefined),
    };
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => flowPromptSession as unknown as AgentSession);

    const flowPromptService = (
      workspaceService as unknown as {
        flowPromptService: {
          isCurrentFingerprint: (workspaceId: string, fingerprint: string) => Promise<boolean>;
          rememberUpdate: (workspaceId: string, fingerprint: string, nextContent: string) => void;
          clearPendingUpdate: (workspaceId: string, fingerprint?: string) => void;
          markInFlightUpdate: (workspaceId: string, fingerprint: string) => void;
          clearInFlightUpdate: (workspaceId: string, fingerprint?: string) => void;
        };
      }
    ).flowPromptService;
    spyOn(flowPromptService, "rememberUpdate").mockImplementation(() => undefined);
    spyOn(flowPromptService, "isCurrentFingerprint").mockResolvedValue(true);
    spyOn(flowPromptService, "clearPendingUpdate").mockImplementation(() => undefined);
    const markInFlightUpdate = spyOn(flowPromptService, "markInFlightUpdate").mockImplementation(
      () => undefined
    );
    const clearInFlightUpdate = spyOn(flowPromptService, "clearInFlightUpdate").mockImplementation(
      () => undefined
    );
    const sendMessage = spyOn(workspaceService, "sendMessage").mockResolvedValue(Ok(undefined));

    await (
      workspaceService as unknown as {
        handleFlowPromptUpdate: (event: {
          workspaceId: string;
          path: string;
          nextContent: string;
          nextFingerprint: string;
          text: string;
        }) => Promise<void>;
      }
    ).handleFlowPromptUpdate({
      workspaceId,
      path: "/tmp/test/workspace/.mux/prompts/test-workspace.md",
      nextContent: "current flow prompt revision",
      nextFingerprint: "current-fingerprint",
      text: "[Flow prompt updated. Follow current agent instructions.]",
    });

    expect(markInFlightUpdate).toHaveBeenCalledWith(workspaceId, "current-fingerprint");
    expect(clearInFlightUpdate).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceService Flow Prompting controls", () => {
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
      findWorkspace: mock(() => ({
        workspacePath: "/tmp/test/workspace",
        projectPath: "/tmp/test/project",
      })),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
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

  test("marks an idle Flow Prompting revision as failed when sendMessage returns an error", async () => {
    const workspaceId = "flow-idle-failure-workspace";
    const flowPromptSession = {
      isBusy: mock(() => false),
      clearFlowPromptUpdate: mock(() => undefined),
      getFlowPromptSendOptions: mock(() =>
        Promise.resolve({
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        })
      ),
      queueFlowPromptUpdate: mock(() => undefined),
    };
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => flowPromptSession as unknown as AgentSession);

    const flowPromptService = (
      workspaceService as unknown as {
        flowPromptService: {
          isCurrentFingerprint: (workspaceId: string, fingerprint: string) => Promise<boolean>;
          rememberUpdate: (workspaceId: string, fingerprint: string, nextContent: string) => void;
          clearPendingUpdate: (workspaceId: string, fingerprint?: string) => void;
          markInFlightUpdate: (workspaceId: string, fingerprint: string) => void;
          clearInFlightUpdate: (workspaceId: string, fingerprint?: string) => void;
          markFailedUpdate: (workspaceId: string, fingerprint: string) => void;
          forgetUpdate: (workspaceId: string, fingerprint: string) => void;
        };
      }
    ).flowPromptService;
    spyOn(flowPromptService, "rememberUpdate").mockImplementation(() => undefined);
    spyOn(flowPromptService, "isCurrentFingerprint").mockResolvedValue(true);
    spyOn(flowPromptService, "clearPendingUpdate").mockImplementation(() => undefined);
    spyOn(flowPromptService, "markInFlightUpdate").mockImplementation(() => undefined);
    const clearInFlightUpdate = spyOn(flowPromptService, "clearInFlightUpdate").mockImplementation(
      () => undefined
    );
    const markFailedUpdate = spyOn(flowPromptService, "markFailedUpdate").mockImplementation(
      () => undefined
    );
    const forgetUpdate = spyOn(flowPromptService, "forgetUpdate").mockImplementation(
      () => undefined
    );
    spyOn(workspaceService, "sendMessage").mockResolvedValue(
      Err({ type: "unknown", raw: "invalid provider config" })
    );

    await (
      workspaceService as unknown as {
        handleFlowPromptUpdate: (event: {
          workspaceId: string;
          path: string;
          nextContent: string;
          nextFingerprint: string;
          text: string;
        }) => Promise<void>;
      }
    ).handleFlowPromptUpdate({
      workspaceId,
      path: "/tmp/test/workspace/.mux/prompts/test-workspace.md",
      nextContent: "current flow prompt revision",
      nextFingerprint: "current-fingerprint",
      text: "[Flow prompt updated. Follow current agent instructions.]",
    });

    expect(clearInFlightUpdate).toHaveBeenCalledWith(workspaceId, "current-fingerprint");
    expect(markFailedUpdate).toHaveBeenCalledWith(workspaceId, "current-fingerprint");
    expect(forgetUpdate).toHaveBeenCalledWith(workspaceId, "current-fingerprint");
  });

  test("switching auto-send off clears the queued Flow Prompting update", async () => {
    const workspaceId = "flow-controls-workspace";
    const session = {
      clearFlowPromptUpdate: mock(() => undefined),
    };
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => session as unknown as AgentSession);

    const setAutoSendMode = spyOn(
      (
        workspaceService as unknown as {
          flowPromptService: {
            setAutoSendMode: (
              workspaceId: string,
              mode: "off" | "end-of-turn",
              options?: { clearPending?: boolean }
            ) => Promise<{
              workspaceId: string;
              path: string;
              exists: boolean;
              hasNonEmptyContent: boolean;
              modifiedAtMs: number | null;
              contentFingerprint: string | null;
              lastEnqueuedFingerprint: string | null;
              isCurrentVersionEnqueued: boolean;
              hasPendingUpdate: boolean;
              autoSendMode: "off" | "end-of-turn";
              nextHeadingContent: string | null;
              updatePreviewText: string | null;
            }>;
          };
        }
      ).flowPromptService,
      "setAutoSendMode"
    ).mockResolvedValue({
      workspaceId,
      path: "/tmp/test/workspace/.mux/prompts/feature.md",
      exists: true,
      hasNonEmptyContent: true,
      modifiedAtMs: 1,
      contentFingerprint: "flow-prompt-fingerprint",
      lastEnqueuedFingerprint: null,
      isCurrentVersionEnqueued: false,
      hasPendingUpdate: false,
      autoSendMode: "off",
      nextHeadingContent: null,
      updatePreviewText: null,
    });

    const result = await workspaceService.updateFlowPromptAutoSendMode(workspaceId, "off");

    expect(result.success).toBe(true);
    expect(session.clearFlowPromptUpdate).toHaveBeenCalledTimes(1);
    expect(setAutoSendMode).toHaveBeenCalledWith(workspaceId, "off", { clearPending: true });
  });

  test("disabling Flow Prompting clears any queued synthetic follow-up before deleting the file", async () => {
    const workspaceId = "flow-delete-workspace";
    const session = {
      clearFlowPromptUpdate: mock(() => undefined),
    };
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => session as unknown as AgentSession);

    const deletePromptFile = spyOn(
      (
        workspaceService as unknown as {
          flowPromptService: {
            deletePromptFile: (workspaceId: string) => Promise<void>;
          };
        }
      ).flowPromptService,
      "deletePromptFile"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.deleteFlowPrompt(workspaceId);

    expect(result.success).toBe(true);
    expect(session.clearFlowPromptUpdate).toHaveBeenCalledTimes(1);
    expect(deletePromptFile).toHaveBeenCalledWith(workspaceId);
  });

  test("attachFlowPrompt clears stale synthetic retries and returns the latest attach draft", async () => {
    const workspaceId = "flow-attach-workspace";
    const session = {
      clearFlowPromptUpdate: mock(() => undefined),
    };
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => session as unknown as AgentSession);

    const attachDraft = {
      text: "Re the live prompt in /tmp/test/workspace/.mux/prompts/feature.md:\n",
      flowPromptAttachment: {
        path: "/tmp/test/workspace/.mux/prompts/feature.md",
        fingerprint: "flow-prompt-fingerprint",
      },
    };
    const flowPromptService = (
      workspaceService as unknown as {
        flowPromptService: {
          clearPendingUpdate: (workspaceId: string, fingerprint?: string) => void;
          getAttachDraft: (workspaceId: string) => Promise<typeof attachDraft | null>;
        };
      }
    ).flowPromptService;
    const clearPendingUpdate = spyOn(flowPromptService, "clearPendingUpdate").mockImplementation(
      () => undefined
    );
    const getAttachDraft = spyOn(flowPromptService, "getAttachDraft").mockResolvedValue(
      attachDraft
    );

    const result = await workspaceService.attachFlowPrompt(workspaceId);

    expect(result).toEqual({ success: true, data: attachDraft });
    expect(session.clearFlowPromptUpdate).toHaveBeenCalledTimes(1);
    expect(clearPendingUpdate).toHaveBeenCalledWith(workspaceId);
    expect(getAttachDraft).toHaveBeenCalledWith(workspaceId);
  });

  test("sendFlowPromptNow queues the latest diff and interrupts the current turn", async () => {
    const workspaceId = "flow-send-now-workspace";
    let queuedFlowPromptUpdate:
      | {
          message: string;
          options?: { queueDispatchMode?: "tool-end" | "turn-end" | null };
          internal?: { synthetic?: boolean };
        }
      | undefined;
    const queuedSession = {
      isBusy: mock(() => true),
      getFlowPromptSendOptions: mock(() =>
        Promise.resolve({
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        })
      ),
      queueFlowPromptUpdate: mock(
        (args: {
          message: string;
          options?: { queueDispatchMode?: "tool-end" | "turn-end" | null };
          internal?: { synthetic?: boolean };
        }) => {
          queuedFlowPromptUpdate = args;
        }
      ),
    };
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => queuedSession as unknown as AgentSession);

    const flowPromptUpdate = {
      workspaceId,
      path: "/tmp/test/workspace/.mux/prompts/feature.md",
      nextContent: "Updated flow prompt instructions",
      nextFingerprint: "flow-prompt-fingerprint",
      text: `[Flow prompt updated. Follow current agent instructions.]\n\nCurrent Next heading:\n\`\`\`md\nOnly work on the test coverage for stage 2.\n\`\`\``,
      state: {
        workspaceId,
        path: "/tmp/test/workspace/.mux/prompts/feature.md",
        exists: true,
        hasNonEmptyContent: true,
        modifiedAtMs: 1,
        contentFingerprint: "flow-prompt-fingerprint",
        lastEnqueuedFingerprint: null,
        isCurrentVersionEnqueued: false,
        hasPendingUpdate: false,
        autoSendMode: "off" as const,
        nextHeadingContent: "Only work on the test coverage for stage 2.",
        updatePreviewText: "[Flow prompt updated. Follow current agent instructions.]",
      },
    };

    const flowPromptService = (
      workspaceService as unknown as {
        flowPromptService: {
          getCurrentUpdate: (workspaceId: string) => Promise<typeof flowPromptUpdate | null>;
          rememberUpdate: (workspaceId: string, fingerprint: string, nextContent: string) => void;
          isCurrentFingerprint: (workspaceId: string, fingerprint: string) => Promise<boolean>;
          markPendingUpdate: (workspaceId: string, nextContent: string) => void;
        };
      }
    ).flowPromptService;
    spyOn(flowPromptService, "getCurrentUpdate").mockResolvedValue(flowPromptUpdate);
    const rememberUpdate = spyOn(flowPromptService, "rememberUpdate").mockImplementation(
      () => undefined
    );
    spyOn(flowPromptService, "isCurrentFingerprint").mockResolvedValue(true);
    const markPendingUpdate = spyOn(flowPromptService, "markPendingUpdate").mockImplementation(
      () => undefined
    );
    const interruptStream = spyOn(workspaceService, "interruptStream").mockResolvedValue(
      Ok(undefined)
    );
    const sendMessage = spyOn(workspaceService, "sendMessage");

    const result = await workspaceService.sendFlowPromptNow(workspaceId);

    expect(result.success).toBe(true);
    expect(rememberUpdate).toHaveBeenCalledWith(
      workspaceId,
      "flow-prompt-fingerprint",
      "Updated flow prompt instructions"
    );
    expect(markPendingUpdate).toHaveBeenCalledWith(workspaceId, "Updated flow prompt instructions");
    expect(queuedFlowPromptUpdate).toBeDefined();
    expect(queuedFlowPromptUpdate?.message).toContain(
      "Only work on the test coverage for stage 2."
    );
    expect(queuedFlowPromptUpdate?.options?.queueDispatchMode).toBe("turn-end");
    expect(queuedFlowPromptUpdate?.internal).toEqual({ synthetic: true });
    expect(interruptStream).toHaveBeenCalledWith(workspaceId, { sendQueuedImmediately: true });
    expect(sendMessage).not.toHaveBeenCalled();
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
      getMetadata: mock(() => Promise.resolve({ lastThinkingLevel: "off" })),
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
        model?: string,
        agentId?: string
      ) => Promise<void>;
    };

    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.updateStreamingStatus(workspaceId, true);

    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, undefined, undefined, undefined);
    expect(emitWorkspaceActivity).toHaveBeenCalledTimes(1);
    expect(emitWorkspaceActivity).toHaveBeenCalledWith(workspaceId, snapshot);
    expect(internals.idleCompactingWorkspaces.has(workspaceId)).toBe(true);
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
        model?: string,
        agentId?: string
      ) => Promise<void>;
    };

    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.updateStreamingStatus(workspaceId, false);

    expect(internals.idleCompactingWorkspaces.has(workspaceId)).toBe(false);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, undefined, undefined, false);
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
      (
        _workspaceId: string,
        streaming: boolean,
        model?: string,
        _thinkingLevel?: string | null,
        hasTodos?: boolean
      ) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: model ?? null,
          lastThinkingLevel: null,
          hasTodos,
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
        model?: string,
        agentId?: string,
        hasTodos?: boolean,
        expectedGeneration?: number
      ) => Promise<void>;
    };

    internals.streamingGenerations.set(workspaceId, 1);
    const staleStopPromise = internals.updateStreamingStatus(
      workspaceId,
      false,
      undefined,
      undefined,
      undefined,
      1
    );

    internals.streamingGenerations.set(workspaceId, 2);
    await internals.updateStreamingStatus(workspaceId, true, "openai:gpt-4o");

    todoReadDeferred.resolve([]);
    await staleStopPromise;

    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(
      workspaceId,
      true,
      "openai:gpt-4o",
      undefined,
      undefined
    );
  });

  test("handleStreamCompletion captures generation before awaiting recency updates", async () => {
    const workspaceId = "ws-stream-completion-generation";
    const recencyDeferred = createDeferred<void>();
    const setStreaming = mock(
      (
        _workspaceId: string,
        streaming: boolean,
        model?: string,
        _thinkingLevel?: string | null,
        hasTodos?: boolean
      ) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: model ?? null,
          lastThinkingLevel: null,
          hasTodos,
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
        model?: string,
        agentId?: string,
        hasTodos?: boolean,
        expectedGeneration?: number
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
    await internals.updateStreamingStatus(workspaceId, true, "openai:gpt-4o-mini");

    recencyDeferred.resolve();
    await completionPromise;

    expect(internals.updateRecencyTimestamp).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(
      workspaceId,
      true,
      "openai:gpt-4o-mini",
      undefined,
      undefined
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

describe("WorkspaceService executeBash host-workspace target", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let tempRoots: string[];

  beforeEach(async () => {
    tempRoots = [];
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
    await Promise.all(
      tempRoots.map((tempRoot) => fsPromises.rm(tempRoot, { recursive: true, force: true }))
    );
  });

  test("devcontainer host-workspace target runs on the host without waking the runtime", async () => {
    const workspaceId = "ws-host-workspace";
    const workspaceName = "feature-branch";
    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-host-workspace-"));
    tempRoots.push(tempRoot);
    const projectPath = path.join(tempRoot, "project");
    const srcDir = path.join(tempRoot, "src");
    const hostWorkspacePath = path.join(srcDir, path.basename(projectPath), workspaceName);
    const waitForInitMock = mock(() => Promise.resolve());
    const getWorkspaceMetadataMock = mock(() =>
      Promise.resolve(
        Ok({
          id: workspaceId,
          name: workspaceName,
          projectName: path.basename(projectPath),
          projectPath,
          runtimeConfig: {
            type: "devcontainer" as const,
            configPath: ".devcontainer/devcontainer.json",
          },
        })
      )
    );

    await fsPromises.mkdir(hostWorkspacePath, { recursive: true });

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir,
      getSessionDir: mock(() => path.join(tempRoot, "sessions")),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => ({ projectPath, workspacePath: hostWorkspacePath })),
      getEffectiveSecrets: mock(() => []),
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
      waitForInit: waitForInitMock,
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

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime");

    try {
      const result = await workspaceService.executeBash(workspaceId, "pwd", {
        executionTarget: "host-workspace",
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.success).toBe(true);
      if (!result.data.success) {
        return;
      }

      expect(result.data.output.trim()).toBe(hostWorkspacePath);
      expect(waitForInitMock).toHaveBeenCalledTimes(0);
      expect(createRuntimeSpy).toHaveBeenCalledTimes(0);
      expect(getWorkspaceMetadataMock).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("devcontainer host-workspace target prefers the persisted workspace path", async () => {
    const workspaceId = "ws-host-workspace-migrated";
    const workspaceName = "feature-branch";
    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-host-workspace-migrated-"));
    tempRoots.push(tempRoot);
    const projectPath = path.join(tempRoot, "project");
    const srcDir = path.join(tempRoot, "src");
    const canonicalHostWorkspacePath = path.join(srcDir, path.basename(projectPath), workspaceName);
    const persistedHostWorkspacePath = path.join(tempRoot, "custom-migrated-path", "my-workspace");
    const waitForInitMock = mock(() => Promise.resolve());
    const getWorkspaceMetadataMock = mock(() =>
      Promise.resolve(
        Ok({
          id: workspaceId,
          name: workspaceName,
          projectName: path.basename(projectPath),
          projectPath,
          runtimeConfig: {
            type: "devcontainer" as const,
            configPath: ".devcontainer/devcontainer.json",
          },
        })
      )
    );

    await fsPromises.mkdir(persistedHostWorkspacePath, { recursive: true });

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir,
      getSessionDir: mock(() => path.join(tempRoot, "sessions")),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => ({ projectPath, workspacePath: persistedHostWorkspacePath })),
      getEffectiveSecrets: mock(() => []),
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
      waitForInit: waitForInitMock,
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

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime");

    try {
      const result = await workspaceService.executeBash(workspaceId, "pwd", {
        executionTarget: "host-workspace",
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.success).toBe(true);
      if (!result.data.success) {
        return;
      }

      expect(result.data.output.trim()).toBe(persistedHostWorkspacePath);
      expect(result.data.output.trim()).not.toBe(canonicalHostWorkspacePath);
      expect(waitForInitMock).toHaveBeenCalledTimes(0);
      expect(createRuntimeSpy).toHaveBeenCalledTimes(0);
      expect(getWorkspaceMetadataMock).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
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
        executionTarget?: "runtime" | "host-workspace";
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
    expect(executeBashMock.mock.calls[0]?.[2]).not.toHaveProperty("executionTarget");
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
      { emitMetadata: false }
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
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, undefined, undefined, false);
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
      executionTarget?: "runtime" | "host-workspace";
    }
  ) => Promise<Result<BashToolResult>>;

  type ArchiveFn = (workspaceId: string) => Promise<Result<void>>;

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
      () => Promise.resolve({ success: true, data: undefined })
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
      () => Promise.resolve({ success: true, data: undefined })
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
        expect(options?.executionTarget).toBeUndefined();

        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => Promise.resolve({ success: true, data: undefined })
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
      () => Promise.resolve({ success: true, data: undefined })
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
      () => Promise.resolve({ success: true, data: undefined })
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
      getEffectiveSecrets: mock(() => []),
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
  test("returns -fork-1 when no existing forks", () => {
    expect(generateForkBranchName("sidebar-a1b2", [])).toBe("sidebar-a1b2-fork-1");
  });

  test("increments past the highest existing fork number", () => {
    expect(
      generateForkBranchName("sidebar-a1b2", [
        "sidebar-a1b2-fork-1",
        "sidebar-a1b2-fork-3",
        "other-workspace",
      ])
    ).toBe("sidebar-a1b2-fork-4");
  });

  test("ignores non-matching workspace names", () => {
    expect(
      generateForkBranchName("feature", ["feature-branch", "feature-impl", "other-fork-1"])
    ).toBe("feature-fork-1");
  });

  test("handles gaps in numbering", () => {
    expect(generateForkBranchName("ws", ["ws-fork-1", "ws-fork-5"])).toBe("ws-fork-6");
  });

  test("treats stale branch names as collisions when choosing next fork name", () => {
    expect(generateForkBranchName("ws", ["ws-fork-1", "ws-fork-2"])).toBe("ws-fork-3");
  });

  test("ignores non-numeric suffixes", () => {
    expect(generateForkBranchName("ws", ["ws-fork-abc", "ws-fork-"])).toBe("ws-fork-1");
  });

  test("ignores partially numeric suffixes", () => {
    expect(generateForkBranchName("ws", ["ws-fork-1abc", "ws-fork-02x", "ws-fork-3"])).toBe(
      "ws-fork-4"
    );
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
