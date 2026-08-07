import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execSync } from "node:child_process";

import {
  TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS,
  TASK_TERMINATION_WORKSPACE_REMOVE_TIMEOUT_MS,
} from "@/constants/terminationTimeouts";
import {
  Config,
  type ProjectConfig,
  type ProjectsConfig,
  type Workspace as WorkspaceConfigEntry,
} from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import * as subagentGitPatchArtifacts from "@/node/services/subagentGitPatchArtifacts";
import {
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import {
  readSubagentReportArtifact,
  upsertSubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";
import {
  readSubagentFailureArtifact,
  upsertSubagentFailureArtifact,
} from "@/node/services/subagentFailureArtifacts";
import { resolveWorkspaceModelFallbackChain } from "@/node/services/taskUtils";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { SessionUsageService } from "@/node/services/sessionUsageService";
import { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import { IdleDispatcher } from "@/node/services/idleDispatcher";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { ExecutionRegistry } from "@/node/services/executionRegistry";
import { ExecutionStore } from "@/node/services/executionStore";
import {
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import {
  TaskService,
  ForegroundWaitBackgroundedError,
  type WorkspaceTurnCreateArgs,
} from "@/node/services/taskService";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { log } from "@/node/services/log";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import type { WorkspaceForkParams } from "@/node/runtime/Runtime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as forkOrchestrator from "@/node/services/utils/forkOrchestrator";
import * as gitModule from "@/node/git";
import * as pathUtilsModule from "@/node/utils/pathUtils";
import { Ok, Err, type Result } from "@/common/types/result";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN } from "@/common/constants/workflowReports";
import {
  formatSubagentReportEnvelope,
  parseSubagentReportEnvelope,
} from "@/common/utils/subagentReportEnvelope";
import { defaultModel } from "@/common/utils/ai/models";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import type { SendMessageError } from "@/common/types/errors";
import type { ErrorEvent, StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";
import {
  buildWorkflowRunCardMessage,
  WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
} from "@/common/utils/workflowRunMessages";
import type { WorkspaceActivitySnapshot, WorkspaceMetadata } from "@/common/types/workspace";
import type { ProvidersConfigMap, WorkspaceChatMessage } from "@/common/orpc/types";
import type { AIService } from "@/node/services/aiService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { InitStateManager as RealInitStateManager } from "@/node/services/initStateManager";
import assert from "node:assert";

function initGitRepo(projectPath: string): void {
  execSync("git init -b main", { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: projectPath, stdio: "ignore" });
  // Ensure tests don't hang when developers have global commit signing enabled.
  execSync("git config commit.gpgsign false", { cwd: projectPath, stdio: "ignore" });
  execSync("bash -lc 'echo \"hello\" > README.md'", { cwd: projectPath, stdio: "ignore" });
  execSync("git add README.md", { cwd: projectPath, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: projectPath, stdio: "ignore" });
}

async function collectFullHistory(service: HistoryService, workspaceId: string) {
  const messages: MuxMessage[] = [];
  const result = await service.iterateFullHistory(workspaceId, "forward", (chunk) => {
    messages.push(...chunk);
  });
  assert(result.success, `collectFullHistory failed: ${result.success ? "" : result.error}`);
  return messages;
}

function findWorkspaceInConfig(config: Config, workspaceId: string) {
  return Array.from(config.loadConfigOrDefault().projects.values())
    .flatMap((project) => project.workspaces)
    .find((workspace) => workspace.id === workspaceId);
}

function createWorkspaceTurnMetadata(projectPath: string): WorkspaceMetadata {
  return {
    id: "childworkspace",
    name: "workspace-turn",
    title: "Workspace turn",
    projectName: "repo",
    projectPath,
    runtimeConfig: { type: "local" },
    createdAt: "2026-06-19T00:00:00.000Z",
  };
}

async function workspaceGoalFileExists(config: Config, workspaceId: string): Promise<boolean> {
  try {
    await fsPromises.access(path.join(config.getSessionDir(workspaceId), "goal.json"));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function waitForWorkspaceTaskStatus(
  config: Config,
  workspaceId: string,
  expectedStatus: WorkspaceConfigEntry["taskStatus"],
  timeoutMs = 20_000
): Promise<void> {
  const start = Date.now();
  while (findWorkspaceInConfig(config, workspaceId)?.taskStatus !== expectedStatus) {
    if (Date.now() - start > timeoutMs) {
      const actualStatus = findWorkspaceInConfig(config, workspaceId)?.taskStatus;
      throw new Error(
        `Timed out waiting for workspace task status (workspaceId=${workspaceId}, expected=${String(expectedStatus)}, actual=${String(actualStatus)})`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForWorkspaceRemoval(
  config: Config,
  workspaceId: string,
  timeoutMs = 20_000
): Promise<void> {
  const start = Date.now();
  while (findWorkspaceInConfig(config, workspaceId)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for workspace cleanup (workspaceId=${workspaceId})`);
    }

    // Patch artifact readiness flips before the async cleanup recheck removes the child workspace.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function createNullInitLogger() {
  return {
    logStep: (_message: string) => undefined,
    logStdout: (_line: string) => undefined,
    logStderr: (_line: string) => undefined,
    logComplete: (_exitCode: number) => undefined,
    enterHookPhase: () => undefined,
  };
}

function createMockInitStateManager(): InitStateManager {
  return {
    startInit: mock(() => undefined),
    enterHookPhase: mock(() => undefined),
    appendOutput: mock(() => undefined),
    endInit: mock(() => Promise.resolve()),
    getInitState: mock(() => undefined),
    readInitStatus: mock(() => Promise.resolve(null)),
  } as unknown as InitStateManager;
}

async function createTestConfig(rootDir: string): Promise<Config> {
  const config = new Config(rootDir);
  await fsPromises.mkdir(config.srcDir, { recursive: true });
  return config;
}

async function createTestProject(
  rootDir: string,
  name = "repo",
  options?: { initGit?: boolean }
): Promise<string> {
  const projectPath = path.join(rootDir, name);
  await fsPromises.mkdir(projectPath, { recursive: true });
  if (options?.initGit ?? true) {
    initGitRepo(projectPath);
  }
  return projectPath;
}

type TestConfigOverrides = Omit<ProjectsConfig, "projects">;

type TestTaskSettings = NonNullable<ProjectsConfig["taskSettings"]>;

type SaveProjectWorkspacesOptions = TestConfigOverrides & {
  extraProjects?: Array<[string, ProjectConfig]>;
};

function testTaskSettings(maxParallelAgentTasks = 3, maxTaskNestingDepth = 3): TestTaskSettings {
  return { maxParallelAgentTasks, maxTaskNestingDepth };
}

function projectWorkspace(
  projectPath: string,
  directoryName: string,
  id: string,
  options: Omit<Partial<WorkspaceConfigEntry>, "id" | "path"> = {}
): WorkspaceConfigEntry {
  const { name = directoryName, ...workspaceOptions } = options;
  return {
    path: path.join(projectPath, directoryName),
    id,
    name,
    ...workspaceOptions,
  };
}

async function saveTestConfig(
  config: Config,
  projects: Array<[string, ProjectConfig]>,
  overrides: TestConfigOverrides = {}
): Promise<void> {
  await config.editConfig(() => ({
    projects: new Map(projects),
    ...overrides,
  }));
}

async function saveWorkspaces(
  config: Config,
  projectPath: string,
  workspaces: WorkspaceConfigEntry[],
  options: SaveProjectWorkspacesOptions | TestTaskSettings = {}
): Promise<void> {
  const normalizedOptions =
    "maxParallelAgentTasks" in options ? { taskSettings: options } : options;
  const { extraProjects = [], ...overrides } = normalizedOptions;
  await saveTestConfig(
    config,
    [[projectPath, { trusted: true, workspaces }], ...extraProjects],
    overrides
  );
}

async function saveLocalParentWorkspace(
  config: Config,
  rootDir: string,
  options?: {
    agentAiDefaults?: Record<string, { modelString?: string; thinkingLevel?: ThinkingLevel }>;
    subagentAiDefaults?: Record<string, { modelString?: string; thinkingLevel?: ThinkingLevel }>;
    parentAiSettings?: { model: string; thinkingLevel: ThinkingLevel };
  }
): Promise<{ parentId: string; projectPath: string }> {
  const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
  const parentId = "1111111111";
  await saveWorkspaces(
    config,
    projectPath,
    [
      {
        path: projectPath,
        id: parentId,
        name: "parent",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
        aiSettings: options?.parentAiSettings ?? {
          model: "anthropic:claude-opus-4-6",
          thinkingLevel: "high",
        },
      },
    ],
    {
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
      agentAiDefaults: options?.agentAiDefaults,
      subagentAiDefaults: options?.subagentAiDefaults,
      migrations: { execSubagentDefaultsSplit: true },
    }
  );
  return { parentId, projectPath };
}

function stubStableIds(config: Config, ids: string[], fallbackId = "fffffffff0"): void {
  let nextIdIndex = 0;
  const configWithStableId = config as unknown as { generateStableId: () => string };
  configWithStableId.generateStableId = () => ids[nextIdIndex++] ?? fallbackId;
}

function createAIServiceMocks(
  config: Config,
  overrides?: Partial<{
    isStreaming: ReturnType<typeof mock>;
    getWorkspaceMetadata: ReturnType<typeof mock>;
    stopStream: ReturnType<typeof mock>;
    createModel: ReturnType<typeof mock>;
    getStreamInfo: ReturnType<typeof mock>;
    getProvidersConfig: ReturnType<typeof mock>;
    on: ReturnType<typeof mock>;
    off: ReturnType<typeof mock>;
  }>
): {
  aiService: AIService;
  isStreaming: ReturnType<typeof mock>;
  getWorkspaceMetadata: ReturnType<typeof mock>;
  stopStream: ReturnType<typeof mock>;
  createModel: ReturnType<typeof mock>;
  getStreamInfo: ReturnType<typeof mock>;
  getProvidersConfig: ReturnType<typeof mock>;
  on: ReturnType<typeof mock>;
  off: ReturnType<typeof mock>;
} {
  const isStreaming = overrides?.isStreaming ?? mock(() => false);
  const getWorkspaceMetadata =
    overrides?.getWorkspaceMetadata ??
    mock(async (workspaceId: string): Promise<Result<WorkspaceMetadata>> => {
      const all = await config.getAllWorkspaceMetadata();
      const found = all.find((m) => m.id === workspaceId);
      return found ? Ok(found) : Err("not found");
    });

  const stopStream =
    overrides?.stopStream ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const createModel =
    overrides?.createModel ??
    mock((): Promise<Result<never>> => Promise.resolve(Err("createModel not mocked")));
  const getStreamInfo = overrides?.getStreamInfo ?? mock(() => undefined);
  const getProvidersConfig = overrides?.getProvidersConfig ?? mock(() => null);

  const on = overrides?.on ?? mock(() => undefined);
  const off = overrides?.off ?? mock(() => undefined);

  return {
    aiService: {
      isStreaming,
      getWorkspaceMetadata,
      stopStream,
      createModel,
      getStreamInfo,
      getProvidersConfig,
      on,
      off,
    } as unknown as AIService,
    isStreaming,
    getWorkspaceMetadata,
    stopStream,
    createModel,
    getStreamInfo,
    getProvidersConfig,
    on,
    off,
  };
}

async function createAgentTask(
  taskService: TaskService,
  parentWorkspaceId: string,
  prompt: string,
  options: Partial<Parameters<TaskService["create"]>[0]> = {}
) {
  return taskService.create({
    parentWorkspaceId,
    kind: "agent",
    agentType: "explore",
    prompt,
    title: "Test task",
    ...options,
  });
}

function createWorkspaceServiceMocks(
  overrides?: Partial<{
    sendMessage: ReturnType<typeof mock>;
    resumeStream: ReturnType<typeof mock>;
    clearQueue: ReturnType<typeof mock>;
    removeQueuedWorkspaceTurn: ReturnType<typeof mock>;
    removeQueuedMessagesByDedupeKeyPrefix: ReturnType<typeof mock>;
    hasQueuedWorkspaceTurn: ReturnType<typeof mock>;
    hasQueuedMessages: ReturnType<typeof mock>;
    getQueuedForegroundWaitInterruption: ReturnType<typeof mock>;
    consumeQueuedForegroundWaitInterruption: ReturnType<typeof mock>;
    isBusyForMessage: ReturnType<typeof mock>;
    hasPendingQueuedOrPreparingTurn: ReturnType<typeof mock>;
    hasPendingBashMonitorWakeContinuation: ReturnType<typeof mock>;
    hasPendingAutoRetry: ReturnType<typeof mock>;
    waitForIdleAndNoQueuedMessages: ReturnType<typeof mock>;
    waitForIdle: ReturnType<typeof mock>;
    waitForPendingStreamErrorRecoveryDecision: ReturnType<typeof mock>;
    archive: ReturnType<typeof mock>;
    retireToTranscript: ReturnType<typeof mock>;
    deleteWorktree: ReturnType<typeof mock>;
    remove: ReturnType<typeof mock>;
    emit: ReturnType<typeof mock>;
    getInfo: ReturnType<typeof mock>;
    replaceHistory: ReturnType<typeof mock>;
    updateAgentStatus: ReturnType<typeof mock>;
    isExperimentEnabled: ReturnType<typeof mock>;
    emitChatEvent: ReturnType<typeof mock>;
    isWorkflowInvocationCurrent: ReturnType<typeof mock>;
    interruptWorkspaceTurnStream: ReturnType<typeof mock>;
    updateTitle: ReturnType<typeof mock>;
    getActivityList: ReturnType<typeof mock>;
    create: ReturnType<typeof mock>;
  }>
): {
  interruptWorkspaceTurnStream: ReturnType<typeof mock>;
  getActivityList: ReturnType<typeof mock>;
  workspaceService: WorkspaceService;
  sendMessage: ReturnType<typeof mock>;
  resumeStream: ReturnType<typeof mock>;
  clearQueue: ReturnType<typeof mock>;
  removeQueuedWorkspaceTurn: ReturnType<typeof mock>;
  removeQueuedMessagesByDedupeKeyPrefix: ReturnType<typeof mock>;
  hasQueuedWorkspaceTurn: ReturnType<typeof mock>;
  hasQueuedMessages: ReturnType<typeof mock>;
  getQueuedForegroundWaitInterruption: ReturnType<typeof mock>;
  consumeQueuedForegroundWaitInterruption: ReturnType<typeof mock>;
  isBusyForMessage: ReturnType<typeof mock>;
  waitForIdleAndNoQueuedMessages: ReturnType<typeof mock>;
  waitForIdle: ReturnType<typeof mock>;
  hasPendingQueuedOrPreparingTurn: ReturnType<typeof mock>;
  hasPendingAutoRetry: ReturnType<typeof mock>;
  waitForPendingStreamErrorRecoveryDecision: ReturnType<typeof mock>;
  archive: ReturnType<typeof mock>;
  retireToTranscript: ReturnType<typeof mock>;
  deleteWorktree: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
  emit: ReturnType<typeof mock>;
  getInfo: ReturnType<typeof mock>;
  replaceHistory: ReturnType<typeof mock>;
  updateAgentStatus: ReturnType<typeof mock>;
  isExperimentEnabled: ReturnType<typeof mock>;
  emitChatEvent: ReturnType<typeof mock>;
  isWorkflowInvocationCurrent: ReturnType<typeof mock>;
  updateTitle: ReturnType<typeof mock>;
  create: ReturnType<typeof mock>;
} {
  const sendMessage =
    overrides?.sendMessage ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const resumeStream =
    overrides?.resumeStream ??
    mock((): Promise<Result<{ started: boolean }>> => Promise.resolve(Ok({ started: true })));
  const clearQueue = overrides?.clearQueue ?? mock((): Result<void> => Ok(undefined));
  const removeQueuedWorkspaceTurn =
    overrides?.removeQueuedWorkspaceTurn ?? mock((): Result<boolean> => Ok(true));
  const removeQueuedMessagesByDedupeKeyPrefix = mock((): Result<number> => Ok(0));
  const hasQueuedWorkspaceTurn = overrides?.hasQueuedWorkspaceTurn ?? mock(() => false);
  const hasQueuedMessages = overrides?.hasQueuedMessages ?? mock(() => false);
  const getQueuedForegroundWaitInterruption =
    overrides?.getQueuedForegroundWaitInterruption ?? mock(() => undefined);
  const consumeQueuedForegroundWaitInterruption =
    overrides?.consumeQueuedForegroundWaitInterruption ?? mock(() => false);
  const isBusyForMessage = overrides?.isBusyForMessage ?? mock(() => false);
  const hasPendingQueuedOrPreparingTurn =
    overrides?.hasPendingQueuedOrPreparingTurn ?? mock(() => false);
  const hasPendingBashMonitorWakeContinuation =
    overrides?.hasPendingBashMonitorWakeContinuation ?? mock(() => false);
  const hasPendingAutoRetry = overrides?.hasPendingAutoRetry ?? mock(() => false);
  const waitForIdleAndNoQueuedMessages =
    overrides?.waitForIdleAndNoQueuedMessages ?? mock((): Promise<void> => Promise.resolve());
  const waitForIdle = overrides?.waitForIdle ?? mock((): Promise<void> => Promise.resolve());
  const waitForPendingStreamErrorRecoveryDecision =
    overrides?.waitForPendingStreamErrorRecoveryDecision ??
    mock((): Promise<void> => Promise.resolve());
  const archive =
    overrides?.archive ??
    mock((): Promise<Result<{ kind: "archived" }>> => Promise.resolve(Ok({ kind: "archived" })));
  const retireToTranscript =
    overrides?.retireToTranscript ??
    mock(() =>
      Promise.resolve(
        Ok({ kind: "transcript-only" as const, cleanup: "worktree-deleted" as const })
      )
    );
  const deleteWorktree =
    overrides?.deleteWorktree ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const remove =
    overrides?.remove ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const emit = overrides?.emit ?? mock(() => true);
  const getInfo = overrides?.getInfo ?? mock(() => Promise.resolve(null));
  const replaceHistory =
    overrides?.replaceHistory ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const updateAgentStatus =
    overrides?.updateAgentStatus ?? mock((): Promise<void> => Promise.resolve());
  const isExperimentEnabled = overrides?.isExperimentEnabled ?? mock(() => false);
  const emitChatEvent =
    overrides?.emitChatEvent ??
    mock((_workspaceId: string, _message: WorkspaceChatMessage) => undefined);
  const isWorkflowInvocationCurrent =
    overrides?.isWorkflowInvocationCurrent ?? mock(() => Promise.resolve(true));

  const getActivityList =
    overrides?.getActivityList ??
    mock((): Promise<Record<string, WorkspaceActivitySnapshot>> => Promise.resolve({}));

  const interruptWorkspaceTurnStream =
    overrides?.interruptWorkspaceTurnStream ??
    mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));

  const updateTitle =
    overrides?.updateTitle ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));

  const create =
    overrides?.create ??
    mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Err("workspaceService.create not mocked"))
    );

  return {
    workspaceService: {
      interruptWorkspaceTurnStream,
      updateTitle,
      getActivityList,
      create,
      sendMessage,
      resumeStream,
      clearQueue,
      removeQueuedWorkspaceTurn,
      removeQueuedMessagesByDedupeKeyPrefix,
      isBusyForMessage,
      hasQueuedWorkspaceTurn,
      hasQueuedMessages,
      getQueuedForegroundWaitInterruption,
      consumeQueuedForegroundWaitInterruption,
      hasPendingQueuedOrPreparingTurn,
      hasPendingBashMonitorWakeContinuation,
      hasPendingAutoRetry,
      waitForIdleAndNoQueuedMessages,
      waitForIdle,
      waitForPendingStreamErrorRecoveryDecision,
      archive,
      retireToTranscript,
      deleteWorktree,
      remove,
      emit,
      getInfo,
      replaceHistory,
      updateAgentStatus,
      isExperimentEnabled,
      emitChatEvent,
      isWorkflowInvocationCurrent,
    } as unknown as WorkspaceService,
    interruptWorkspaceTurnStream,
    updateTitle,
    getActivityList,
    create,
    sendMessage,
    resumeStream,
    clearQueue,
    removeQueuedWorkspaceTurn,
    removeQueuedMessagesByDedupeKeyPrefix,
    hasQueuedWorkspaceTurn,
    hasQueuedMessages,
    getQueuedForegroundWaitInterruption,
    consumeQueuedForegroundWaitInterruption,
    isBusyForMessage,
    hasPendingQueuedOrPreparingTurn,
    hasPendingAutoRetry,
    waitForIdleAndNoQueuedMessages,
    waitForIdle,
    waitForPendingStreamErrorRecoveryDecision,
    archive,
    retireToTranscript,
    deleteWorktree,
    remove,
    emit,
    getInfo,
    replaceHistory,
    updateAgentStatus,
    isExperimentEnabled,
    emitChatEvent,
    isWorkflowInvocationCurrent,
  };
}

function createTaskServiceHarness(
  config: Config,
  overrides?: {
    aiService?: AIService;
    workspaceService?: WorkspaceService;
    initStateManager?: InitStateManager;
    sessionUsageService?: SessionUsageService;
    workspaceGoalService?: WorkspaceGoalService;
  }
): {
  historyService: HistoryService;
  partialService: HistoryService;
  taskService: TaskService;
  aiService: AIService;
  workspaceService: WorkspaceService;
  initStateManager: InitStateManager;
} {
  const historyService = new HistoryService(config);
  const partialService = historyService;

  const aiService = overrides?.aiService ?? createAIServiceMocks(config).aiService;
  const workspaceService =
    overrides?.workspaceService ?? createWorkspaceServiceMocks().workspaceService;
  const initStateManager = overrides?.initStateManager ?? createMockInitStateManager();

  const executionStore = new ExecutionStore(config);
  const executionRegistry = new ExecutionRegistry(config, { executionStore });
  const taskService = new TaskService(
    config,
    historyService,
    aiService,
    workspaceService,
    initStateManager,
    undefined,
    overrides?.sessionUsageService,
    overrides?.workspaceGoalService,
    { executionStore, executionRegistry }
  );

  return {
    historyService,
    partialService,
    taskService,
    aiService,
    workspaceService,
    initStateManager,
  };
}

describe("TaskService", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-taskService-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  test("scratch tasks share the managed workdir and stay in the scratch config bucket", async () => {
    const config = await createTestConfig(rootDir);
    const parentId = "1111111111";
    const childId = "2222222222";
    const scratchPath = path.join(config.rootDir, "scratch", parentId);
    await fsPromises.mkdir(scratchPath, { recursive: true });
    await saveTestConfig(
      config,
      [
        [
          SCRATCH_PROJECT_CONFIG_KEY,
          {
            projectKind: "system",
            trusted: true,
            workspaces: [
              {
                kind: "scratch",
                path: scratchPath,
                id: parentId,
                name: `scratch-${parentId}`,
                createdAt: new Date().toISOString(),
                runtimeConfig: { type: "local" },
                aiSettings: {
                  model: "anthropic:claude-opus-4-6",
                  thinkingLevel: "high",
                },
              },
            ],
          },
        ],
      ],
      { taskSettings: testTaskSettings() }
    );
    stubStableIds(config, [childId]);

    const workspaceMocks = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await createAgentTask(taskService, parentId, "Inspect the scratch files");

    expect(result).toMatchObject(
      Ok({
        workspaceId: childId,
        kind: "agent",
        status: "running",
        modelString: "anthropic:claude-opus-4-6",
        thinkingLevel: "high",
      })
    );
    expect(result.success && result.data.taskId).not.toBe(childId);
    const scratchProject = config.loadConfigOrDefault().projects.get(SCRATCH_PROJECT_CONFIG_KEY);
    const child = scratchProject?.workspaces.find((workspace) => workspace.id === childId);
    expect(child?.kind).toBe("scratch");
    expect(child?.path).toBe(scratchPath);
    expect(child?.taskIsolation).toBe("none");
    expect(child?.parentWorkspaceId).toBe(parentId);
    expect(config.loadConfigOrDefault().projects.has(scratchPath)).toBe(false);
    expect(workspaceMocks.sendMessage).toHaveBeenCalledWith(
      childId,
      "Inspect the scratch files",
      expect.any(Object),
      { agentInitiated: true }
    );
  });

  test("opaque execution ids retain nested scope and legacy workspace aliases", async () => {
    const config = await createTestConfig(rootDir);
    const parentId = "1111111111";
    const firstWorkspaceId = "2222222222";
    const nestedWorkspaceId = "3333333333";
    const scratchPath = path.join(config.rootDir, "scratch", parentId);
    await fsPromises.mkdir(scratchPath, { recursive: true });
    await saveTestConfig(
      config,
      [
        [
          SCRATCH_PROJECT_CONFIG_KEY,
          {
            projectKind: "system",
            trusted: true,
            workspaces: [
              {
                kind: "scratch",
                path: scratchPath,
                id: parentId,
                name: `scratch-${parentId}`,
                createdAt: new Date().toISOString(),
                runtimeConfig: { type: "local" },
                aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
              },
            ],
          },
        ],
      ],
      { taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 } }
    );
    stubStableIds(config, [firstWorkspaceId, nestedWorkspaceId]);

    const workspaceMocks = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });
    const first = await createAgentTask(taskService, parentId, "Inspect first");
    assert(first.success, "first task should be created");
    const nested = await createAgentTask(taskService, first.data.workspaceId, "Inspect nested");
    assert(nested.success, "nested task should be created");

    expect(first.data.taskId).not.toBe(first.data.workspaceId);
    expect(nested.data.taskId).not.toBe(nested.data.workspaceId);
    const registry = new ExecutionRegistry(config);
    const firstHandle = await registry.get(parentId, first.data.taskId);
    const nestedHandle = await registry.get(parentId, nested.data.taskId);
    expect(firstHandle).toMatchObject({
      executionId: first.data.taskId,
      ownerSessionId: parentId,
      requesterWorkspaceId: parentId,
      target: { workspaceId: firstWorkspaceId },
    });
    expect(nestedHandle).toMatchObject({
      executionId: nested.data.taskId,
      parentExecutionId: first.data.taskId,
      ownerSessionId: parentId,
      requesterWorkspaceId: firstWorkspaceId,
      target: { workspaceId: nestedWorkspaceId },
    });

    expect(
      (await taskService.listDescendantAgentTasks(parentId)).map((task) => ({
        taskId: task.taskId,
        workspaceId: task.workspaceId,
      }))
    ).toEqual([
      { taskId: first.data.taskId, workspaceId: firstWorkspaceId },
      { taskId: nested.data.taskId, workspaceId: nestedWorkspaceId },
    ]);
    expect(
      (await taskService.listDescendantAgentTasks(firstWorkspaceId)).map((task) => task.taskId)
    ).toEqual([nested.data.taskId]);

    const opaqueSend = await taskService.sendMessageToDescendantAgentTask(
      parentId,
      first.data.taskId,
      "Use canonical ids",
      "tool-end"
    );
    expect(opaqueSend.success).toBe(true);
    const aliasSend = await taskService.sendMessageToDescendantAgentTask(
      parentId,
      first.data.workspaceId,
      "Legacy alias still works",
      "tool-end"
    );
    expect(aliasSend.success).toBe(true);

    const terminated = await taskService.terminateDescendantAgentTask(parentId, first.data.taskId);
    expect(terminated).toEqual(Ok({ terminatedTaskIds: [nested.data.taskId, first.data.taskId] }));
    expect(await registry.get(parentId, first.data.taskId)).toMatchObject({
      status: "interrupted",
      result: { kind: "interrupted", message: "Task terminated" },
    });
    expect(await registry.get(parentId, nested.data.taskId)).toMatchObject({
      status: "interrupted",
      result: { kind: "interrupted", message: "Task terminated" },
    });
  });

  test("canonical final assistant text settles the execution with the latest valid report payload", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["canonical-child"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const workspaceMocks = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await createAgentTask(taskService, parentId, "Return a canonical result", {
      attentionPolicy: "notify_on_terminal",
    });
    assert(created.success, "canonical task should be created");

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: created.data.workspaceId,
      messageId: "assistant-canonical-final",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-valid",
          toolName: "agent_report",
          input: { reportMarkdown: "Structured candidate" },
          state: "output-available",
          output: {
            success: true,
            report: {
              reportMarkdown: "Structured candidate",
              structuredOutput: { claims: ["durable"] },
            },
          },
        },
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-invalid-newer",
          toolName: "agent_report",
          input: { reportMarkdown: "Invalid newer attempt" },
          state: "output-available",
          output: { success: false, error: "rejected" },
        },
        { type: "text", text: "Canonical final assistant text" },
      ],
    });

    const registry = new ExecutionRegistry(config);
    const handle = await registry.get(parentId, created.data.taskId);
    expect(handle).toMatchObject({
      executionId: created.data.taskId,
      status: "completed",
      result: {
        kind: "completed",
        reportMarkdown: "Canonical final assistant text",
        structuredOutput: { claims: ["durable"] },
      },
    });
    expect(
      await taskService.waitForAgentReport(created.data.taskId, {
        timeoutMs: 100,
        requestingWorkspaceId: parentId,
      })
    ).toMatchObject({
      reportMarkdown: "Canonical final assistant text",
      structuredOutput: { claims: ["durable"] },
    });
    expect(
      await taskService.getScopedExecutionSnapshot(parentId, created.data.workspaceId)
    ).toMatchObject({
      kind: "ok",
      source: "canonical",
      workspaceId: created.data.workspaceId,
      handle: {
        executionId: created.data.taskId,
        status: "completed",
        result: { kind: "completed", reportMarkdown: "Canonical final assistant text" },
      },
    });
    expect(
      await taskService.waitForScopedExecutionTerminal(parentId, created.data.taskId, {
        timeoutMs: 0,
      })
    ).toMatchObject({
      kind: "terminal",
      handle: {
        executionId: created.data.taskId,
        status: "completed",
      },
    });

    // A fresh service instance must resolve both the opaque ID and workspace alias from disk.
    const restartedTaskService = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    }).taskService;
    expect(
      await restartedTaskService.getScopedExecutionSnapshot(parentId, created.data.taskId)
    ).toMatchObject({
      kind: "ok",
      source: "canonical",
      handle: { status: "completed" },
    });
    expect(
      await restartedTaskService.waitForScopedExecutionTerminal(
        parentId,
        created.data.workspaceId,
        { timeoutMs: 0 }
      )
    ).toMatchObject({
      kind: "terminal",
      handle: { executionId: created.data.taskId, status: "completed" },
    });

    const parentHistory = await collectFullHistory(historyService, parentId);
    expect(parentHistory).toEqual([]);
    expect(
      await readSubagentReportArtifact(config.getSessionDir(parentId), created.data.workspaceId)
    ).toBeNull();
    const attentionStore = new TerminalAttentionStore(config);
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", created.data.taskId)
      )
    ).toMatchObject({
      sourceId: created.data.taskId,
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
    });
  });

  test("canonical required structured output failure is terminal without a recovery prompt", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["canonical-structured-error"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const workspaceMocks = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await createAgentTask(taskService, parentId, "Return required output", {
      workflowTask: {
        runId: "wfr_canonical",
        stepId: "collect",
        outputSchema: {
          type: "object",
          properties: { claims: { type: "array", items: { type: "string" } } },
          required: ["claims"],
          additionalProperties: false,
        },
      },
    });
    assert(created.success, "canonical workflow task should be created");
    workspaceMocks.sendMessage.mockClear();

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: created.data.workspaceId,
      messageId: "assistant-canonical-invalid-structured",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "Final text without required structured output" }],
    });

    const registry = new ExecutionRegistry(config);
    const handle = await registry.get(parentId, created.data.taskId);
    expect(handle).toMatchObject({
      status: "error",
      result: {
        kind: "error",
        errorType: "invalid_structured_output",
      },
    });
    expect(handle?.result?.kind === "error" ? handle.result.error : "").toContain(
      "Required property is missing"
    );
    expect(workspaceMocks.sendMessage).not.toHaveBeenCalled();
    expect(await collectFullHistory(historyService, parentId)).toEqual([]);
    const waitError = await taskService
      .waitForAgentReport(created.data.taskId, {
        timeoutMs: 100,
        requestingWorkspaceId: parentId,
      })
      .catch((error: unknown) => error);
    expect(waitError).toBeInstanceOf(Error);
    if (!(waitError instanceof Error)) throw new Error("Expected canonical wait to reject");
    expect(waitError.message).toContain("Required property is missing");
  });

  test("canonical missing final assistant text settles as an error without reprompting", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["canonical-missing-final"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const workspaceMocks = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await createAgentTask(taskService, parentId, "Return final text");
    assert(created.success, "canonical task should be created");
    workspaceMocks.sendMessage.mockClear();

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: created.data.workspaceId,
      messageId: "assistant-canonical-missing-final",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    const registry = new ExecutionRegistry(config);
    expect(await registry.get(parentId, created.data.taskId)).toMatchObject({
      status: "error",
      result: {
        kind: "error",
        error: "Task stream ended without final assistant text.",
        errorType: "missing_final_assistant_text",
      },
    });
    expect(workspaceMocks.sendMessage).not.toHaveBeenCalled();
  });

  test("create persists sticky retention only when requested", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["stickytask", "normaltask"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 };
      cfg.projects.get(projectPath)?.workspaces.push({
        path: projectPath,
        id: "activeblock",
        name: "agent_explore_activeblock",
        parentWorkspaceId: parentId,
        agentId: "explore",
        agentType: "explore",
        taskStatus: "running",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    const { taskService } = createTaskServiceHarness(config);

    const stickyResult = await createAgentTask(taskService, parentId, "Own the separate PR", {
      sticky: true,
    });
    const normalResult = await createAgentTask(taskService, parentId, "Do transient work");

    expect(stickyResult).toMatchObject({ success: true, data: { status: "queued" } });
    expect(normalResult).toMatchObject({ success: true, data: { status: "queued" } });
    expect(findWorkspaceInConfig(config, "stickytask")?.taskSticky).toBe(true);
    expect(findWorkspaceInConfig(config, "normaltask")?.taskSticky).toBeUndefined();
  });

  async function startWorkspaceTurnForTest(
    options: {
      stableIds?: string[];
      disposable?: boolean;
      sendMessage?: ReturnType<typeof mock>;
      remove?: ReturnType<typeof mock>;
      isStreaming?: ReturnType<typeof mock>;
      hasQueuedMessages?: ReturnType<typeof mock>;
      hasPendingQueuedOrPreparingTurn?: ReturnType<typeof mock>;
      hasPendingBashMonitorWakeContinuation?: ReturnType<typeof mock>;
      hasPendingAutoRetry?: ReturnType<typeof mock>;
      waitForPendingStreamErrorRecoveryDecision?: ReturnType<typeof mock>;
    } = {}
  ) {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, options.stableIds ?? ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-06-19T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
      }
    );
    const workspaceMocks = createWorkspaceServiceMocks({
      create: createWorkspace,
      ...(options.sendMessage != null ? { sendMessage: options.sendMessage } : {}),
      ...(options.remove != null ? { remove: options.remove } : {}),
      ...(options.hasQueuedMessages != null
        ? { hasQueuedMessages: options.hasQueuedMessages }
        : {}),
      ...(options.hasPendingQueuedOrPreparingTurn != null
        ? { hasPendingQueuedOrPreparingTurn: options.hasPendingQueuedOrPreparingTurn }
        : {}),
      ...(options.hasPendingBashMonitorWakeContinuation != null
        ? {
            hasPendingBashMonitorWakeContinuation: options.hasPendingBashMonitorWakeContinuation,
          }
        : {}),
      ...(options.hasPendingAutoRetry != null
        ? { hasPendingAutoRetry: options.hasPendingAutoRetry }
        : {}),
      ...(options.waitForPendingStreamErrorRecoveryDecision != null
        ? {
            waitForPendingStreamErrorRecoveryDecision:
              options.waitForPendingStreamErrorRecoveryDecision,
          }
        : {}),
    });
    const aiMocks = createAIServiceMocks(config, {
      ...(options.isStreaming != null ? { isStreaming: options.isStreaming } : {}),
    });
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new", ...(options.disposable === true ? { disposable: true } : {}) },
    });
    expect(created.success).toBe(true);
    if (!created.success) {
      throw new Error(created.error);
    }

    return {
      config,
      parentId,
      projectPath,
      taskService,
      workspaceMocks,
      aiMocks,
      historyService,
      created: {
        ...created.data,
        executionId: created.data.taskId,
        // Most service tests exercise internal stream correlation, which intentionally stays wst_.
        taskId: `wst_${options.stableIds?.[0] ?? "handle"}`,
      },
    };
  }

  async function createWorkspaceLifecycleHarness(
    options: { archived?: boolean; archive?: ReturnType<typeof mock> } = {}
  ) {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "child"),
        id: "childworkspace",
        name: "child",
        title: "Child workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
        ...(options.archived ? { archivedAt: new Date().toISOString() } : {}),
      });
      project.workspaces.push({
        path: path.join(projectPath, "unowned"),
        id: "unownedworkspace",
        name: "unowned",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const workspaceMocks = createWorkspaceServiceMocks({ archive: options.archive });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_created",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-created",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: true,
      disposableWorkspace: false,
      title: "Created child",
    });
    return { config, parentId, projectPath, taskService, taskHandleStore, ...workspaceMocks };
  }

  test("workspace lifecycle archives only parent-owned created workspace turns", async () => {
    const { parentId, taskService, archive } = await createWorkspaceLifecycleHarness();

    const archived = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined);

    const unowned = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "unownedworkspace" },
      {}
    );

    expect(unowned).toEqual(
      Ok({ status: "invalid_scope", action: "archive", workspaceId: "unownedworkspace" })
    );
  });

  test("workspace lifecycle treats canonical existing follow-up handles as owned when the workspace was created by the parent", async () => {
    const { parentId, taskService, archive } = await createWorkspaceLifecycleHarness();
    const now = new Date().toISOString();
    await (
      taskService as unknown as {
        persistWorkspaceTurnRecord: (record: WorkspaceTurnTaskHandleRecord) => Promise<void>;
      }
    ).persistWorkspaceTurnRecord({
      kind: "workspace_turn",
      executionId: "exe_existing",
      handleId: "wst_existing",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-existing",
      status: "completed",
      createdAt: now,
      updatedAt: now,
      createdWorkspace: false,
      disposableWorkspace: false,
      title: "Existing child",
      reportMarkdown: "Done",
    });

    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "exe_existing" },
      {}
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        taskId: "exe_existing",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined);
  });

  test("workspace lifecycle serializes concurrent handles that resolve to the same workspace", async () => {
    let archiveCallCount = 0;
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      archiveCallCount += 1;
      await Promise.resolve();
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before archive runs");
      assert(projectPath, "harness project path must be assigned before archive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.archivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
    const harness = await createWorkspaceLifecycleHarness({ archive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;
    await harness.taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_existing",
      ownerWorkspaceId: harness.parentId,
      workspaceId: "childworkspace",
      turnId: "turn-existing",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
      title: "Existing child",
    });

    const results = await Promise.all([
      harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
        harness.parentId,
        { taskId: "wst_created" },
        {}
      ),
      harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
        harness.parentId,
        { taskId: "wst_existing" },
        {}
      ),
    ]);

    expect(results.map((result) => (result.success ? result.data.status : "error")).sort()).toEqual(
      ["already_archived", "archived"]
    );
    expect(archiveCallCount).toBe(1);
  });

  test("workspace lifecycle rejects existing follow-up handles for workspaces this parent did not create", async () => {
    const { parentId, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_foreignexisting",
      ownerWorkspaceId: parentId,
      workspaceId: "unownedworkspace",
      turnId: "turn-foreign-existing",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
      title: "Unowned existing child",
    });

    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "wst_foreignexisting" },
      {}
    );

    expect(result).toEqual(
      Ok({
        status: "invalid_scope",
        action: "archive",
        taskId: "wst_foreignexisting",
        workspaceId: "unownedworkspace",
      })
    );
    expect(archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle gates destructive actions on archived state before active turns", async () => {
    const { parentId, taskService, taskHandleStore, deleteWorktree, remove } =
      await createWorkspaceLifecycleHarness();
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-running",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    });

    const deleteResult = await taskService.deleteOwnedWorkspaceTurnWorktree(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );
    const removeResult = await taskService.removeOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true, force: true }
    );

    expect(deleteResult).toEqual(
      Ok({
        status: "requires_archive",
        action: "delete_worktree",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(removeResult).toEqual(
      Ok({
        status: "requires_archive",
        action: "remove",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(deleteWorktree).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("workspace lifecycle returns archive confirmation and treats already archived as idempotent", async () => {
    const confirmationArchive = mock(
      (): Promise<Result<{ kind: "confirm-lossy-untracked-files"; paths: string[] }>> =>
        Promise.resolve(Ok({ kind: "confirm-lossy-untracked-files", paths: ["scratch.txt"] }))
    );
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "child"),
        id: "childworkspace",
        name: "child",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    const workspaceMocks = createWorkspaceServiceMocks({ archive: confirmationArchive });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_created",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-created",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: true,
      disposableWorkspace: false,
    });

    const confirmation = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { acknowledgedUntrackedPaths: ["scratch.txt"] }
    );

    expect(confirmation).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "child",
        paths: ["scratch.txt"],
      })
    );
    expect(confirmationArchive).toHaveBeenCalledWith("childworkspace", ["scratch.txt"]);

    const confirmationByTaskId = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "wst_created" },
      { acknowledgedUntrackedPathsByWorkspaceId: { childworkspace: ["task-scratch.txt"] } }
    );

    expect(confirmationByTaskId).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        taskId: "wst_created",
        workspaceId: "childworkspace",
        displayName: "child",
        paths: ["scratch.txt"],
      })
    );
    expect(confirmationArchive).toHaveBeenCalledWith("childworkspace", ["task-scratch.txt"]);

    await config.editConfig((cfg) => {
      const child = cfg.projects
        .get(projectPath)
        ?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.archivedAt = new Date().toISOString();
      return cfg;
    });
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-running",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    });

    const alreadyArchived = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(alreadyArchived).toEqual(
      Ok({
        status: "already_archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "child",
      })
    );
    expect(confirmationArchive).toHaveBeenCalledTimes(2);
  });

  test("workspace lifecycle requires explicit interruption for active archived workspace turns", async () => {
    const { parentId, taskService, taskHandleStore, archive, deleteWorktree } =
      await createWorkspaceLifecycleHarness({ archived: true });
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-running",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set("childworkspace", {
      handleId: "wst_running",
      ownerWorkspaceId: parentId,
    });

    const active = await taskService.deleteOwnedWorkspaceTurnWorktree(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(active).toEqual(
      Ok({
        status: "active",
        action: "delete_worktree",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        activeTaskIds: ["wst_running"],
      })
    );
    expect(deleteWorktree).not.toHaveBeenCalled();

    const interrupted = await taskService.deleteOwnedWorkspaceTurnWorktree(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(interrupted).toEqual(
      Ok({
        status: "deleted_worktree",
        action: "delete_worktree",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(deleteWorktree).toHaveBeenCalledWith("childworkspace");
    expect(archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle removes archived owned workspaces and treats missing metadata as already removed", async () => {
    const { config, parentId, taskService, remove } = await createWorkspaceLifecycleHarness({
      archived: true,
    });

    const removed = await taskService.removeOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { force: true }
    );

    expect(removed).toEqual(
      Ok({
        status: "removed",
        action: "remove",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(remove).toHaveBeenCalledWith("childworkspace", true);

    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        project.workspaces = project.workspaces.filter(
          (workspace) => workspace.id !== "childworkspace"
        );
      }
      return cfg;
    });

    const alreadyRemoved = await taskService.removeOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { force: true }
    );

    expect(alreadyRemoved).toEqual(
      Ok({ status: "already_removed", action: "remove", workspaceId: "childworkspace" })
    );
  });

  test("Project Chat can create and reuse ordinary same-project workspaces", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "repo");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "existing", "existingworkspace", {
          runtimeConfig: { type: "local" },
        }),
      ],
      { taskSettings: testTaskSettings(), defaultRuntime: "local" }
    );
    const projectChat = await config.ensureProjectChat(projectPath);
    stubStableIds(config, ["newhandle", "newturn", "existinghandle", "existingturn"]);

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        expect(args[0]).toBe(projectPath);
        expect(args[4]).toEqual({ type: "local" });
        expect(args[2]).toBeUndefined();
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push(
            projectWorkspace(projectPath, "created", "createdworkspace", {
              title: "Created from Project Chat",
              runtimeConfig: { type: "local" },
            })
          );
          return cfg;
        });
        return Ok({
          metadata: {
            ...createWorkspaceTurnMetadata(projectPath),
            id: "createdworkspace",
            name: "created",
          },
        });
      }
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    expect(taskService.isProjectChatOwner(projectChat.sessionId)).toBe(true);
    const created = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Create workspace",
      title: "Created from Project Chat",
      workspace: { mode: "new" },
    });
    expect(created).toMatchObject({
      success: true,
      data: { workspaceId: "createdworkspace", status: "running" },
    });

    const reused = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Continue existing workspace",
      title: "Existing task handle",
      workspace: {
        mode: "existing",
        workspaceId: "existingworkspace",
        title: "Renamed existing workspace",
      },
    });
    expect(reused).toMatchObject({
      success: true,
      data: { workspaceId: "existingworkspace", status: "running" },
    });
    expect(workspaceMocks.updateTitle).toHaveBeenCalledWith(
      "existingworkspace",
      "Renamed existing workspace"
    );
    expect(sendMessage.mock.calls.map((call) => call[0])).toEqual([
      "createdworkspace",
      "existingworkspace",
    ]);
    if (!reused.success) return;
    sendMessage.mockClear();
    await taskService.reportAgentProgress(
      reused.data.workspaceId,
      "existing-progress",
      { reportMarkdown: "Existing workspace update" },
      {
        handleId: reused.data.taskId,
        ownerWorkspaceId: projectChat.sessionId,
        turnId: "existingturn",
      }
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(parseSubagentReportEnvelope(sendMessage.mock.calls[0]?.[1] as string)).toMatchObject({
      taskId: reused.data.taskId,
      workspaceId: "existingworkspace",
      turnId: "existingturn",
      status: "in_progress",
    });
  });

  test("Project Chat passes every explicit runtime config through and explicit config beats defaults", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "runtime-overrides");
    await saveWorkspaces(config, projectPath, [], {
      taskSettings: { ...testTaskSettings(), maxParallelAgentTasks: 20 },
      defaultRuntime: "local",
    });
    const projectChat = await config.ensureProjectChat(projectPath);
    stubStableIds(config, [
      "localhandle",
      "localturn",
      "worktreehandle",
      "worktreeturn",
      "sshhandle",
      "sshturn",
      "coderhandle",
      "coderturn",
      "dockerhandle",
      "dockerturn",
      "devcontainerhandle",
      "devcontainerturn",
    ]);

    const runtimeConfigs: RuntimeConfig[] = [
      { type: "local" },
      { type: "worktree", srcBaseDir: "/tmp/project-chat-worktrees" },
      {
        type: "ssh",
        host: "devbox",
        srcBaseDir: "~/mux",
        identityFile: "~/.ssh/project",
        port: 2222,
      },
      {
        type: "ssh",
        host: "coder://",
        srcBaseDir: "~/mux",
        coder: { template: "ubuntu", templateOrg: "acme", preset: "large" },
      },
      { type: "docker", image: "node:20", shareCredentials: true },
      {
        type: "devcontainer",
        configPath: ".devcontainer/devcontainer.json",
        shareCredentials: true,
      },
    ];
    let workspaceNumber = 0;
    const createWorkspace = mock(
      (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const runtimeConfig = args[4] as RuntimeConfig | undefined;
        expect(runtimeConfig).toEqual(runtimeConfigs[workspaceNumber]);
        expect(args[2]).toBe(runtimeConfig?.type === "local" ? undefined : "main");
        expect(args[3]).toBe(`Workspace ${workspaceNumber + 1}`);
        workspaceNumber += 1;
        return Promise.resolve(
          Ok({
            metadata: {
              ...createWorkspaceTurnMetadata(projectPath),
              id: `childworkspace${workspaceNumber}`,
            },
          })
        );
      }
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    for (const [index, runtimeConfig] of runtimeConfigs.entries()) {
      const result = await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: `Create workspace ${index + 1}`,
        title: `Task handle ${index + 1}`,
        workspace: {
          mode: "new",
          title: `Workspace ${index + 1}`,
          runtimeConfig,
        },
      });
      expect(result.success).toBe(true);
    }

    expect(createWorkspace).toHaveBeenCalledTimes(runtimeConfigs.length);
  });

  test("Project Chat rejects runtime mutation on existing workspace turns", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "existing-runtime-rejection");
    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "existing", "existingworkspace")],
      testTaskSettings()
    );
    const projectChat = await config.ensureProjectChat(projectPath);
    const workspaceMocks = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Continue existing workspace",
      title: "Existing",
      workspace: {
        mode: "existing",
        workspaceId: "existingworkspace",
        runtimeConfig: { type: "local" },
      },
    });

    expect(result).toEqual(
      Err(
        'Task.createWorkspaceTurn: workspace.runtimeConfig is only accepted when workspace.mode="new"'
      )
    );
    expect(workspaceMocks.create).not.toHaveBeenCalled();
    expect(workspaceMocks.sendMessage).not.toHaveBeenCalled();
  });

  test("Project Chat uses project runtime defaults before global defaults when runtime is omitted", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "project-runtime-default");
    await saveWorkspaces(config, projectPath, [], {
      taskSettings: testTaskSettings(),
      defaultRuntime: "worktree",
    });
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.defaultRuntime = "local";
      return cfg;
    });
    const projectChat = await config.ensureProjectChat(projectPath);
    const createWorkspace = mock(
      (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        expect(args[2]).toBeUndefined();
        expect(args[4]).toEqual({ type: "local" });
        return Promise.resolve(Ok({ metadata: createWorkspaceTurnMetadata(projectPath) }));
      }
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Create with defaults",
      title: "Default runtime",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });

  test("parent Project Chat resolves runtime defaults from each exact logical target", async () => {
    const config = await createTestConfig(rootDir);
    const parentProjectPath = await createTestProject(rootDir, "runtime-default-parent");
    const worktreeChildPath = path.join(parentProjectPath, "packages", "worktree-child");
    const globalChildPath = path.join(parentProjectPath, "packages", "global-child");
    await fsPromises.mkdir(worktreeChildPath, { recursive: true });
    await fsPromises.mkdir(globalChildPath, { recursive: true });
    await saveTestConfig(
      config,
      [
        [parentProjectPath, { defaultRuntime: "local", trusted: true, workspaces: [] }],
        [worktreeChildPath, { defaultRuntime: "worktree", parentProjectPath, workspaces: [] }],
        [
          globalChildPath,
          {
            runtimeOverridesEnabled: true,
            parentProjectPath,
            workspaces: [],
          },
        ],
      ],
      { taskSettings: testTaskSettings(10), defaultRuntime: "docker" }
    );
    const projectChat = await config.ensureProjectChat(parentProjectPath);
    const createdWorkspaceIds = ["root-created", "worktree-created", "explicit-created"];
    const createWorkspace = mock(
      (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const workspaceId = createdWorkspaceIds.shift();
        assert(workspaceId, "unexpected workspace creation");
        return Promise.resolve(
          Ok({
            metadata: {
              ...createWorkspaceTurnMetadata(parentProjectPath),
              id: workspaceId,
              subProjectPath: args[5] as string | undefined,
            },
          })
        );
      }
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const rootResult = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Create in root",
      title: "Root runtime",
      workspace: { mode: "new" },
    });
    const worktreeChildResult = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Create in worktree child",
      title: "Worktree child runtime",
      workspace: { mode: "new", projectPath: worktreeChildPath },
    });
    const globalChildResult = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Create in global-default child",
      title: "Global child runtime",
      workspace: { mode: "new", projectPath: globalChildPath },
    });
    const explicitRuntime: RuntimeConfig = { type: "local" };
    const explicitChildResult = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Create in global-default child with explicit runtime",
      title: "Explicit child runtime",
      workspace: {
        mode: "new",
        projectPath: globalChildPath,
        runtimeConfig: explicitRuntime,
      },
    });

    expect(rootResult.success).toBe(true);
    expect(worktreeChildResult.success).toBe(true);
    expect(globalChildResult).toEqual(
      Err(
        "Task.createWorkspaceTurn: the default docker runtime requires frontend-only remembered configuration; pass workspace.runtimeConfig explicitly"
      )
    );
    expect(explicitChildResult.success).toBe(true);
    expect(createWorkspace).toHaveBeenCalledTimes(3);

    const [rootCreate, worktreeChildCreate, explicitChildCreate] = createWorkspace.mock.calls;
    expect(rootCreate?.[0]).toBe(parentProjectPath);
    expect(rootCreate?.[2]).toBeUndefined();
    expect(rootCreate?.[4]).toEqual({ type: "local" });
    expect(rootCreate?.[5]).toBeUndefined();

    expect(worktreeChildCreate?.[0]).toBe(parentProjectPath);
    expect(worktreeChildCreate?.[2]).toBe("main");
    expect(worktreeChildCreate?.[4]).toBeUndefined();
    expect(worktreeChildCreate?.[5]).toBe(worktreeChildPath);

    expect(explicitChildCreate?.[0]).toBe(parentProjectPath);
    expect(explicitChildCreate?.[2]).toBeUndefined();
    expect(explicitChildCreate?.[4]).toEqual(explicitRuntime);
    expect(explicitChildCreate?.[5]).toBe(globalChildPath);
  });

  test("Project Chat discovers the first devcontainer config for an omitted devcontainer default", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "devcontainer-default");
    await fsPromises.mkdir(path.join(projectPath, ".devcontainer"), { recursive: true });
    await fsPromises.writeFile(
      path.join(projectPath, ".devcontainer", "devcontainer.json"),
      "{}",
      "utf8"
    );
    await saveWorkspaces(config, projectPath, [], {
      taskSettings: testTaskSettings(),
      defaultRuntime: "devcontainer",
    });
    const projectChat = await config.ensureProjectChat(projectPath);
    const createWorkspace = mock(
      (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        expect(args[2]).toBe("main");
        expect(args[4]).toEqual({
          type: "devcontainer",
          configPath: ".devcontainer/devcontainer.json",
        });
        return Promise.resolve(Ok({ metadata: createWorkspaceTurnMetadata(projectPath) }));
      }
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Create devcontainer workspace",
      title: "Devcontainer default",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });

  test("Project Chat does not silently replace an explicit worktree runtime on non-Git projects", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "explicit-worktree-non-git", {
      initGit: false,
    });
    await saveWorkspaces(config, projectPath, [], {
      taskSettings: testTaskSettings(),
      defaultRuntime: "local",
    });
    const projectChat = await config.ensureProjectChat(projectPath);
    const explicitRuntime: RuntimeConfig = {
      type: "worktree",
      srcBaseDir: "/tmp/project-chat-worktrees",
    };
    const createWorkspace = mock(
      (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        expect(args[2]).toBeUndefined();
        expect(args[4]).toEqual(explicitRuntime);
        return Promise.resolve(Err("Trunk branch is required for worktree and SSH runtimes"));
      }
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Create explicit worktree",
      title: "Explicit worktree",
      workspace: { mode: "new", runtimeConfig: explicitRuntime },
    });

    expect(result).toEqual(
      Err(
        "Task.createWorkspaceTurn: workspace create failed (Trunk branch is required for worktree and SSH runtimes)"
      )
    );
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });

  test("Project Chat propagates Git branch discovery failures instead of dropping to local", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "branch-discovery-failure");
    await saveWorkspaces(config, projectPath, [], {
      taskSettings: testTaskSettings(),
      defaultRuntime: "worktree",
    });
    const projectChat = await config.ensureProjectChat(projectPath);
    const workspaceMocks = createWorkspaceServiceMocks();
    const listBranches = spyOn(gitModule, "listLocalBranches").mockRejectedValueOnce(
      new Error("git unavailable")
    );
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    try {
      const result = await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: "Create workspace",
        title: "Branch discovery",
        workspace: { mode: "new" },
      });

      expect(result).toEqual(
        Err("Task.createWorkspaceTurn: failed to inspect Git branches (git unavailable)")
      );
      expect(workspaceMocks.create).not.toHaveBeenCalled();
    } finally {
      listBranches.mockRestore();
    }
  });

  test("Project Chat propagates enclosing Git repository inspection failures", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "git-inspection-failure");
    await saveWorkspaces(config, projectPath, [], {
      taskSettings: testTaskSettings(),
      defaultRuntime: "worktree",
    });
    const projectChat = await config.ensureProjectChat(projectPath);
    const workspaceMocks = createWorkspaceServiceMocks();
    const inspectGit = spyOn(pathUtilsModule, "inspectInsideGitRepository").mockRejectedValueOnce(
      new Error("permission denied")
    );
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    try {
      const result = await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: "Create workspace",
        title: "Git inspection failure",
        workspace: { mode: "new" },
      });

      expect(result).toEqual(
        Err("Task.createWorkspaceTurn: failed to inspect Git repository (permission denied)")
      );
      expect(workspaceMocks.create).not.toHaveBeenCalled();
    } finally {
      inspectGit.mockRestore();
    }
  });

  test("Project Chat uses worktrees for standalone projects nested in an enclosing repository", async () => {
    const config = await createTestConfig(rootDir);
    const repositoryPath = await createTestProject(rootDir, "enclosing-repo");
    const projectPath = path.join(repositoryPath, "packages", "web");
    await fsPromises.mkdir(projectPath, { recursive: true });
    await saveWorkspaces(config, projectPath, [], {
      taskSettings: testTaskSettings(),
      defaultRuntime: "worktree",
    });
    const projectChat = await config.ensureProjectChat(projectPath);
    const createWorkspace = mock(
      (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        expect(args[0]).toBe(projectPath);
        expect(args[2]).toBe("main");
        expect(args[4]).toBeUndefined();
        return Promise.resolve(Ok({ metadata: createWorkspaceTurnMetadata(projectPath) }));
      }
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: createWorkspaceServiceMocks({ create: createWorkspace, sendMessage })
        .workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Create workspace",
      title: "Nested project",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });

  test("Project Chat rejects unsupported automatic workspace runtime defaults", async () => {
    const unsupportedDefaults = ["ssh", "coder", "docker", "devcontainer"] as const;

    for (const defaultRuntime of unsupportedDefaults) {
      const config = await createTestConfig(path.join(rootDir, defaultRuntime));
      const projectPath = await createTestProject(config.rootDir, `repo-${defaultRuntime}`);
      await saveWorkspaces(config, projectPath, [], {
        taskSettings: testTaskSettings(),
        defaultRuntime,
      });
      const projectChat = await config.ensureProjectChat(projectPath);
      const workspaceMocks = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, {
        workspaceService: workspaceMocks.workspaceService,
      });

      const result = await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: "Create workspace",
        title: "Unsupported runtime",
        workspace: { mode: "new" },
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected unsupported runtime rejection");
      expect(result.error).toContain(defaultRuntime);
      expect(workspaceMocks.create).not.toHaveBeenCalled();
    }
  });

  test("Project Chat cleanup interrupts every active owned workspace turn before deleting handles", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "cleanup-owner", { initGit: false });
    await saveWorkspaces(config, projectPath, [], testTaskSettings());
    const projectChat = await config.ensureProjectChat(projectPath);
    const streamingWorkspaceIds = new Set([
      "activeworkspace",
      "startingworkspace",
      "foreignworkspace",
    ]);
    const isStreaming = mock((workspaceId: string) => streamingWorkspaceIds.has(workspaceId));
    const interruptWorkspaceTurnStream = mock((workspaceId: string): Promise<Result<void>> => {
      streamingWorkspaceIds.delete(workspaceId);
      return Promise.resolve(Ok(undefined));
    });
    const operations: string[] = [];
    const hasQueuedWorkspaceTurn = mock(
      (_workspaceId: string, handleId: string) => handleId === "wst_queued"
    );
    const removeQueuedWorkspaceTurn = mock(
      (_workspaceId: string, handleId: string): Result<boolean> => {
        operations.push(`cancel:${handleId}`);
        return Ok(true);
      }
    );
    const waitForIdleAndNoQueuedMessages = mock((workspaceId: string): Promise<void> => {
      operations.push(`idle:${workspaceId}`);
      return Promise.resolve();
    });
    const workspaceMocks = createWorkspaceServiceMocks({
      interruptWorkspaceTurnStream,
      hasQueuedWorkspaceTurn,
      removeQueuedWorkspaceTurn,
      waitForIdleAndNoQueuedMessages,
    });
    const aiMocks = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });
    const store = new TaskHandleStore(config);
    const baseRecord = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: projectChat.sessionId,
      turnId: "turn",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    };
    await store.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_active",
      workspaceId: "activeworkspace",
      status: "running",
    });
    await store.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_queued",
      workspaceId: "activeworkspace",
      status: "queued",
      createdAt: "2026-08-06T00:00:01.000Z",
      updatedAt: "2026-08-06T00:00:01.000Z",
    });
    await store.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_starting",
      workspaceId: "startingworkspace",
      status: "starting",
    });
    await store.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_completed",
      workspaceId: "completedworkspace",
      status: "completed",
    });
    await store.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_foreign",
      ownerWorkspaceId: "ordinary-owner",
      workspaceId: "foreignworkspace",
      status: "running",
    });

    using _projectSessionRoute = config.retainProjectSessionRouting(projectChat.sessionId);
    await config.editConfig((cfg) => {
      cfg.projects.delete(projectPath);
      return cfg;
    });

    expect(await taskService.interruptAllWorkspaceTurnsForOwner(projectChat.sessionId)).toEqual(
      Ok(undefined)
    );
    expect(
      Object.fromEntries(
        (await store.listWorkspaceTurns(projectChat.sessionId)).map((record) => [
          record.handleId,
          record.status,
        ])
      )
    ).toEqual({
      wst_active: "interrupted",
      wst_queued: "interrupted",
      wst_starting: "interrupted",
      wst_completed: "completed",
    });
    expect(await store.getWorkspaceTurn("ordinary-owner", "wst_foreign")).toMatchObject({
      status: "running",
      workspaceId: "foreignworkspace",
    });
    expect(operations.indexOf("cancel:wst_queued")).toBeLessThan(
      operations.indexOf("idle:activeworkspace")
    );
    expect(waitForIdleAndNoQueuedMessages).toHaveBeenCalledTimes(2);
    expect(interruptWorkspaceTurnStream).toHaveBeenCalledWith("activeworkspace");
    expect(interruptWorkspaceTurnStream).toHaveBeenCalledWith("startingworkspace");
    expect(
      fsPromises.access(path.join(config.sessionsDir, projectChat.sessionId))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("Project Chat owner cleanup fails when an owned workspace does not become idle", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "cleanup-busy-owner", {
      initGit: false,
    });
    await saveWorkspaces(config, projectPath, [], testTaskSettings());
    const projectChat = await config.ensureProjectChat(projectPath);
    const waitForIdleAndNoQueuedMessages = mock(() => Promise.resolve());
    const workspaceMocks = createWorkspaceServiceMocks({
      waitForIdleAndNoQueuedMessages,
      interruptWorkspaceTurnStream: mock(() => Promise.resolve(Err("stream stop failed"))),
    });
    const aiMocks = createAIServiceMocks(config, {
      isStreaming: mock(() => true),
    });
    const { taskService } = createTaskServiceHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });
    const store = new TaskHandleStore(config);
    await store.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_busy",
      ownerWorkspaceId: projectChat.sessionId,
      workspaceId: "busyworkspace",
      turnId: "turn",
      status: "running",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    });

    const result = await taskService.interruptAllWorkspaceTurnsForOwner(projectChat.sessionId);

    expect(result).toEqual(Err("Owned workspace busyworkspace is still active after interruption"));
    expect(waitForIdleAndNoQueuedMessages).toHaveBeenCalledWith("busyworkspace");
    expect(await store.getWorkspaceTurn(projectChat.sessionId, "wst_busy")).toMatchObject({
      status: "interrupted",
    });
  });

  test("sub-project Project Chat reuses and lists workspaces from the parent storage bucket", async () => {
    const config = await createTestConfig(rootDir);
    const parentProjectPath = await createTestProject(rootDir, "repo");
    const subProjectPath = path.join(parentProjectPath, "packages", "web");
    await fsPromises.mkdir(subProjectPath, { recursive: true });
    await saveTestConfig(
      config,
      [
        [
          parentProjectPath,
          {
            defaultRuntime: "worktree",
            trusted: true,
            workspaces: [
              projectWorkspace(parentProjectPath, "parent", "parentworkspace", {
                runtimeConfig: { type: "local" },
              }),
            ],
          },
        ],
        [
          subProjectPath,
          {
            defaultRuntime: "local",
            parentProjectPath,
            workspaces: [
              projectWorkspace(parentProjectPath, "subproject", "subprojectworkspace", {
                runtimeConfig: { type: "local" },
              }),
            ],
          },
        ],
      ],
      { taskSettings: testTaskSettings(), defaultRuntime: "local" }
    );
    const projectChat = await config.ensureProjectChat(subProjectPath);
    stubStableIds(config, ["newhandle", "newturn", "existinghandle", "existingturn"]);
    const createWorkspace = mock(
      (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        expect(args[2]).toBeUndefined();
        expect(args[4]).toEqual({ type: "local" });
        expect(args[0]).toBe(parentProjectPath);
        expect(args[5]).toBe(subProjectPath);
        return Promise.resolve(
          Ok({
            metadata: {
              ...createWorkspaceTurnMetadata(parentProjectPath),
              id: "createdsubproject",
              name: "created-subproject",
              subProjectPath,
            },
          })
        );
      }
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: createWorkspaceServiceMocks({ create: createWorkspace, sendMessage })
        .workspaceService,
    });

    expect(
      await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: "Create sub-project workspace",
        title: "Sub-project implementation",
        workspace: { mode: "new" },
      })
    ).toMatchObject({
      success: true,
      data: { workspaceId: "createdsubproject", status: "running" },
    });
    expect(
      await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: "Continue sub-project workspace",
        title: "Sub-project follow-up",
        workspace: { mode: "existing", workspaceId: "subprojectworkspace" },
      })
    ).toMatchObject({
      success: true,
      data: { workspaceId: "subprojectworkspace", status: "running" },
    });
    expect(
      await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: "Do not cross into the parent project scope",
        title: "Parent workspace",
        workspace: { mode: "existing", workspaceId: "parentworkspace" },
      })
    ).toEqual(Err("Task.createWorkspaceTurn: invalid_scope for existing workspace"));
    expect(
      await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: "Do not create in the parent project scope",
        title: "Parent creation",
        workspace: { mode: "new", projectPath: parentProjectPath },
      })
    ).toEqual(Err(`Task.createWorkspaceTurn: invalid_scope for project path ${parentProjectPath}`));
    expect(sendMessage.mock.calls.map((call) => call[0])).toEqual([
      "createdsubproject",
      "subprojectworkspace",
    ]);

    const listed = await taskService.listProjectWorkspaces(projectChat.sessionId);
    expect(listed.success).toBe(true);
    if (!listed.success) throw new Error(listed.error);
    expect(listed.data.projectPath).toBe(subProjectPath);
    expect(listed.data.availableProjects).toEqual([
      { projectPath: subProjectPath, displayName: "web", kind: "sub_project" },
    ]);
    expect(listed.data.workspaces).toHaveLength(1);
    expect(listed.data.workspaces[0]).toMatchObject({
      workspaceId: "subprojectworkspace",
      projectPath: subProjectPath,
      projectDisplayName: "web",
      subProjectPath,
      name: "subproject",
      archived: false,
      workspaceTurn: {
        status: "running",
        title: "Sub-project follow-up",
      },
    });
    expect(listed.data.workspaces[0]?.workspaceTurn?.taskId).toMatch(/^exe_/);
    expect(typeof listed.data.workspaces[0]?.workspaceTurn?.updatedAt).toBe("string");
  });

  test("parent Project Chat creates, reuses, and lifecycle-manages direct child workspaces", async () => {
    const config = await createTestConfig(rootDir);
    const parentProjectPath = await createTestProject(rootDir, "parent-coordinator", {
      initGit: false,
    });
    const subProjectPath = path.join(parentProjectPath, "packages", "web");
    await fsPromises.mkdir(subProjectPath, { recursive: true });
    await saveTestConfig(
      config,
      [
        [
          parentProjectPath,
          {
            defaultRuntime: "local",
            trusted: true,
            workspaces: [
              projectWorkspace(parentProjectPath, "root", "rootworkspace", {
                runtimeConfig: { type: "local" },
              }),
              projectWorkspace(parentProjectPath, "child", "childworkspace", {
                runtimeConfig: { type: "local" },
                subProjectPath,
              }),
              projectWorkspace(parentProjectPath, "lifecycle", "childlifecycle", {
                runtimeConfig: { type: "local" },
                subProjectPath,
              }),
            ],
          },
        ],
        [subProjectPath, { defaultRuntime: "worktree", parentProjectPath, workspaces: [] }],
      ],
      { taskSettings: testTaskSettings(), defaultRuntime: "worktree" }
    );
    const projectChat = await config.ensureProjectChat(parentProjectPath);
    stubStableIds(config, ["newhandle", "newturn", "existinghandle", "existingturn"]);
    const createWorkspace = mock(
      (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        expect(args[0]).toBe(parentProjectPath);
        expect(args[2]).toBeUndefined();
        expect(args[4]).toEqual({ type: "local" });
        expect(args[5]).toBe(subProjectPath);
        return Promise.resolve(
          Ok({
            metadata: {
              ...createWorkspaceTurnMetadata(parentProjectPath),
              id: "createdchild",
              name: "created-child",
              subProjectPath,
            },
          })
        );
      }
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const archive = mock(() => Promise.resolve(Ok({ kind: "archived" as const })));
    const workspaceMocks = createWorkspaceServiceMocks({
      create: createWorkspace,
      sendMessage,
      archive,
    });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    expect(
      await taskService.archiveOwnedWorkspaceTurnWorkspace(projectChat.sessionId, {
        workspaceId: "childlifecycle",
      })
    ).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childlifecycle",
        displayName: "lifecycle",
      })
    );
    expect(
      await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: "Create in child",
        title: "Child creation",
        workspace: { mode: "new", projectPath: subProjectPath },
      })
    ).toMatchObject({ success: true, data: { workspaceId: "createdchild" } });
    expect(
      await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: "Continue child",
        title: "Child reuse",
        workspace: { mode: "existing", workspaceId: "childworkspace" },
      })
    ).toMatchObject({ success: true, data: { workspaceId: "childworkspace" } });
    expect(sendMessage.mock.calls.map((call) => call[0])).toEqual([
      "createdchild",
      "childworkspace",
    ]);
  });

  test("Project Chat lifecycle revalidates exact sub-project ownership after locking", async () => {
    const config = await createTestConfig(rootDir);
    const parentProjectPath = await createTestProject(rootDir, "lifecycle-parent", {
      initGit: false,
    });
    const subProjectPath = path.join(parentProjectPath, "packages", "web");
    const workspacePath = path.join(parentProjectPath, "workspace");
    await fsPromises.mkdir(subProjectPath, { recursive: true });
    await fsPromises.mkdir(workspacePath, { recursive: true });
    await saveTestConfig(
      config,
      [
        [
          parentProjectPath,
          {
            trusted: true,
            workspaces: [
              projectWorkspace(parentProjectPath, "workspace", "workspace", {
                runtimeConfig: { type: "local" },
                subProjectPath,
              }),
            ],
          },
        ],
        [subProjectPath, { parentProjectPath: parentProjectPath, workspaces: [] }],
      ],
      { taskSettings: testTaskSettings() }
    );
    const projectChat = await config.ensureProjectChat(subProjectPath);
    const archive = mock(() => Promise.resolve(Ok({ kind: "archived" as const })));
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: createWorkspaceServiceMocks({ archive }).workspaceService,
    });
    type LifecycleResolution =
      | { status: string }
      | {
          action: "archive" | "delete_worktree" | "remove";
          taskId?: string;
          taskTitle?: string;
          ownerKind: "project_chat" | "workspace";
          workspaceId: string;
          metadata: WorkspaceMetadata | null;
        };
    const internal = taskService as unknown as {
      resolveOwnedWorkspaceLifecycleTarget: (
        ownerWorkspaceId: string,
        action: "archive" | "delete_worktree" | "remove",
        target: { taskId?: string; workspaceId?: string }
      ) => Promise<LifecycleResolution>;
    };
    const resolveTarget = internal.resolveOwnedWorkspaceLifecycleTarget.bind(taskService);
    internal.resolveOwnedWorkspaceLifecycleTarget = async (...args) => {
      const resolved = await resolveTarget(...args);
      if (!("status" in resolved)) {
        await config.editConfig((cfg) => {
          const parent = cfg.projects.get(parentProjectPath);
          const workspace = parent?.workspaces.find((entry) => entry.id === "workspace");
          if (workspace) {
            workspace.subProjectPath = undefined;
          }
          cfg.projects.delete(subProjectPath);
          return cfg;
        });
      }
      return resolved;
    };

    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(projectChat.sessionId, {
      workspaceId: "workspace",
    });

    expect(result).toEqual(
      Ok({
        status: "invalid_scope",
        action: "archive",
        workspaceId: "workspace",
      })
    );
    expect(archive).not.toHaveBeenCalled();
  });

  test("Project Chat bulk workspace list returns parent and child scopes with latest turn state", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const subProjectPath = path.join(projectPath, "packages", "web");
    const emptySubProjectPath = path.join(projectPath, "packages", "empty-child");
    await fsPromises.mkdir(subProjectPath, { recursive: true });
    await fsPromises.mkdir(emptySubProjectPath, { recursive: true });
    const otherProjectPath = await createTestProject(rootDir, "other", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "active", "activeworkspace", {
          title: "Active workspace",
          createdAt: "2026-08-01T00:00:00.000Z",
          runtimeConfig: { type: "local" },
          agentId: "researcher",
          aiSettingsByAgent: {
            exec: {
              model: "openai:gpt-5.6-sol",
              thinkingLevel: "high",
              reasoningMode: "pro",
            },
            researcher: {
              model: "anthropic:claude-opus-4-6",
              thinkingLevel: "low",
            },
          },
        }),
        projectWorkspace(projectPath, "fallback", "fallbackworkspace", {
          createdAt: "2026-08-06T02:00:00.000Z",
          runtimeConfig: { type: "local" },
          archivedAt: "2026-08-06T02:15:00.000Z",
          unarchivedAt: "2026-08-06T02:30:00.000Z",
        }),
        projectWorkspace(projectPath, "archived", "archivedworkspace", {
          createdAt: "2026-08-05T00:00:00.000Z",
          runtimeConfig: { type: "local" },
          archivedAt: "2026-08-05T00:00:00.000Z",
        }),
        projectWorkspace(projectPath, "child", "childworkspace", {
          createdAt: "2026-08-01T00:00:00.000Z",
          runtimeConfig: { type: "local" },
          subProjectPath,
        }),
        projectWorkspace(projectPath, "subagent", "subagent", {
          runtimeConfig: { type: "local" },
          parentWorkspaceId: "activeworkspace",
          taskStatus: "running",
        }),
      ],
      {
        taskSettings: testTaskSettings(),
        extraProjects: [
          [emptySubProjectPath, { parentProjectPath: projectPath, workspaces: [] }],
          [subProjectPath, { parentProjectPath: projectPath, workspaces: [] }],
          [
            otherProjectPath,
            {
              trusted: true,
              workspaces: [
                projectWorkspace(otherProjectPath, "foreign", "foreign", {
                  runtimeConfig: { type: "local" },
                }),
              ],
            },
          ],
        ],
      }
    );
    const projectChat = await config.ensureProjectChat(projectPath);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_active",
      ownerWorkspaceId: projectChat.sessionId,
      workspaceId: "activeworkspace",
      turnId: "turn-active",
      status: "completed",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:01:00.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      title: "Active turn",
      prompt: "Continue the active implementation",
    });
    const getActivityList = mock(() =>
      Promise.resolve({
        activeworkspace: {
          recency: Date.parse("2026-08-06T03:00:00.000Z"),
          streaming: false,
          lastModel: "openai:gpt-5.6-sol",
          lastThinkingLevel: "high" as const,
        },
      })
    );
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: createWorkspaceServiceMocks({ getActivityList }).workspaceService,
    });

    const listed = await taskService.listProjectWorkspaces(projectChat.sessionId);
    expect(listed.success).toBe(true);
    if (!listed.success) throw new Error(listed.error);
    expect(getActivityList).toHaveBeenCalledTimes(1);
    expect(listed.data.projectPath).toBe(projectPath);
    expect(listed.data.availableProjects).toEqual([
      { projectPath, displayName: "repo", kind: "parent" },
      {
        projectPath: emptySubProjectPath,
        displayName: "empty-child",
        kind: "sub_project",
      },
      { projectPath: subProjectPath, displayName: "web", kind: "sub_project" },
    ]);
    expect(listed.data.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "activeworkspace",
      "fallbackworkspace",
      "childworkspace",
      "archivedworkspace",
    ]);
    expect(listed.data.workspaces[0]).toMatchObject({
      workspaceId: "activeworkspace",
      name: "active",
      projectPath,
      projectDisplayName: "repo",
      subProjectPath: null,
      title: "Active workspace",
      archived: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      lastActivityAt: "2026-08-06T03:00:00.000Z",
      updatedAt: "2026-08-06T03:00:00.000Z",
      runtimeConfig: { type: "local" },
      execAiSettings: {
        model: "openai:gpt-5.6-sol",
        thinkingLevel: "high",
        reasoningMode: "pro",
      },
      workspaceTurn: {
        taskId: "wst_active",
        status: "completed",
        title: "Active turn",
        prompt: "Continue the active implementation",
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:01:00.000Z",
      },
    });
    expect(listed.data.workspaces[1]).toMatchObject({
      workspaceId: "fallbackworkspace",
      lastActivityAt: "2026-08-06T02:30:00.000Z",
      updatedAt: "2026-08-06T02:30:00.000Z",
    });
    expect(listed.data.workspaces[2]).toMatchObject({
      workspaceId: "childworkspace",
      projectPath: subProjectPath,
      projectDisplayName: "web",
      subProjectPath,
    });

    const childOnly = await taskService.listProjectWorkspaces(projectChat.sessionId, {
      projectPath: subProjectPath,
    });
    expect(childOnly.success).toBe(true);
    if (!childOnly.success) throw new Error(childOnly.error);
    expect(childOnly.data.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "childworkspace",
    ]);

    expect(
      await taskService.listProjectWorkspaces(projectChat.sessionId, {
        projectPath: path.join(projectPath, "unregistered"),
      })
    ).toEqual(
      Err(
        `project_workspace_list: invalid_scope for project_path ${path.join(projectPath, "unregistered")}; use an exact projectPath from availableProjects`
      )
    );

    const activeOnly = await taskService.listProjectWorkspaces(projectChat.sessionId, {
      includeArchived: false,
    });
    expect(activeOnly.success).toBe(true);
    if (!activeOnly.success) throw new Error(activeOnly.error);
    expect(activeOnly.data.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "activeworkspace",
      "fallbackworkspace",
      "childworkspace",
    ]);
  });

  test("Project Chat rejects invalid existing workspace scopes", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const otherProjectPath = await createTestProject(rootDir, "other", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "ordinary", "ordinary", {
          runtimeConfig: { type: "local" },
        }),
        projectWorkspace(projectPath, "subagent", "subagent", {
          runtimeConfig: { type: "local" },
          parentWorkspaceId: "ordinary",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "multi", "multi", {
          runtimeConfig: { type: "local" },
          projects: [
            { projectPath, projectName: "repo" },
            { projectPath: otherProjectPath, projectName: "other" },
          ],
        }),
      ],
      {
        taskSettings: testTaskSettings(),
        extraProjects: [
          [
            otherProjectPath,
            {
              trusted: true,
              workspaces: [
                projectWorkspace(otherProjectPath, "foreign", "foreign", {
                  runtimeConfig: { type: "local" },
                }),
              ],
            },
          ],
        ],
      }
    );
    const projectChat = await config.ensureProjectChat(projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: createWorkspaceServiceMocks({ sendMessage }).workspaceService,
    });

    for (const workspaceId of [projectChat.sessionId, "subagent", "multi", "foreign", "missing"]) {
      const result = await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: `Use ${workspaceId}`,
        title: workspaceId,
        workspace: { mode: "existing", workspaceId },
      });
      expect(result).toEqual(Err("Task.createWorkspaceTurn: invalid_scope for existing workspace"));
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("Project Chat rejects hidden/system project ownership", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "system", { initGit: false });
    await saveTestConfig(
      config,
      [[projectPath, { projectKind: "system", trusted: true, workspaces: [] }]],
      { taskSettings: testTaskSettings() }
    );
    const projectChat = await config.ensureProjectChat(projectPath);
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Err("should not create workspace"))
    );
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: createWorkspaceServiceMocks({ create: createWorkspace }).workspaceService,
    });

    expect(
      await taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt: "Create hidden workspace",
        title: "Hidden",
        workspace: { mode: "new" },
      })
    ).toEqual(Err("Task.createWorkspaceTurn: hidden/system Project Chat owners are not supported"));
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  test("Project Chat lifecycle can archive ordinary same-project workspaces", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const otherProjectPath = await createTestProject(rootDir, "other", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "ordinary", "ordinary", {
          title: "Ordinary",
          runtimeConfig: { type: "local" },
        }),
        projectWorkspace(projectPath, "subagent", "subagent", {
          runtimeConfig: { type: "local" },
          parentWorkspaceId: "ordinary",
          taskStatus: "running",
        }),
      ],
      {
        taskSettings: testTaskSettings(),
        extraProjects: [
          [
            otherProjectPath,
            {
              trusted: true,
              workspaces: [
                projectWorkspace(otherProjectPath, "foreign", "foreign", {
                  runtimeConfig: { type: "local" },
                }),
              ],
            },
          ],
        ],
      }
    );
    const projectChat = await config.ensureProjectChat(projectPath);
    const workspaceMocks = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    expect(
      await taskService.archiveOwnedWorkspaceTurnWorkspace(
        projectChat.sessionId,
        { workspaceId: "ordinary" },
        {}
      )
    ).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "ordinary",
        displayName: "Ordinary",
      })
    );
    expect(workspaceMocks.archive).toHaveBeenCalledWith("ordinary", undefined);

    for (const workspaceId of ["subagent", "foreign", projectChat.sessionId]) {
      expect(
        await taskService.archiveOwnedWorkspaceTurnWorkspace(
          projectChat.sessionId,
          { workspaceId },
          {}
        )
      ).toEqual(Ok({ status: "invalid_scope", action: "archive", workspaceId }));
    }
  });

  test("createWorkspaceTurn creates a normal workspace and starts a correlated turn", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-06-19T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
      }
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize the repo",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "running",
    });
    expect(result.data.taskId).toMatch(/^exe_/);
    expect(result.data.taskId).not.toBe(result.data.workspaceId);
    const canonicalExecutions = await new ExecutionStore(config).list(parentId);
    expect(canonicalExecutions).toHaveLength(1);
    const canonicalExecutionId = canonicalExecutions[0]?.executionId;
    assert(canonicalExecutionId, "canonical execution ID must exist");
    expect(result.data.taskId).toBe(canonicalExecutionId);
    expect(canonicalExecutionId).toMatch(/^exe_/);
    expect(canonicalExecutions[0]).toMatchObject({
      aliases: ["wst_childworkspace"],
      ownerSessionId: parentId,
      requesterWorkspaceId: parentId,
      target: { kind: "workspace", workspaceId: "childworkspace", origin: "created" },
      launchPolicy: { kind: "workspace_turn", title: "Workspace turn" },
      status: "running",
    });
    const shadow = await new TaskHandleStore(config).getWorkspaceTurn(
      parentId,
      "wst_childworkspace"
    );
    assert(shadow?.executionId, "shadow execution ID must exist");
    expect(canonicalExecutionId).toBe(shadow?.executionId);
    expect(
      await taskService.getScopedExecutionSnapshot(parentId, result.data.taskId)
    ).toMatchObject({
      kind: "ok",
      source: "canonical",
      handle: { executionId: result.data.taskId, status: "running" },
      workspaceId: "childworkspace",
    });
    expect(
      await taskService.getScopedExecutionSnapshot(parentId, "wst_childworkspace")
    ).toMatchObject({
      kind: "ok",
      source: "canonical",
      handle: { executionId: result.data.taskId, status: "running" },
      workspaceId: "childworkspace",
    });
    expect(
      await taskService.waitForScopedExecutionTerminal(parentId, result.data.taskId, {
        timeoutMs: 0,
      })
    ).toMatchObject({
      kind: "timeout",
      snapshot: { executionId: result.data.taskId, status: "running" },
    });
    const childConfig = findWorkspaceInConfig(config, "childworkspace");
    expect(childConfig?.parentWorkspaceId).toBeUndefined();
    expect(childConfig?.taskStatus).toBeUndefined();
    expect(childConfig?.tags).toMatchObject({
      "mux.taskHandleId": "wst_childworkspace",
      "mux.taskOwnerWorkspaceId": parentId,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[0]).toBe("childworkspace");
    expect(sendMessageCall[1]).toBe("Summarize the repo");
    expect(sendMessageCall[2]).toMatchObject({ agentId: "exec" });
    expect(sendMessageCall[3]).toMatchObject({
      startStreamInBackground: true,
      requireIdle: true,
      agentInitiated: true,
    });
  });

  test("createWorkspaceTurn inherits pro mode from the parent's active non-exec agent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          // Pro was toggled while a custom agent was active — no exec bucket
          // exists, so inheritance must read the active-agent bucket.
          agentId: "researcher",
          aiSettingsByAgent: {
            researcher: {
              model: "openai:gpt-5.6-sol",
              thinkingLevel: "high",
              reasoningMode: "pro",
            },
          },
        },
      ],
      testTaskSettings()
    );

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-06-19T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
      }
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize the repo",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[2]).toMatchObject({ reasoningMode: "pro" });
  });

  test("createWorkspaceTurn resolves AI settings: agent defaults on create, target settings on follow-up, explicit override wins", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, [
      "firsthandle",
      "firstturn",
      "secondhandle",
      "secondturn",
      "thirdhandle",
      "thirdturn",
    ]);
    // Owner persisted at opus/high (helper default); configured exec agent
    // defaults differ from both the owner's persisted and live settings.
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: { exec: { modelString: "openai:gpt-5.2", thinkingLevel: "xhigh" } },
    });

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-06-19T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
      }
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Creation: configured agent defaults outrank the owner's live runtime
    // settings (owner turned down to medium must not produce medium children).
    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      parentRuntimeAiSettings: {
        modelString: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      },
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    const firstSend = sendMessage.mock.calls[0];
    expect(firstSend[2]).toMatchObject({
      agentId: "exec",
      model: "openai:gpt-5.2",
      thinkingLevel: "xhigh",
    });

    // Simulate the child's own last-used settings (persist-on-send or a manual
    // flip inside the child workspace).
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      const child = project?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.aiSettingsByAgent = {
        exec: { model: "anthropic:claude-opus-4-6", thinkingLevel: "low" },
      };
      return cfg;
    });

    // Follow-up: the target continues its own settings; the owner's bump to
    // high must not drag the child along, and agent defaults no longer apply.
    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      parentRuntimeAiSettings: {
        modelString: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "high",
      },
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(second.success).toBe(true);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[2]).toMatchObject({
      model: "anthropic:claude-opus-4-6",
      thinkingLevel: "low",
    });

    // Explicit per-launch overrides still outrank the target's own settings.
    const third = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Third prompt",
      title: "Override",
      modelString: "openai:gpt-5.3-codex",
      thinkingLevel: "medium",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(third.success).toBe(true);
    const thirdSend = sendMessage.mock.calls[2];
    expect(thirdSend[2]).toMatchObject({
      model: "openai:gpt-5.3-codex",
      thinkingLevel: "medium",
    });
  });

  test("createWorkspaceTurn persists explicit existing-workspace overrides as subsequent defaults", async () => {
    const config = await createTestConfig(rootDir);
    const { projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const projectChat = await config.ensureProjectChat(projectPath);
    stubStableIds(config, [
      "firsthandle",
      "firstturn",
      "secondhandle",
      "secondturn",
      "thirdhandle",
      "thirdturn",
      "fourthhandle",
      "fourthturn",
    ]);
    await config.editConfig((cfg) => {
      cfg.taskSettings = testTaskSettings(10);
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "existing"),
        id: "existingworkspace",
        name: "existing",
        createdAt: "2026-08-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        aiSettingsByAgent: {
          exec: {
            model: "anthropic:claude-sonnet-4-5",
            thinkingLevel: "low",
            reasoningMode: "standard",
          },
        },
      });
      return cfg;
    });

    const sentSettings: Array<{
      model: string;
      thinkingLevel: ThinkingLevel;
      reasoningMode?: OpenAIReasoningMode;
    }> = [];
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const workspaceId = args[0] as string;
      const options = args[2] as {
        model: string;
        thinkingLevel: ThinkingLevel;
        reasoningMode?: OpenAIReasoningMode;
      };
      sentSettings.push({
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        ...(options.reasoningMode != null ? { reasoningMode: options.reasoningMode } : {}),
      });
      // Faithfully model WorkspaceService.sendMessage's accepted-send persistence path so the next
      // Project Chat turn resolves from the target workspace, not from test-only manual mutation.
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        const workspace = project?.workspaces.find((entry) => entry.id === workspaceId);
        assert(workspace, "target workspace must exist");
        workspace.aiSettingsByAgent = {
          ...(workspace.aiSettingsByAgent ?? {}),
          exec: {
            model: options.model,
            thinkingLevel: options.thinkingLevel,
            ...(options.reasoningMode != null ? { reasoningMode: options.reasoningMode } : {}),
          },
        };
        return cfg;
      });
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: createWorkspaceServiceMocks({ sendMessage }).workspaceService,
    });

    const launch = (prompt: string, overrides: Partial<WorkspaceTurnCreateArgs> = {}) =>
      taskService.createWorkspaceTurn({
        ownerWorkspaceId: projectChat.sessionId,
        prompt,
        title: prompt,
        workspace: { mode: "existing", workspaceId: "existingworkspace" },
        ...overrides,
      });

    await launch("Override A", {
      modelString: "openai:gpt-5.6-sol",
      thinkingLevel: "high",
      reasoningMode: "pro",
    });
    await launch("Inherit A");
    await launch("Override B", {
      modelString: "anthropic:claude-opus-4-6",
      thinkingLevel: "medium",
      reasoningMode: "standard",
    });
    await launch("Inherit B");

    expect(sentSettings).toEqual([
      {
        model: "openai:gpt-5.6-sol",
        thinkingLevel: "high",
        reasoningMode: "pro",
      },
      {
        model: "openai:gpt-5.6-sol",
        thinkingLevel: "high",
        reasoningMode: "pro",
      },
      {
        model: "anthropic:claude-opus-4-6",
        thinkingLevel: "medium",
        reasoningMode: "standard",
      },
      {
        model: "anthropic:claude-opus-4-6",
        thinkingLevel: "medium",
        reasoningMode: "standard",
      },
    ]);
  });

  test("createWorkspaceTurn follow-ups do not re-inject the owner's pro mode over the target's own settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettingsByAgent: {
            exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
          },
        },
      ],
      testTaskSettings()
    );

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-06-19T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
      }
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Creation still inherits the owner's pro mode.
    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    const firstSend = sendMessage.mock.calls[0];
    expect(firstSend[2]).toMatchObject({ reasoningMode: "pro" });

    // The child was switched back to standard (absent = standard per
    // WorkspaceAISettingsSchema); follow-ups must respect that.
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      const child = project?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.aiSettingsByAgent = {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high" },
      };
      return cfg;
    });

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(second.success).toBe(true);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[2]).toMatchObject({ reasoningMode: "standard" });
  });

  test("createWorkspaceTurn rejects multi-project owners instead of dropping secondary repos", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const secondaryProjectPath = await createTestProject(rootDir, "repo-secondary", {
      initGit: false,
    });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          projects: [
            { projectPath, projectName: "repo" },
            { projectPath: secondaryProjectPath, projectName: "repo-secondary" },
          ],
        },
      ],
      {
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
        extraProjects: [[secondaryProjectPath, { trusted: true, workspaces: [] }]],
      }
    );
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Err("should not create workspace"))
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize all projects",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("multi-project workspace turns are not supported");
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn rejects fork mode until workspace turns support forking", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Err("should not create workspace"))
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize fork",
      title: "Workspace turn",
      workspace: { mode: "fork" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('workspace.mode="fork" is not supported');
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn marks accepted pre-stream failures as handle errors", async () => {
    const sendMessage = mock(
      async (...args: unknown[]): Promise<Result<void, SendMessageError>> => {
        const internal = args[3] as
          | { onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void }
          | undefined;
        await internal?.onAcceptedPreStreamFailure?.({
          type: "unknown",
          raw: "Runtime startup failed",
        });
        return Ok(undefined);
      }
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest({ sendMessage });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "error",
      error: "Runtime startup failed",
      workspaceId: "childworkspace",
    });
  });

  test("createWorkspaceTurn reprompts only owner-created existing workspaces", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-06-19T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
      }
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);

    const taskHandleStore = (
      taskService as unknown as {
        taskHandleStore: {
          listAllWorkspaceTurns: (options?: { statuses?: readonly string[] }) => Promise<unknown[]>;
        };
      }
    ).taskHandleStore;
    const listAllWorkspaceTurns = spyOn(taskHandleStore, "listAllWorkspaceTurns");

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data).toMatchObject({
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "running",
    });
    expect(second.data.taskId).toMatch(/^exe_/);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[0]).toBe("childworkspace");
    expect(secondSend[1]).toBe("Second prompt");
    expect(secondSend[3]).toMatchObject({ requireIdle: true });
    const secondSnapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_secondhandle");
    expect(secondSnapshot).toMatchObject({
      createdWorkspace: false,
      workspaceId: "childworkspace",
      status: "running",
    });
    expect(listAllWorkspaceTurns).toHaveBeenCalledTimes(1);
    listAllWorkspaceTurns.mockRestore();

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "other-parent"),
        id: "other-parent",
        name: "other-parent",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    const foreign = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: "other-parent",
      prompt: "Should not run",
      title: "Foreign",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(foreign.success).toBe(false);
    if (foreign.success) return;
    expect(foreign.error).toContain("invalid_scope");
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("createWorkspaceTurn queues busy owner-created existing workspaces", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      return cfg;
    });

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-06-19T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
      }
    );
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void, SendMessageError>> =>
        Promise.resolve(Ok(undefined))
    );
    const busyWorkspaceIds = new Set<string>();
    const isStreaming = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const isBusyForMessage = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const hasQueuedMessages = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const workspaceMocks = createWorkspaceServiceMocks({
      create: createWorkspace,
      sendMessage,
      hasQueuedWorkspaceTurn: mock(
        (workspaceId: string, handleId: string) =>
          workspaceId === "childworkspace" && handleId === "wst_secondhandle"
      ),
      isBusyForMessage,
      hasQueuedMessages,
    });
    const aiMocks = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    busyWorkspaceIds.add("childworkspace");

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Queued prompt",
      title: "Follow-up",
      workspace: {
        mode: "existing",
        workspaceId: "childworkspace",
        queueDispatchMode: "turn-end",
      },
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data).toMatchObject({
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "queued",
    });
    expect(second.data.taskId).toMatch(/^exe_/);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[0]).toBe("childworkspace");
    expect(secondSend[1]).toBe("Queued prompt");
    expect(secondSend[2]).toMatchObject({
      queueDispatchMode: "turn-end",
      muxMetadata: {
        type: "workspace-turn-task",
        taskHandleId: "wst_secondhandle",
        ownerWorkspaceId: parentId,
        turnId: "secondturn",
      },
    });
    expect(secondSend[3]).toMatchObject({
      startStreamInBackground: true,
      requireIdle: false,
      agentInitiated: true,
    });
    expect(secondSend[3]).toHaveProperty("onAccepted");

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_secondhandle");
    expect(snapshot).toMatchObject({
      createdWorkspace: false,
      workspaceId: "childworkspace",
      status: "queued",
    });

    const internal = taskService as unknown as { countActiveWorkspaceTurns: () => Promise<number> };
    expect(await internal.countActiveWorkspaceTurns()).toBe(1);

    const interrupted = await taskService.interruptWorkspaceTurn(parentId, "wst_secondhandle");
    expect(interrupted.success).toBe(true);
    expect(workspaceMocks.removeQueuedWorkspaceTurn).toHaveBeenCalledWith(
      "childworkspace",
      "wst_secondhandle",
      { cancelReason: "Workspace turn interrupted" }
    );
    const sendInternal = secondSend[3] as { onAccepted: () => Promise<void> };
    let acceptedAfterInterruptError: unknown;
    try {
      await sendInternal.onAccepted();
    } catch (error) {
      acceptedAfterInterruptError = error;
    }
    if (!(acceptedAfterInterruptError instanceof Error)) {
      throw new Error("Expected onAccepted to reject after interrupt");
    }
    expect(acceptedAfterInterruptError.message).toMatch(/canceled before stream start/);
    expect(aiMocks.stopStream).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn reserves a slot before queueing a manually busy existing workspace", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["queuedhandle", "queuedturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        {
          path: path.join(projectPath, "childworkspace"),
          id: "childworkspace",
          name: "childworkspace",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        },
        {
          path: path.join(projectPath, "otherworkspace"),
          id: "otherworkspace",
          name: "otherworkspace",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        }
      );
      return cfg;
    });

    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({
      sendMessage,
      isBusyForMessage: mock((workspaceId: string) => workspaceId === "childworkspace"),
    });
    const aiMocks = createAIServiceMocks(config, {
      isStreaming: mock((workspaceId: string) => workspaceId === "otherworkspace"),
    });
    const { taskService } = createTaskServiceHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const createdAt = "2026-06-19T00:00:00.000Z";
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_owned",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "ownedturn",
      status: "completed",
      createdAt,
      updatedAt: createdAt,
      createdWorkspace: true,
      disposableWorkspace: false,
    });
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_other",
      ownerWorkspaceId: parentId,
      workspaceId: "otherworkspace",
      turnId: "otherturn",
      status: "running",
      createdAt,
      updatedAt: createdAt,
      createdWorkspace: true,
      disposableWorkspace: false,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Queued prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("maxParallelAgentTasks exceeded");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn counts active workspace turns across all owners", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const otherParentId = "other-parent";
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, otherParentId),
        id: otherParentId,
        name: otherParentId,
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-06-19T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
      }
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: otherParentId,
      prompt: "Second prompt",
      title: "Other workspace turn",
      workspace: { mode: "new" },
    });
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error).toContain("maxParallelAgentTasks exceeded");
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("active workspace turn count excludes foreground-waiting workspace turns", async () => {
    const { taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      countActiveWorkspaceTurns: () => Promise<number>;
      startForegroundAwait: (workspaceId: string) => () => void;
    };

    expect(await internal.countActiveWorkspaceTurns()).toBe(1);
    const stopForegroundAwait = internal.startForegroundAwait("childworkspace");
    try {
      expect(await internal.countActiveWorkspaceTurns()).toBe(0);
    } finally {
      stopForegroundAwait();
    }
  });

  test("active workspace turn count settles stale persisted handles", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await internal.countActiveWorkspaceTurns()).toBe(0);

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
      workspaceId: "childworkspace",
    });
  });

  test("active workspace turn count keeps startup-retrying handles live", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingQueuedOrPreparingTurn,
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await internal.countActiveWorkspaceTurns()).toBe(1);
    expect(hasPendingQueuedOrPreparingTurn).toHaveBeenCalledWith("childworkspace");

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(snapshot?.error).toBeUndefined();
  });

  test("getWorkspaceTurnSnapshot settles stale active handles before returning", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
      workspaceId: "childworkspace",
    });
  });

  test("uncorrelated stream-end before queued workspace turn prompt does not interrupt it", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const oldAssistant = createMuxMessage("old-assistant", "assistant", "Previous turn", {
      model: "anthropic:claude-opus-4-6",
      finishReason: "stop",
    });
    const queuedPrompt = createMuxMessage("queued-prompt", "user", "Queued follow-up", {
      muxMetadata: {
        type: "workspace-turn-task",
        taskHandleId: created.taskId,
        ownerWorkspaceId: parentId,
        turnId: "turn",
      },
    });
    expect((await historyService.appendToHistory(created.workspaceId, oldAssistant)).success).toBe(
      true
    );
    expect((await historyService.appendToHistory(created.workspaceId, queuedPrompt)).success).toBe(
      true
    );

    const internal = taskService as unknown as {
      interruptWorkspaceTurnFromUncorrelatedStreamEnd: (event: StreamEndEvent) => Promise<boolean>;
    };
    const handled = await internal.interruptWorkspaceTurnFromUncorrelatedStreamEnd({
      type: "stream-end",
      workspaceId: created.workspaceId,
      messageId: "old-assistant",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        finishReason: "stop",
      },
      parts: [],
    });

    expect(handled).toBe(true);
    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, created.taskId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: created.workspaceId });
  });

  test("getWorkspaceTurnSnapshot recovers stale completed handles from matching history", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const appendResult = await historyService.appendToHistory(
      created.workspaceId,
      createMuxMessage(
        "msg_completed",
        "assistant",
        "Recovered final text",
        {
          model: "anthropic:claude-opus-4-6",
          agentId: "exec",
          finishReason: "stop",
          muxMetadata: {
            type: "workspace-turn-task",
            taskHandleId: created.taskId,
            ownerWorkspaceId: parentId,
            turnId: "turn",
          },
        },
        [
          {
            type: "dynamic-tool",
            toolCallId: "attach-recovered",
            toolName: "attach_file",
            input: { path: "/coder/child/chart.png" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "prepared" },
                {
                  type: "media",
                  data: Buffer.from("recovered-image").toString("base64"),
                  mediaType: "image/png",
                  filename: "chart.png",
                },
              ],
            },
          },
        ]
      )
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, created.taskId);
    expect(snapshot).toMatchObject({
      status: "completed",
      workspaceId: created.workspaceId,
      messageId: "msg_completed",
      reportMarkdown: "Recovered final text",
      finalMessageRef: { messageId: "msg_completed", finishReason: "stop", textCharCount: 20 },
    });
    expect(snapshot?.artifacts?.attachFiles).toHaveLength(1);
    const recoveredArtifact = snapshot?.artifacts?.attachFiles[0];
    expect(recoveredArtifact).toMatchObject({
      filename: "chart.png",
      mediaType: "image/png",
      sourceToolCallId: "attach-recovered",
    });
    expect(await fsPromises.readFile(recoveredArtifact?.path ?? "")).toEqual(
      Buffer.from("recovered-image")
    );
  });

  test("getWorkspaceTurnSnapshot recovers stale truncated handles from matching history as errors", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const appendResult = await historyService.appendToHistory(
      created.workspaceId,
      createMuxMessage("msg_truncated_history", "assistant", "Partial text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: created.taskId,
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, created.taskId);
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: created.workspaceId,
      messageId: "msg_truncated_history",
      error: "Workspace turn ended before completion (finishReason: length)",
    });
    expect(snapshot?.reportMarkdown).toBeUndefined();
  });

  test("listWorkspaceTurnTasks settles stale active handles before returning", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await taskService.listWorkspaceTurnTasks(parentId, { statuses: ["running"] })).toEqual(
      []
    );

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({ status: "interrupted", workspaceId: "childworkspace" });
  });

  test("active Project Chat workspace turns route progress without settling and task_await returns the final response", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "workspace-turn-progress");
    await saveWorkspaces(config, projectPath, [], {
      taskSettings: testTaskSettings(),
      defaultRuntime: "local",
    });
    const projectChat = await config.ensureProjectChat(projectPath);
    stubStableIds(config, ["handle", "turn"]);

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-08-06T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({
          metadata: {
            ...createWorkspaceTurnMetadata(projectPath),
            id: "childworkspace",
            name: "workspace-turn",
          },
        });
      }
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: projectChat.sessionId,
      prompt: "Investigate",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;
    sendMessage.mockClear();

    const context = {
      // Stream correlation remains on the shadow handle; public progress surfaces the execution ID.
      handleId: "wst_handle",
      ownerWorkspaceId: projectChat.sessionId,
      turnId: "turn",
    };
    await taskService.reportAgentProgress(
      created.data.workspaceId,
      "progress-1",
      { reportMarkdown: "First update", title: "Progress" },
      context
    );
    await taskService.reportAgentProgress(
      created.data.workspaceId,
      "progress-1",
      { reportMarkdown: "Duplicate update" },
      context
    );
    await taskService.reportAgentProgress(
      created.data.workspaceId,
      "progress-2",
      { reportMarkdown: "Second update" },
      context
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const reportCalls = sendMessage.mock.calls as unknown[][];
    const firstReport = parseSubagentReportEnvelope(reportCalls[0]?.[1] as string);
    expect(firstReport).toMatchObject({
      taskId: created.data.taskId,
      status: "in_progress",
      agentType: "workspace",
      workspaceId: created.data.workspaceId,
      turnId: "turn",
      reportMarkdown: "First update",
    });
    expect(reportCalls[0]?.[0]).toBe(projectChat.sessionId);
    expect(reportCalls[0]?.[3]).toMatchObject({
      queueDedupeKey: "agent-report:wst_handle:progress-1",
      foregroundWaitInterruption: {
        reason: "progress_report_received",
        sourceTaskId: created.data.taskId,
        report: {
          workspaceId: created.data.workspaceId,
          turnId: "turn",
          reportMarkdown: "First update",
        },
      },
    });
    expect(
      await taskService.getWorkspaceTurnSnapshot(projectChat.sessionId, created.data.taskId)
    ).toMatchObject({ status: "running" });
    expect(
      findWorkspaceInConfig(config, created.data.workspaceId)?.parentWorkspaceId
    ).toBeUndefined();
    expect(findWorkspaceInConfig(config, created.data.workspaceId)?.taskStatus).toBeUndefined();

    const finalResultPromise = taskService.waitForWorkspaceTurn(created.data.taskId, {
      requestingWorkspaceId: projectChat.sessionId,
      timeoutMs: 1_000,
      backgroundOnMessageQueued: false,
    });
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: created.data.workspaceId,
      messageId: "msg-final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: projectChat.sessionId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Final answer" }],
    });

    const finalResult = await finalResultPromise;
    expect(finalResult).toMatchObject({
      taskId: created.data.taskId,
      workspaceId: created.data.workspaceId,
      reportMarkdown: "Final answer",
      messageId: "msg-final",
      finalMessageRef: {
        messageId: "msg-final",
        agentId: "exec",
        finishReason: "stop",
        textCharCount: 12,
      },
    });
  });

  test("workspace-turn progress rejects mismatched, inactive, queued, and terminal correlations", async () => {
    const { parentId, taskService, created } = await startWorkspaceTurnForTest();
    const context = {
      handleId: created.taskId,
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };

    const expectProgressError = async (promise: Promise<void>, message: string) => {
      let thrown: unknown;
      try {
        await promise;
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(message);
    };

    await expectProgressError(
      taskService.reportAgentProgress(
        "foreign-workspace",
        "foreign",
        { reportMarkdown: "no" },
        context
      ),
      "does not belong to this workspace"
    );
    await expectProgressError(
      taskService.reportAgentProgress(
        created.workspaceId,
        "wrong-turn",
        { reportMarkdown: "no" },
        { ...context, turnId: "wrong" }
      ),
      "correlation is stale"
    );
    await expectProgressError(
      taskService.reportAgentProgress(
        created.workspaceId,
        "wrong-owner",
        { reportMarkdown: "no" },
        { ...context, ownerWorkspaceId: "wrong-owner" }
      ),
      "missing or owned by another workspace"
    );

    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      taskHandleStore: TaskHandleStore;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    await expectProgressError(
      taskService.reportAgentProgress(
        created.workspaceId,
        "stale",
        { reportMarkdown: "no" },
        context
      ),
      "no longer active"
    );

    const record = await internal.taskHandleStore.getWorkspaceTurn(parentId, created.taskId);
    expect(record).not.toBeNull();
    if (record == null) return;
    internal.activeWorkspaceTurnHandleByWorkspaceId.set(created.workspaceId, {
      handleId: created.taskId,
      ownerWorkspaceId: parentId,
    });
    await internal.taskHandleStore.upsertWorkspaceTurn({ ...record, status: "queued" });
    await expectProgressError(
      taskService.reportAgentProgress(
        created.workspaceId,
        "queued",
        { reportMarkdown: "no" },
        context
      ),
      "only available from an active workspace turn"
    );

    await internal.taskHandleStore.upsertWorkspaceTurn({ ...record, status: "completed" });
    await expectProgressError(
      taskService.reportAgentProgress(
        created.workspaceId,
        "terminal",
        { reportMarkdown: "no" },
        context
      ),
      "after the workspace turn has completed"
    );
  });

  test("workspace-turn stream-end finalizes the handle without agent_report semantics", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-06-19T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
      }
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(created.success).toBe(true);

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Done" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "completed",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      reportMarkdown: "Done",
      finalMessageRef: { messageId: "msg_1", agentId: "exec", textCharCount: 4 },
    });
    const childConfig = findWorkspaceInConfig(config, "childworkspace");
    expect(childConfig?.parentWorkspaceId).toBeUndefined();
    expect(childConfig?.taskStatus).toBeUndefined();
  });

  test("notify_on_terminal canonical workspace turn wakes the owner via task_await on completion", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    // Register the child workspace the handle points at.
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "workspace-turn"),
        id: "childworkspace",
        name: "workspace-turn",
        title: "Workspace turn",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const workspaceMocks = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const createdAt = "2026-06-19T00:00:00.000Z";
    await (
      taskService as unknown as {
        persistWorkspaceTurnRecord: (record: WorkspaceTurnTaskHandleRecord) => Promise<void>;
      }
    ).persistWorkspaceTurnRecord({
      kind: "workspace_turn",
      executionId: "exe_handle",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "running",
      createdAt,
      updatedAt: createdAt,
      createdWorkspace: true,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
    });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set("childworkspace", {
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
    });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      pendingTerminalAttentionDrains: Set<Promise<void>>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Done" }],
    });

    // Drain runs asynchronously; await any in-flight drains before asserting.
    await Promise.all([...internal.pendingTerminalAttentionDrains]);

    const wakeCall = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("exe_handle")
    );
    expect(wakeCall).toBeDefined();
    const prompt = wakeCall?.[1] as string;
    expect(prompt).toContain("task_await");
    expect(prompt).toContain("timeout_secs: 0");
    expect(wakeCall?.[2]).toMatchObject({
      muxMetadata: {
        type: "background-work-wake",
        records: [
          {
            sourceKind: "workspace_turn",
            sourceId: "exe_handle",
            outcome: "completed",
            title: "Workspace turn",
            workspaceId: "childworkspace",
          },
        ],
      },
    });
    expect(wakeCall?.[3]).toMatchObject({ synthetic: true, requireIdle: true });

    // Restart-safe dedupe marker is persisted.
    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot?.terminalAttentionNotifiedAt).toBeDefined();
  });

  test("Project Chat terminal attention uses persisted orchestrator settings and is one-shot", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    await saveWorkspaces(config, projectPath, [], testTaskSettings());
    const projectChat = await config.ensureProjectChat(projectPath);
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project?.projectChat, "Project Chat must exist");
      project.projectChat.aiSettingsByAgent = {
        orchestrator: {
          model: "openai:gpt-5.3-codex",
          thinkingLevel: "high",
        },
      };
      return cfg;
    });

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const notification = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: projectChat.sessionId,
      sourceKind: "workspace_turn",
      sourceId: "wst_project",
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
    });
    expect(notification).not.toBeNull();

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };

    await internal.drainTerminalAttention(projectChat.sessionId);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(projectChat.sessionId);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("wst_project");
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      model: "openai:gpt-5.3-codex",
      agentId: "orchestrator",
      thinkingLevel: "high",
    });
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      muxMetadata: {
        type: "background-work-wake",
        records: [
          {
            sourceKind: "workspace_turn",
            sourceId: "wst_project",
            outcome: "completed",
            title: "Workspace turn",
          },
        ],
      },
    });
    expect(sendMessage.mock.calls[0]?.[3]).toMatchObject({ synthetic: true, requireIdle: true });
    expect(await terminalAttentionStore.get(projectChat.sessionId, notification!.id)).toMatchObject(
      { status: "delivered" }
    );

    await internal.drainTerminalAttention(projectChat.sessionId);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("notify_on_terminal workspace turn defers wake-up while owner has a queued turn", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "workspace-turn"),
        id: "childworkspace",
        name: "workspace-turn",
        title: "Workspace turn",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    // Owner is preparing/queuing a user turn: terminal wake-up must NOT inject ahead of it.
    const hasPendingQueuedOrPreparingTurn = mock(() => true);
    const workspaceMocks = createWorkspaceServiceMocks({
      sendMessage,
      hasPendingQueuedOrPreparingTurn,
    });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const createdAt = "2026-06-19T00:00:00.000Z";
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "running",
      createdAt,
      updatedAt: createdAt,
      createdWorkspace: true,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
    });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set("childworkspace", {
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
    });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      pendingTerminalAttentionDrains: Set<Promise<void>>;
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Done" }],
    });
    await Promise.all([...internal.pendingTerminalAttentionDrains]);

    // No wake-up sent while a queued/preparing turn exists.
    const wakeCall = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("wst_handle")
    );
    expect(wakeCall).toBeUndefined();

    // Notification remains pending; once the owner is idle, draining delivers it.
    hasPendingQueuedOrPreparingTurn.mockImplementation(() => false);
    await internal.drainTerminalAttention(parentId);
    const drained = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("wst_handle")
    );
    expect(drained).toBeDefined();
  });

  test("coalesced workspace-turn errors do not turn completed sub-agent handoff into failure", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "task_done",
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
      title: "Repository audit",
    });
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_error",
      outputDelivery: "requires_task_await",
      terminalOutcome: "error",
      title: "Verification turn",
    });
    const workflowRunId = "wfr_coalesced_research";
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "coalesced-research",
        description: "Coalesced research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendNextEvent(workflowRunId, {
      type: "result",
      at: "2026-06-19T00:00:02.000Z",
      result: { reportMarkdown: "Research complete" },
    });
    await runStore.appendStatus(workflowRunId, "completed", "2026-06-19T00:00:03.000Z");
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workflow_run",
      sourceId: workflowRunId,
      outputDelivery: "workflow_result_context",
      terminalOutcome: "completed",
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };

    await internal.drainTerminalAttention(parentId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const prompt = String(sendMessage.mock.calls[0]?.[1]);
    expect(prompt).toContain("Background sub-agent task(s) have completed");
    expect(prompt).not.toContain("failed terminally");
    expect(prompt).toContain("wst_error");
    expect(prompt).toContain(workflowRunId);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      muxMetadata: {
        type: "background-work-wake",
        records: [
          {
            sourceKind: "agent_task",
            sourceId: "task_done",
            outcome: "completed",
            title: "Repository audit",
            workspaceId: "task_done",
          },
          {
            sourceKind: "workspace_turn",
            sourceId: "wst_error",
            outcome: "error",
            title: "Verification turn",
          },
          {
            sourceKind: "workflow_run",
            sourceId: workflowRunId,
            outcome: "completed",
            title: "coalesced-research",
            workspaceId: parentId,
          },
        ],
      },
    });
    expect(prompt).toContain("task_await");
  });

  test("completed subagent wake is suppressed after the parent responded to its latest progress update", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const childId = "task-progress-responded";
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: childId,
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    await historyService.appendToHistory(
      parentId,
      createMuxMessage(
        "progress-update",
        "user",
        formatSubagentReportEnvelope({
          taskId: childId,
          agentType: "explore",
          status: "in_progress",
          title: "Progress",
          reportMarkdown: "Found the relevant code path.",
        }),
        { timestamp: Date.now(), synthetic: true }
      )
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("progress-response", "assistant", "Thanks, I have integrated that update.", {
        timestamp: Date.now(),
      })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage(
        "terminal-report",
        "user",
        formatSubagentReportEnvelope({
          taskId: childId,
          agentType: "explore",
          status: "completed",
          title: "Final report",
          reportMarkdown: "Investigation complete.",
        }),
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      )
    );

    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await internal.drainTerminalAttention(parentId);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await terminalAttentionStore.listPending(parentId)).toEqual([]);
  });

  test("progress response tracking distinguishes guidance from reflexive waits", async () => {
    const config = await createTestConfig(rootDir);
    const { historyService, taskService } = createTaskServiceHarness(config);
    const internal = taskService as unknown as {
      findProgressRespondedTaskIds: (
        ownerWorkspaceId: string,
        candidateTaskIds: ReadonlySet<string>
      ) => Promise<Set<string>>;
    };

    const childId = "progress-child";
    const siblingId = "progress-sibling";
    const scenarios = [
      {
        name: "same-child-guidance",
        expected: true,
        part: {
          type: "dynamic-tool" as const,
          toolCallId: "guide-child",
          toolName: "task_send_message" as const,
          state: "output-available" as const,
          input: { task_id: childId, message: "Good finding; continue." },
          output: { status: "accepted", taskId: childId },
        },
      },
      {
        name: "same-child-rewait",
        expected: false,
        part: {
          type: "dynamic-tool" as const,
          toolCallId: "rewait-child",
          toolName: "task_await" as const,
          state: "output-available" as const,
          input: { task_ids: [childId] },
          output: { results: [{ status: "running", taskId: childId }] },
        },
      },
      {
        name: "sibling-guidance",
        expected: false,
        part: {
          type: "dynamic-tool" as const,
          toolCallId: "guide-sibling",
          toolName: "task_send_message" as const,
          state: "output-available" as const,
          input: { task_id: siblingId, message: "Continue." },
          output: { status: "accepted", taskId: siblingId },
        },
      },
      {
        name: "failed-guidance",
        expected: false,
        part: {
          type: "dynamic-tool" as const,
          toolCallId: "failed-guide",
          toolName: "task_send_message" as const,
          state: "output-available" as const,
          input: { task_id: childId, message: "Continue." },
          output: {
            status: "not_active",
            taskId: childId,
            taskStatus: "reported",
            error: "Task already completed.",
          },
        },
      },
    ];

    for (const scenario of scenarios) {
      const parentId = `parent-${scenario.name}`;
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(
          `${scenario.name}-progress`,
          "user",
          formatSubagentReportEnvelope({
            taskId: childId,
            agentType: "explore",
            status: "in_progress",
            title: "Progress",
            reportMarkdown: "Found the relevant code path.",
          }),
          { timestamp: Date.now(), synthetic: true }
        )
      );
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(`${scenario.name}-response`, "assistant", "", { timestamp: Date.now() }, [
          scenario.part,
        ])
      );
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(
          `${scenario.name}-completed`,
          "user",
          formatSubagentReportEnvelope({
            taskId: childId,
            agentType: "explore",
            status: "completed",
            title: "Final report",
            reportMarkdown: "Investigation complete.",
          }),
          { timestamp: Date.now(), synthetic: true, uiVisible: true }
        )
      );

      const responded = await internal.findProgressRespondedTaskIds(parentId, new Set([childId]));
      expect(responded.has(childId), scenario.name).toBe(scenario.expected);
    }
  });

  test("structured wait interruptions participate in per-child response tracking", async () => {
    const config = await createTestConfig(rootDir);
    const { historyService, taskService } = createTaskServiceHarness(config);
    const internal = taskService as unknown as {
      findProgressRespondedTaskIds: (
        ownerWorkspaceId: string,
        candidateTaskIds: ReadonlySet<string>
      ) => Promise<Set<string>>;
    };
    const childId = "structured-progress-child";
    const interruption = {
      reason: "progress_report_received" as const,
      sourceTaskId: childId,
      report: {
        agentType: "explore",
        title: "Progress",
        reportMarkdown: "Found the relevant code path.",
      },
    };

    for (const scenario of [
      { name: "text-before-report", guidance: false, expected: false },
      { name: "same-turn-guidance", guidance: true, expected: true },
    ]) {
      const parentId = `parent-${scenario.name}`;
      const parts: MuxMessage["parts"] = [
        {
          type: "dynamic-tool",
          toolCallId: `${scenario.name}-task`,
          toolName: "task",
          state: "output-available",
          input: {
            subagent_type: "explore",
            prompt: "Trace the path.",
            title: "Trace",
            run_in_background: false,
          },
          output: {
            status: "running",
            taskId: childId,
            interruption,
            note: "Foreground wait paused because a queued message needs attention.",
          },
        },
      ];
      if (scenario.guidance) {
        parts.push({
          type: "dynamic-tool",
          toolCallId: `${scenario.name}-guidance`,
          toolName: "task_send_message",
          state: "output-available",
          input: { task_id: childId, message: "Good finding; continue." },
          output: { status: "accepted", taskId: childId },
        });
      }

      await historyService.appendToHistory(
        parentId,
        createMuxMessage(
          `${scenario.name}-response`,
          "assistant",
          scenario.guidance ? "" : "This text was emitted before the child report.",
          { timestamp: Date.now() },
          parts
        )
      );
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(
          `${scenario.name}-completed`,
          "user",
          formatSubagentReportEnvelope({
            taskId: childId,
            agentType: "explore",
            status: "completed",
            title: "Final report",
            reportMarkdown: "Investigation complete.",
          }),
          { timestamp: Date.now(), synthetic: true, uiVisible: true }
        )
      );

      const responded = await internal.findProgressRespondedTaskIds(parentId, new Set([childId]));
      expect(responded.has(childId), scenario.name).toBe(scenario.expected);
    }
  });

  test("intervening user turns block text attribution but preserve explicit guidance", async () => {
    const config = await createTestConfig(rootDir);
    const { historyService, taskService } = createTaskServiceHarness(config);
    const internal = taskService as unknown as {
      findProgressRespondedTaskIds: (
        ownerWorkspaceId: string,
        candidateTaskIds: ReadonlySet<string>
      ) => Promise<Set<string>>;
    };
    const childId = "intervening-user-progress-child";
    const interruption = {
      reason: "progress_report_received" as const,
      sourceTaskId: childId,
      report: {
        agentType: "explore",
        title: "Progress",
        reportMarkdown: "Found the relevant code path.",
      },
    };

    for (const scenario of [
      { name: "user-answer-text", guidance: false, expected: false },
      { name: "user-answer-guidance", guidance: true, expected: true },
    ]) {
      const parentId = `parent-${scenario.name}`;
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(`${scenario.name}-progress`, "assistant", "", { timestamp: Date.now() }, [
          {
            type: "dynamic-tool",
            toolCallId: `${scenario.name}-task`,
            toolName: "task",
            state: "output-available",
            input: {
              subagent_type: "explore",
              prompt: "Trace the path.",
              title: "Trace",
              run_in_background: false,
            },
            output: {
              status: "running",
              taskId: childId,
              interruption,
              note: "Foreground wait paused because a queued message needs attention.",
            },
          },
        ])
      );
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(
          `${scenario.name}-user`,
          "user",
          "Also check the unrelated build failure.",
          {
            timestamp: Date.now(),
          }
        )
      );
      const responseParts: MuxMessage["parts"] = scenario.guidance
        ? [
            {
              type: "dynamic-tool",
              toolCallId: `${scenario.name}-guidance`,
              toolName: "task_send_message",
              state: "output-available",
              input: { task_id: childId, message: "Good finding; continue." },
              output: { status: "accepted", taskId: childId },
            },
          ]
        : [];
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(
          `${scenario.name}-response`,
          "assistant",
          "I addressed the build question.",
          { timestamp: Date.now() },
          responseParts
        )
      );
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(
          `${scenario.name}-completed`,
          "user",
          formatSubagentReportEnvelope({
            taskId: childId,
            agentType: "explore",
            status: "completed",
            title: "Final report",
            reportMarkdown: "Investigation complete.",
          }),
          { timestamp: Date.now(), synthetic: true, uiVisible: true }
        )
      );

      const responded = await internal.findProgressRespondedTaskIds(parentId, new Set([childId]));
      expect(responded.has(childId), scenario.name).toBe(scenario.expected);
    }
  });

  test("plain text remains ambiguous when a non-candidate sibling also awaits a response", async () => {
    const config = await createTestConfig(rootDir);
    const { historyService, taskService } = createTaskServiceHarness(config);
    const internal = taskService as unknown as {
      findProgressRespondedTaskIds: (
        ownerWorkspaceId: string,
        candidateTaskIds: ReadonlySet<string>
      ) => Promise<Set<string>>;
    };

    const parentId = "parent-ambiguous-progress-response";
    const completedChild = "progress-completed-child";
    const activeSibling = "progress-active-sibling";
    for (const childId of [completedChild, activeSibling]) {
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(
          `${childId}-progress`,
          "user",
          formatSubagentReportEnvelope({
            taskId: childId,
            agentType: "explore",
            status: "in_progress",
            title: "Progress",
            reportMarkdown: `Progress from ${childId}.`,
          }),
          { timestamp: Date.now(), synthetic: true }
        )
      );
    }
    await historyService.appendToHistory(
      parentId,
      createMuxMessage(
        "ambiguous-progress-response",
        "assistant",
        "Thanks, keep following that lead.",
        { timestamp: Date.now() }
      )
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage(
        `${completedChild}-completed`,
        "user",
        formatSubagentReportEnvelope({
          taskId: completedChild,
          agentType: "explore",
          status: "completed",
          title: "Final report",
          reportMarkdown: "Completed child report.",
        }),
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      )
    );

    const responded = await internal.findProgressRespondedTaskIds(
      parentId,
      new Set([completedChild])
    );
    expect([...responded]).toEqual([]);
  });

  test("mixed text and guidance only respond to the targeted sibling", async () => {
    const config = await createTestConfig(rootDir);
    const { historyService, taskService } = createTaskServiceHarness(config);
    const internal = taskService as unknown as {
      findProgressRespondedTaskIds: (
        ownerWorkspaceId: string,
        candidateTaskIds: ReadonlySet<string>
      ) => Promise<Set<string>>;
    };

    const parentId = "parent-mixed-progress-response";
    const childA = "progress-child-a";
    const childB = "progress-child-b";
    for (const childId of [childA, childB]) {
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(
          `${childId}-progress`,
          "user",
          formatSubagentReportEnvelope({
            taskId: childId,
            agentType: "explore",
            status: "in_progress",
            title: "Progress",
            reportMarkdown: `Progress from ${childId}.`,
          }),
          { timestamp: Date.now(), synthetic: true }
        )
      );
    }
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("mixed-progress-response", "assistant", "", { timestamp: Date.now() }, [
        {
          type: "dynamic-tool",
          toolCallId: "guide-child-a",
          toolName: "task_send_message",
          state: "output-available",
          input: { task_id: childA, message: "Continue with the current scope." },
          output: { status: "accepted", taskId: childA },
        },
        { type: "text", text: "I’ll steer child A and leave child B pending." },
      ])
    );
    for (const childId of [childA, childB]) {
      await historyService.appendToHistory(
        parentId,
        createMuxMessage(
          `${childId}-completed`,
          "user",
          formatSubagentReportEnvelope({
            taskId: childId,
            agentType: "explore",
            status: "completed",
            title: "Final report",
            reportMarkdown: `Final report from ${childId}.`,
          }),
          { timestamp: Date.now(), synthetic: true, uiVisible: true }
        )
      );
    }

    const responded = await internal.findProgressRespondedTaskIds(
      parentId,
      new Set([childA, childB])
    );
    expect([...responded]).toEqual([childA]);
  });

  test("completed subagent wake remains when its visible terminal report card is missing", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const childId = "task-progress-missing-terminal-card";
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: childId,
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    await historyService.appendToHistory(
      parentId,
      createMuxMessage(
        "progress-without-card",
        "user",
        formatSubagentReportEnvelope({
          taskId: childId,
          agentType: "explore",
          status: "in_progress",
          title: "Progress",
          reportMarkdown: "Progress was answered but terminal persistence failed.",
        }),
        { timestamp: Date.now(), synthetic: true }
      )
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("progress-without-card-response", "assistant", "Progress handled.", {
        timestamp: Date.now(),
      })
    );

    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await internal.drainTerminalAttention(parentId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(
      "Background sub-agent task(s) have completed"
    );
  });

  test("completed subagent wake remains when the latest progress update has no assistant response", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const childId = "task-progress-unanswered";
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: childId,
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    await historyService.appendToHistory(
      parentId,
      createMuxMessage(
        "old-progress",
        "user",
        formatSubagentReportEnvelope({
          taskId: childId,
          agentType: "explore",
          status: "in_progress",
          title: "Earlier progress",
          reportMarkdown: "An earlier update was processed.",
        }),
        { timestamp: Date.now(), synthetic: true }
      )
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("old-response", "assistant", "Earlier response", { timestamp: Date.now() })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage(
        "latest-progress",
        "user",
        formatSubagentReportEnvelope({
          taskId: childId,
          agentType: "explore",
          status: "in_progress",
          title: "Latest progress",
          reportMarkdown: "A newer update has not been processed yet.",
        }),
        { timestamp: Date.now(), synthetic: true }
      )
    );

    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await internal.drainTerminalAttention(parentId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(
      "Background sub-agent task(s) have completed"
    );
  });

  test("terminal wake-up waits for queued owner turn to clear", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "task_done",
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
    });

    let ownerPending = true;
    const hasPendingQueuedOrPreparingTurn = mock(() => ownerPending);
    const hasQueuedMessages = mock(() => ownerPending);
    let releaseIdle!: () => void;
    const waitForIdleAndNoQueuedMessages = mock(
      (): Promise<void> =>
        new Promise((resolve) => {
          releaseIdle = resolve;
        })
    );
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage,
      hasPendingQueuedOrPreparingTurn,
      hasQueuedMessages,
      waitForIdleAndNoQueuedMessages,
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };

    await internal.drainTerminalAttention(parentId);
    await Promise.resolve();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);

    ownerPending = false;
    releaseIdle();
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("terminal wake-up waits for pending auto-retry to clear", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "task_done",
      outputDelivery: "already_injected",
      title: "Fallback audit",
      terminalOutcome: "completed",
    });

    let ownerPendingAutoRetry = true;
    const hasPendingQueuedOrPreparingTurn = mock(() => ownerPendingAutoRetry);
    let releaseRetryCleared!: () => void;
    const waitForIdleAndNoQueuedMessages = mock(
      (): Promise<void> =>
        new Promise((resolve) => {
          releaseRetryCleared = resolve;
        })
    );
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage,
      hasPendingQueuedOrPreparingTurn,
      waitForIdleAndNoQueuedMessages,
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };

    await internal.drainTerminalAttention(parentId);
    await Promise.resolve();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(waitForIdleAndNoQueuedMessages).toHaveBeenCalledWith(parentId);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);

    ownerPendingAutoRetry = false;
    releaseRetryCleared();
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("terminal wake-up retries without idle-only flag after completion-phase busy", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "task_done",
      title: "Fallback audit",
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
    });

    let acceptQueuedFallback: (() => Promise<void> | void) | undefined;
    const sendMessage = mock(
      (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: { requireIdle?: boolean; onAccepted?: () => Promise<void> | void }
      ): Promise<Result<void, { type: string; raw: string }>> => {
        if (internal?.requireIdle === true) {
          return Promise.resolve(
            Err({ type: "unknown", raw: "Workspace is busy; idle-only send was skipped." })
          );
        }
        acceptQueuedFallback = internal?.onAccepted;
        return Promise.resolve(Ok(undefined));
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };

    await internal.drainTerminalAttention(parentId);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[3]).toMatchObject({ requireIdle: true });
    expect(sendMessage.mock.calls[1]?.[3]).not.toMatchObject({ requireIdle: true });
    expect(sendMessage.mock.calls[1]?.[1]).toBe(sendMessage.mock.calls[0]?.[1]);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      muxMetadata: {
        type: "background-work-wake",
        records: [
          {
            sourceKind: "agent_task",
            sourceId: "task_done",
            outcome: "completed",
            title: "Fallback audit",
            workspaceId: "task_done",
          },
        ],
      },
    });
    expect(sendMessage.mock.calls[1]?.[2]).toEqual(sendMessage.mock.calls[0]?.[2]);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);
    expect(acceptQueuedFallback).toBeDefined();
    await acceptQueuedFallback?.();
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("terminal wake-up reschedules when queued fallback is canceled", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "task_done",
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
    });

    let idleFailuresRemaining = 1;
    let cancelQueuedFallback: ((reason: string) => Promise<void> | void) | undefined;
    const sendMessage = mock(
      (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: {
          requireIdle?: boolean;
          onCanceled?: (reason: string) => Promise<void> | void;
        }
      ): Promise<Result<void, { type: string; raw: string }>> => {
        if (internal?.requireIdle === true && idleFailuresRemaining > 0) {
          idleFailuresRemaining -= 1;
          return Promise.resolve(
            Err({ type: "unknown", raw: "Workspace is busy; idle-only send was skipped." })
          );
        }
        if (internal?.requireIdle !== true) {
          cancelQueuedFallback = internal?.onCanceled;
        }
        return Promise.resolve(Ok(undefined));
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };

    await internal.drainTerminalAttention(parentId);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);
    expect(cancelQueuedFallback).toBeDefined();

    await cancelQueuedFallback?.("cleared");
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[2]?.[3]).toMatchObject({ requireIdle: true });
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("terminal wake-up re-pends when queued fallback fails before stream", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "task_done",
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
    });

    let idleFailuresRemaining = 1;
    let acceptQueuedFallback: (() => Promise<void> | void) | undefined;
    let failQueuedFallback: ((error: SendMessageError) => Promise<void> | void) | undefined;
    const sendMessage = mock(
      (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: {
          requireIdle?: boolean;
          onAccepted?: () => Promise<void> | void;
          onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
        }
      ): Promise<Result<void, { type: string; raw: string }>> => {
        if (internal?.requireIdle === true && idleFailuresRemaining > 0) {
          idleFailuresRemaining -= 1;
          return Promise.resolve(
            Err({ type: "unknown", raw: "Workspace is busy; idle-only send was skipped." })
          );
        }
        if (internal?.requireIdle !== true) {
          acceptQueuedFallback = internal?.onAccepted;
          failQueuedFallback = internal?.onAcceptedPreStreamFailure;
        }
        return Promise.resolve(Ok(undefined));
      }
    );
    let releaseIdle!: () => void;
    const waitForIdleAndNoQueuedMessages = mock(
      (): Promise<void> =>
        new Promise((resolve) => {
          releaseIdle = resolve;
        })
    );
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage,
      waitForIdleAndNoQueuedMessages,
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };

    await internal.drainTerminalAttention(parentId);
    await acceptQueuedFallback?.();
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);

    await failQueuedFallback?.({ type: "unknown", raw: "pre-stream failure" });
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);

    releaseIdle();
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[2]?.[3]).toMatchObject({ requireIdle: true });
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("terminal wake-up drains are serialized per owner", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    let releaseSend!: () => void;
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sawFirstSend!: () => void;
    const firstSendSeen = new Promise<void>((resolve) => {
      sawFirstSend = resolve;
    });
    const sendMessage = mock(async (..._args: unknown[]): Promise<Result<void>> => {
      sawFirstSend();
      await sendReleased;
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      enqueueTerminalAttention: (params: {
        ownerWorkspaceId: string;
        sourceKind: "agent_task";
        sourceId: string;
        outputDelivery: "already_injected";
        terminalOutcome: "completed";
      }) => Promise<void>;
    };

    await Promise.all([
      internal.enqueueTerminalAttention({
        ownerWorkspaceId: parentId,
        sourceKind: "agent_task",
        sourceId: "task-a",
        outputDelivery: "already_injected",
        terminalOutcome: "completed",
      }),
      internal.enqueueTerminalAttention({
        ownerWorkspaceId: parentId,
        sourceKind: "agent_task",
        sourceId: "task-b",
        outputDelivery: "already_injected",
        terminalOutcome: "completed",
      }),
    ]);
    await firstSendSeen;
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    releaseSend();
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("terminal wake-up drain ignores nested workflow runs", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: "wfr_top_notify",
      workspaceId: parentId,
      workflow: {
        name: "top",
        description: "Top workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'top' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_top_notify", "running", "2026-06-19T00:00:01.000Z");
    await runStore.createRun({
      id: "wfr_nested_internal",
      workspaceId: parentId,
      workflow: {
        name: "nested",
        description: "Nested workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'nested' }; }\n",
      args: {},
      parentWorkflow: { runId: "wfr_top_notify", stepId: "nested", inputHash: "hash", depth: 0 },
      now: "2026-06-19T00:00:02.000Z",
    });
    await runStore.appendStatus("wfr_nested_internal", "running", "2026-06-19T00:00:03.000Z");

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "task_done",
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };

    await internal.drainTerminalAttention(parentId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(
      "Background sub-agent task(s) have completed"
    );
  });

  test("terminal workflow wake-up reconstructs durable result context", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_terminal_notify";
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendNextEvent(runId, {
      type: "result",
      at: "2026-06-19T00:00:02.000Z",
      result: { reportMarkdown: "Workflow finished", structuredOutput: { ok: true } },
    });
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.enqueueWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const prompt = String(sendMessage.mock.calls[0]?.[1]);
    expect(prompt).toContain("mux_workflow_result");
    expect(prompt).toContain("Workflow finished");
    expect(prompt).toContain(runId);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("workflow task_await consumption tombstones later terminal wake-ups", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_consumed_terminal_notify";
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "consumed",
        description: "Consumed workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'consumed' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendNextEvent(runId, {
      type: "result",
      at: "2026-06-19T00:00:02.000Z",
      result: { reportMarkdown: "Already consumed" },
    });
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.markWorkflowRunTerminalAttentionConsumed({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await taskService.enqueueWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);

    await taskService.resetWorkflowRunTerminalAttention({ ownerWorkspaceId: parentId, runId });
    await taskService.enqueueWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("Already consumed");
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("workspace turn task_await consumption tombstones later terminal wake-ups", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      enqueueTerminalAttention: (params: {
        ownerWorkspaceId: string;
        sourceKind: "workspace_turn";
        sourceId: string;
        outputDelivery: "requires_task_await";
        terminalOutcome: "completed" | "error" | "interrupted";
      }) => Promise<void>;
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };

    await taskService.markWorkspaceTurnTerminalAttentionConsumed({
      ownerWorkspaceId: parentId,
      taskId: "wst_consumed_then_enqueued",
      status: "completed",
    });
    await internal.enqueueTerminalAttention({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_consumed_then_enqueued",
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
    });
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);

    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_pending_then_consumed",
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
    });
    await taskService.markWorkspaceTurnTerminalAttentionConsumed({
      ownerWorkspaceId: parentId,
      taskId: "wst_pending_then_consumed",
      status: "completed",
    });
    await internal.drainTerminalAttention(parentId);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);

    await taskService.markWorkspaceTurnTerminalAttentionConsumed({
      ownerWorkspaceId: parentId,
      taskId: "wst_running_not_consumed",
      status: "running",
    });
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_running_not_consumed",
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
    });

    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);
  });

  test("startup recovery persists terminal workflow wake-ups", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_recovered_terminal_notify";
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "recovered",
        description: "Recovered workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'recovered' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendNextEvent(runId, {
      type: "result",
      at: "2026-06-19T00:00:02.000Z",
      result: { reportMarkdown: "Recovered workflow result" },
    });
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      recoverTerminalWorkflowRunAttentionNotifications: () => Promise<number>;
    };

    expect(await internal.recoverTerminalWorkflowRunAttentionNotifications()).toBe(1);
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("Recovered workflow result");
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("initialize replays and clears persisted pending task guidance", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-restart-guidance";
    const childTaskId = "child-restart-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskPendingGuidance: [
            { id: "guidance-1", message: "First correction", queueDispatchMode: "turn-end" },
            { id: "guidance-2", message: "Second correction", queueDispatchMode: "tool-end" },
          ],
        }),
      ],
      testTaskSettings()
    );

    const sendMessage = mock(
      async (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: { onAccepted?: () => Promise<void> | void }
      ): Promise<Result<void>> => {
        await internal?.onAccepted?.();
        return Ok(undefined);
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();

    expect(sendMessage).toHaveBeenCalledWith(
      childTaskId,
      expect.stringContaining("1. First correction\n\n2. Second correction"),
      expect.objectContaining({ model: "openai:gpt-5.2", agentId: "exec" }),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toBeUndefined();
  });

  test("initialize replays pending guidance even when the task has active descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-restart-guidance-descendant";
    const childTaskId = "child-restart-guidance-descendant";
    const grandchildTaskId = "grandchild-restart-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskPendingGuidance: [
            {
              id: "guidance-blocked",
              message: "Apply this correction",
              queueDispatchMode: "turn-end",
            },
          ],
        }),
        projectWorkspace(projectPath, "grandchild", grandchildTaskId, {
          parentWorkspaceId: childTaskId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const sendMessage = mock(
      async (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: { onAccepted?: () => Promise<void> | void }
      ): Promise<Result<void>> => {
        await internal?.onAccepted?.();
        return Ok(undefined);
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();

    expect(sendMessage).toHaveBeenCalledWith(
      childTaskId,
      expect.stringContaining("Apply this correction"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toBeUndefined();
  });

  test("initialize drains persisted terminal wake-ups from before restart", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_restart_pending",
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(parentId);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("wst_restart_pending");
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("timeout_secs: 0");
    expect(sendMessage.mock.calls[0]?.[3]).toMatchObject({
      synthetic: true,
      agentInitiated: true,
      requireIdle: true,
    });
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("initialize drains persisted Project Chat terminal wake-ups from the separate session root", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "project-chat-restart", {
      initGit: false,
    });
    await saveWorkspaces(config, projectPath, [], testTaskSettings());
    const projectChat = await config.ensureProjectChat(projectPath);
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project?.projectChat, "Project Chat must exist");
      project.projectChat.aiSettingsByAgent = {
        orchestrator: { model: "openai:gpt-5.2", thinkingLevel: "high" },
      };
      return cfg;
    });

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: projectChat.sessionId,
      sourceKind: "workspace_turn",
      sourceId: "wst_project_restart_pending",
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
    });
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(projectChat.sessionId);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("wst_project_restart_pending");
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      model: "openai:gpt-5.2",
      agentId: "orchestrator",
      thinkingLevel: "high",
    });
    expect(await terminalAttentionStore.listPending(projectChat.sessionId)).toHaveLength(0);
  });

  test("initialize recovers terminal notify workspace turns without pending notification", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const handleId = "wst_restart_missing_notification";
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
      title: "Recovered verification",
      reportMarkdown: "Done before notification persisted",
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(handleId);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      muxMetadata: {
        type: "background-work-wake",
        records: [
          {
            sourceKind: "workspace_turn",
            sourceId: handleId,
            outcome: "completed",
            title: "Recovered verification",
            workspaceId: "childworkspace",
          },
        ],
      },
    });
    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, handleId);
    expect(snapshot?.terminalAttentionNotifiedAt).toBeDefined();
  });

  test("initialize repairs canonical workspace-turn projections from execution-backed shadows", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const store = new TaskHandleStore(config);
    await store.upsertWorkspaceTurn({
      kind: "workspace_turn",
      executionId: "exe_reconciled_turn",
      handleId: "wst_reconciled_turn",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-shadow",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:03.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      title: "Shadow title",
      prompt: "Shadow prompt",
      reportMarkdown: "Recovered canonical report",
      finalMessageRef: { messageId: "message-recovered", partCount: 1 },
      terminalAttentionNotifiedAt: "2026-06-19T00:00:04.000Z",
    });
    await store.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_legacy_unchanged",
      ownerWorkspaceId: parentId,
      workspaceId: "legacyworkspace",
      turnId: "legacy-turn",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "Legacy report",
    });
    await new ExecutionStore(config).upsert({
      version: 1,
      executionId: "exe_reconciled_turn",
      aliases: ["custom-alias", "wst_reconciled_turn"],
      ownerSessionId: parentId,
      requesterWorkspaceId: "original-requester",
      target: { kind: "workspace", workspaceId: "original-target", origin: "existing" },
      launchPolicy: {
        kind: "workspace_turn",
        turnId: "canonical-turn",
        title: "Canonical title",
        prompt: "Canonical prompt",
      },
      completionPolicy: { kind: "final_assistant_message" },
      retentionPolicy: { kind: "delete_workspace_on_completion" },
      attentionPolicy: "notify_on_terminal",
      status: "error",
      result: { kind: "error", error: "Stale canonical result" },
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:01.000Z",
      terminalAt: "2026-06-18T00:00:01.000Z",
    });

    const { taskService } = createTaskServiceHarness(config);
    await taskService.initialize();

    expect(await new ExecutionStore(config).get(parentId, "exe_reconciled_turn")).toEqual({
      version: 1,
      executionId: "exe_reconciled_turn",
      aliases: ["custom-alias", "wst_reconciled_turn"],
      ownerSessionId: parentId,
      requesterWorkspaceId: "original-requester",
      target: { kind: "workspace", workspaceId: "original-target", origin: "existing" },
      launchPolicy: {
        kind: "workspace_turn",
        turnId: "canonical-turn",
        title: "Canonical title",
        prompt: "Canonical prompt",
      },
      completionPolicy: { kind: "final_assistant_message" },
      retentionPolicy: { kind: "delete_workspace_on_completion" },
      attentionPolicy: "notify_on_terminal",
      status: "completed",
      result: {
        kind: "completed",
        reportMarkdown: "Recovered canonical report",
        finalMessageRef: { messageId: "message-recovered", partCount: 1 },
      },
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:03.000Z",
      terminalAt: "2026-06-19T00:00:03.000Z",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:04.000Z",
    });
    const legacyShadow = await store.getWorkspaceTurn(parentId, "wst_legacy_unchanged");
    expect(legacyShadow).toMatchObject({
      status: "completed",
      reportMarkdown: "Legacy report",
    });
    expect(legacyShadow?.executionId).toBeUndefined();
    expect(await new ExecutionStore(config).list(parentId)).toHaveLength(1);
  });

  test("initialize defers terminal wake-up while blocking task-owned work is active", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "task_done",
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
    });

    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_blocking_active",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set("childworkspace", {
      handleId: "wst_blocking_active",
      ownerWorkspaceId: parentId,
    });

    await taskService.initialize();
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);
  });

  test("workspace-turn stream-end with non-stop finish marks the handle error", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_truncated",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Partial" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      messageId: "msg_truncated",
      error: "Workspace turn ended before completion (finishReason: length)",
    });
    expect(snapshot?.reportMarkdown).toBeUndefined();
  });

  test("workspace-turn tool-calls stream-end defers to a queued wake continuation", async () => {
    // A queued bash-monitor wake cuts the correlated stream at a tool boundary
    // (finishReason "tool-calls") while the child seamlessly continues the
    // same turn — the handle must stay running.
    const hasPendingBashMonitorWakeContinuation = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingBashMonitorWakeContinuation,
    });
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    const correlation = {
      type: "workspace-turn-task",
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    } as const;

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_queue_cut",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: correlation,
      },
      parts: [{ type: "text", text: "Kicked off verification" }],
    });

    const running = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(running).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(running?.error).toBeUndefined();

    // The continuation stream inherits the correlation metadata (see
    // AgentSession.inheritOpenWorkspaceTurnMetadata); its terminal stream-end
    // settles the turn with the real outcome.
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_continuation_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: correlation,
      },
      parts: [{ type: "text", text: "Final review report" }],
    });

    const settled = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(settled).toMatchObject({
      status: "completed",
      messageId: "msg_continuation_final",
      reportMarkdown: "Final review report",
    });
  });

  test("workspace-turn tool-calls stream-end with superseding queued input settles error", async () => {
    // Ordinary queued input (manual message, bare /compact) also cuts the
    // stream at a tool boundary, but it supersedes the delegated turn instead
    // of continuing it — the handle must settle now, not defer forever.
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingQueuedOrPreparingTurn,
    });
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_superseded_cut",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Cut mid-work" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "error",
      messageId: "msg_superseded_cut",
      error: "Workspace turn ended before completion (finishReason: tool-calls)",
    });
  });

  test("workspace-turn tool-calls stream-end defers to a streaming inherited continuation", async () => {
    // The wake already dispatched: the active stream (a newer messageId)
    // inherited this turn's correlation, proving the turn is continuing.
    const { parentId, taskService, aiMocks } = await startWorkspaceTurnForTest();
    aiMocks.getStreamInfo.mockImplementation((workspaceId: string) =>
      workspaceId === "childworkspace"
        ? {
            messageId: "msg_continuation_active",
            model: "anthropic:claude-opus-4-6",
            historySequence: 2,
            startTime: Date.now(),
            parts: [],
            toolCompletionTimestamps: new Map(),
            muxMetadata: {
              type: "workspace-turn-task",
              taskHandleId: "wst_handle",
              ownerWorkspaceId: parentId,
              turnId: "turn",
            },
          }
        : undefined
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_queue_cut_streaming",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Cut mid-work" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(snapshot?.error).toBeUndefined();
  });

  test("uncorrelated compaction stream-end does not interrupt an active workspace turn", async () => {
    // On-send compaction can consume a monitor-wake continuation mid-turn; the
    // compact turn's own stream-end is uncorrelated and must not supersede the
    // still-running delegated turn.
    const { parentId, taskService, created } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: created.workspaceId,
      messageId: "msg_compaction_summary",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "compact",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Compacted context" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, created.taskId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: created.workspaceId });
    expect(snapshot?.error).toBeUndefined();
  });

  test("workspace-turn tool-calls stream-end without continuation settles error", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_tool_calls_terminal",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Partial" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      messageId: "msg_tool_calls_terminal",
      error: "Workspace turn ended before completion (finishReason: tool-calls)",
    });
  });

  test("parent stream-end auto-resumes for active background workspace turns", async () => {
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: parentId,
      messageId: "parent_msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Parent done" }],
    });

    expect(workspaceMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[0]).toBe(parentId);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[1]).toContain("wst_handle");
  });

  test("workspace-turn stream-end waits for active descendants before finalizing", async () => {
    const { config, parentId, projectPath, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Premature final text" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(workspaceMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[0]).toBe("childworkspace");
  });

  test("workspace-turn stream-end ignores nonblocking notify descendants", async () => {
    const { config, parentId, projectPath, taskService } = await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "notify-descendant-task"),
        id: "notify-descendant-task",
        name: "notify-descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        taskAttentionPolicy: "notify_on_terminal",
      });
      return cfg;
    });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_notify_only",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Final text despite background work" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({ status: "completed", workspaceId: "childworkspace" });
    expect(snapshot).not.toMatchObject({ deferredMessageIds: ["msg_notify_only"] });
  });

  test("workspace-turn deferred stream-end does not finalize the handle", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const event: StreamEndEvent = {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_deferred",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Pre-handoff text" }],
    };
    const internal = taskService as unknown as {
      markWorkspaceTurnStreamEndDeferred: (event: StreamEndEvent) => Promise<void>;
      finalizeWorkspaceTurnFromStreamEnd: (event: StreamEndEvent) => Promise<boolean>;
    };

    await internal.markWorkspaceTurnStreamEndDeferred(event);
    expect(await internal.finalizeWorkspaceTurnFromStreamEnd(event)).toBe(true);

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_deferred"],
    });
  });

  test("workspace-turn deferred marker does not rewrite terminal handles", async () => {
    const { parentId, taskService, created } = await startWorkspaceTurnForTest();
    const interruptResult = await taskService.interruptWorkspaceTurn(parentId, created.executionId);
    expect(interruptResult.success).toBe(true);
    await (
      taskService as unknown as {
        markWorkspaceTurnStreamEndDeferred: (event: StreamEndEvent) => Promise<void>;
      }
    ).markWorkspaceTurnStreamEndDeferred({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_deferred_after_interrupt",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Pre-handoff text" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({ status: "interrupted" });
    expect(snapshot?.deferredMessageIds).toBeUndefined();
  });

  test("workspace-turn stale recovery skips deferred pre-handoff stream-end history", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prehandoff", "assistant", "Premature final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_prehandoff",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Premature final text" }],
    });

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_prehandoff"],
    });
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const recovered = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(recovered).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
    });
    expect(recovered?.reportMarkdown).toBeUndefined();
  });

  test("workspace-turn stale recovery repairs restart-interrupted deferred handles after descendants stop blocking", async () => {
    const { config, parentId, projectPath, taskService, historyService, workspaceMocks } =
      await startWorkspaceTurnForTest({ disposable: true });
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prehandoff", "assistant", "Recovered final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_prehandoff",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Recovered final text" }],
    });
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
    });

    await config.editConfig((cfg) => {
      const descendant = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "descendant-task");
      assert(descendant, "descendant task must exist");
      descendant.archivedAt = "2026-06-19T00:01:00.000Z";
      return cfg;
    });

    const repaired = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(repaired).toMatchObject({
      status: "completed",
      messageId: "msg_prehandoff",
      reportMarkdown: "Recovered final text",
    });
    expect(repaired?.error).toBeUndefined();
    expect(workspaceMocks.remove).toHaveBeenCalledWith("childworkspace", true);
  });

  test("listWorkspaceTurnTasks repairs restart-interrupted deferred handles before filtering", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_recovered_list", "assistant", "Recovered list text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      deferredMessageIds: ["msg_recovered_list"],
      error: "Workspace turn interrupted after restart",
    });

    const listed = await taskService.listWorkspaceTurnTasks(parentId, {
      statuses: ["interrupted", "completed"],
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      handleId: "wst_handle",
      status: "completed",
      messageId: "msg_recovered_list",
      reportMarkdown: "Recovered list text",
    });
    expect(listed[0]?.error).toBeUndefined();

    const interruptedOnly = await taskService.listWorkspaceTurnTasks(parentId, {
      statuses: ["interrupted"],
    });
    expect(interruptedOnly.map((record) => record.handleId)).not.toContain("wst_handle");
  });

  test("workspace-turn stale recovery repairs restart-interrupted deferred error handles", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        archivedAt: "2026-06-19T00:01:00.000Z",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_truncated", "assistant", "Partial text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);

    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      deferredMessageIds: ["msg_truncated"],
      error: "Workspace turn interrupted after restart",
    });

    const repaired = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(repaired).toMatchObject({
      status: "error",
      messageId: "msg_truncated",
      error: "Workspace turn ended before completion (finishReason: length)",
    });
  });

  test("correlated stream-end corrects a stale error settlement after self-healed retry", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_retry_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Recovered after retry" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_retry_final",
      reportMarkdown: "Recovered after retry",
    });
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.terminalAttentionNotifiedAt).toBeUndefined();
  });

  test("resettled workspace turn re-arms a consumed notify_on_terminal wake-up", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
      attentionPolicy: "notify_on_terminal",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    });
    // The stale error's wake-up was already delivered; without the tombstone reset,
    // enqueueIfAbsent would swallow the corrected outcome's notification.
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_handle",
      outputDelivery: "requires_task_await",
      terminalOutcome: "error",
    });
    await terminalAttentionStore.markDelivered(parentId, "workspace_turn:wst_handle");
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_retry_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Recovered after retry" }],
    });

    const notification = await terminalAttentionStore.get(parentId, "workspace_turn:wst_handle");
    expect(notification).toMatchObject({ terminalOutcome: "completed" });
    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "completed",
      reportMarkdown: "Recovered after retry",
    });
  });

  test("duplicate correlated stream-end replay keeps a settled error handle unchanged", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      messageId: "msg_truncated_replay",
      error: "Workspace turn ended before completion (finishReason: length)",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_truncated_replay",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Partial text" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "error",
      messageId: "msg_truncated_replay",
      updatedAt: "2026-06-19T00:00:01.000Z",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    });
  });

  test("late correlated stream-end does not resettle an explicitly interrupted workspace turn", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    // Explicit interrupt (user Esc / task_terminate): status interrupted WITHOUT the
    // stale-restart marker. An in-flight stream-end completing after the cancel must not
    // make the canceled turn appear completed.
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_late_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Late final text" }],
    });

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "interrupted",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
  });

  test("explicitly interrupted workspace turns are not revived by same-turn retry evidence", async () => {
    const isStreaming = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      isStreaming,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "interrupted",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
  });

  test("correlated stream-end never overwrites a completed workspace turn", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      messageId: "msg_first",
      reportMarkdown: "First result",
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_second",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Second result" }],
    });

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "completed",
      messageId: "msg_first",
      reportMarkdown: "First result",
    });
  });

  test("getWorkspaceTurnSnapshot repairs a stale error handle from self-healed history", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_selfhealed", "assistant", "Self-healed final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });

    // List paths skip history repair for settled handles (no runtime activity), so the
    // stale record stays visible there until a snapshot read reconciles it.
    const listed = await taskService.listWorkspaceTurnTasks(parentId, { statuses: ["error"] });
    expect(listed.map((record) => record.handleId)).toContain("wst_handle");

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_selfhealed",
      reportMarkdown: "Self-healed final text",
    });
    expect(snapshot?.error).toBeUndefined();
  });

  test("getWorkspaceTurnSnapshot revives an interrupted handle while the child retries the same turn", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasPendingAutoRetry,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Workspace turn interrupted after restart",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    });
    // Delivered tombstone from the stale settlement; revive must clear it so the revived
    // turn's eventual real settlement can enqueue a fresh wake-up.
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_handle",
      outputDelivery: "requires_task_await",
      terminalOutcome: "interrupted",
    });
    await terminalAttentionStore.markDelivered(parentId, "workspace_turn:wst_handle");
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.terminalAttentionNotifiedAt).toBeUndefined();
    expect(await terminalAttentionStore.get(parentId, "workspace_turn:wst_handle")).toBeNull();
    expect(internal.activeWorkspaceTurnHandleByWorkspaceId.get("childworkspace")).toEqual({
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
    });
  });

  test("history repair of a stale error handle waits for active child background work", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    // The retried turn emitted its correlated final while a descendant task was still
    // running; reporting completed before it finishes would hand the parent an
    // incomplete result that active handles avoid via deferred stream-ends. Instead the
    // handle is revived with the final recorded as deferred, then settles once the
    // blocker is gone.
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_blocked_final", "assistant", "Blocked final text", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "stop",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });

    const blocked = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(blocked).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_blocked_final"],
    });
    expect(blocked?.error).toBeUndefined();
    expect(blocked?.reportMarkdown).toBeUndefined();

    await config.editConfig((cfg) => {
      const descendant = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "descendant-task");
      assert(descendant, "descendant task must exist");
      descendant.archivedAt = "2026-06-19T00:01:00.000Z";
      return cfg;
    });

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "completed",
      messageId: "msg_blocked_final",
      reportMarkdown: "Blocked final text",
    });
  });

  test("turn-end blocker scan keeps a stale handle live between retry streams via child blockers", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    // Codex handoff gap: the retried child's stream ended, no auto-retry is pending, but
    // its descendant work is still running. The blocker scan must still treat the turn as
    // live so the parent cannot end its turn during that window.
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).toContain("wst_handle");
    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  test("turn-end blocker scan revives and includes a stale retrying handle", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasPendingAutoRetry,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    // The parent turn-end path must treat the stale-but-retrying handle as live work so
    // the parent cannot end its turn while the child is still running.
    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).toContain("wst_handle");
    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  test("active-only listWorkspaceTurnTasks revives and includes a stale retrying handle", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasPendingAutoRetry,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    // task_list defaults to active statuses; the status filter applies AFTER
    // normalization, so the stale-but-retrying handle is revived and reported as
    // running instead of silently disappearing from the active view.
    const listed = await taskService.listWorkspaceTurnTasks(parentId, {
      statuses: ["queued", "starting", "running"],
    });
    expect(listed.map((record) => record.handleId)).toContain("wst_handle");
    expect(listed.find((record) => record.handleId === "wst_handle")?.status).toBe("running");
  });

  test("queued manual input does not revive a settled workspace turn", async () => {
    // Ordinary queued input is not yet in history, so the newest-correlated-prompt guard
    // cannot see it; the liveness gate must not treat it as a same-turn continuation.
    const hasQueuedMessages = mock((workspaceId: string) => workspaceId === "childworkspace");
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasQueuedMessages,
      hasPendingQueuedOrPreparingTurn,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).not.toContain(
      "wst_handle"
    );
    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "error",
      error: "Stream error: provider overloaded",
    });
  });

  test("a newer unrelated child prompt does not revive a settled workspace turn", async () => {
    const isStreaming = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      isStreaming,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_manual", "user", "Manual follow-up", {})
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "error",
      error: "Stream error: provider overloaded",
    });
  });

  test("revive does not clobber a newer same-status settlement written after the stale read", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    const taskHandleStore = new TaskHandleStore(config);
    // The record currently on disk: a FRESH error settled by the live retry itself.
    const freshError = {
      kind: "workspace_turn" as const,
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error" as const,
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:05:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: retry also failed",
    };
    await taskHandleStore.upsertWorkspaceTurn(freshError);
    const internal = taskService as unknown as {
      reviveRetryingWorkspaceTurn: (record: typeof freshError) => Promise<typeof freshError | null>;
    };

    // Reconcile observed an OLDER error record (same status, earlier updatedAt) before the
    // retry failed; the revive must notice the newer settlement and leave it untouched.
    const revived = await internal.reviveRetryingWorkspaceTurn({
      ...freshError,
      updatedAt: "2026-06-19T00:00:01.000Z",
      error: "Stream error: provider overloaded",
    });

    expect(revived).toMatchObject({
      status: "error",
      updatedAt: "2026-06-19T00:05:00.000Z",
      error: "Stream error: retry also failed",
    });
    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "error",
      updatedAt: "2026-06-19T00:05:00.000Z",
      error: "Stream error: retry also failed",
    });
  });

  test("history repair scans past newer unrelated prompts to a correlated final message", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    // The turn self-healed and finished, THEN the child received an unrelated manual
    // prompt before the parent ever called task_await.
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_selfhealed_final", "assistant", "Self-healed final text", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "stop",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_manual_later", "user", "Manual follow-up", {})
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_selfhealed_final",
      reportMarkdown: "Self-healed final text",
    });
    expect(snapshot?.error).toBeUndefined();
  });

  test("workspace-turn stale recovery uses deferred history after archived descendants stop blocking", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prehandoff", "assistant", "Premature final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_prehandoff",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Premature final text" }],
    });

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_prehandoff"],
    });

    await config.editConfig((cfg) => {
      const descendant = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "descendant-task");
      assert(descendant, "descendant task must exist");
      descendant.archivedAt = "2026-06-19T00:01:00.000Z";
      return cfg;
    });

    const recovered = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(recovered).toMatchObject({
      status: "completed",
      messageId: "msg_prehandoff",
      reportMarkdown: "Premature final text",
    });
    expect(recovered?.deferredMessageIds).toBeUndefined();
  });

  test("workspace-turn deferred recovery waits for active workflow blockers", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir("childworkspace") });
    await runStore.createRun({
      id: "wfr_child_background",
      workspaceId: "childworkspace",
      workflow: {
        name: "child-background",
        description: "Child background workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_child_background", "running", "2026-06-19T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: config.getSessionDir("childworkspace"),
      runId: "wfr_child_background",
      createdAtMs: Date.parse("2026-06-19T00:00:01.000Z"),
    });

    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_workflow_blocked", "assistant", "Workflow-blocked final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);

    await (
      taskService as unknown as { handleStreamEnd: (event: StreamEndEvent) => Promise<void> }
    ).handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_workflow_blocked",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Workflow-blocked final text" }],
    });

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_workflow_blocked"],
    });

    await runStore.appendStatus("wfr_child_background", "completed", "2026-06-19T00:00:02.000Z");
    const recovered = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(recovered).toMatchObject({
      status: "completed",
      messageId: "msg_workflow_blocked",
      reportMarkdown: "Workflow-blocked final text",
    });
  });

  test("workspace-turn auto-resume preserves handle metadata", async () => {
    const { config, parentId, projectPath, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });

    await (
      taskService as unknown as { handleStreamEnd: (event: StreamEndEvent) => Promise<void> }
    ).handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Premature final text" }],
    });

    expect(workspaceMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[2]).toMatchObject({
      muxMetadata: {
        type: "workspace-turn-task",
        taskHandleId: "wst_handle",
        ownerWorkspaceId: parentId,
        turnId: "turn",
      },
    });
  });

  test("workspace-turn stream-end ignores unrelated mux metadata", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "compaction_msg",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      },
      parts: [{ type: "text", text: "Compaction summary" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
  });

  test("workspace-turn stream-end without correlation metadata interrupts the active handle", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-06-19T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
      }
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(created.success).toBe(true);

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Done without correlation metadata" }],
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "interrupted",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      error: "Workspace turn superseded by an uncorrelated workspace stream-end",
    });
    expect(snapshot?.reportMarkdown).toBeUndefined();
  });

  test("workspace-turn stream errors mark the handle failed", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = mock(
      async (...args: unknown[]): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
        const tags = args[7] as Record<string, string> | undefined;
        await config.editConfig((cfg) => {
          const project = cfg.projects.get(projectPath);
          assert(project, "test project must exist");
          project.workspaces.push({
            path: path.join(projectPath, "workspace-turn"),
            id: "childworkspace",
            name: "workspace-turn",
            title: "Workspace turn",
            createdAt: "2026-06-19T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            tags,
          });
          return cfg;
        });
        return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
      }
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(created.success).toBe(true);

    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      error: "Provider failed",
      errorType: "authentication",
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      error: "Provider failed",
    });
  });

  test("workspace-turn terminal stream errors mark the handle failed", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_unknown_error",
      error: "Provider returned no usable result",
      errorType: "unknown",
    });

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      error: "Provider returned no usable result",
    });
  });

  test("workspace-turn recoverable stream errors stay running while retry is pending", async () => {
    let retryDecisionAwaited = false;
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => retryDecisionAwaited && workspaceId === "childworkspace"
    );
    const waitForPendingStreamErrorRecoveryDecision = mock((): Promise<void> => {
      retryDecisionAwaited = true;
      return Promise.resolve();
    });
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingQueuedOrPreparingTurn,
      waitForPendingStreamErrorRecoveryDecision,
    });
    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      error: "Context too large",
      errorType: "context_exceeded",
    });

    expect(waitForPendingStreamErrorRecoveryDecision).toHaveBeenCalledWith("childworkspace");
    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  // Regression: stream_truncated (a transient provider drop) previously fell
  // outside the recoverable allowlist and terminally settled the handle even
  // though the child session had already scheduled an in-session auto-retry,
  // falsely reporting the turn as failed to the parent.
  test("workspace-turn auto-retryable stream errors stay running while retry is pending", async () => {
    let retryDecisionAwaited = false;
    const hasPendingAutoRetry = mock(
      (workspaceId: string) => retryDecisionAwaited && workspaceId === "childworkspace"
    );
    const waitForPendingStreamErrorRecoveryDecision = mock((): Promise<void> => {
      retryDecisionAwaited = true;
      return Promise.resolve();
    });
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingAutoRetry,
      waitForPendingStreamErrorRecoveryDecision,
    });
    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_truncated",
      error: "Anthropic stream closed unexpectedly before the response completed.",
      errorType: "stream_truncated",
    });

    expect(waitForPendingStreamErrorRecoveryDecision).toHaveBeenCalledWith("childworkspace");
    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  test("workspace-turn auto-retryable stream errors without a pending retry mark the handle failed", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_truncated_exhausted",
      error: "Anthropic stream closed unexpectedly before the response completed.",
      errorType: "stream_truncated",
    });

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      error: "Anthropic stream closed unexpectedly before the response completed.",
    });
  });

  // Codex review: unrelated queued manual messages must not keep the handle
  // running for auto-retryable errors — they start a different turn, so the
  // failed turn would never resume. Only an actual pending auto-retry counts.
  test("workspace-turn auto-retryable stream errors with only queued messages mark the handle failed", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(() => true);
    const hasPendingAutoRetry = mock(() => false);
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingQueuedOrPreparingTurn,
      hasPendingAutoRetry,
    });
    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_truncated_queued_only",
      error: "Anthropic stream closed unexpectedly before the response completed.",
      errorType: "stream_truncated",
    });

    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      error: "Anthropic stream closed unexpectedly before the response completed.",
    });
  });

  test("workspace-turn exhausted recoverable stream errors mark the handle failed", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_exhausted_context",
      error: "Context still too large after retry",
      errorType: "context_exceeded",
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      error: "Context still too large after retry",
    });
  });

  test("workspace-turn system stream aborts keep the handle running for resume", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamAbort: (event: StreamAbortEvent) => Promise<void>;
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamAbort({
      type: "stream-abort",
      workspaceId: "childworkspace",
      messageId: "msg_system_abort",
      abortReason: "system",
    });
    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_resumed",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Resumed done" }],
    });
    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "completed",
      messageId: "msg_resumed",
      reportMarkdown: "Resumed done",
    });
  });

  test("workspace-turn stream aborts mark the handle interrupted", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamAbort: (event: StreamAbortEvent) => Promise<void>;
    };

    await internal.handleStreamAbort({
      type: "stream-abort",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      abortReason: "user",
    });

    const snapshot = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    expect(snapshot).toMatchObject({
      status: "interrupted",
      workspaceId: "childworkspace",
    });
  });

  test("waitForWorkspaceTurn handles completion racing with waiter registration", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      taskHandleStore: {
        getWorkspaceTurn: TaskService["getWorkspaceTurnSnapshot"];
      };
    };
    const originalGetWorkspaceTurn = internal.taskHandleStore.getWorkspaceTurn.bind(
      internal.taskHandleStore
    );
    let triggered = false;
    spyOn(internal.taskHandleStore, "getWorkspaceTurn").mockImplementation(
      async (ownerWorkspaceId: string, handleId: string) => {
        const record = await originalGetWorkspaceTurn(ownerWorkspaceId, handleId);
        if (!triggered && handleId === "wst_handle" && record?.status === "running") {
          triggered = true;
          await internal.handleStreamEnd({
            type: "stream-end",
            workspaceId: "childworkspace",
            messageId: "msg_1",
            metadata: {
              model: "anthropic:claude-opus-4-6",
              agentId: "exec",
              finishReason: "stop",
              muxMetadata: {
                type: "workspace-turn-task",
                taskHandleId: "wst_handle",
                ownerWorkspaceId: parentId,
                turnId: "turn",
              },
            },
            parts: [{ type: "text", text: "Done" }],
          });
        }
        return record;
      }
    );

    const report = await taskService.waitForWorkspaceTurn("wst_handle", {
      requestingWorkspaceId: parentId,
      timeoutMs: 100,
    });

    expect(triggered).toBe(true);
    expect(report.reportMarkdown).toBe("Done");
  });

  test("workspace-turn mirror failures are repairable while terminal exposure stays durable", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    const shadow = await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle");
    assert(shadow?.executionId, "workspace turn must have a canonical execution ID");
    const internal = taskService as unknown as {
      executionRegistry: ExecutionRegistry;
      persistWorkspaceTurnRecord: (record: NonNullable<typeof shadow>) => Promise<void>;
      settleWorkspaceTurn: (params: unknown) => Promise<void>;
      settleWorkspaceTurnWaiters: (handleId: string, settlement: unknown) => boolean;
    };
    const canonicalBefore = await new ExecutionStore(config).get(parentId, shadow.executionId);
    assert(canonicalBefore, "canonical execution must exist");

    const mirror = spyOn(internal.executionRegistry, "overwriteForReconciliation");
    mirror.mockRejectedValueOnce(new Error("active mirror unavailable"));
    const activeUpdate = { ...shadow, updatedAt: "2026-06-19T00:00:01.000Z" };
    await internal.persistWorkspaceTurnRecord(activeUpdate);
    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "running",
      updatedAt: activeUpdate.updatedAt,
    });
    expect(await new ExecutionStore(config).get(parentId, shadow.executionId)).toEqual(
      canonicalBefore
    );

    const waiterSettlement = spyOn(internal, "settleWorkspaceTurnWaiters");
    mirror.mockRejectedValueOnce(new Error("terminal mirror unavailable"));
    const terminal = {
      ...activeUpdate,
      status: "completed" as const,
      updatedAt: "2026-06-19T00:00:02.000Z",
      reportMarkdown: "Durable shadow result",
    };
    let terminalMirrorError: unknown;
    try {
      await internal.settleWorkspaceTurn({
        record: activeUpdate,
        next: terminal,
        waiterSettlement: {
          status: "completed",
          result: {
            taskId: terminal.handleId,
            workspaceId: terminal.workspaceId,
            reportMarkdown: terminal.reportMarkdown,
          },
        },
      });
    } catch (error) {
      terminalMirrorError = error;
    }
    assert(terminalMirrorError instanceof Error, "terminal mirror must fail");
    expect(terminalMirrorError.message).toContain("terminal mirror unavailable");
    expect(waiterSettlement).not.toHaveBeenCalled();
    expect(await taskService.getWorkspaceTurnSnapshot(parentId, "wst_handle")).toMatchObject({
      status: "completed",
      reportMarkdown: "Durable shadow result",
    });
    expect(await new ExecutionStore(config).get(parentId, shadow.executionId)).toEqual(
      canonicalBefore
    );
  });

  test("workspace-turn terminal settlements do not overwrite each other", async () => {
    const completed = await startWorkspaceTurnForTest();
    const staleRunningRecord = await completed.taskService.getWorkspaceTurnSnapshot(
      completed.parentId,
      "wst_handle"
    );
    assert(staleRunningRecord, "expected running workspace-turn record");
    const completedInternal = completed.taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      settleWorkspaceTurn: (params: unknown) => Promise<void>;
    };
    await completedInternal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_done",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: completed.parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Done" }],
    });
    await completedInternal.settleWorkspaceTurn({
      record: staleRunningRecord,
      next: {
        ...staleRunningRecord,
        status: "interrupted",
        updatedAt: "2026-06-19T00:00:01.000Z",
      },
      waiterSettlement: { status: "error", error: new Error("late interrupt") },
    });
    expect(
      await completed.taskService.getWorkspaceTurnSnapshot(completed.parentId, "wst_handle")
    ).toMatchObject({
      status: "completed",
      messageId: "msg_done",
      reportMarkdown: "Done",
    });

    const interrupted = await startWorkspaceTurnForTest({
      stableIds: ["secondhandle", "secondturn"],
    });
    const staleInterruptedRecord = await interrupted.taskService.getWorkspaceTurnSnapshot(
      interrupted.parentId,
      "wst_secondhandle"
    );
    assert(staleInterruptedRecord, "expected second running workspace-turn record");
    const interruptResult = await interrupted.taskService.interruptWorkspaceTurn(
      interrupted.parentId,
      "wst_secondhandle"
    );
    expect(interruptResult.success).toBe(true);
    await (
      interrupted.taskService as unknown as {
        settleWorkspaceTurn: (params: unknown) => Promise<void>;
      }
    ).settleWorkspaceTurn({
      record: staleInterruptedRecord,
      next: {
        ...staleInterruptedRecord,
        status: "completed",
        updatedAt: "2026-06-19T00:00:01.000Z",
        messageId: "msg_late_done",
        reportMarkdown: "Late done",
      },
      waiterSettlement: {
        status: "completed",
        result: {
          taskId: "wst_secondhandle",
          workspaceId: "childworkspace",
          reportMarkdown: "Late done",
        },
      },
    });
    const interruptedSnapshot = await interrupted.taskService.getWorkspaceTurnSnapshot(
      interrupted.parentId,
      "wst_secondhandle"
    );
    expect(interruptedSnapshot).toMatchObject({ status: "interrupted" });
    expect(interruptedSnapshot?.reportMarkdown).toBeUndefined();
  });

  test("waitForWorkspaceTurn foreground waits can be sent to background", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();

    const waitResult = taskService
      .waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 1_000,
        backgroundOnMessageQueued: true,
      })
      .then(
        () => null,
        (error: unknown) => error
      );

    expect(taskService.backgroundForegroundWaitsForWorkspace(parentId)).toBe(1);
    expect(await waitResult).toBeInstanceOf(ForegroundWaitBackgroundedError);
    expect(taskService.backgroundForegroundWaitsForWorkspace(parentId)).toBe(0);
  });

  test("waitForWorkspaceTurn backgrounds when tool-end message was already queued", async () => {
    const hasQueuedMessages = mock(() => true);
    const { parentId, taskService } = await startWorkspaceTurnForTest({ hasQueuedMessages });

    const waitError = await taskService
      .waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 1_000,
        backgroundOnMessageQueued: true,
      })
      .catch((error: unknown) => error);

    expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);
    expect(hasQueuedMessages).toHaveBeenCalledWith(parentId, "tool-end");
    expect(taskService.backgroundForegroundWaitsForWorkspace(parentId)).toBe(0);
  });

  test("disposable workspace turns are removed after completion, error, or interruption", async () => {
    const completedRemove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const completed = await startWorkspaceTurnForTest({
      disposable: true,
      remove: completedRemove,
    });
    await (
      completed.taskService as unknown as {
        handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      }
    ).handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_completed",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: completed.parentId,
          turnId: "turn",
        },
      },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "attach-disposable",
          toolName: "attach_file",
          input: { path: "/remote/disposable/report.pdf" },
          state: "output-available",
          output: {
            type: "content",
            value: [
              { type: "text", text: "prepared" },
              {
                type: "media",
                data: Buffer.from("%PDF-disposable").toString("base64"),
                mediaType: "application/pdf",
                filename: "report.pdf",
              },
            ],
          },
        },
        { type: "text", text: "Done" },
      ],
    });
    expect(completedRemove).toHaveBeenCalledWith("childworkspace", true);
    const completedSnapshot = await completed.taskService.getWorkspaceTurnSnapshot(
      completed.parentId,
      "wst_handle"
    );
    expect(completedSnapshot?.artifacts?.attachFiles).toHaveLength(1);
    const completedArtifact = completedSnapshot?.artifacts?.attachFiles[0];
    expect(completedArtifact).toMatchObject({
      filename: "report.pdf",
      mediaType: "application/pdf",
      sourceToolCallId: "attach-disposable",
    });
    expect(await fsPromises.readFile(completedArtifact?.path ?? "")).toEqual(
      Buffer.from("%PDF-disposable")
    );
    assert(completedSnapshot?.executionId, "completed shadow must retain canonical execution ID");
    expect(
      await new ExecutionStore(completed.config).get(
        completed.parentId,
        completedSnapshot.executionId
      )
    ).toMatchObject({
      aliases: ["wst_handle"],
      status: "completed",
      terminalAt: completedSnapshot.updatedAt,
      result: {
        kind: "completed",
        reportMarkdown: "Done",
        finalMessageRef: { messageId: "msg_completed" },
        artifacts: { attachFiles: [completedArtifact] },
      },
    });

    const errorRemove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const failed = await startWorkspaceTurnForTest({ disposable: true, remove: errorRemove });
    await (
      failed.taskService as unknown as {
        handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
      }
    ).handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_error",
      error: "Provider failed",
      errorType: "authentication",
    });
    expect(errorRemove).toHaveBeenCalledWith("childworkspace", true);
    const failedShadow = await failed.taskService.getWorkspaceTurnSnapshot(
      failed.parentId,
      "wst_handle"
    );
    assert(failedShadow?.executionId, "error shadow must retain canonical execution ID");
    expect(
      await new ExecutionStore(failed.config).get(failed.parentId, failedShadow.executionId)
    ).toMatchObject({
      status: "error",
      result: { kind: "error", error: "Provider failed" },
    });

    const interruptedRemove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const interrupted = await startWorkspaceTurnForTest({
      disposable: true,
      remove: interruptedRemove,
      isStreaming: mock(() => true),
    });
    const interruptResult = await interrupted.taskService.interruptWorkspaceTurn(
      interrupted.parentId,
      "wst_handle"
    );
    expect(interruptResult.success).toBe(true);
    expect(interruptedRemove).toHaveBeenCalledWith("childworkspace", true);
    const interruptedShadow = await interrupted.taskService.getWorkspaceTurnSnapshot(
      interrupted.parentId,
      "wst_handle"
    );
    assert(interruptedShadow?.executionId, "interrupted shadow must retain canonical execution ID");
    expect(
      await new ExecutionStore(interrupted.config).get(
        interrupted.parentId,
        interruptedShadow.executionId
      )
    ).toMatchObject({
      status: "interrupted",
      result: { kind: "interrupted" },
    });
  });

  test("enforces maxTaskNestingDepth", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], "dddddddddd");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });

    const initLogger = createNullInitLogger();

    const parentName = "parent";
    const parentCreate = await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    expect(parentCreate.success).toBe(true);

    const parentId = "1111111111";
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(3, 2)
    );
    const { taskService } = createTaskServiceHarness(config);

    const first = await createAgentTask(taskService, parentId, "explore this repo");
    expect(first.success).toBe(true);
    if (!first.success) return;

    const second = await createAgentTask(taskService, first.data.workspaceId, "nested explore");
    expect(second.success).toBe(true);
    if (!second.success) return;

    const third = await createAgentTask(
      taskService,
      second.data.workspaceId,
      "nested explore again"
    );
    expect(third.success).toBe(false);
    if (!third.success) {
      expect(third.error).toContain("maxTaskNestingDepth");
    }
  }, 20_000);

  test("plan is only runnable for workflow-owned task creation", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["planworkflow"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);

    const normal = await createAgentTask(taskService, parentId, "plan normally", {
      agentId: "plan",
      agentType: "plan",
    });
    expect(normal.success).toBe(false);

    const workflowOwned = await createAgentTask(taskService, parentId, "plan workflow step", {
      agentId: "plan",
      agentType: "plan",
      workflowTask: { runId: "wfr_plan", stepId: "plan" },
    });
    expect(workflowOwned.success).toBe(true);
  });

  test("createMany allows workflow-owned plan tasks but not normal plan tasks", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["planbatcha", "planbatchb"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);

    const normal = await taskService.createMany([
      {
        parentWorkspaceId: parentId,
        kind: "agent" as const,
        agentId: "plan",
        prompt: "plan normally",
        title: "Normal plan",
      },
    ]);
    expect(normal.success).toBe(false);

    const workflowOwned = await taskService.createMany([
      {
        parentWorkspaceId: parentId,
        kind: "agent" as const,
        agentId: "plan",
        prompt: "plan workflow step",
        title: "Workflow plan",
        workflowTask: { runId: "wfr_plan_many", stepId: "plan" },
      },
    ]);
    expect(workflowOwned.success).toBe(true);
  });

  test("createMany reserves admitted tasks as starting and over-capacity tasks as queued", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], "dddddddddd");

    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { maxParallelAgentTasks: 2, maxTaskNestingDepth: 3 };
      return cfg;
    });

    const sendMessage = mock(() => new Promise<Result<void>>(() => undefined));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.createMany(
      ["one", "two", "three"].map((prompt, index) => ({
        parentWorkspaceId: parentId,
        kind: "agent" as const,
        agentId: "explore",
        prompt,
        title: `Task ${index + 1}`,
      }))
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((task) => task.status)).toEqual(["starting", "starting", "queued"]);

    const executionStore = new ExecutionStore(config);
    const executionStatuses = await Promise.all(
      result.data.map(async (task) => (await executionStore.get(parentId, task.taskId))?.status)
    );
    expect(executionStatuses).toEqual(["starting", "starting", "queued"]);

    const tasks = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .filter((workspace) => workspace.parentWorkspaceId === parentId);
    expect(tasks.map((task) => task.taskStatus)).toEqual(["starting", "starting", "queued"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createMany persists task policies for both admitted and queued tasks", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb"], "cccccccccc");

    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 };
      return cfg;
    });

    const sendMessage = mock(() => new Promise<Result<void>>(() => undefined));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.createMany(
      ["one", "two"].map((prompt, index) => ({
        parentWorkspaceId: parentId,
        kind: "agent" as const,
        agentId: "explore",
        prompt,
        title: `Task ${index + 1}`,
        // Both policies must survive queueing so cleanup and refusal handling keep the caller's
        // explicit intent after restart.
        onRefusal: "fail" as const,
        sticky: true,
      }))
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((task) => task.status)).toEqual(["starting", "queued"]);

    // Both the immediately-admitted and the queued task must persist the policies so later send,
    // cleanup, and post-restart resume paths keep honoring them.
    const tasks = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .filter((workspace) => workspace.parentWorkspaceId === parentId);
    expect(tasks.map((task) => task.taskOnRefusal)).toEqual(["fail", "fail"]);
    expect(tasks.map((task) => task.taskSticky)).toEqual([true, true]);
  });

  test("resolveWorkspaceModelFallbackChain honors taskOnRefusal opt-out", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const failChildId = "child-fail";
    const fallbackChildId = "child-fallback";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child-fail", failChildId, {
          name: "agent_explore_fail",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskOnRefusal: "fail",
        }),
        projectWorkspace(projectPath, "child-fallback", fallbackChildId, {
          name: "agent_explore_fallback",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );
    await config.editConfig((cfg) => {
      cfg.modelFallbacks = {
        "anthropic:claude-fable-5": { models: ["openai:gpt-5.5"] },
      };
      return cfg;
    });

    const cfg = config.loadConfigOrDefault();

    // Tasks default to the configured chain; "fail" opts out; workspaces not
    // in config (plain non-task sends) keep the chain; unconfigured source
    // models have no chain at all.
    expect(
      resolveWorkspaceModelFallbackChain(cfg, fallbackChildId, "anthropic:claude-fable-5")
    ).toEqual(["openai:gpt-5.5"]);
    expect(
      resolveWorkspaceModelFallbackChain(cfg, failChildId, "anthropic:claude-fable-5")
    ).toEqual([]);
    expect(
      resolveWorkspaceModelFallbackChain(cfg, "not-in-config", "anthropic:claude-fable-5")
    ).toEqual(["openai:gpt-5.5"]);
    expect(resolveWorkspaceModelFallbackChain(cfg, fallbackChildId, "openai:gpt-5.5")).toEqual([]);
  });

  test("createMany launch failure preserves returned task metadata and launch error", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Err("Forbidden")));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.createMany([
      {
        parentWorkspaceId: parentId,
        kind: "agent",
        agentId: "explore",
        prompt: "launch should fail",
        title: "Failing task",
      },
    ]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const taskId = result.data[0]?.taskId;
    const workspaceId = result.data[0]?.workspaceId;
    assert(typeof taskId === "string" && taskId.length > 0, "created task id is required");
    assert(
      typeof workspaceId === "string" && workspaceId.length > 0,
      "created workspace id is required"
    );

    let launchError: unknown;
    try {
      await taskService.waitForAgentReport(taskId, {
        timeoutMs: 10_000,
        requestingWorkspaceId: parentId,
      });
    } catch (error: unknown) {
      launchError = error;
    }
    assert(launchError instanceof Error, "waitForAgentReport should reject with launch error");
    expect(launchError.message).toContain("Forbidden");

    const taskEntry = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === workspaceId);
    expect(await new ExecutionStore(config).get(parentId, taskId)).toMatchObject({
      status: "error",
      result: { kind: "error", error: "Forbidden" },
    });
    expect(taskEntry?.taskStatus).toBe("interrupted");
    expect(taskEntry?.taskLaunchError).toBe("Forbidden");
  });

  test("queues tasks when maxParallelAgentTasks is reached and starts them when a slot frees", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"], "eeeeeeeeee");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parent1Name = "parent1";
    const parent2Name = "parent2";
    await runtime.createWorkspace({
      projectPath,
      branchName: parent1Name,
      trunkBranch: "main",
      directoryName: parent1Name,
      initLogger,
    });
    await runtime.createWorkspace({
      projectPath,
      branchName: parent2Name,
      trunkBranch: "main",
      directoryName: parent2Name,
      initLogger,
    });

    const parent1Id = "1111111111";
    const parent2Id = "2222222222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, parent1Name),
          id: parent1Id,
          name: parent1Name,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        {
          path: runtime.getWorkspacePath(projectPath, parent2Name),
          id: parent2Id,
          name: parent2Name,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const running = await createAgentTask(taskService, parent1Id, "task 1");
    expect(running.success).toBe(true);
    if (!running.success) return;

    const queued = await createAgentTask(taskService, parent2Id, "task 2");
    expect(queued.success).toBe(true);
    if (!queued.success) return;
    expect(queued.data.status).toBe("queued");

    // Free the slot by marking the first task as reported. Also simulate a legacy queued
    // task that only has agentType so dequeue preserves Explore instead of falling back to Exec.
    await config.editConfig((cfg) => {
      for (const [_project, project] of cfg.projects) {
        const ws = project.workspaces.find((w) => w.id === running.data.workspaceId);
        if (ws) {
          ws.taskStatus = "reported";
        }
        const queuedWs = project.workspaces.find((w) => w.id === queued.data.workspaceId);
        if (queuedWs) {
          queuedWs.agentId = "";
        }
      }
      return cfg;
    });

    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(
      () => undefined
    );
    try {
      await taskService.initialize();

      expect(sendMessage).toHaveBeenCalledWith(
        queued.data.workspaceId,
        "task 2",
        expect.objectContaining({ agentId: "explore" }),
        expect.objectContaining({ allowQueuedAgentTask: true })
      );
      expect(runBackgroundInitSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ skipInitHook: true }),
        queued.data.workspaceId
      );
    } finally {
      runBackgroundInitSpy.mockRestore();
    }

    const cfg = config.loadConfigOrDefault();
    const started = Array.from(cfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queued.data.workspaceId);
    expect(started?.taskStatus).toBe("running");
  }, 20_000);

  test("resumes accepted queued starts instead of replaying prompts", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    const queuedTaskId = "task-queued";
    const queuedWorkspaceName = "agent_explore_task-queued";
    const acceptedStartingTaskId = "task-starting-accepted";
    const acceptedStartingWorkspaceName = "agent_explore_task-starting-accepted";
    const acceptedPrompt = "already accepted prompt";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, parentName),
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        {
          path: runtime.getWorkspacePath(projectPath, queuedWorkspaceName),
          id: queuedTaskId,
          name: queuedWorkspaceName,
          title: "Legacy queued task",
          createdAt: new Date().toISOString(),
          runtimeConfig,
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskModelString: defaultModel,
          taskTrunkBranch: parentName,
        },
        {
          path: runtime.getWorkspacePath(projectPath, acceptedStartingWorkspaceName),
          id: acceptedStartingTaskId,
          name: acceptedStartingWorkspaceName,
          title: "Accepted starting task",
          createdAt: new Date().toISOString(),
          runtimeConfig,
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "starting",
          taskPrompt: acceptedPrompt,
          taskModelString: defaultModel,
          taskTrunkBranch: parentName,
        },
      ],
      testTaskSettings(2, 3)
    );

    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    const appendAcceptedPrompt = await historyService.appendToHistory(
      acceptedStartingTaskId,
      createMuxMessage("accepted-starting-prompt", "user", acceptedPrompt)
    );
    expect(appendAcceptedPrompt.success).toBe(true);
    expect(findWorkspaceInConfig(config, queuedTaskId)?.taskPrompt).toBeUndefined();
    expect(findWorkspaceInConfig(config, acceptedStartingTaskId)?.taskPrompt).toBe(acceptedPrompt);

    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(
      () => undefined
    );
    try {
      await taskService.initialize();

      for (const taskId of [queuedTaskId, acceptedStartingTaskId]) {
        expect(resumeStream).toHaveBeenCalledWith(
          taskId,
          expect.objectContaining({ model: defaultModel, agentId: "explore" }),
          expect.objectContaining({ allowQueuedAgentTask: true, agentInitiated: true })
        );
      }
      const sendMessagePrompts = (
        sendMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls.map((call) => call[1]);
      expect(sendMessagePrompts).not.toContain(acceptedPrompt);
    } finally {
      runBackgroundInitSpy.mockRestore();
    }

    await Promise.all([
      waitForWorkspaceTaskStatus(config, queuedTaskId, "running"),
      waitForWorkspaceTaskStatus(config, acceptedStartingTaskId, "running"),
    ]);

    const queued = findWorkspaceInConfig(config, queuedTaskId);
    expect(queued?.taskStatus).toBe("running");
    const acceptedStarting = findWorkspaceInConfig(config, acceptedStartingTaskId);
    expect(acceptedStarting?.taskStatus).toBe("running");
    expect(acceptedStarting?.taskPrompt).toBeUndefined();
  }, 20_000);

  test("does not count foreground-awaiting tasks towards maxParallelAgentTasks", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], "dddddddddd");

    const projectPath = await createTestProject(rootDir);

    let streamingWorkspaceId: string | null = null;
    const { aiService } = createAIServiceMocks(config, {
      isStreaming: mock((workspaceId: string) => workspaceId === streamingWorkspaceId),
    });

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const rootName = "root";
    await runtime.createWorkspace({
      projectPath,
      branchName: rootName,
      trunkBranch: "main",
      directoryName: rootName,
      initLogger,
    });

    const rootWorkspaceId = "root-111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, rootName),
          id: rootWorkspaceId,
          name: rootName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const parentTask = await createAgentTask(taskService, rootWorkspaceId, "parent task");
    expect(parentTask.success).toBe(true);
    if (!parentTask.success) return;
    streamingWorkspaceId = parentTask.data.workspaceId;

    // With maxParallelAgentTasks=1, nested tasks will be created as queued.
    const childTask = await createAgentTask(taskService, parentTask.data.workspaceId, "child task");
    expect(childTask.success).toBe(true);
    if (!childTask.success) return;
    expect(childTask.data.status).toBe("queued");

    // Simulate a foreground await from the parent task workspace. This should allow the queued child
    // to start despite maxParallelAgentTasks=1, avoiding a scheduler deadlock.
    const waiter = taskService.waitForAgentReport(childTask.data.workspaceId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentTask.data.workspaceId,
    });

    const internal = taskService as unknown as {
      maybeStartQueuedTasks: () => Promise<void>;
      resolveWaiters: (taskId: string, report: { reportMarkdown: string; title?: string }) => void;
    };

    await internal.maybeStartQueuedTasks();

    expect(sendMessage).toHaveBeenCalledWith(
      childTask.data.workspaceId,
      "child task",
      expect.anything(),
      expect.objectContaining({ allowQueuedAgentTask: true })
    );

    const cfgAfterStart = config.loadConfigOrDefault();
    const startedEntry = Array.from(cfgAfterStart.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childTask.data.workspaceId);
    expect(startedEntry?.taskStatus).toBe("running");

    internal.resolveWaiters(childTask.data.workspaceId, { reportMarkdown: "ok" });
    const report = await waiter;
    expect(report.reportMarkdown).toBe("ok");
  }, 20_000);

  test("persists forked runtime config updates when dequeuing tasks", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb"], "cccccccccc");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, parentName),
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const forkedSrcBaseDir = path.join(config.srcDir, "forked-runtime");
    const sourceSrcBaseDir = path.join(config.srcDir, "source-runtime");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- intentionally capturing prototype method for spy
    const originalFork = WorktreeRuntime.prototype.forkWorkspace;
    let forkCallCount = 0;
    const forkSpy = spyOn(WorktreeRuntime.prototype, "forkWorkspace").mockImplementation(
      async function (this: WorktreeRuntime, params: WorkspaceForkParams) {
        const result = await originalFork.call(this, params);
        if (!result.success) return result;
        forkCallCount += 1;
        if (forkCallCount === 2) {
          return {
            ...result,
            forkedRuntimeConfig: { ...runtimeConfig, srcBaseDir: forkedSrcBaseDir },
            sourceRuntimeConfig: { ...runtimeConfig, srcBaseDir: sourceSrcBaseDir },
          };
        }
        return result;
      }
    );

    try {
      const { taskService } = createTaskServiceHarness(config);

      const running = await createAgentTask(taskService, parentId, "task 1");
      expect(running.success).toBe(true);
      if (!running.success) return;

      const queued = await createAgentTask(taskService, parentId, "task 2");
      expect(queued.success).toBe(true);
      if (!queued.success) return;
      expect(queued.data.status).toBe("queued");

      await config.editConfig((cfg) => {
        for (const [_project, project] of cfg.projects) {
          const ws = project.workspaces.find((w) => w.id === running.data.workspaceId);
          if (ws) {
            ws.taskStatus = "reported";
          }
        }
        return cfg;
      });

      await taskService.initialize();

      const postCfg = config.loadConfigOrDefault();
      const workspaces = Array.from(postCfg.projects.values()).flatMap((p) => p.workspaces);
      const parentEntry = workspaces.find((w) => w.id === parentId);
      const childEntry = workspaces.find((w) => w.id === queued.data.workspaceId);
      expect(parentEntry?.runtimeConfig).toMatchObject({
        type: "worktree",
        srcBaseDir: sourceSrcBaseDir,
      });
      expect(childEntry?.runtimeConfig).toMatchObject({
        type: "worktree",
        srcBaseDir: forkedSrcBaseDir,
      });
    } finally {
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("configures MultiProjectRuntime envResolver before queued task background init", async () => {
    const config = await createTestConfig(rootDir);

    const primaryProjectPath = await createTestProject(rootDir, "repo-primary");
    const secondaryProjectPath = await createTestProject(rootDir, "repo-secondary");

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath: primaryProjectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath: primaryProjectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    const queuedTaskId = "task-queued";
    const queuedWorkspaceName = "agent_exec_task-queued";
    const projects = [
      {
        projectPath: primaryProjectPath,
        projectName: path.basename(primaryProjectPath),
      },
      {
        projectPath: secondaryProjectPath,
        projectName: path.basename(secondaryProjectPath),
      },
    ];

    await config.editConfig(() => ({
      projects: new Map([
        [
          primaryProjectPath,
          {
            trusted: true,
            workspaces: [
              {
                path: runtime.getWorkspacePath(primaryProjectPath, parentName),
                id: parentId,
                name: parentName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
                projects,
              },
              {
                path: runtime.getWorkspacePath(primaryProjectPath, queuedWorkspaceName),
                id: queuedTaskId,
                name: queuedWorkspaceName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
                parentWorkspaceId: parentId,
                taskStatus: "queued",
                taskPrompt: "start queued task",
                taskTrunkBranch: "main",
                projects,
              },
            ],
          },
        ],
        [secondaryProjectPath, { trusted: true, workspaces: [] }],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    }));

    await config.updateProjectSecrets(primaryProjectPath, [
      { key: "PRIMARY_SECRET", value: "primary-secret" },
    ]);
    await config.updateProjectSecrets(secondaryProjectPath, [
      { key: "SECONDARY_SECRET", value: "secondary-secret" },
    ]);

    const targetRuntime = new MultiProjectRuntime(
      new ContainerManager(config.srcDir),
      [
        {
          projectPath: primaryProjectPath,
          projectName: path.basename(primaryProjectPath),
          runtime: {
            getWorkspacePath: mock(() => path.join(primaryProjectPath, queuedWorkspaceName)),
            initWorkspace: mock(() => Promise.resolve({ success: true })),
          } as unknown as WorktreeRuntime,
        },
        {
          projectPath: secondaryProjectPath,
          projectName: path.basename(secondaryProjectPath),
          runtime: {
            getWorkspacePath: mock(() => path.join(secondaryProjectPath, queuedWorkspaceName)),
            initWorkspace: mock(() => Promise.resolve({ success: true })),
          } as unknown as WorktreeRuntime,
        },
      ],
      queuedWorkspaceName
    );

    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork").mockResolvedValue({
      success: true,
      data: {
        workspacePath: path.join(config.srcDir, "_workspaces", queuedWorkspaceName),
        trunkBranch: "main",
        forkedRuntimeConfig: runtimeConfig,
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
        projects,
      },
    });
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(
      () => undefined
    );

    try {
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      await taskService.initialize();

      expect(forkSpy).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        queuedTaskId,
        "start queued task",
        expect.anything(),
        expect.objectContaining({ allowQueuedAgentTask: true })
      );
      expect(runBackgroundInitSpy).toHaveBeenCalledTimes(1);

      const firstBackgroundInitCall = runBackgroundInitSpy.mock.calls[0];
      assert(firstBackgroundInitCall, "Expected queued task to trigger background init");
      const [runtimeArg, initParams] = firstBackgroundInitCall;
      expect(runtimeArg).toBe(targetRuntime);
      expect(initParams.env).toEqual({ PRIMARY_SECRET: "primary-secret" });
      assert(
        runtimeArg instanceof MultiProjectRuntime,
        "Expected queued task runtime to be multi-project"
      );
      assert(runtimeArg.envResolver, "Expected MultiProjectRuntime.envResolver to be configured");
      expect(await runtimeArg.envResolver(primaryProjectPath)).toEqual({
        PRIMARY_SECRET: "primary-secret",
      });
      expect(await runtimeArg.envResolver(secondaryProjectPath)).toEqual({
        SECONDARY_SECRET: "secondary-secret",
      });
    } finally {
      runBackgroundInitSpy.mockRestore();
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("isolation: none shares the parent worktree without forking or re-initializing", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    const parentId = "1111111111";
    const childTaskId = "2222222222";
    stubStableIds(config, [childTaskId]);

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings()
    );

    // orchestrateFork must NOT be called for isolation: "none"; runBackgroundInit is stubbed only
    // so a stray call would be observable (it should not be invoked either).
    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(
      () => undefined
    );
    try {
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const result = await createAgentTask(taskService, parentId, "read-only analysis", {
        isolation: "none",
      });

      expect(result.success).toBe(true);
      assert(result.success, "Expected shared-workspace task to be created");
      expect(result.data.status).toBe("running");
      expect(result.data.workspaceId).toBe(childTaskId);
      expect(result.data.taskId).not.toBe(childTaskId);

      // No fork and no init: the sub-agent reuses the parent's live checkout.
      expect(forkSpy).not.toHaveBeenCalled();
      expect(runBackgroundInitSpy).not.toHaveBeenCalled();

      // The persisted child entry points at the parent's checkout and is flagged shared.
      const childEntry = findWorkspaceInConfig(config, childTaskId);
      assert(childEntry, "Expected child task workspace to be persisted");
      expect(childEntry.path).toBe(parentPath);
      expect(childEntry.taskIsolation).toBe("none");
      expect(childEntry.runtimeConfig?.type).toBe("worktree");

      expect(sendMessage).toHaveBeenCalledWith(
        childTaskId,
        "read-only analysis",
        expect.anything(),
        expect.objectContaining({ agentInitiated: true })
      );
    } finally {
      runBackgroundInitSpy.mockRestore();
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("dequeued isolation: none task reuses the parent checkout without forking or init", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    const parentId = "1111111111";
    const queuedTaskId = "task-shared-queued";
    const queuedWorkspaceName = "agent_explore_task-shared-queued";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        {
          // Shared queued tasks persist the parent's checkout path (see TaskService.create).
          path: parentPath,
          id: queuedTaskId,
          name: queuedWorkspaceName,
          title: "Shared queued task",
          createdAt: new Date().toISOString(),
          runtimeConfig,
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskPrompt: "queued shared analysis",
          taskModelString: defaultModel,
          taskTrunkBranch: parentName,
          taskIsolation: "none",
        },
      ],
      testTaskSettings()
    );

    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(
      () => undefined
    );
    try {
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      await taskService.initialize();
      await waitForWorkspaceTaskStatus(config, queuedTaskId, "running");

      // Dequeue must reuse the existing shared checkout: no fork, no init.
      expect(forkSpy).not.toHaveBeenCalled();
      expect(runBackgroundInitSpy).not.toHaveBeenCalled();

      const entry = findWorkspaceInConfig(config, queuedTaskId);
      assert(entry, "Expected queued shared task to remain persisted");
      expect(entry.path).toBe(parentPath);
      expect(entry.taskIsolation).toBe("none");

      expect(sendMessage).toHaveBeenCalledWith(
        queuedTaskId,
        "queued shared analysis",
        expect.anything(),
        expect.objectContaining({ agentInitiated: true })
      );
    } finally {
      runBackgroundInitSpy.mockRestore();
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("nested isolation: none task inherits the shared parent's real branch and checkout", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const grandparentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: grandparentName,
      trunkBranch: "main",
      directoryName: grandparentName,
      initLogger,
    });
    const checkoutPath = runtime.getWorkspacePath(projectPath, grandparentName);

    const grandparentId = "1111111111";
    const sharedParentId = "2222222222";
    const nestedChildId = "4444444444";
    stubStableIds(config, [nestedChildId]);

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: checkoutPath,
          id: grandparentId,
          name: grandparentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        {
          // The parent is itself a shared task: synthetic name, path = grandparent's checkout,
          // and taskTrunkBranch names the real branch checked out there.
          path: checkoutPath,
          id: sharedParentId,
          name: "agent_explore_shared-parent",
          createdAt: new Date().toISOString(),
          runtimeConfig,
          parentWorkspaceId: grandparentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          taskTrunkBranch: grandparentName,
          taskIsolation: "none",
        },
      ],
      testTaskSettings()
    );

    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(
      () => undefined
    );
    try {
      const { workspaceService } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const result = await createAgentTask(taskService, sharedParentId, "nested analysis", {
        isolation: "none",
      });

      expect(result.success).toBe(true);
      assert(result.success, "Expected nested shared task to be created");
      expect(forkSpy).not.toHaveBeenCalled();

      const childEntry = findWorkspaceInConfig(config, nestedChildId);
      assert(childEntry, "Expected nested shared task to be persisted");
      // Path resolves through the parent's persisted (shared) checkout, not its synthetic name.
      expect(childEntry.path).toBe(checkoutPath);
      // The persisted trunk branch is the REAL branch in the shared checkout (the grandparent's),
      // not the parent's synthetic agent workspace name — fork fallbacks depend on it existing.
      expect(childEntry.taskTrunkBranch).toBe(grandparentName);
      expect(childEntry.taskIsolation).toBe("none");
    } finally {
      runBackgroundInitSpy.mockRestore();
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("createMany honors isolation: none by reusing the parent checkout", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    const parentId = "1111111111";
    const childTaskId = "3333333333";
    stubStableIds(config, [childTaskId]);

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings()
    );

    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(
      () => undefined
    );
    try {
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const result = await taskService.createMany([
        {
          parentWorkspaceId: parentId,
          kind: "agent" as const,
          agentId: "explore",
          prompt: "batched shared analysis",
          title: "Batched shared task",
          isolation: "none" as const,
        },
      ]);

      expect(result.success).toBe(true);
      assert(result.success, "Expected createMany to succeed");
      expect(result.data[0]?.status).toBe("starting");

      // The reserved entry must point at the parent's checkout and carry the shared flag so
      // the reservation launch path reuses it (no fork, no init) and removal preserves it.
      const entry = findWorkspaceInConfig(config, childTaskId);
      assert(entry, "Expected batched shared task to be persisted");
      expect(entry.path).toBe(parentPath);
      expect(entry.taskIsolation).toBe("none");

      await waitForWorkspaceTaskStatus(config, childTaskId, "running");
      expect(forkSpy).not.toHaveBeenCalled();
      expect(runBackgroundInitSpy).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(
        childTaskId,
        "batched shared analysis",
        expect.anything(),
        expect.objectContaining({ agentInitiated: true })
      );
    } finally {
      runBackgroundInitSpy.mockRestore();
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("interrupts queued tasks when the primary project loses trust before dequeue", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    const queuedTaskId = "task-queued";
    const queuedWorkspaceName = "agent_exec_task-queued";

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, parentName),
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        {
          path: runtime.getWorkspacePath(projectPath, queuedWorkspaceName),
          id: queuedTaskId,
          name: queuedWorkspaceName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
          parentWorkspaceId: parentId,
          taskStatus: "queued",
          taskPrompt: "start queued task",
          taskTrunkBranch: "main",
        },
      ],
      testTaskSettings(1, 3)
    );

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "Expected queued task project to exist before revoking trust");
      project.trusted = false;
      return cfg;
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();
    await taskService.initialize();

    expect(sendMessage).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const queuedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === queuedTaskId);
    expect(queuedTask?.taskStatus).toBe("interrupted");
  }, 20_000);

  test("interrupts queued multi-project tasks when a secondary project loses trust", async () => {
    const config = await createTestConfig(rootDir);

    const primaryProjectPath = await createTestProject(rootDir, "repo-primary");
    const secondaryProjectPath = await createTestProject(rootDir, "repo-secondary");

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath: primaryProjectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath: primaryProjectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    const queuedTaskId = "task-queued";
    const queuedWorkspaceName = "agent_exec_task-queued";
    const projects = [
      {
        projectPath: primaryProjectPath,
        projectName: path.basename(primaryProjectPath),
      },
      {
        projectPath: secondaryProjectPath,
        projectName: path.basename(secondaryProjectPath),
      },
    ];

    await config.editConfig(() => ({
      projects: new Map([
        [
          primaryProjectPath,
          {
            trusted: true,
            workspaces: [
              {
                path: runtime.getWorkspacePath(primaryProjectPath, parentName),
                id: parentId,
                name: parentName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
                projects,
              },
              {
                path: runtime.getWorkspacePath(primaryProjectPath, queuedWorkspaceName),
                id: queuedTaskId,
                name: queuedWorkspaceName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
                parentWorkspaceId: parentId,
                taskStatus: "queued",
                taskPrompt: "start queued task",
                taskTrunkBranch: "main",
                projects,
              },
            ],
          },
        ],
        [secondaryProjectPath, { trusted: true, workspaces: [] }],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    }));

    await config.editConfig((cfg) => {
      const secondaryProject = cfg.projects.get(secondaryProjectPath);
      assert(secondaryProject, "Expected secondary project to exist before revoking trust");
      secondaryProject.trusted = false;
      return cfg;
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();
    await taskService.initialize();

    expect(sendMessage).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const queuedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === queuedTaskId);
    expect(queuedTask?.taskStatus).toBe("interrupted");
  }, 20_000);

  test("does not run init hooks for queued tasks until they start", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], "dddddddddd");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, parentName),
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const initStateManager = new RealInitStateManager(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService,
      initStateManager: initStateManager as unknown as InitStateManager,
    });

    const running = await createAgentTask(taskService, parentId, "task 1");
    expect(running.success).toBe(true);
    if (!running.success) return;

    // Wait for running task init (fire-and-forget) so the init-status file exists.
    await initStateManager.waitForInit(running.data.workspaceId);

    const queued = await createAgentTask(taskService, parentId, "task 2");
    expect(queued.success).toBe(true);
    if (!queued.success) return;
    expect(queued.data.status).toBe("queued");

    // Queued tasks should not create a worktree directory until they're dequeued.
    const cfgBeforeStart = config.loadConfigOrDefault();
    const queuedEntryBeforeStart = Array.from(cfgBeforeStart.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queued.data.workspaceId);
    expect(queuedEntryBeforeStart).toBeTruthy();
    await fsPromises.stat(queuedEntryBeforeStart!.path).then(
      () => {
        throw new Error("Expected queued task workspace path to not exist before start");
      },
      () => undefined
    );

    const queuedInitStatusPath = path.join(
      config.getSessionDir(queued.data.workspaceId),
      "init-status.json"
    );
    await fsPromises.stat(queuedInitStatusPath).then(
      () => {
        throw new Error("Expected queued task init-status to not exist before start");
      },
      () => undefined
    );

    // Free slot and start queued tasks.
    await config.editConfig((cfg) => {
      for (const [_project, project] of cfg.projects) {
        const ws = project.workspaces.find((w) => w.id === running.data.workspaceId);
        if (ws) {
          ws.taskStatus = "reported";
        }
      }
      return cfg;
    });

    await taskService.initialize();

    expect(sendMessage).toHaveBeenCalledWith(
      queued.data.workspaceId,
      "task 2",
      expect.anything(),
      expect.objectContaining({ allowQueuedAgentTask: true })
    );

    // Init should start only once the task is dequeued.
    await initStateManager.waitForInit(queued.data.workspaceId);
    expect(await fsPromises.stat(queuedInitStatusPath)).toBeTruthy();

    const cfgAfterStart = config.loadConfigOrDefault();
    const queuedEntryAfterStart = Array.from(cfgAfterStart.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queued.data.workspaceId);
    expect(queuedEntryAfterStart).toBeTruthy();
    expect(await fsPromises.stat(queuedEntryAfterStart!.path)).toBeTruthy();
  }, 20_000);

  test("does not start queued tasks while a reported task is still streaming", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const reportedTaskId = "task-reported";
    const queuedTaskId = "task-queued";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "reported", reportedTaskId, {
          name: "agent_explore_reported",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "reported",
        }),
        projectWorkspace(projectPath, "queued", queuedTaskId, {
          name: "agent_explore_queued",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "queued",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { aiService } = createAIServiceMocks(config, {
      isStreaming: mock((workspaceId: string) => workspaceId === reportedTaskId),
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    expect(sendMessage).not.toHaveBeenCalled();

    const cfg = config.loadConfigOrDefault();
    const queued = Array.from(cfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queuedTaskId);
    expect(queued?.taskStatus).toBe("queued");
  });

  test("allows multiple agent tasks under the same parent up to maxParallelAgentTasks", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], "dddddddddd");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });

    const initLogger = createNullInitLogger();

    const parentName = "parent";
    const parentCreate = await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    expect(parentCreate.success).toBe(true);

    const parentId = "1111111111";
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(2, 3)
    );
    const { taskService } = createTaskServiceHarness(config);

    const first = await createAgentTask(taskService, parentId, "task 1");
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.data.status).toBe("running");

    const second = await createAgentTask(taskService, parentId, "task 2");
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.status).toBe("running");

    const third = await createAgentTask(taskService, parentId, "task 3");
    expect(third.success).toBe(true);
    if (!third.success) return;
    expect(third.data.status).toBe("queued");
  }, 20_000);

  test("supports creating agent tasks from local (project-dir) workspaces without requiring git", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        },
      ],
      testTaskSettings()
    );
    const { taskService } = createTaskServiceHarness(config);

    const created = await createAgentTask(taskService, parentId, "run task from local workspace", {
      modelString: "openai:gpt-5.2",
      thinkingLevel: "medium",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.workspaceId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.path).toBe(projectPath);
    expect(childEntry?.runtimeConfig?.type).toBe("local");
    expect(childEntry?.aiSettings).toEqual({ model: "openai:gpt-5.2", thinkingLevel: "medium" });
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.2");
    expect(childEntry?.taskThinkingLevel).toBe("medium");
  }, 20_000);

  test("inherits parent model + thinking when target agent has no global defaults", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
        },
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task with inherited model", {
      modelString: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run task with inherited model",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "explore",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      { agentInitiated: true }
    );

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.workspaceId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.aiSettings).toEqual({
      model: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);

  test("inherits parent workspace model + thinking when create args omit model and thinking", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
        },
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run task inheriting parent settings"
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run task inheriting parent settings",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "explore",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      { agentInitiated: true }
    );

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.workspaceId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);

  test("inherits the parent's pro reasoning mode into task sends and child settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
        },
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task inheriting pro mode");
    expect(created.success).toBe(true);
    if (!created.success) return;

    // The child's kickoff send must carry the parent's pro mode (the send path
    // re-gates per model, so this is safe even for non-GPT-5.6 task models).
    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run task inheriting pro mode",
      {
        model: "openai:gpt-5.6-sol",
        agentId: "explore",
        thinkingLevel: "high",
        reasoningMode: "pro",
        experiments: undefined,
      },
      { agentInitiated: true }
    );

    // Persisted child settings carry it too, so queued/restart resumes
    // (which rebuild options from the record) keep pro mode.
    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.workspaceId);
    expect(childEntry?.aiSettings).toEqual({
      model: "openai:gpt-5.6-sol",
      thinkingLevel: "high",
      reasoningMode: "pro",
    });
  }, 20_000);

  test("falls back to the parent's active-agent pro mode when spawning another agent type", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          // Pro was toggled while the exec agent was active; the spawned
          // explore agent has no per-agent bucket of its own, so inheritance
          // must fall back to the parent's active-agent settings.
          agentId: "exec",
          aiSettingsByAgent: {
            exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
          },
        },
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run explore with parent pro mode"
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run explore with parent pro mode",
      expect.objectContaining({ agentId: "explore", reasoningMode: "pro" }),
      { agentInitiated: true }
    );
  }, 20_000);

  test("keeps a mapped alias's native max thinking level when spawning a task", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          // A configured alias mapped to GPT-5.6: without the providers config
          // threaded into the task-path clamp, "max" would be downgraded to
          // "high" against the default four-level ladder.
          aiSettings: { model: "openai:team-sol", thinkingLevel: "max" },
        },
      ],
      testTaskSettings()
    );

    const providersConfig: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "team-sol", mappedToModel: "openai:gpt-5.6-sol" }],
      },
    };
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const aiMocks = createAIServiceMocks(config, {
      getProvidersConfig: mock(() => providersConfig),
    });
    const { taskService } = createTaskServiceHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService,
    });

    const created = await createAgentTask(taskService, parentId, "run with mapped alias max");
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run with mapped alias max",
      expect.objectContaining({ model: "openai:team-sol", thinkingLevel: "max" }),
      { agentInitiated: true }
    );
  }, 20_000);

  test("resolves a numeric thinking override against the inherited model's policy", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          // opus-4-6 allows [off, low, medium, high, xhigh]; index 9 clamps to the highest (xhigh).
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "off" },
        },
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run with numeric thinking", {
      thinkingLevel: 9,
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run with numeric thinking",
      {
        model: "anthropic:claude-opus-4-6",
        agentId: "explore",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      { agentInitiated: true }
    );

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.workspaceId);
    expect(childEntry?.taskModelString).toBe("anthropic:claude-opus-4-6");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);

  test("agentAiDefaults outrank workspace aiSettingsByAgent for same agent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "high" },
          aiSettingsByAgent: {
            explore: { model: "openai:gpt-5.2-pro", thinkingLevel: "medium" },
          },
        },
      ],
      {
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
        agentAiDefaults: {
          explore: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
        },
      }
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run task with same-agent conflicts"
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run task with same-agent conflicts",
      {
        model: "anthropic:claude-haiku-4-5",
        agentId: "explore",
        thinkingLevel: "off",
        experiments: undefined,
      },
      { agentInitiated: true }
    );

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.workspaceId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.aiSettings).toEqual({
      model: "anthropic:claude-haiku-4-5",
      thinkingLevel: "off",
    });
    expect(childEntry?.taskModelString).toBe("anthropic:claude-haiku-4-5");
    expect(childEntry?.taskThinkingLevel).toBe("off");
  }, 20_000);

  test("does not inherit base-chain defaults when target agent has no global defaults", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    // Custom agent definition stored in the project workspace (.mux/agents).
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "custom.md"),
      `---\nname: Custom\ndescription: Exec-derived custom agent for tests\nbase: exec\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
      "utf-8"
    );

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
        },
      ],
      {
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
        agentAiDefaults: {
          exec: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
        },
      }
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task with custom agent", {
      agentType: "custom",
      modelString: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run task with custom agent",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "custom",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      { agentInitiated: true }
    );

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.workspaceId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.aiSettings).toEqual({
      model: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);

  test("explicit task args outrank agentAiDefaults on task create", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    // Custom agent definition stored in the project workspace (.mux/agents).
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "custom.md"),
      `---\nname: Custom\ndescription: Exec-derived custom agent for tests\nbase: exec\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
      "utf-8"
    );

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
        },
      ],
      {
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
        agentAiDefaults: {
          custom: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
        },
      }
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task with custom agent", {
      agentType: "custom",
      modelString: "openai:gpt-4o-mini",
      thinkingLevel: "off",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run task with custom agent",
      {
        model: "openai:gpt-4o-mini",
        agentId: "custom",
        thinkingLevel: "off",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
  }, 20_000);

  test("task-created child workspaces do not inherit the parent's goal file", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["goalchild1"], "goalchild2");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const historyService = new HistoryService(config);
    const extensionMetadata = new ExtensionMetadataService(
      path.join(rootDir, "task-goal-extensionMetadata.json")
    );
    const workspaceGoalService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata
    );
    const result = await workspaceGoalService.setGoal({
      workspaceId: parentId,
      objective: "Parent owns the goal",
      budgetCents: 100,
    });
    expect(result.success).toBe(true);
    expect(await workspaceGoalFileExists(config, parentId)).toBe(true);

    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const created = await createAgentTask(
      taskService,
      parentId,
      "child should not inherit a goal",
      {
        agentType: "exec",
        title: "No child goal",
      }
    );

    expect(created.success).toBe(true);
    assert(created.success);
    expect(await workspaceGoalFileExists(config, created.data.workspaceId)).toBe(false);
  }, 20_000);

  test("parent runtime AI settings outrank persisted parent workspace settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      parentAiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with parent runtime fallback",
      {
        agentType: "exec",
        parentRuntimeAiSettings: { modelString: "openai:gpt-5.3-codex" },
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run exec task with parent runtime fallback",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "exec",
        thinkingLevel: "medium",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.workspaceId);
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("medium");
  }, 20_000);

  test("subagentAiDefaults outrank parent runtime AI settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      subagentAiDefaults: {
        exec: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with configured default",
      {
        agentType: "exec",
        parentRuntimeAiSettings: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run exec task with configured default",
      {
        model: "anthropic:claude-haiku-4-5",
        agentId: "exec",
        thinkingLevel: "off",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.workspaceId);
    expect(childEntry?.taskModelString).toBe("anthropic:claude-haiku-4-5");
    expect(childEntry?.taskThinkingLevel).toBe("off");
  }, 20_000);

  test("parent runtime thinking hint is clamped by the resolved model policy", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const resolvedModel = "openai:gpt-5.5-pro";
    const requestedThinkingLevel: ThinkingLevel = "off";
    const expectedThinkingLevel = enforceThinkingPolicy(resolvedModel, requestedThinkingLevel);
    expect(expectedThinkingLevel).not.toBe(requestedThinkingLevel);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      parentAiSettings: { model: resolvedModel, thinkingLevel: "high" },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with parent runtime thinking fallback",
      {
        agentType: "exec",
        parentRuntimeAiSettings: { thinkingLevel: requestedThinkingLevel },
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run exec task with parent runtime thinking fallback",
      {
        model: resolvedModel,
        agentId: "exec",
        thinkingLevel: expectedThinkingLevel,
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.workspaceId);
    expect(childEntry?.taskModelString).toBe(resolvedModel);
    expect(childEntry?.taskThinkingLevel).toBe(expectedThinkingLevel);
  }, 20_000);

  test("exec subagent uses subagentAiDefaults exec when present", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.2", thinkingLevel: "medium" },
      },
      subagentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with subagent defaults",
      {
        agentType: "exec",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run exec task with subagent defaults",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "exec",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.workspaceId);
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);

  test("explicit task args outrank subagentAiDefaults exec on task create", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      subagentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with explicit args",
      {
        agentType: "exec",
        modelString: "openai:gpt-5.2",
        thinkingLevel: "medium",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run exec task with explicit args",
      {
        model: "openai:gpt-5.2",
        agentId: "exec",
        thinkingLevel: "medium",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.workspaceId);
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.2");
    expect(childEntry?.taskThinkingLevel).toBe("medium");
  }, 20_000);

  test("exec subagent falls back to agentAiDefaults exec when subagent default is absent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with agent defaults",
      {
        agentType: "exec",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run exec task with agent defaults",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "exec",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
  }, 20_000);

  test("exec subagent partial override combines subagent model with agent thinking", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.2", thinkingLevel: "xhigh" },
      },
      subagentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with partial defaults",
      {
        agentType: "exec",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run exec task with partial defaults",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "exec",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
  }, 20_000);

  test("subagent thinking defaults are clamped by the resolved model policy", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const resolvedModel = "openai:gpt-5.5-pro";
    const requestedThinkingLevel: ThinkingLevel = "off";
    const expectedThinkingLevel = enforceThinkingPolicy(resolvedModel, requestedThinkingLevel);
    expect(expectedThinkingLevel).not.toBe(requestedThinkingLevel);

    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      parentAiSettings: { model: resolvedModel, thinkingLevel: "high" },
      subagentAiDefaults: {
        exec: { thinkingLevel: requestedThinkingLevel },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with clamped default thinking",
      {
        agentType: "exec",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run exec task with clamped default thinking",
      {
        model: resolvedModel,
        agentId: "exec",
        thinkingLevel: expectedThinkingLevel,
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.workspaceId);
    expect(childEntry?.taskModelString).toBe(resolvedModel);
    expect(childEntry?.taskThinkingLevel).toBe(expectedThinkingLevel);
  }, 20_000);

  test("thinking policy is enforced after resolving the final subagent model", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      subagentAiDefaults: {
        exec: { modelString: "google:gemini-3-pro" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with clamped thinking",
      {
        agentType: "exec",
        thinkingLevel: "off",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.workspaceId,
      "run exec task with clamped thinking",
      {
        model: "google:gemini-3-pro",
        agentId: "exec",
        thinkingLevel: "low",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
  }, 20_000);

  test("Task.create persists workflow task metadata for report validation", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["taskflow01"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);

    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    };

    const result = await createAgentTask(taskService, parentId, "extract claims", {
      workflowTask: {
        runId: "wfr_123",
        stepId: "claims",
        outputSchema,
      },
    });

    expect(result.success).toBe(true);
    const task = findWorkspaceInConfig(config, "taskflow01");
    expect(task?.workflowTask).toEqual({
      runId: "wfr_123",
      stepId: "claims",
      outputSchema,
    });
  });

  test("TaskService extracts persisted agent_report payloads from tool output", async () => {
    const config = await createTestConfig(rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const reportReader = taskService as unknown as {
      findAgentReportArgsInParts(parts: readonly unknown[]): {
        reportMarkdown: string;
        title?: string;
        structuredOutput?: unknown;
      } | null;
    };

    const report = reportReader.findAgentReportArgsInParts([
      {
        type: "dynamic-tool",
        toolName: "agent_report",
        state: "output-available",
        input: { reportMarkdown: "ignored because output report is authoritative", title: null },
        output: {
          success: true,
          report: {
            reportMarkdown: "# Done",
            title: "Done",
            structuredOutput: { claims: ["durable"] },
          },
        },
      },
    ]);

    expect(report).toEqual({
      reportMarkdown: "# Done",
      title: "Done",
      structuredOutput: { claims: ["durable"] },
    });
  });

  test("TaskService preserves schema-shaped workflow agent_report args verbatim", async () => {
    const config = await createTestConfig(rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const reportReader = taskService as unknown as {
      findAgentReportArgsInParts(
        parts: readonly unknown[],
        options?: { acceptSchemaShapedWorkflowReport?: boolean }
      ): {
        reportMarkdown: string;
        title?: string;
        structuredOutput?: unknown;
      } | null;
    };

    const schemaOutput = { reportMarkdown: "# Done", structuredOutput: null, title: null };
    const report = reportReader.findAgentReportArgsInParts(
      [
        {
          type: "dynamic-tool",
          toolName: "agent_report",
          state: "output-available",
          input: schemaOutput,
          output: { success: true },
        },
      ],
      { acceptSchemaShapedWorkflowReport: true }
    );

    expect(report).toEqual({
      reportMarkdown: STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN,
      structuredOutput: schemaOutput,
    });
  });

  test("created task metadata is not recomputed after defaults change", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      subagentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
      },
    });

    const { taskService } = createTaskServiceHarness(config);
    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task before defaults change",
      {
        agentType: "exec",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    await config.editConfig((cfg) => ({
      ...cfg,
      subagentAiDefaults: {
        exec: { modelString: "openai:gpt-5.2", thinkingLevel: "medium" },
      },
    }));

    const childEntry = findWorkspaceInConfig(config, created.data.workspaceId);
    expect(childEntry?.aiSettings).toEqual({
      model: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);
  test("auto-resumes a parent workspace until background tasks finish", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.objectContaining({
        model: "openai:gpt-5.2",
        thinkingLevel: "medium",
      }),
      // Auto-resume skips counter reset
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("auto-resumes a parent workspace until background workflow runs finish", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_background";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    await recordAgentWorkflowRunReference({
      workspaceSessionDir: config.getSessionDir(rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: Date.now(),
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(workflowRunId),
      expect.objectContaining({
        model: "openai:gpt-5.2",
        thinkingLevel: "medium",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
    const prompt = (sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1];
    assert(typeof prompt === "string", "expected workflow auto-resume prompt");
    expect(prompt).toContain(`task_ids: ["${workflowRunId}"]`);
    expect(prompt).toContain("task_await");
  });

  test("queues parent auto-resume if stream-end cleanup is still busy", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const sendMessage = mock(
      (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: { requireIdle?: boolean }
      ): Promise<Result<void, { type: string; raw: string }>> => {
        if (internal?.requireIdle === true) {
          return Promise.resolve(
            Err({ type: "unknown", raw: "Workspace is busy; idle-only send was skipped." })
          );
        }
        return Promise.resolve(Ok(undefined));
      }
    );
    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.anything(),
      expect.objectContaining({ requireIdle: true })
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.anything(),
      expect.not.objectContaining({ requireIdle: true })
    );
  });

  test("does not queue parent auto-resume if follow-up turn appears during idle fallback", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const sendMessage = mock(
      (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: { requireIdle?: boolean }
      ): Promise<Result<void, { type: string; raw: string }>> => {
        if (internal?.requireIdle === true) {
          return Promise.resolve(
            Err({ type: "unknown", raw: "Workspace is busy; idle-only send was skipped." })
          );
        }
        return Promise.resolve(Ok(undefined));
      }
    );
    let queueChecks = 0;
    const hasPendingQueuedOrPreparingTurn = mock(() => {
      queueChecks += 1;
      return queueChecks >= 3;
    });
    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage,
      hasPendingQueuedOrPreparingTurn,
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.anything(),
      expect.objectContaining({ requireIdle: true })
    );
  });

  test("does not auto-resume for an agent workflow superseded by a manual user turn", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_superseded";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: config.getSessionDir(rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendManualUser = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("manual-user", "user", "Ignore the old workflow", { timestamp: 2_000 })
    );
    expect(appendManualUser.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not auto-resume for an agent workflow superseded by a context reset", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_reset_superseded";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: config.getSessionDir(rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendReset = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("reset-boundary", "assistant", "Context reset", {
        timestamp: 2_000,
        contextBoundaryKind: "reset",
      })
    );
    expect(appendReset.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not trust persisted workflow refs at the same timestamp as manual supersession", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_same_ms_superseded";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: config.getSessionDir(rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 2_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendManualUser = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("manual-user", "user", "Ignore the old workflow", { timestamp: 2_000 })
    );
    expect(appendManualUser.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("ignores current workflow_run parts from a stream superseded in history", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_current_parts_stale";
    const assistantMessageId = "assistant-before-slash";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    expect(
      (
        await historyService.appendToHistory(
          rootWorkspaceId,
          createMuxMessage(assistantMessageId, "assistant", "", { timestamp: 1_000 })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          rootWorkspaceId,
          createMuxMessage("workflow-slash-trigger", "user", "/research new topic", {
            timestamp: 2_000,
          })
        )
      ).success
    ).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: assistantMessageId,
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "workflow-call-stale",
          toolName: "workflow_run",
          state: "output-available",
          input: { name: "background-research", args: {}, run_in_background: true },
          output: { status: "running", runId: workflowRunId, result: null },
        },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("workflow_resume parts emitted after supersession re-establish provenance", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_resumed_after_supersession";
    const assistantMessageId = "assistant-after-supersession";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    expect(
      (
        await historyService.appendToHistory(
          rootWorkspaceId,
          createMuxMessage("manual-user", "user", "Ignore the old workflow", { timestamp: 1_000 })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          rootWorkspaceId,
          createMuxMessage(assistantMessageId, "assistant", "", { timestamp: 2_000 })
        )
      ).success
    ).toBe(true);

    // The stream ends after the superseding user turn, so its workflow_resume output re-attaches
    // the agent to the run and the auto-resume nudge must be delivered.
    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: assistantMessageId,
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "workflow-resume-1",
          toolName: "workflow_resume",
          state: "output-available",
          input: { run_id: workflowRunId, mode: "resume", run_in_background: true },
          output: { status: "running", runId: workflowRunId, result: null },
        },
      ],
    });

    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(workflowRunId),
      expect.anything(),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("does not trust persisted workflow refs after timestamp-less manual user turns", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_timestampless_superseded";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: config.getSessionDir(rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendManualUser = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("manual-user", "user", "Ignore the old workflow")
    );
    expect(appendManualUser.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("keeps workflow refs current across mid-stream auto-compaction", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_midstream_compaction_current";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: config.getSessionDir(rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendCompaction = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("midstream-auto-compaction", "user", "Compacting to continue", {
        timestamp: 2_000,
        synthetic: true,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: {
            followUpContent: {
              text: "Continue",
              model: "openai:gpt-5.2",
              agentId: "exec",
              dispatchOptions: { source: "internal-resume" },
            },
          },
          source: "auto-compaction",
        },
      })
    );
    expect(appendCompaction.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(workflowRunId),
      expect.anything(),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("does not auto-resume after on-send compaction supersedes an agent workflow", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_auto_compact_superseded";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: config.getSessionDir(rootWorkspaceId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const appendCompaction = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage("auto-compaction", "user", "Compacting before a new user prompt", {
        timestamp: 2_000,
        synthetic: true,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: {},
          source: "auto-compaction",
        },
      })
    );
    expect(appendCompaction.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not auto-resume a parent for slash-command workflow run cards", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowRunId = "wfr_slash_background";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootWorkspaceId,
      workflow: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const slashCard = buildWorkflowRunCardMessage(
      { name: "background-research", args: {} },
      { runId: workflowRunId, status: "running", result: null },
      Date.now()
    );
    slashCard.metadata = {
      ...slashCard.metadata,
      muxMetadata: { type: WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE, runId: workflowRunId },
    };
    const appendCard = await historyService.appendToHistory(rootWorkspaceId, slashCard);
    expect(appendCard.success).toBe(true);

    const appendTaskAwaitDiscovery = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage(
        "assistant-task-await-discovery",
        "assistant",
        "",
        { timestamp: Date.now() },
        [
          {
            type: "dynamic-tool",
            toolCallId: "task-await-1",
            toolName: "task_await",
            state: "output-available",
            input: {},
            output: { results: [{ taskId: workflowRunId, status: "running" }] },
          },
        ]
      )
    );
    expect(appendTaskAwaitDiscovery.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not auto-resume a parent for workflow-owned descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowTaskId = "task-workflow";
    const workflowChildTaskId = "task-workflow-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "workflow-task", workflowTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_target", stepId: "scope" },
        }),
        projectWorkspace(projectPath, "workflow-child", workflowChildTaskId, {
          parentWorkspaceId: workflowTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not auto-resume a parent while a follow-up turn is already queued or preparing", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const hasPendingQueuedOrPreparingTurn = mock(() => true);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      hasPendingQueuedOrPreparingTurn,
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(hasPendingQueuedOrPreparingTurn).toHaveBeenCalledWith(rootWorkspaceId);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not auto-resume for queue-backgrounded descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waitPromise = taskService.waitForAgentReport(childTaskId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    expect(taskService.backgroundForegroundWaitsForWorkspace(rootWorkspaceId)).toBe(1);
    const waitError = await waitPromise.catch((error: unknown) => error);
    expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("still nudges when active descendants were not queue-backgrounded", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.objectContaining({
        model: "openai:gpt-5.2",
        thinkingLevel: "medium",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("notify_on_terminal child does not force await across multiple stream-ends", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-notify";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-notify", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
          taskAttentionPolicy: "notify_on_terminal",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    for (const messageId of ["assistant-root-1", "assistant-root-2"]) {
      await handleTaskServiceStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: rootWorkspaceId,
        messageId,
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });
    }

    // notify_on_terminal is durable: neither stream-end forces a task_await nudge.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("notify_on_terminal child subtree does not leak blocking grandchildren to owner", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-notify";
    const grandchildTaskId = "task-grandchild";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-notify", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskAttentionPolicy: "notify_on_terminal",
        }),
        projectWorkspace(projectPath, "grandchild-task", grandchildTaskId, {
          name: "agent_explore_grandchild",
          parentWorkspaceId: childTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("queue-backgrounded foreground wait stays suppressed across multiple stream-ends", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-bg";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-bg", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waitPromise = taskService.waitForAgentReport(childTaskId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    expect(taskService.backgroundForegroundWaitsForWorkspace(rootWorkspaceId)).toBe(1);
    const waitError = await waitPromise.catch((error: unknown) => error);
    expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);

    for (const messageId of ["assistant-root-1", "assistant-root-2"]) {
      await handleTaskServiceStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: rootWorkspaceId,
        messageId,
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });
    }

    // Detaching a foreground wait via a queued message now persists notify_on_terminal,
    // so neither stream-end re-forces a task_await nudge (durable, not one-shot).
    expect(sendMessage).not.toHaveBeenCalled();

    // The persisted policy is durable.
    const persisted = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((w) => w.id === childTaskId);
    expect(persisted?.taskAttentionPolicy).toBe("notify_on_terminal");
  });

  test("multiple queue-backgrounded tasks stay durably non-blocking", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const taskAId = "task-bg-a";
    const taskBId = "task-bg-b";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-bg-a", taskAId, {
          name: "agent_explore_a",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
        projectWorkspace(projectPath, "child-task-bg-b", taskBId, {
          name: "agent_explore_b",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waitAPromise = taskService.waitForAgentReport(taskAId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    const waitBPromise = taskService.waitForAgentReport(taskBId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    expect(taskService.backgroundForegroundWaitsForWorkspace(rootWorkspaceId)).toBe(2);

    const [waitAError, waitBError] = await Promise.all([
      waitAPromise.catch((error: unknown) => error),
      waitBPromise.catch((error: unknown) => error),
    ]);
    expect(waitAError).toBeInstanceOf(ForegroundWaitBackgroundedError);
    expect(waitBError).toBeInstanceOf(ForegroundWaitBackgroundedError);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root-1",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root-2",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    // Both detached waits persist notify_on_terminal, so a later stream-end never re-forces await.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("markBackgroundWorkNotifyOnTerminal makes a timed-out wait durably non-blocking", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-timeout";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-timeout", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    // Simulate the task tool's timeout-detach: the foreground wait exceeded its budget but the task
    // keeps running, so it is marked notify_on_terminal.
    await taskService.markBackgroundWorkNotifyOnTerminal(childTaskId, rootWorkspaceId);

    const persisted = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((w) => w.id === childTaskId);
    expect(persisted?.taskAttentionPolicy).toBe("notify_on_terminal");

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("markBackgroundWorkNotifyOnTerminal wakes for terminal workspace-turn records", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const handleId = "wst_timeout_race";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: rootWorkspaceId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "Done before notify policy persisted",
    });

    // Simulates the race Codex caught: the workspace turn settled before the queued/timeout detach
    // persisted notify_on_terminal, so the persistence helper must enqueue the missing wake-up.
    await taskService.markBackgroundWorkNotifyOnTerminal(handleId, rootWorkspaceId);
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(handleId);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("timeout_secs: 0");
    const snapshot = await taskService.getWorkspaceTurnSnapshot(rootWorkspaceId, handleId);
    expect(snapshot?.attentionPolicy).toBe("notify_on_terminal");
    expect(snapshot?.terminalAttentionNotifiedAt).toBeDefined();
  });

  test("renewed foreground wait does not re-promote durable notify policy to blocking", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-bg";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-bg", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const firstWaitPromise = taskService.waitForAgentReport(childTaskId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    expect(taskService.backgroundForegroundWaitsForWorkspace(rootWorkspaceId)).toBe(1);
    const firstWaitError = await firstWaitPromise.catch((error: unknown) => error);
    expect(firstWaitError).toBeInstanceOf(ForegroundWaitBackgroundedError);

    const secondWaitPromise = taskService.waitForAgentReport(childTaskId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
      timeoutMs: 10,
    });
    const secondWaitError = await secondWaitPromise.catch((error: unknown) => error);
    expect(secondWaitError).toBeInstanceOf(Error);
    if (secondWaitError instanceof Error) {
      expect(secondWaitError.message).toBe("Timed out waiting for agent_report");
    }

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root-renewed",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    // The first detachment persisted notify_on_terminal durably. A later explicit foreground
    // wait (even though it times out) must NOT re-promote the work to blocking, so no nudge fires.
    expect(sendMessage).not.toHaveBeenCalled();

    const persisted = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((w) => w.id === childTaskId);
    expect(persisted?.taskAttentionPolicy).toBe("notify_on_terminal");
  });

  test("mixed descendants — nudges only for non-queue-backgrounded tasks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const backgroundTaskId = "task-bg";
    const blockingTaskId = "task-blocking";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task-bg", backgroundTaskId, {
          name: "agent_explore_bg",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
        projectWorkspace(projectPath, "child-task-blocking", blockingTaskId, {
          name: "agent_explore_blocking",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waitPromise = taskService.waitForAgentReport(backgroundTaskId, {
      requestingWorkspaceId: rootWorkspaceId,
      backgroundOnMessageQueued: true,
    });
    expect(taskService.backgroundForegroundWaitsForWorkspace(rootWorkspaceId)).toBe(1);
    const waitError = await waitPromise.catch((error: unknown) => error);
    expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(blockingTaskId),
      expect.objectContaining({
        model: "openai:gpt-5.2",
        thinkingLevel: "medium",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(backgroundTaskId),
      expect.anything(),
      expect.anything()
    );
  });
  test("auto-resume preserves parent agentId from stream-end event metadata", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2", agentId: "plan" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.objectContaining({
        agentId: "plan",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("auto-resume preserves parent agentId from history when stream-end metadata omits agentId", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const appendResult = await historyService.appendToHistory(
      rootWorkspaceId,
      createMuxMessage(
        "assistant-root-history",
        "assistant",
        "Parent is currently running in plan mode.",
        { timestamp: Date.now(), agentId: "plan" }
      )
    );
    expect(appendResult.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.objectContaining({
        agentId: "plan",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("auto-resume falls back to exec agentId when metadata and history lack agentId", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(childTaskId),
      expect.objectContaining({
        agentId: "exec",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("tasks-completed auto-resume preserves parent agentId from history", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        {
          path: path.join(projectPath, "child-task"),
          id: childTaskId,
          name: "agent_explore_child",
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const appendResult = await historyService.appendToHistory(
      parentWorkspaceId,
      createMuxMessage(
        "assistant-parent-history",
        "assistant",
        "Parent is currently running in plan mode.",
        { timestamp: Date.now(), agentId: "plan" }
      )
    );
    expect(appendResult.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Hello from child",
            title: "Result",
          },
          state: "output-available",
          output: {
            success: true,
            report: {
              reportMarkdown: "Hello from child",
              title: "Result",
              structuredOutput: { claims: ["fast handoff"] },
            },
          },
        },
        { type: "text", text: "Hello from child" },
      ],
    });

    // The completed-subagent wake-up is delivered by the async terminal-attention drain.
    await Promise.all([
      ...(taskService as unknown as { pendingTerminalAttentionDrains: Set<Promise<void>> })
        .pendingTerminalAttentionDrains,
    ]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const handoffPrompt = (sendMessage as unknown as { mock: { calls: Array<[string, string]> } })
      .mock.calls[0]?.[1];
    assert(typeof handoffPrompt === "string", "tasks-completed handoff prompt is required");
    expect(handoffPrompt).toContain("structured outputs");
    expect(handoffPrompt).not.toContain("task_await");
    expect(sendMessage).toHaveBeenCalledWith(
      parentWorkspaceId,
      expect.stringContaining("Background sub-agent task(s) have completed"),
      expect.objectContaining({
        agentId: "plan",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );

    const parentHistory = await collectFullHistory(historyService, parentWorkspaceId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("structuredOutput");
    expect(serializedParentHistory).toContain("claims");
  });

  test("waitForAgentReport surfaces the child's report-time AI settings", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-report-settings";
    const childTaskId = "task-report-settings";

    // The persisted settings at report time differ from any launch-time snapshot a
    // caller may hold (e.g. after a plan-to-exec handoff rewrote them).
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        {
          path: path.join(projectPath, "child-task"),
          id: childTaskId,
          name: "agent_exec_child",
          parentWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "anthropic:claude-opus-5",
          taskThinkingLevel: "high",
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "assistant-child-report-settings",
      metadata: { model: "anthropic:claude-opus-5", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-settings-call",
          toolName: "agent_report",
          input: { reportMarkdown: "Done", title: "Result" },
          state: "output-available",
          output: {
            success: true,
            report: { reportMarkdown: "Done", title: "Result" },
          },
        },
        { type: "text", text: "Done" },
      ],
    });

    const report = await taskService.waitForAgentReport(childTaskId, {
      requestingWorkspaceId: parentWorkspaceId,
    });
    expect(report.model).toBe("anthropic:claude-opus-5");
    expect(report.thinkingLevel).toBe("high");
  });

  test("workflow-owned child reports do not trigger generic parent handoff", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-workflow-report";
    const childTaskId = "task-workflow-report";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "workflow-child", childTaskId, {
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
          workflowTask: { runId: "wfr_report_handoff", stepId: "collect" },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "assistant-workflow-child-output",
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Workflow step report",
            title: "Workflow Step",
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Workflow step report" },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const parentHistory = await collectFullHistory(historyService, parentWorkspaceId);
    expect(JSON.stringify(parentHistory)).not.toContain("<mux_subagent_report>");
  });

  test("pending injected report wake-up drains after foreground-awaited sibling completes", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-pending-sibling-report";
    const backgroundChildId = "task-background-report";
    const foregroundChildId = "task-foreground-report";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "background-child", backgroundChildId, {
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskAttentionPolicy: "notify_on_terminal",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
        projectWorkspace(projectPath, "foreground-child", foregroundChildId, {
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const foregroundWaiter = taskService.waitForAgentReport(foregroundChildId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentWorkspaceId,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: backgroundChildId,
      messageId: "assistant-background-output",
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-background",
          toolName: "agent_report",
          input: { reportMarkdown: "Background result", title: "Background" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Background result" },
      ],
    });
    await flushTerminalAttentionDrains(taskService);

    expect(await terminalAttentionStore.listPending(parentWorkspaceId)).toHaveLength(1);
    expect(sendMessage).not.toHaveBeenCalled();

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: foregroundChildId,
      messageId: "assistant-foreground-output",
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-foreground",
          toolName: "agent_report",
          input: { reportMarkdown: "Foreground result", title: "Foreground" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Foreground result" },
      ],
    });

    const foregroundReport = await foregroundWaiter;
    expect(foregroundReport.reportMarkdown).toBe("Foreground result");
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledWith(
      parentWorkspaceId,
      expect.stringContaining("Background sub-agent task(s) have completed"),
      expect.anything(),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
    expect(await terminalAttentionStore.listPending(parentWorkspaceId)).toHaveLength(0);
  });

  test("foreground waiter suppresses tasks-completed auto-resume notification", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        {
          path: path.join(projectPath, "child-task"),
          id: childTaskId,
          name: "agent_explore_child",
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const waiter = taskService.waitForAgentReport(childTaskId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentWorkspaceId,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ],
    });

    const report = await waiter;
    expect(report.reportMarkdown).toBe("Hello from child");
    expect(report.title).toBe("Result");

    expect(sendMessage).not.toHaveBeenCalledWith(
      parentWorkspaceId,
      expect.stringContaining("task(s) have completed"),
      expect.anything(),
      expect.anything()
    );
  });

  test("hard-interrupted parent skips tasks-completed auto-resume after child report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-111";
    const childTaskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        {
          path: path.join(projectPath, "child-task"),
          id: childTaskId,
          name: "agent_explore_child",
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    taskService.markParentWorkspaceInterrupted(parentWorkspaceId);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendMessageToDescendantAgentTask sends updated guidance with the child's settings", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-guidance";
    const childTaskId = "child-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
          taskExperiments: { advisorTool: true },
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      sendMessage: mock(
        async (
          _workspaceId: string,
          _message: string,
          _options: unknown,
          internal?: { onAccepted?: () => Promise<void> | void }
        ): Promise<Result<void>> => {
          await internal?.onAccepted?.();
          return Ok(undefined);
        }
      ),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Inspect the generated schema instead.",
      "turn-end"
    );

    expect(result).toEqual(Ok({ delivery: "accepted" }));
    expect(sendMessage).toHaveBeenCalledWith(
      childTaskId,
      "Updated guidance from parent:\n\nInspect the generated schema instead.",
      {
        model: "openai:gpt-5.2",
        agentId: "explore",
        thinkingLevel: "medium",
        reasoningMode: undefined,
        experiments: { advisorTool: true },
        queueDispatchMode: "turn-end",
      },
      expect.objectContaining({
        synthetic: true,
        agentInitiated: true,
        startStreamInBackground: true,
      })
    );
  });

  test("sendMessageToDescendantAgentTask revives awaiting-report tasks and rolls back failed sends", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-awaiting-guidance";
    const childTaskId = "child-awaiting-guidance";
    let sendSucceeds = false;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage: mock(
        (): Promise<Result<void, SendMessageError>> =>
          Promise.resolve(
            sendSucceeds ? Ok(undefined) : Err({ type: "unknown", raw: "send failed" })
          )
      ),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Continue with the correction.",
        "tool-end"
      )
    ).toEqual(Err({ code: "send_failed", message: "send failed" }));
    expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("awaiting_report");

    sendSucceeds = true;
    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Continue with the correction.",
        "tool-end"
      )
    ).toEqual(Ok({ delivery: "queued", queueDispatchMode: "tool-end" }));
    expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("running");
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toEqual([
      expect.objectContaining({
        message: "Continue with the correction.",
        queueDispatchMode: "tool-end",
      }),
    ]);
  });

  test("sendMessageToDescendantAgentTask preserves later queued guidance reservations", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-multiple-guidance";
    const childTaskId = "child-multiple-guidance";
    const acceptedCallbacks: Array<() => Promise<void> | void> = [];

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage: mock(
        (
          _workspaceId: string,
          _message: string,
          _options: unknown,
          internal?: { onAccepted?: () => Promise<void> | void }
        ): Promise<Result<void>> => {
          if (internal?.onAccepted) {
            acceptedCallbacks.push(internal.onAccepted);
          }
          return Promise.resolve(Ok(undefined));
        }
      ),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "First correction",
        "turn-end"
      )
    ).toEqual(Ok({ delivery: "queued", queueDispatchMode: "turn-end" }));
    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Second correction",
        "turn-end"
      )
    ).toEqual(Ok({ delivery: "queued", queueDispatchMode: "turn-end" }));
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toHaveLength(2);

    await acceptedCallbacks[0]?.();
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toEqual([
      expect.objectContaining({ message: "Second correction" }),
    ]);
    await acceptedCallbacks[1]?.();
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toBeUndefined();
  });

  test("sendMessageToDescendantAgentTask serializes queued guidance with launch reservation", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-queued-race";
    const childTaskId = "child-queued-race";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "queued",
          taskPrompt: "Original brief",
        }),
      ],
      testTaskSettings()
    );

    const { taskService } = createTaskServiceHarness(config);
    const internalTaskService = taskService as unknown as {
      mutex: { acquire(): Promise<AsyncDisposable> };
    };
    const schedulerLock = await internalTaskService.mutex.acquire();
    const guidanceResult = taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Use the correction.",
      "tool-end"
    );
    await Promise.resolve();
    await config.editConfig((current) => {
      const child = current.projects
        .get(projectPath)
        ?.workspaces.find((workspace) => workspace.id === childTaskId);
      assert(child);
      child.taskStatus = "starting";
      return current;
    });
    await schedulerLock[Symbol.asyncDispose]();

    expect(await guidanceResult).toEqual(Err({ code: "not_active", taskStatus: "starting" }));
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPrompt).toBe("Original brief");
  });

  test("sendMessageToDescendantAgentTask updates queued prompts without bypassing scheduling", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-queued-guidance";
    const childTaskId = "child-queued-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "queued",
          taskPrompt: "Original brief",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Do not edit generated files.",
      "tool-end"
    );

    expect(result).toEqual(Ok({ delivery: "queued" }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPrompt).toBe(
      "Original brief\n\nUpdated guidance from parent:\n\nDo not edit generated files."
    );
  });

  test("pending parent guidance blocks stale report settlement at stream end", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-pending-guidance-report";
    const childTaskId = "child-pending-guidance-report";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
          taskPendingGuidance: [
            {
              id: "pending-guidance",
              message: "Apply the correction.",
              queueDispatchMode: "turn-end",
            },
          ],
        }),
      ],
      testTaskSettings()
    );

    const { taskService } = createTaskServiceHarness(config);
    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "assistant-stale-report",
      metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-stale",
          toolName: "agent_report",
          input: { reportMarkdown: "Stale report" },
          state: "output-available",
          output: { success: true },
        },
      ],
    });

    expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("running");
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toHaveLength(1);
  });

  test("sendMessageToDescendantAgentTask treats legacy missing taskStatus as running", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-legacy-guidance";
    const childTaskId = "child-legacy-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: undefined,
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Apply the corrected requirement.",
        "tool-end"
      )
    ).toEqual(Ok({ delivery: "queued", queueDispatchMode: "tool-end" }));
  });

  test("sendMessageToDescendantAgentTask rejects archived descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-archived-guidance";
    const childTaskId = "child-archived-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          taskStatus: "running",
          archivedAt: "2026-08-03T00:00:00.000Z",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Correction",
        "tool-end"
      )
    ).toEqual(
      Err({
        code: "not_active",
        taskStatus: "running",
        message: "Task workspace is archived and cannot accept updated guidance.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendMessageToDescendantAgentTask persists legacy implicit-running status", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-legacy-guidance-persistence";
    const childTaskId = "child-legacy-guidance-persistence";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: undefined,
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Persist this correction",
        "turn-end"
      )
    ).toEqual(Ok({ delivery: "queued", queueDispatchMode: "turn-end" }));

    expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("running");
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toHaveLength(1);
  });

  test("sendMessageToDescendantAgentTask rejects non-descendants and settled children", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-guidance-scope";
    const otherParentId = "other-guidance-scope";
    const otherChildId = "other-child-guidance-scope";
    const settledChildId = "settled-child-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "other-parent", otherParentId),
        projectWorkspace(projectPath, "other-child", otherChildId, {
          parentWorkspaceId: otherParentId,
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "settled-child", settledChildId, {
          parentWorkspaceId,
          taskStatus: "reported",
        }),
      ],
      testTaskSettings()
    );

    const { taskService } = createTaskServiceHarness(config);

    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        otherChildId,
        "Correction",
        "tool-end"
      )
    ).toEqual(Err({ code: "invalid_scope" }));
    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        settledChildId,
        "Correction",
        "tool-end"
      )
    ).toEqual(Err({ code: "not_active", taskStatus: "reported" }));
  });

  test("requestAgentFinalReportForTimeout records finalization token only after prompt send succeeds", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-111";
    const childTaskId = "task-timeout-child";
    let sendSucceeds = false;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    let isStreaming = false;
    let callOnAccepted = true;
    let queuedOnAccepted: (() => Promise<void> | void) | undefined;
    const { aiService, stopStream } = createAIServiceMocks(config, {
      isStreaming: mock(() => isStreaming),
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      sendMessage: mock(async (...args: unknown[]): Promise<Result<void>> => {
        if (!sendSucceeds) {
          return Err("send failed");
        }
        const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
        if (callOnAccepted) {
          await internal?.onAccepted?.();
        } else {
          queuedOnAccepted = internal?.onAccepted;
        }
        return Ok(undefined);
      }),
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    const request = {
      workflowRunId: "wfr_timeout",
      stepId: "slow-step",
      inputHash: "hash",
      finalizationToken: "token-1",
    };

    const failedPromptResult = await taskService.requestAgentFinalReportForTimeout(
      childTaskId,
      request
    );
    expect(failedPromptResult).toBe("not_active");
    let childWorkspace = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((workspace) => workspace.id === childTaskId);
    expect(childWorkspace?.taskTimeoutFinalizationTokens).toBeUndefined();

    sendSucceeds = true;
    const promptedResult = await taskService.requestAgentFinalReportForTimeout(
      childTaskId,
      request
    );
    expect(promptedResult).toBe("prompted");
    childWorkspace = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((workspace) => workspace.id === childTaskId);
    expect(sendMessage).toHaveBeenLastCalledWith(
      childTaskId,
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ startStreamInBackground: true })
    );
    expect(childWorkspace?.taskTimeoutFinalizationTokens).toEqual(["token-1"]);
    isStreaming = true;
    const alreadyPromptedResult = await taskService.requestAgentFinalReportForTimeout(
      childTaskId,
      request
    );
    expect(alreadyPromptedResult).toBe("prompted");
    expect(stopStream).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    isStreaming = false;
    callOnAccepted = false;
    const queuedPromptResult = await taskService.requestAgentFinalReportForTimeout(childTaskId, {
      ...request,
      finalizationToken: "token-queued",
    });
    expect(queuedPromptResult).toBe("queued");
    childWorkspace = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((workspace) => workspace.id === childTaskId);
    expect(childWorkspace?.taskTimeoutFinalizationTokens).toEqual(["token-1"]);
    expect(sendMessage).toHaveBeenCalledTimes(3);
    await queuedOnAccepted?.();
    childWorkspace = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((workspace) => workspace.id === childTaskId);
    expect(childWorkspace?.taskTimeoutFinalizationTokens).toEqual(["token-1", "token-queued"]);
  });

  test("requestAgentFinalReportForTimeout requires propose_plan for timed-out plan agents", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-111";
    const childTaskId = "task-timeout-plan-child";
    let sentMessage = "";
    let sentToolPolicy: Array<{ regex_match: string; action: string }> | undefined;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_plan_child",
          parentWorkspaceId,
          agentId: "plan",
          agentType: "plan",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage: mock(
        async (
          _workspaceId: string,
          message: string,
          options: { toolPolicy?: Array<{ regex_match: string; action: string }> },
          internal?: { onAccepted?: () => Promise<void> | void }
        ): Promise<Result<void>> => {
          sentMessage = message;
          sentToolPolicy = options.toolPolicy;
          await internal?.onAccepted?.();
          return Ok(undefined);
        }
      ),
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const result = await taskService.requestAgentFinalReportForTimeout(childTaskId, {
      workflowRunId: "wfr_timeout",
      stepId: "plan-step",
      inputHash: "hash",
      finalizationToken: "plan-token",
    });
    expect(result).toBe("prompted");

    expect(sentToolPolicy).toEqual([{ regex_match: "^propose_plan$", action: "require" }]);
    expect(sentMessage).toContain("propose_plan");
    expect(sentMessage).not.toContain("agent_report");
  });

  test("failAgentTaskForHardTimeout clears queued finalization before aborting the stream", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-111";
    const childTaskId = "task-timeout-child";
    const operations: string[] = [];

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService, stopStream } = createAIServiceMocks(config, {
      stopStream: mock((): Promise<Result<void>> => {
        operations.push("stopStream");
        return Promise.resolve(Ok(undefined));
      }),
    });
    const { workspaceService, clearQueue } = createWorkspaceServiceMocks({
      clearQueue: mock((): Result<void> => {
        operations.push("clearQueue");
        return Ok(undefined);
      }),
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.failAgentTaskForHardTimeout(childTaskId, {
      workflowRunId: "wfr_timeout",
      stepId: "slow-step",
      inputHash: "hash",
      reason: "timed out",
    });

    expect(clearQueue).toHaveBeenCalledWith(childTaskId);
    expect(stopStream).toHaveBeenCalledWith(childTaskId, {
      abandonPartial: true,
      abortReason: "system",
    });
    expect(operations.slice(0, 2)).toEqual(["clearQueue", "stopStream"]);
  });

  test("terminateDescendantAgentTask stops stream, removes workspace, and rejects waiters", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const taskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "task", taskId, {
          name: "agent_exec_task",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService, stopStream } = createAIServiceMocks(config);
    const { workspaceService, remove } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waiter = taskService
      .waitForAgentReport(taskId, { timeoutMs: 10_000 })
      .catch((error: unknown) => error);

    const terminateResult = await taskService.terminateDescendantAgentTask(rootWorkspaceId, taskId);
    expect(terminateResult.success).toBe(true);

    const caught = await waiter;
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/terminated/i);
    }
    expect(stopStream).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ abandonPartial: true })
    );
    expect(remove).toHaveBeenCalledWith(taskId, true);
  });

  test("terminateDescendantAgentTask terminates descendant tasks leaf-first", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, remove } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const terminateResult = await taskService.terminateDescendantAgentTask(
      rootWorkspaceId,
      parentTaskId
    );
    expect(terminateResult.success).toBe(true);
    if (!terminateResult.success) return;
    expect(terminateResult.data.terminatedTaskIds).toEqual([childTaskId, parentTaskId]);

    expect(remove).toHaveBeenNthCalledWith(1, childTaskId, true);
    expect(remove).toHaveBeenNthCalledWith(2, parentTaskId, true);
  });

  test("terminateDescendantAgentTask skips a timed-out stream and continues other descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const stuckTaskId = "task-stuck";
    const siblingTaskId = "task-sibling";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "stuck-task", stuckTaskId, {
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "sibling-task", siblingTaskId, {
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const stopStream = mock((workspaceId: string): Promise<Result<void>> => {
      return workspaceId === stuckTaskId
        ? new Promise(() => undefined)
        : Promise.resolve(Ok(undefined));
    });
    const { aiService } = createAIServiceMocks(config, { stopStream });
    const { workspaceService, remove } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      timeout?: number
    ) => {
      if (timeout === TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS) {
        // Fire on a 0ms macrotask, not a microtask: already-resolved stop
        // promises settle through several microtask hops first, so only the
        // genuinely stuck stream can lose the race to this timer.
        return originalSetTimeout(handler, 0);
      }
      return originalSetTimeout(handler, timeout);
    }) as typeof setTimeout);

    const terminateResult = await taskService.terminateDescendantAgentTask(
      rootWorkspaceId,
      parentTaskId
    );
    timeoutSpy.mockRestore();

    expect(terminateResult.success).toBe(false);
    if (terminateResult.success) return;
    expect(terminateResult.error).toContain(`Timed out stopping task stream (${stuckTaskId})`);
    expect(terminateResult.error).toContain(
      `Skipped removing task workspace (${parentTaskId}): a descendant task workspace was not removed`
    );
    expect(remove).not.toHaveBeenCalledWith(stuckTaskId, true);
    expect(remove).toHaveBeenCalledWith(siblingTaskId, true);
    // The stuck child survives, so its ancestor must survive too: a live child
    // must never point at removed parent metadata.
    expect(remove).not.toHaveBeenCalledWith(parentTaskId, true);
  });

  test("terminate retry awaits the original in-flight removal instead of trusting a dedup Ok", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    // First removal of the child hangs; later calls return Ok, simulating
    // WorkspaceService.remove()'s short-circuit for IDs already being removed.
    let childRemoveCalls = 0;
    const remove = mock((workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      if (workspaceId === childTaskId) {
        childRemoveCalls += 1;
        if (childRemoveCalls === 1) {
          return new Promise(() => undefined);
        }
      }
      return Promise.resolve(Ok(undefined));
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      timeout?: number
    ) => {
      if (timeout === TASK_TERMINATION_WORKSPACE_REMOVE_TIMEOUT_MS) {
        // 0ms macrotask so pending microtask chains settle first (see above).
        return originalSetTimeout(handler, 0);
      }
      return originalSetTimeout(handler, timeout);
    }) as typeof setTimeout);

    const firstAttempt = await taskService.terminateDescendantAgentTask(
      rootWorkspaceId,
      parentTaskId
    );
    const retryAttempt = await taskService.terminateDescendantAgentTask(
      rootWorkspaceId,
      parentTaskId
    );
    timeoutSpy.mockRestore();

    expect(firstAttempt.success).toBe(false);
    expect(retryAttempt.success).toBe(false);
    if (retryAttempt.success) return;
    expect(retryAttempt.error).toContain(`Timed out removing task workspace (${childTaskId})`);
    // The retry must not re-call remove for the child (a fresh call would
    // return the dedup Ok) and must keep the parent blocked.
    expect(childRemoveCalls).toBe(1);
    expect(remove).not.toHaveBeenCalledWith(parentTaskId, true);
  });

  test("descendant traversal terminates when task metadata contains a cycle", () => {
    const config = new Config(rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const traversal = taskService as unknown as {
      listDescendantAgentTaskIdsFromIndex: (
        index: {
          byId: Map<string, unknown>;
          childrenByParent: Map<string, string[]>;
          parentById: Map<string, string>;
        },
        workspaceId: string
      ) => string[];
    };
    const index = {
      byId: new Map<string, unknown>(),
      childrenByParent: new Map([
        ["root", ["child"]],
        ["child", ["grandchild"]],
        ["grandchild", ["child", "root"]],
      ]),
      parentById: new Map<string, string>(),
    };

    expect(traversal.listDescendantAgentTaskIdsFromIndex(index, "root")).toEqual([
      "child",
      "grandchild",
    ]);
  });

  test("terminateAllDescendantAgentTasks interrupts entire subtree leaf-first", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const callOrder: string[] = [];
    const clearQueue = mock((workspaceId: string): Result<void> => {
      callOrder.push(`clear:${workspaceId}`);
      return Ok(undefined);
    });
    const stopStream = mock((workspaceId: string): Promise<Result<void>> => {
      callOrder.push(`stop:${workspaceId}`);
      return Promise.resolve(Ok(undefined));
    });

    const { aiService } = createAIServiceMocks(config, { stopStream });
    const { workspaceService, remove } = createWorkspaceServiceMocks({ clearQueue });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const interruptedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(interruptedTaskIds).toEqual([childTaskId, parentTaskId]);

    expect(clearQueue).toHaveBeenNthCalledWith(1, childTaskId);
    expect(clearQueue).toHaveBeenNthCalledWith(2, parentTaskId);
    expect(stopStream).toHaveBeenNthCalledWith(
      1,
      childTaskId,
      expect.objectContaining({ abandonPartial: false })
    );
    expect(stopStream).toHaveBeenNthCalledWith(
      2,
      parentTaskId,
      expect.objectContaining({ abandonPartial: false })
    );
    expect(callOrder).toEqual([
      `clear:${childTaskId}`,
      `stop:${childTaskId}`,
      `clear:${parentTaskId}`,
      `stop:${parentTaskId}`,
    ]);
    expect(remove).not.toHaveBeenCalled();

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const parentTask = tasks.find((workspace) => workspace.id === parentTaskId);
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(parentTask?.taskStatus).toBe("interrupted");
    expect(childTask?.taskStatus).toBe("interrupted");
  });

  test("terminateAllDescendantAgentTasks can scope interrupts to one workflow run", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowTaskId = "task-workflow";
    const workflowChildTaskId = "task-workflow-child";
    const otherTaskId = "task-other";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "workflow-task", workflowTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_target", stepId: "scope" },
        }),
        projectWorkspace(projectPath, "workflow-child", workflowChildTaskId, {
          parentWorkspaceId: workflowTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "other-task", otherTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_other", stepId: "scope" },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const interruptedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId, {
      workflowRunId: "wfr_target",
    });

    expect(interruptedTaskIds).toEqual([workflowChildTaskId, workflowTaskId]);
    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    expect(tasks.find((workspace) => workspace.id === workflowTaskId)?.taskStatus).toBe(
      "interrupted"
    );
    expect(tasks.find((workspace) => workspace.id === workflowChildTaskId)?.taskStatus).toBe(
      "interrupted"
    );
    expect(tasks.find((workspace) => workspace.id === otherTaskId)?.taskStatus).toBe("running");
  });

  test("listDescendantAgentTasks can exclude workflow-owned descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowTaskId = "task-workflow";
    const workflowChildTaskId = "task-workflow-child";
    const regularTaskId = "task-regular";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "workflow-task", workflowTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_target", stepId: "scope" },
        }),
        projectWorkspace(projectPath, "workflow-child", workflowChildTaskId, {
          parentWorkspaceId: workflowTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "regular-task", regularTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    expect(
      new Set(
        (await taskService.listDescendantAgentTasks(rootWorkspaceId)).map((task) => task.taskId)
      )
    ).toEqual(new Set([regularTaskId, workflowChildTaskId, workflowTaskId]));
    expect(
      (
        await taskService.listDescendantAgentTasks(rootWorkspaceId, {
          excludeWorkflowTasks: true,
        })
      ).map((task) => task.taskId)
    ).toEqual([regularTaskId]);
    expect(
      await taskService.isWorkflowOwnedDescendantAgentTask(rootWorkspaceId, workflowTaskId)
    ).toBe(true);
    expect(
      await taskService.isWorkflowOwnedDescendantAgentTask(rootWorkspaceId, workflowChildTaskId)
    ).toBe(true);
    expect(
      await taskService.isWorkflowOwnedDescendantAgentTask(rootWorkspaceId, regularTaskId)
    ).toBe(false);
  });

  test("isWorkflowOwnedDescendantAgentTask consults persisted report metadata", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowTaskId = "task-workflow";
    const removedWorkflowChildTaskId = "task-workflow-child-removed";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "workflow-task", workflowTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "reported",
          workflowTask: { runId: "wfr_target", stepId: "scope" },
        }),
      ],
      testTaskSettings()
    );

    await upsertSubagentReportArtifact({
      workspaceId: rootWorkspaceId,
      workspaceSessionDir: config.getSessionDir(rootWorkspaceId),
      childTaskId: removedWorkflowChildTaskId,
      parentWorkspaceId: workflowTaskId,
      ancestorWorkspaceIds: [workflowTaskId, rootWorkspaceId],
      workflowOwnedAncestorWorkspaceIds: [rootWorkspaceId],
      reportMarkdown: "done",
      nowMs: 1,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    expect(
      await taskService.isWorkflowOwnedDescendantAgentTask(
        rootWorkspaceId,
        removedWorkflowChildTaskId
      )
    ).toBe(true);
    expect(
      await taskService.isWorkflowOwnedDescendantAgentTask(
        workflowTaskId,
        removedWorkflowChildTaskId
      )
    ).toBe(false);
  });

  test("listActiveDescendantAgentTaskIds can exclude workflow-owned descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowTaskId = "task-workflow";
    const workflowChildTaskId = "task-workflow-child";
    const regularTaskId = "task-regular";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "workflow-task", workflowTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_target", stepId: "scope" },
        }),
        projectWorkspace(projectPath, "workflow-child", workflowChildTaskId, {
          parentWorkspaceId: workflowTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "regular-task", regularTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    expect(new Set(taskService.listActiveDescendantAgentTaskIds(rootWorkspaceId))).toEqual(
      new Set([regularTaskId, workflowChildTaskId, workflowTaskId])
    );
    expect(
      taskService.listActiveDescendantAgentTaskIds(rootWorkspaceId, {
        excludeWorkflowTasks: true,
      })
    ).toEqual([regularTaskId]);
  });

  test("terminateAllDescendantAgentTasks preserves already-completed descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";
    const completedAt = "2026-03-09T11:05:58.780Z";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: completedAt,
        }),
      ],
      testTaskSettings()
    );

    const callOrder: string[] = [];
    const clearQueue = mock((workspaceId: string): Result<void> => {
      callOrder.push(`clear:${workspaceId}`);
      return Ok(undefined);
    });
    const stopStream = mock((workspaceId: string): Promise<Result<void>> => {
      callOrder.push(`stop:${workspaceId}`);
      return Promise.resolve(Ok(undefined));
    });

    const { aiService } = createAIServiceMocks(config, { stopStream });
    const { workspaceService } = createWorkspaceServiceMocks({ clearQueue });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const interruptedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(interruptedTaskIds).toEqual([parentTaskId]);
    expect(callOrder).toEqual([
      `clear:${childTaskId}`,
      `stop:${childTaskId}`,
      `clear:${parentTaskId}`,
      `stop:${parentTaskId}`,
    ]);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const parentTask = tasks.find((workspace) => workspace.id === parentTaskId);
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(parentTask?.taskStatus).toBe("interrupted");
    expect(childTask?.taskStatus).toBe("reported");
    expect(childTask?.reportedAt).toBe(completedAt);
  });

  test("terminateAllDescendantAgentTasks still interrupts running descendants with stale reportedAt", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";
    const staleReportedAt = "2026-03-09T11:05:58.780Z";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
          reportedAt: staleReportedAt,
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const interruptedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(interruptedTaskIds).toEqual([childTaskId, parentTaskId]);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(childTask?.taskStatus).toBe("interrupted");
    expect(childTask?.reportedAt).toBeUndefined();
  });

  test("terminateAllDescendantAgentTasks rejects waiters when a descendant disappears mid-cascade", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waiterResult = taskService
      .waitForAgentReport(childTaskId, {
        timeoutMs: 1_000,
        requestingWorkspaceId: rootWorkspaceId,
      })
      .then(() => new Error("Expected waiter to reject"))
      .catch((error: unknown) => error);

    const internal = taskService as unknown as {
      editWorkspaceEntry: (
        workspaceId: string,
        updater: (workspace: unknown) => void,
        options?: { allowMissing?: boolean }
      ) => Promise<boolean>;
    };
    const originalEditWorkspaceEntry = internal.editWorkspaceEntry.bind(taskService);
    const editWorkspaceEntrySpy = spyOn(internal, "editWorkspaceEntry").mockImplementation(
      (workspaceId, updater, options) => {
        if (workspaceId === childTaskId) {
          return Promise.resolve(false);
        }
        return originalEditWorkspaceEntry(workspaceId, updater, options);
      }
    );

    try {
      const interruptedTaskIds =
        await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
      expect(interruptedTaskIds).toEqual([parentTaskId]);

      const waiterError = await waiterResult;
      expect(waiterError).toBeInstanceOf(Error);
      if (waiterError instanceof Error) {
        expect(waiterError.message).toBe("Parent workspace interrupted");
      }
    } finally {
      editWorkspaceEntrySpy.mockRestore();
    }
  });

  test("terminateAllDescendantAgentTasks preserves completed report cache for interrupted descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      resolveWaiters: (
        taskId: string,
        report: { reportMarkdown: string; title?: string }
      ) => boolean;
    };
    internal.resolveWaiters(childTaskId, {
      reportMarkdown: "cached report",
      title: "cached title",
    });

    const interruptedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(interruptedTaskIds).toEqual([childTaskId, parentTaskId]);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(childTask?.taskStatus).toBe("interrupted");

    const report = await taskService.waitForAgentReport(childTaskId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: rootWorkspaceId,
    });
    expect(report).toEqual({ reportMarkdown: "cached report", title: "cached title" });
  });

  test("terminateAllDescendantAgentTasks is a no-op with no descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const { aiService, stopStream } = createAIServiceMocks(config);
    const { workspaceService, remove } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const terminatedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(terminatedTaskIds).toEqual([]);
    expect(stopStream).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("terminateAllDescendantAgentTasks preserves queued task prompts across repeated interrupts", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const queuedTaskId = "task-queued";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "queued-task", queuedTaskId, {
          name: "agent_exec_queued",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "queued",
          taskPrompt: "resume me later",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    const firstInterruptedTaskIds =
      await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(firstInterruptedTaskIds).toEqual([queuedTaskId]);

    const secondInterruptedTaskIds =
      await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(secondInterruptedTaskIds).toEqual([queuedTaskId]);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const queuedTask = tasks.find((workspace) => workspace.id === queuedTaskId);
    expect(queuedTask?.taskStatus).toBe("interrupted");
    expect(queuedTask?.taskPrompt).toBe("resume me later");
  });

  test("markInterruptedTaskRunning restores interrupted descendant tasks to running without clearing prompt", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "interrupted",
          taskPrompt: "stale prompt",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    const transitioned = await taskService.markInterruptedTaskRunning(childTaskId);
    expect(transitioned).toBe(true);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(childTask?.taskStatus).toBe("running");
    expect(childTask?.taskPrompt).toBe("stale prompt");
  });

  test("markInterruptedTaskRunning is a no-op for non-interrupted workspaces", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const editConfigSpy = spyOn(config, "editConfig");
    const { taskService } = createTaskServiceHarness(config);

    const transitioned = await taskService.markInterruptedTaskRunning(childTaskId);

    expect(transitioned).toBe(false);
    expect(editConfigSpy).not.toHaveBeenCalled();
  });

  test("restoreInterruptedTaskAfterResumeFailure reverts running descendant tasks and clears stale reportedAt", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          reportedAt: "2026-03-09T11:05:58.780Z",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    await taskService.restoreInterruptedTaskAfterResumeFailure(childTaskId);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(childTask?.taskStatus).toBe("interrupted");
    expect(childTask?.reportedAt).toBeUndefined();
  });

  test("initialize interrupts workflow-owned tasks instead of recovering them after owning workflow interrupt", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const runtimeConfig = { type: "local" as const };
    const parentId = "parent-workflow-interrupted";
    const queuedChildId = "child-workflow-queued";
    const runningChildId = "child-workflow-running";
    const awaitingChildId = "child-workflow-awaiting";
    const nestedRunningChildId = "child-workflow-nested-running";
    const workflowRunId = "wfr_interrupted_owner";
    const innerWorkflowRunId = "wfr_active_inner_owner";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId, { runtimeConfig }),
        projectWorkspace(projectPath, "queued", queuedChildId, {
          name: "agent_explore_queued",
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskPrompt: "queued work",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: workflowRunId, stepId: "queued" },
        }),
        projectWorkspace(projectPath, "running", runningChildId, {
          name: "agent_explore_running",
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: workflowRunId, stepId: "running" },
        }),
        projectWorkspace(projectPath, "awaiting", awaitingChildId, {
          name: "agent_explore_awaiting",
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: workflowRunId, stepId: "awaiting" },
        }),
        projectWorkspace(projectPath, "nested-running", nestedRunningChildId, {
          name: "agent_explore_nested_running",
          parentWorkspaceId: runningChildId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: innerWorkflowRunId, stepId: "nested" },
        }),
      ],
      testTaskSettings(10, 3)
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "interrupted",
        description: "Interrupted",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "interrupted", "2026-05-29T00:00:01.000Z");
    const innerRunStore = new WorkflowRunStore({
      sessionDir: config.getSessionDir(runningChildId),
    });
    await innerRunStore.createRun({
      id: innerWorkflowRunId,
      workspaceId: runningChildId,
      workflow: {
        name: "inner-running",
        description: "Inner running",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await innerRunStore.appendStatus(innerWorkflowRunId, "running", "2026-05-29T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).not.toHaveBeenCalled();
    for (const taskId of [queuedChildId, runningChildId, awaitingChildId, nestedRunningChildId]) {
      expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("interrupted");
    }
    expect(findWorkspaceInConfig(config, queuedChildId)?.taskPrompt).toBe("queued work");
  });

  test("initialize recovers parent tasks after interrupting inactive workflow children", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-workflow-child-interrupted";
    const parentTaskId = "parent-awaiting-after-child-interrupt";
    const childTaskId = "child-running-inactive-workflow";
    const workflowRunId = "wfr_child_inactive_owner";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        projectWorkspace(projectPath, "parent", parentTaskId, {
          name: "agent_explore_parent",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: defaultModel,
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "child" },
        }),
      ],
      testTaskSettings(10, 3)
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentTaskId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentTaskId,
      workflow: {
        name: "interrupted",
        description: "Interrupted",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "interrupted", "2026-05-29T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("interrupted");
    expect(sendMessage).toHaveBeenCalledWith(
      parentTaskId,
      expect.stringContaining("awaiting its final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true })
    );
  });

  // Archive mock that mirrors the real WorkspaceService.archive persistence effect
  // (sets archivedAt in config) so tests can assert the sidebar-relevant state rather
  // than only mock call counts.
  function createConfigMutatingArchiveMock(getConfig: () => Config) {
    return mock(async (workspaceId: string): Promise<Result<{ kind: "archived" }>> => {
      await getConfig().editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const workspace = project.workspaces.find((w) => w.id === workspaceId);
          if (workspace) workspace.archivedAt = new Date().toISOString();
        }
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
  }

  test("markWorkflowRunEnded archives interrupted workflow children and blocked reported ancestors", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-run-ended";
    const reportedParentId = "reported-parent-blocked";
    const interruptedChildId = "interrupted-child-no-report";
    const completedChildId = "completed-leaf-child";
    const stickyInterruptedId = "sticky-interrupted-child";
    const stickyCompletedId = "sticky-completed-parent";
    const stickyParentChildId = "sticky-parent-interrupted-child";
    const userInterruptedId = "user-spawned-interrupted";
    const workflowRunId = "wfr_ended_garbage_sweep";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        // Reported workflow-owned task blocked by the structural-leaf topology gate:
        // its interrupted-without-report child keeps hasChildAgentTasks true forever.
        projectWorkspace(projectPath, "reported-parent", reportedParentId, {
          name: "agent_exec_reported_parent",
          parentWorkspaceId: rootId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: "2026-05-29T00:00:02.000Z",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "parent" },
        }),
        // Interrupted WITHOUT a completed report: canCleanupReportedTask never accepts
        // it, so before the sweep it lingered in the active sidebar forever.
        projectWorkspace(projectPath, "interrupted-child", interruptedChildId, {
          name: "agent_explore_interrupted",
          parentWorkspaceId: reportedParentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
        }),
        // Completed-report leaf: must go through the existing remove-based cleanup,
        // not the archive path.
        projectWorkspace(projectPath, "completed-child", completedChildId, {
          name: "agent_explore_completed",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-05-29T00:00:03.000Z",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "completed" },
        }),
        // Sticky workflow descendants are explicit user-retained workspaces. Run-end cleanup must
        // neither archive interrupted ones nor remove completed ones.
        projectWorkspace(projectPath, "sticky-interrupted", stickyInterruptedId, {
          name: "agent_exec_sticky_interrupted",
          parentWorkspaceId: rootId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
          taskSticky: true,
          workflowTask: { runId: workflowRunId, stepId: "sticky-interrupted" },
        }),
        projectWorkspace(projectPath, "sticky-completed", stickyCompletedId, {
          name: "agent_exec_sticky_completed",
          parentWorkspaceId: rootId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: "2026-05-29T00:00:04.000Z",
          taskModelString: defaultModel,
          taskSticky: true,
          workflowTask: { runId: workflowRunId, stepId: "sticky-completed" },
        }),
        projectWorkspace(projectPath, "sticky-parent-child", stickyParentChildId, {
          name: "agent_explore_sticky_parent_child",
          parentWorkspaceId: stickyCompletedId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
        }),
        // User-spawned interrupted task (no workflowTask in ancestry): intentionally
        // stays visible for manual inspection.
        projectWorkspace(projectPath, "user-interrupted", userInterruptedId, {
          name: "agent_explore_user",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
        }),
      ],
      testTaskSettings(10, 3)
    );

    const archive = createConfigMutatingArchiveMock(() => config);
    const remove = mock(async (workspaceId: string): Promise<Result<void>> => {
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const index = project.workspaces.findIndex((w) => w.id === workspaceId);
          if (index !== -1) project.workspaces.splice(index, 1);
        }
        return cfg;
      });
      return Ok(undefined);
    });
    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService } = createWorkspaceServiceMocks({ archive, remove });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.markWorkflowRunEnded(workflowRunId);

    // Interrupted-without-report workflow child: archived (hidden from the active
    // sidebar) but preserved, still interrupted.
    const interruptedChild = findWorkspaceInConfig(config, interruptedChildId);
    expect(interruptedChild?.archivedAt).toBeString();
    expect(interruptedChild?.taskStatus).toBe("interrupted");

    // Completed-report leaf: removed via the existing cleanup walk, never archived.
    expect(findWorkspaceInConfig(config, completedChildId)).toBeUndefined();

    // Sticky workflow descendants remain active and untouched despite the run ending.
    const stickyInterrupted = findWorkspaceInConfig(config, stickyInterruptedId);
    expect(stickyInterrupted?.archivedAt).toBeUndefined();
    expect(stickyInterrupted?.taskStatus).toBe("interrupted");
    const stickyCompleted = findWorkspaceInConfig(config, stickyCompletedId);
    expect(stickyCompleted?.archivedAt).toBeUndefined();
    expect(stickyCompleted?.taskStatus).toBe("reported");

    expect(findWorkspaceInConfig(config, stickyParentChildId)?.archivedAt).toBeString();

    // Reported ancestor blocked only by its archived interrupted child: archived too,
    // so the garbage cluster leaves the active sidebar without deleting anything.
    const reportedParent = findWorkspaceInConfig(config, reportedParentId);
    expect(reportedParent?.archivedAt).toBeString();
    expect(reportedParent?.taskStatus).toBe("reported");

    // User-spawned interrupted task keeps current behavior: visible, untouched.
    const userInterrupted = findWorkspaceInConfig(config, userInterruptedId);
    expect(userInterrupted?.archivedAt).toBeUndefined();
    expect(userInterrupted?.taskStatus).toBe("interrupted");
  });

  test("terminateAllDescendantAgentTasks archives run-scoped interrupted children immediately", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-run-interrupt";
    const workflowChildId = "workflow-running-child";
    const userChildId = "user-running-child";
    const workflowRunId = "wfr_interrupt_sweep";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        projectWorkspace(projectPath, "workflow-child", workflowChildId, {
          name: "agent_explore_workflow",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "child" },
        }),
        projectWorkspace(projectPath, "user-child", userChildId, {
          name: "agent_explore_user",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
        }),
      ],
      testTaskSettings(10, 3)
    );

    const archive = createConfigMutatingArchiveMock(() => config);
    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService } = createWorkspaceServiceMocks({ archive });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    // Run-scoped interrupt (WorkflowService.interruptRun path): the sweep archives the
    // freshly interrupted workflow child even if the runner's onRunEnded hook already
    // fired before the children were interrupted.
    await taskService.terminateAllDescendantAgentTasks(rootId, { workflowRunId });

    const workflowChild = findWorkspaceInConfig(config, workflowChildId);
    expect(workflowChild?.taskStatus).toBe("interrupted");
    expect(workflowChild?.archivedAt).toBeString();

    // The run-scoped filter leaves the user-spawned sibling running and unarchived.
    const userChild = findWorkspaceInConfig(config, userChildId);
    expect(userChild?.taskStatus).toBe("running");
    expect(userChild?.archivedAt).toBeUndefined();
  });

  test("sweep keeps an ancestor visible when a descendant archive is skipped", async () => {
    // Regression (PR #3694 Codex P2): a child archive skipped by the lossy-untracked-file
    // confirmation (or a failed archive) must block its ancestors' archives too —
    // otherwise the parent gets hidden while its unarchived child stays active in the
    // sidebar as an orphan.
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-skip-blocks-ancestor";
    const parentTaskId = "interrupted-parent-task";
    const childTaskId = "interrupted-child-lossy";
    const workflowRunId = "wfr_skip_blocks_ancestor";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        projectWorkspace(projectPath, "interrupted-parent", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "parent" },
        }),
        projectWorkspace(projectPath, "interrupted-child", childTaskId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentTaskId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
        }),
      ],
      testTaskSettings(10, 3)
    );

    // Child archive is deferred pending untracked-file confirmation; parent would archive.
    const archived: string[] = [];
    const archive = mock(
      async (
        workspaceId: string
      ): Promise<Result<{ kind: "archived" } | { kind: "confirm-lossy-untracked-files" }>> => {
        if (workspaceId === childTaskId) {
          return Ok({ kind: "confirm-lossy-untracked-files" });
        }
        await config.editConfig((cfg) => {
          for (const project of cfg.projects.values()) {
            const workspace = project.workspaces.find((w) => w.id === workspaceId);
            if (workspace) workspace.archivedAt = new Date().toISOString();
          }
          return cfg;
        });
        archived.push(workspaceId);
        return Ok({ kind: "archived" });
      }
    );
    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService } = createWorkspaceServiceMocks({ archive });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.markWorkflowRunEnded(workflowRunId);

    // Child stayed visible (confirmation pending) — so the parent must stay visible too.
    expect(findWorkspaceInConfig(config, childTaskId)?.archivedAt).toBeUndefined();
    expect(findWorkspaceInConfig(config, parentTaskId)?.archivedAt).toBeUndefined();
    expect(archived).not.toContain(parentTaskId);
  });

  test("initialize archives interrupted workflow-owned children of inactive runs but not user-spawned tasks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-startup-sweep";
    const workflowChildId = "workflow-child-startup";
    const staleInterruptedId = "workflow-child-stale-interrupted";
    const userInterruptedId = "user-interrupted-startup";
    const workflowRunId = "wfr_startup_sweep";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        // Running child of an inactive run: the startup prepass transitions it to
        // "interrupted"; the startup sweep must then archive it.
        projectWorkspace(projectPath, "workflow-child", workflowChildId, {
          name: "agent_explore_workflow",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "child" },
        }),
        // Historical garbage: already interrupted (pre-sweep sessions) — must self-heal.
        projectWorkspace(projectPath, "stale-interrupted", staleInterruptedId, {
          name: "agent_explore_stale",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "stale" },
        }),
        projectWorkspace(projectPath, "user-interrupted", userInterruptedId, {
          name: "agent_explore_user",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
        }),
      ],
      testTaskSettings(10, 3)
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootId,
      workflow: {
        name: "interrupted",
        description: "Interrupted",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "interrupted", "2026-05-29T00:00:01.000Z");

    const archive = createConfigMutatingArchiveMock(() => config);
    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService } = createWorkspaceServiceMocks({ archive });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    // Prepass interrupted the running child; the startup sweep archived both it and
    // the historical interrupted leftover.
    for (const taskId of [workflowChildId, staleInterruptedId]) {
      const workspace = findWorkspaceInConfig(config, taskId);
      expect(workspace?.taskStatus).toBe("interrupted");
      expect(workspace?.archivedAt).toBeString();
    }

    // User-spawned interrupted task keeps current behavior: visible, untouched.
    const userInterrupted = findWorkspaceInConfig(config, userInterruptedId);
    expect(userInterrupted?.taskStatus).toBe("interrupted");
    expect(userInterrupted?.archivedAt).toBeUndefined();
  });

  test("initialize re-sweeps a run whose interrupted children were archived but reported ancestor was not", async () => {
    // Regression (PR #3694 Codex P2): crash window between sweep phases. If a previous
    // session archived the interrupted child (phase 1) but crashed before archiving the
    // reported ancestor it blocks (phase 2), no unarchived interrupted task remains to
    // seed the startup sweep — so the reported ancestor stayed visible forever. The
    // seeding now also considers unarchived reported workflow-owned tasks.
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-crash-window";
    const reportedParentId = "reported-parent-crash-window";
    const archivedChildId = "archived-interrupted-child";
    const workflowRunId = "wfr_crash_window_sweep";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        // Phase-2 leftover: reported, unarchived, blocked by its archived child.
        projectWorkspace(projectPath, "reported-parent", reportedParentId, {
          name: "agent_exec_reported_parent",
          parentWorkspaceId: rootId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: "2026-05-29T00:00:02.000Z",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "parent" },
        }),
        // Phase-1 result from the crashed session: interrupted child already archived.
        projectWorkspace(projectPath, "archived-child", archivedChildId, {
          name: "agent_explore_archived",
          parentWorkspaceId: reportedParentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
          archivedAt: "2026-05-29T00:00:03.000Z",
        }),
      ],
      testTaskSettings(10, 3)
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootId,
      workflow: {
        name: "interrupted",
        description: "Interrupted",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "interrupted", "2026-05-29T00:00:01.000Z");

    const archive = createConfigMutatingArchiveMock(() => config);
    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService } = createWorkspaceServiceMocks({ archive });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    // The startup sweep re-seeded the run from the unarchived reported ancestor and
    // archived it (blocked only by its archived child), completing the interrupted sweep.
    const reportedParent = findWorkspaceInConfig(config, reportedParentId);
    expect(reportedParent?.archivedAt).toBeString();
    expect(reportedParent?.taskStatus).toBe("reported");
  });

  test("initialize drains queued tasks after interrupting inactive workflow children", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = await createTestProject(rootDir, "repo-queue-after-interrupt");
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const rootName = "root";
    await runtime.createWorkspace({
      projectPath,
      branchName: rootName,
      trunkBranch: "main",
      directoryName: rootName,
      initLogger: createNullInitLogger(),
    });

    const rootId = "root-queue-after-interrupt";
    const runningTaskId = "running-inactive-workflow-occupies-slot";
    const queuedWorkflowTaskId = "queued-inactive-workflow";
    const queuedTaskId = "queued-starts-after-interrupt";
    const workflowRunId = "wfr_queue_after_interrupt";

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, rootName),
          id: rootId,
          name: rootName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        projectWorkspace(projectPath, "running", runningTaskId, {
          name: "agent_explore_running",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: workflowRunId, stepId: "running" },
        }),
        projectWorkspace(projectPath, "queued-workflow", queuedWorkflowTaskId, {
          name: "agent_explore_queued_workflow",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskPrompt: "abandoned workflow queued work",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: workflowRunId, stepId: "queued" },
        }),
        projectWorkspace(projectPath, "queued", queuedTaskId, {
          name: "agent_explore_queued",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskPrompt: "queued work",
          taskModelString: defaultModel,
          runtimeConfig,
        }),
      ],
      testTaskSettings(1, 3)
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootId,
      workflow: {
        name: "interrupted",
        description: "Interrupted",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "interrupted", "2026-05-29T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    expect(findWorkspaceInConfig(config, runningTaskId)?.taskStatus).toBe("interrupted");
    expect(findWorkspaceInConfig(config, queuedWorkflowTaskId)?.taskStatus).toBe("interrupted");
    expect(findWorkspaceInConfig(config, queuedTaskId)?.taskStatus).toBe("running");
    expect(sendMessage).toHaveBeenCalledWith(
      queuedTaskId,
      "queued work",
      expect.objectContaining({ agentId: "explore" }),
      expect.objectContaining({ allowQueuedAgentTask: true })
    );
  });

  test("initialize resumes awaiting_report tasks after restart", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("awaiting its final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true })
    );
  });

  test("initialize uses legacy agentType when modern agentId is unavailable for awaiting_report tasks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-custom-plan-222";
    const customAgentId = "custom_plan_runner";
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const parentWorkspacePath = path.join(projectPath, "parent");
    const childWorkspacePath = path.join(projectPath, "child-custom-plan");

    const customAgentDir = path.join(parentWorkspacePath, ".mux", "agents");
    await fsPromises.mkdir(customAgentDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(customAgentDir, `${customAgentId}.md`),
      [
        "---",
        "name: Custom Plan Runner",
        "base: plan",
        "subagent:",
        "  runnable: true",
        "---",
        "Custom plan-like agent for restart handling tests.",
        "",
      ].join("\n")
    );

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentWorkspacePath,
          id: parentId,
          name: "parent",
          runtimeConfig,
        },
        {
          path: childWorkspacePath,
          id: childId,
          name: "agent_custom_plan_child",
          parentWorkspaceId: parentId,
          agentId: "missing-agent",
          agentType: customAgentId,
          taskStatus: "awaiting_report",
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();

    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("awaiting its propose_plan"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^propose_plan$", action: "require" }],
        agentId: customAgentId,
      }),
      expect.objectContaining({ synthetic: true })
    );
  });

  test("initialize honors child project agent overrides before parent built-in fallback", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo-child-override");
    const parentId = "parent-child-override-111";
    const childId = "child-exec-override-222";
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const parentWorkspacePath = path.join(projectPath, "parent");
    const childWorkspacePath = path.join(projectPath, "child-exec-override");

    const childAgentDir = path.join(childWorkspacePath, ".mux", "agents");
    await fsPromises.mkdir(childAgentDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(childAgentDir, "exec.md"),
      [
        "---",
        "name: Child Exec Override",
        "base: plan",
        "subagent:",
        "  runnable: true",
        "---",
        "Child plan-like Exec override for restart handling tests.",
        "",
      ].join("\n")
    );

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentWorkspacePath,
          id: parentId,
          name: "parent",
          runtimeConfig,
        },
        {
          path: childWorkspacePath,
          id: childId,
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "awaiting_report",
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();

    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("awaiting its propose_plan"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^propose_plan$", action: "require" }],
        agentId: "exec",
      }),
      expect.objectContaining({ synthetic: true })
    );
  });

  describe("backgroundForegroundWaitsForWorkspace", () => {
    test("rejects opted-in foreground waiters with ForegroundWaitBackgroundedError", async () => {
      const config = await createTestConfig(rootDir);

      const parentId = "parent-ws";
      const childId = "child-task-ws";
      const projectPath = "/test/project";

      await saveWorkspaces(
        config,
        projectPath,
        [
          { path: `${projectPath}/parent`, id: parentId, name: "parent" },
          {
            path: `${projectPath}/child`,
            id: childId,
            name: "agent_explore_child",
            parentWorkspaceId: parentId,
            agentType: "explore",
            taskStatus: "running",
          },
        ],
        testTaskSettings(2, 3)
      );

      const { taskService } = createTaskServiceHarness(config);

      const waitPromise = taskService.waitForAgentReport(childId, {
        requestingWorkspaceId: parentId,
        backgroundOnMessageQueued: true,
      });

      const interruption = {
        reason: "progress_report_received",
        sourceTaskId: childId,
        report: {
          agentType: "explore",
          title: "Progress",
          reportMarkdown: "Found the relevant path.",
        },
      } as const;
      const count = taskService.backgroundForegroundWaitsForWorkspace(parentId, interruption);
      expect(count).toBe(1);

      const err = await waitPromise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForegroundWaitBackgroundedError);
      expect((err as ForegroundWaitBackgroundedError).interruption).toEqual(interruption);

      const count2 = taskService.backgroundForegroundWaitsForWorkspace(parentId);
      expect(count2).toBe(0);
    });

    test("backgrounds waiters when tool-end message was already queued", async () => {
      const config = await createTestConfig(rootDir);

      const parentId = "parent-ws";
      const childId = "child-task-ws";
      const projectPath = "/test/project";

      await saveWorkspaces(
        config,
        projectPath,
        [
          { path: `${projectPath}/parent`, id: parentId, name: "parent" },
          {
            path: `${projectPath}/child`,
            id: childId,
            name: "agent_explore_child",
            parentWorkspaceId: parentId,
            agentType: "explore",
            taskStatus: "queued",
          },
        ],
        testTaskSettings(2, 3)
      );

      const hasQueuedMessages = mock(() => true);
      const interruption = {
        reason: "progress_report_received",
        sourceTaskId: childId,
        report: {
          agentType: "explore",
          title: "Progress",
          reportMarkdown: "Found the relevant path.",
        },
      } as const;
      const getQueuedForegroundWaitInterruption = mock(() => interruption);
      const consumeQueuedForegroundWaitInterruption = mock(() => true);
      const { workspaceService } = createWorkspaceServiceMocks({
        hasQueuedMessages,
        getQueuedForegroundWaitInterruption,
        consumeQueuedForegroundWaitInterruption,
      });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      const internal = taskService as unknown as {
        backgroundableForegroundWaitersByWorkspaceId: Map<string, Set<unknown>>;
        pendingStartWaitersByTaskId: Map<string, unknown[]>;
        pendingWaitersByTaskId: Map<string, unknown[]>;
      };

      const waitError = await taskService
        .waitForAgentReport(childId, {
          requestingWorkspaceId: parentId,
          backgroundOnMessageQueued: true,
        })
        .catch((error: unknown) => error);

      expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);
      expect((waitError as ForegroundWaitBackgroundedError).interruption).toEqual(interruption);
      expect(hasQueuedMessages).toHaveBeenCalledWith(parentId, "tool-end");
      expect(getQueuedForegroundWaitInterruption).toHaveBeenCalledWith(parentId, "tool-end");
      expect(consumeQueuedForegroundWaitInterruption).toHaveBeenCalledWith(
        parentId,
        interruption,
        "Sub-agent update delivered through the interrupted foreground wait."
      );
      expect(taskService.backgroundForegroundWaitsForWorkspace(parentId)).toBe(0);
      expect(internal.backgroundableForegroundWaitersByWorkspaceId.has(parentId)).toBe(false);
      expect(internal.pendingStartWaitersByTaskId.has(childId)).toBe(false);
      expect(internal.pendingWaitersByTaskId.has(childId)).toBe(false);
    });

    test("defaults to queue-backgroundable when requestingWorkspaceId is present", async () => {
      const config = await createTestConfig(rootDir);

      const parentId = "parent-ws";
      const childId = "child-task-ws";
      const projectPath = "/test/project";

      await saveWorkspaces(
        config,
        projectPath,
        [
          { path: `${projectPath}/parent`, id: parentId, name: "parent" },
          {
            path: `${projectPath}/child`,
            id: childId,
            name: "agent_explore_child",
            parentWorkspaceId: parentId,
            agentType: "explore",
            taskStatus: "running",
          },
        ],
        testTaskSettings(2, 3)
      );

      const { taskService } = createTaskServiceHarness(config);

      const waitPromise = taskService.waitForAgentReport(childId, {
        requestingWorkspaceId: parentId,
      });

      const count = taskService.backgroundForegroundWaitsForWorkspace(parentId);
      expect(count).toBe(1);

      const waitError = await waitPromise.catch((error: unknown) => error);
      expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);
    });

    test("does not affect foreground waiters that explicitly opt out of backgrounding", async () => {
      const config = await createTestConfig(rootDir);

      const parentId = "parent-ws";
      const childId = "child-task-ws";
      const projectPath = "/test/project";

      await saveWorkspaces(
        config,
        projectPath,
        [
          { path: `${projectPath}/parent`, id: parentId, name: "parent" },
          {
            path: `${projectPath}/child`,
            id: childId,
            name: "agent_explore_child",
            parentWorkspaceId: parentId,
            agentType: "explore",
            taskStatus: "running",
          },
        ],
        testTaskSettings(2, 3)
      );

      const { taskService } = createTaskServiceHarness(config);

      const waitPromise = taskService.waitForAgentReport(childId, {
        requestingWorkspaceId: parentId,
        backgroundOnMessageQueued: false,
      });

      const count = taskService.backgroundForegroundWaitsForWorkspace(parentId);
      expect(count).toBe(0);

      const internal = taskService as unknown as {
        resolveWaiters: (
          taskId: string,
          report: { reportMarkdown: string; title?: string }
        ) => void;
      };
      internal.resolveWaiters(childId, { reportMarkdown: "ok" });

      const result = await waitPromise;
      expect(result).toEqual({ reportMarkdown: "ok" });
    });
  });

  test("waitForAgentReport does not time out while task is queued", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "queued",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    // Timeout is short so the test would fail if the timer started while queued.
    const reportPromise = taskService.waitForAgentReport(childId, { timeoutMs: 50 });

    // Wait longer than timeout while task is still queued.
    await new Promise((r) => setTimeout(r, 100));

    const internal = taskService as unknown as {
      setTaskStatus: (workspaceId: string, status: "queued" | "running") => Promise<void>;
      resolveWaiters: (taskId: string, report: { reportMarkdown: string; title?: string }) => void;
    };

    await internal.setTaskStatus(childId, "running");
    internal.resolveWaiters(childId, { reportMarkdown: "ok" });

    const report = await reportPromise;
    expect(report.reportMarkdown).toBe("ok");
  });

  test("waitForAgentReport reuses the standard completion reminder for awaiting_report tasks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const waitError = await taskService
      .waitForAgentReport(childId, { timeoutMs: 10 })
      .catch((error: unknown) => error);

    expect(waitError).toBeInstanceOf(Error);
    if (waitError instanceof Error) {
      expect(waitError.message).toBe("Timed out waiting for agent_report");
    }

    // waitForAgentReport schedules the completion reminder as a fire-and-forget task under
    // workspaceEventLocks. The short timeout above can reject before that background work
    // finishes, so acquire the same lock (which only resolves after the holder releases)
    // before asserting on sendMessage to avoid a race under load.
    const internal = taskService as unknown as {
      workspaceEventLocks: { withLock(key: string, fn: () => Promise<void>): Promise<void> };
    };
    await internal.workspaceEventLocks.withLock(childId, () => Promise.resolve());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      childId,
      expect.stringContaining("A caller is still waiting for agent_report"),
      expect.any(Object),
      expect.any(Object)
    );
  });

  test("waitForAgentReport rejects interrupted tasks without waiting", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    let caught: unknown = null;
    try {
      await taskService.waitForAgentReport(childId, { timeoutMs: 10_000 });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/Task interrupted/);
    }
  });

  test("waitForAgentReport returns cached report for interrupted task", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    const internal = taskService as unknown as {
      resolveWaiters: (
        taskId: string,
        report: { reportMarkdown: string; title?: string }
      ) => boolean;
    };
    internal.resolveWaiters(childId, { reportMarkdown: "cached report", title: "cached title" });

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    expect(report).toEqual({ reportMarkdown: "cached report", title: "cached title" });
  });

  test("waitForAgentReport returns persisted artifact for interrupted task", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    const planFilePath = path.join(rootDir, "plans", "repo", "child-222.md");
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "persisted report",
      title: "persisted title",
      planFilePath,
      nowMs: Date.now(),
    });

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    expect(report).toEqual({
      reportMarkdown: "persisted report",
      title: "persisted title",
      planFilePath,
    });
  });

  test("waitForAgentReport returns persisted artifact for stale running task", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);
    const patchGeneration = spyOn(
      (
        taskService as unknown as {
          gitPatchArtifactService: { maybeStartGeneration: (...args: unknown[]) => Promise<void> };
        }
      ).gitPatchArtifactService,
      "maybeStartGeneration"
    ).mockResolvedValue(undefined);

    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "persisted report",
      title: "persisted title",
      nowMs: Date.now(),
    });

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10,
      requestingWorkspaceId: parentId,
    });

    expect(report).toEqual({ reportMarkdown: "persisted report", title: "persisted title" });
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    expect(patchGeneration).toHaveBeenCalledWith(parentId, childId, expect.any(Function));
  });

  test("waitForAgentReport returns persisted report after workspace is removed", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "ok",
      title: "t",
      nowMs: Date.now(),
    });

    await config.removeWorkspace(childId);

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10,
      requestingWorkspaceId: parentId,
    });
    expect(report.reportMarkdown).toBe("ok");
    expect(report.title).toBe("t");
  });

  test("isDescendantAgentTask consults persisted ancestry after workspace is removed", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "ok",
      title: "t",
      nowMs: Date.now(),
    });

    await config.removeWorkspace(childId);

    expect(await taskService.isDescendantAgentTask(parentId, childId)).toBe(true);
    expect(await taskService.isDescendantAgentTask("other-parent", childId)).toBe(false);
  });

  test("filterDescendantAgentTaskIds consults persisted ancestry after cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "ok",
      title: "t",
      nowMs: Date.now(),
    });

    await config.removeWorkspace(childId);

    expect(await taskService.filterDescendantAgentTaskIds(parentId, [childId])).toEqual([childId]);
    expect(await taskService.filterDescendantAgentTaskIds("other-parent", [childId])).toEqual([]);
  });

  test("descendant scope checks consult persisted failure artifacts after cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const failedChildId = "child-failed";
    const workflowChildId = "child-workflow-failed";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "parent", parentId)],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    // Both children failed terminally (e.g. model_refusal) and were cleaned up:
    // no config entry, no report artifact — only the failure artifact remains.
    await upsertSubagentFailureArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: failedChildId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      errorType: "model_refusal",
      errorMessage: "Model refused (finishReason: refusal): anthropic:claude-fable-5",
    });
    await upsertSubagentFailureArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: workflowChildId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      workflowOwnedAncestorWorkspaceIds: [parentId],
      errorType: "model_refusal",
      errorMessage: "Model refused (finishReason: refusal): anthropic:claude-fable-5",
    });

    // task_await's scope gate must keep the failed child in scope so
    // waitForAgentReport can surface the persisted typed failure instead of
    // the await degrading to invalid_scope/not_found.
    expect(await taskService.filterDescendantAgentTaskIds(parentId, [failedChildId])).toEqual([
      failedChildId,
    ]);
    expect(await taskService.isDescendantAgentTask(parentId, failedChildId)).toBe(true);
    expect(await taskService.filterDescendantAgentTaskIds("other-parent", [failedChildId])).toEqual(
      []
    );
    expect(await taskService.isDescendantAgentTask("other-parent", failedChildId)).toBe(false);

    // End-to-end through the same call task_await makes after the scope gate.
    let awaitError: unknown;
    try {
      await taskService.waitForAgentReport(failedChildId, {
        timeoutMs: 10,
        requestingWorkspaceId: parentId,
      });
    } catch (error: unknown) {
      awaitError = error;
    }
    assert(awaitError instanceof Error, "waitForAgentReport should reject with the typed failure");
    expect(awaitError.message).toContain("Model refused (finishReason: refusal)");

    // A workflow-owned failed child stays excluded from direct task_await,
    // matching live behavior (its failure is consumed through the workflow run).
    expect(await taskService.isWorkflowOwnedDescendantAgentTask(parentId, failedChildId)).toBe(
      false
    );
    expect(await taskService.isWorkflowOwnedDescendantAgentTask(parentId, workflowChildId)).toBe(
      true
    );
  });

  test("waitForAgentReport falls back to persisted report after cache is cleared", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "ok",
      title: "t",
      nowMs: Date.now(),
    });

    await config.removeWorkspace(childId);

    // Simulate process restart / eviction.
    (
      taskService as unknown as { completedReportsByTaskId: Map<string, unknown> }
    ).completedReportsByTaskId.clear();

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10,
      requestingWorkspaceId: parentId,
    });
    expect(report.reportMarkdown).toBe("ok");
    expect(report.title).toBe("t");
  });

  test("does not request agent_report on stream end while task has active descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const descendantTaskId = "task-333";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child-task", descendantTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("does not force await or report while task-owned notify_on_terminal descendants are active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const descendantTaskId = "task-333";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
        projectWorkspace(projectPath, "child-task", descendantTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
          taskAttentionPolicy: "notify_on_terminal",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const ws = findWorkspaceInConfig(config, parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("keeps agent_report blocked while task-owned notify_on_terminal descendants are active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const descendantTaskId = "task-333";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
        projectWorkspace(projectPath, "child-task", descendantTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
          taskAttentionPolicy: "notify_on_terminal",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Premature report", title: "Too early" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Premature report" },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      await readSubagentReportArtifact(config.getSessionDir(rootWorkspaceId), parentTaskId)
    ).toBeNull();
    const ws = findWorkspaceInConfig(config, parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("does not accept agent_report while task-owned workspace turns are still active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const workspaceTurnId = "workspace-turn-child";
    const workspaceTurnHandleId = "wst_childturn";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
      workspaceId: workspaceTurnId,
      turnId: "turn-1",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    });

    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set(workspaceTurnId, {
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Premature report", title: "Too early" },
          state: "output-available",
          output: { success: true },
        },
      ],
    });

    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      parentTaskId,
      expect.stringContaining(workspaceTurnHandleId),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("does not force await or report while task-owned notify_on_terminal workspace turns are active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const workspaceTurnId = "workspace-turn-child";
    const workspaceTurnHandleId = "wst_childturn_notify";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
      ],
      testTaskSettings()
    );
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
      workspaceId: workspaceTurnId,
      turnId: "turn-1",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set(workspaceTurnId, {
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const ws = findWorkspaceInConfig(config, parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("does not force await or report while task-owned notify_on_terminal workflow runs are active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const workflowRunId = "wfr_task_notify";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentTaskId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentTaskId,
      workflow: {
        name: "child-workflow",
        description: "Child workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-19T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: config.getSessionDir(parentTaskId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const ws = findWorkspaceInConfig(config, parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("initialize does not request agent_report while task-owned notify_on_terminal work is active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const workspaceTurnId = "workspace-turn-child";
    const workspaceTurnHandleId = "wst_childturn_notify";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
      ],
      testTaskSettings()
    );
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
      workspaceId: workspaceTurnId,
      turnId: "turn-1",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set(workspaceTurnId, {
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
    });

    await taskService.initialize();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("reverts awaiting_report to running on stream end while task has active descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const descendantTaskId = "task-333";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
        projectWorkspace(projectPath, "child-task", descendantTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("rolls back created workspace when initial sendMessage fails", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "aaaaaaaaaa");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    const parentCreate = await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    expect(parentCreate.success).toBe(true);

    const parentId = "1111111111";
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings()
    );
    const { aiService } = createAIServiceMocks(config);
    const failingSendMessage = mock(() => Promise.resolve(Err("send failed")));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage: failingSendMessage });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const created = await createAgentTask(taskService, parentId, "do the thing");

    expect(created.success).toBe(false);

    const postCfg = config.loadConfigOrDefault();
    const stillExists = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .some((w) => w.id === "aaaaaaaaaa");
    expect(stillExists).toBe(false);

    const workspaceName = "agent_explore_aaaaaaaaaa";
    const workspacePath = runtime.getWorkspacePath(projectPath, workspaceName);
    let workspacePathExists = true;
    try {
      await fsPromises.access(workspacePath);
    } catch {
      workspacePathExists = false;
    }
    expect(workspacePathExists).toBe(false);
  }, 20_000);

  test("Task.create rejects variants metadata without a label", async () => {
    const config = await createTestConfig(rootDir);
    const { taskService } = createTaskServiceHarness(config);

    const created = await createAgentTask(taskService, "parent-workspace", "review frontend", {
      title: "Split review",
      bestOf: {
        groupId: "task-group-variants",
        index: 0,
        total: 2,
        kind: "variants",
      },
    });

    expect(created.success).toBe(false);
    if (created.success) {
      return;
    }
    expect(created.error).toContain("bestOf.label is required when bestOf.kind is variants");
  });

  test("agent_report posts report to parent, finalizes pending task tool output, and triggers cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage, emit } = createWorkspaceServiceMocks({ remove });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    // Seed child history with the initial prompt + assistant placeholder so committing the final
    // partial updates the existing assistant message (matching real streaming behavior).
    const childPrompt = createMuxMessage("user-child-prompt", "user", "do the thing", {
      timestamp: Date.now(),
    });
    const appendChildPrompt = await historyService.appendToHistory(childId, childPrompt);
    expect(appendChildPrompt.success).toBe(true);

    const childAssistantPlaceholder = createMuxMessage("assistant-child-partial", "assistant", "", {
      timestamp: Date.now(),
    });
    const appendChildPlaceholder = await historyService.appendToHistory(
      childId,
      childAssistantPlaceholder
    );
    expect(appendChildPlaceholder.success).toBe(true);

    const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
    if (typeof childHistorySequence !== "number") {
      throw new Error("Expected child historySequence to be a number");
    }

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: childHistorySequence },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Hello from child",
            title: "Result",
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    // Simulate stream manager committing the final partial right before natural stream end.
    const commitChildPartial = await partialService.commitPartial(childId);
    expect(commitChildPartial.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    const updatedChildPartial = await partialService.readPartial(childId);
    expect(updatedChildPartial).toBeNull();

    await collectFullHistory(historyService, parentId);

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("output-available");
      expect(toolPart?.output && typeof toolPart.output === "object").toBe(true);
      expect(JSON.stringify(toolPart?.output)).toContain("Hello from child");
    }

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws).toBeUndefined();

    expect(emit).toHaveBeenCalledWith(
      "metadata",
      expect.objectContaining({ workspaceId: childId })
    );

    const reportArtifact = await readSubagentReportArtifact(
      config.getSessionDir(parentId),
      childId
    );
    expect(reportArtifact?.reportMarkdown).toBe("Hello from child");
    expect(reportArtifact?.structuredOutput).toBeUndefined();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(childId, true);
    const childReportHandoffPrompt = (
      sendMessage as unknown as { mock: { calls: Array<[string, string]> } }
    ).mock.calls[0]?.[1];
    assert(typeof childReportHandoffPrompt === "string", "child report handoff prompt is required");
    expect(childReportHandoffPrompt).not.toContain("task_await");
    expect(sendMessage).toHaveBeenCalledWith(
      parentId,
      expect.stringContaining("sub-agent task(s) have completed"),
      expect.any(Object),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
    expect(emit).toHaveBeenCalled();
  });

  interface BestOfTestChildWorkspace {
    id: string;
    name: string;
    taskStatus: NonNullable<WorkspaceMetadata["taskStatus"]>;
    bestOf: NonNullable<WorkspaceMetadata["bestOf"]>;
    title?: string;
    createdAt?: string;
    pathName?: string;
    agentType?: string;
    agentId?: string;
  }

  async function createBestOfTaskServiceTestHarness(params: {
    parentId: string;
    children: readonly BestOfTestChildWorkspace[];
  }) {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", params.parentId),
        ...params.children.map((child) => ({
          path: path.join(projectPath, child.pathName ?? child.id),
          id: child.id,
          name: child.name,
          ...(child.title ? { title: child.title } : {}),
          parentWorkspaceId: params.parentId,
          agentType: child.agentType ?? "explore",
          ...(child.agentId ? { agentId: child.agentId } : {}),
          taskStatus: child.taskStatus,
          ...(child.createdAt ? { createdAt: child.createdAt } : {}),
          bestOf: child.bestOf,
        })),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });

    return {
      config,
      remove,
      ...createTaskServiceHarness(config, { aiService, workspaceService }),
    };
  }

  async function writePendingBestOfParentPartial(params: {
    partialService: ReturnType<typeof createTaskServiceHarness>["partialService"];
    parentId: string;
    messageId: string;
    toolCallId: string;
    title: string;
    n?: number;
    variants?: string[];
    timestamp: number;
    prompt?: string;
    additionalParts?: MuxMessage["parts"];
  }): Promise<void> {
    const parentPartial = createMuxMessage(
      params.messageId,
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: params.timestamp },
      [
        {
          type: "dynamic-tool",
          toolCallId: params.toolCallId,
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: params.prompt ?? "compare options",
            title: params.title,
            ...(params.n != null ? { n: params.n } : {}),
            ...(params.variants ? { variants: params.variants } : {}),
          },
          state: "input-available",
        },
        ...(params.additionalParts ?? []),
      ]
    );
    expect((await params.partialService.writePartial(params.parentId, parentPartial)).success).toBe(
      true
    );
  }

  function getTaskToolPart(
    message: MuxMessage | null
  ): (DynamicToolPart & { state: string; output?: unknown }) | undefined {
    return message?.parts.find((part) => isDynamicToolPart(part) && part.toolName === "task") as
      | (DynamicToolPart & { state: string; output?: unknown })
      | undefined;
  }

  function getConfiguredWorkspaceIds(config: Config): string[] {
    return Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
  }

  async function handleTaskServiceStreamEndForTest(
    taskService: TaskService,
    event: StreamEndEvent
  ): Promise<void> {
    await (
      taskService as unknown as {
        handleStreamEnd: (streamEndEvent: StreamEndEvent) => Promise<void>;
      }
    ).handleStreamEnd(event);
  }

  async function flushTerminalAttentionDrains(taskService: TaskService): Promise<void> {
    // Terminal wake-ups are delivered by an async drain; await any in-flight drains, then await
    // again in case a drain scheduled another (idempotent, settles quickly).
    for (let i = 0; i < 3; i++) {
      const drains = (
        taskService as unknown as { pendingTerminalAttentionDrains: Set<Promise<void>> }
      ).pendingTerminalAttentionDrains;
      if (drains.size === 0) break;
      await Promise.all([...drains]);
    }
  }

  async function finalizeReportedChildTaskForTest(params: {
    historyService: HistoryService;
    partialService: ReturnType<typeof createTaskServiceHarness>["partialService"];
    taskService: TaskService;
    childId: string;
    reportMarkdown: string;
    title: string;
    prompt?: string;
  }): Promise<void> {
    const childPrompt = createMuxMessage(
      `user-${params.childId}-prompt`,
      "user",
      params.prompt ?? "compare options",
      {
        timestamp: Date.now(),
      }
    );
    expect((await params.historyService.appendToHistory(params.childId, childPrompt)).success).toBe(
      true
    );

    const childAssistantPlaceholder = createMuxMessage(
      `assistant-${params.childId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now() }
    );
    expect(
      (await params.historyService.appendToHistory(params.childId, childAssistantPlaceholder))
        .success
    ).toBe(true);

    const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
    if (typeof childHistorySequence !== "number") {
      throw new Error("Expected child historySequence to be a number");
    }

    const childPartial = createMuxMessage(
      `assistant-${params.childId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: childHistorySequence },
      [
        {
          type: "dynamic-tool",
          toolCallId: `agent-report-${params.childId}`,
          toolName: "agent_report",
          input: { reportMarkdown: params.reportMarkdown, title: params.title },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: params.reportMarkdown },
      ]
    );
    expect((await params.partialService.writePartial(params.childId, childPartial)).success).toBe(
      true
    );
    expect((await params.partialService.commitPartial(params.childId)).success).toBe(true);

    await handleTaskServiceStreamEndForTest(params.taskService, {
      type: "stream-end",
      workspaceId: params.childId,
      messageId: `assistant-${params.childId}-partial`,
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });
  }

  async function upsertTestSubagentReports(params: {
    config: Config;
    parentId: string;
    reports: ReadonlyArray<{
      childTaskId: string;
      reportMarkdown: string;
      title: string;
    }>;
  }): Promise<void> {
    const parentSessionDir = params.config.getSessionDir(params.parentId);
    for (const report of params.reports) {
      await upsertSubagentReportArtifact({
        workspaceId: params.parentId,
        workspaceSessionDir: parentSessionDir,
        childTaskId: report.childTaskId,
        parentWorkspaceId: params.parentId,
        ancestorWorkspaceIds: [params.parentId],
        reportMarkdown: report.reportMarkdown,
        title: report.title,
        nowMs: Date.now(),
      });
    }
  }

  test("agent_report waits for all best-of reports before finalizing pending parent task output", async () => {
    const parentId = "parent-best-of";
    const childOneId = "child-best-of-1";
    const childTwoId = "child-best-of-2";
    const bestOf = { groupId: "best-of-group", index: 0, total: 2 } as const;

    const { config, historyService, partialService, taskService, remove } =
      await createBestOfTaskServiceTestHarness({
        parentId,
        children: [
          {
            id: childOneId,
            name: "agent_explore_child_1",
            taskStatus: "running",
            bestOf,
          },
          {
            id: childTwoId,
            name: "agent_explore_child_2",
            taskStatus: "running",
            bestOf: { ...bestOf, index: 1 },
          },
        ],
      });

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-best-of-partial",
      toolCallId: "task-best-of-call",
      title: "Best of 2",
      n: 2,
      timestamp: Date.now(),
    });

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childOneId,
      reportMarkdown: "Report from child one",
      title: "Option one",
    });

    const parentHistoryAfterFirst = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistoryAfterFirst)).not.toContain("Report from child one");

    const afterFirstParentPartial = await partialService.readPartial(parentId);
    expect(afterFirstParentPartial).not.toBeNull();
    expect(getTaskToolPart(afterFirstParentPartial)?.state).toBe("input-available");
    expect(remove).not.toHaveBeenCalled();

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childTwoId,
      reportMarkdown: "Report from child two",
      title: "Option two",
    });

    const afterSecondParentPartial = await partialService.readPartial(parentId);
    expect(afterSecondParentPartial).not.toBeNull();
    const toolPart = getTaskToolPart(afterSecondParentPartial);
    expect(toolPart?.state).toBe("output-available");
    expect(toolPart?.output && typeof toolPart.output === "object").toBe(true);
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain(childOneId);
    expect(serializedOutput).toContain(childTwoId);
    expect(serializedOutput).toContain("Report from child one");
    expect(serializedOutput).toContain("Report from child two");

    const remainingTaskIds = getConfiguredWorkspaceIds(config);
    expect(remainingTaskIds).not.toContain(childOneId);
    expect(remainingTaskIds).not.toContain(childTwoId);
  });

  test("agent_report finalizes variants parent output with labels", async () => {
    const parentId = "parent-variants";
    const childOneId = "child-variants-1";
    const childTwoId = "child-variants-2";
    const taskGroup = {
      groupId: "task-group-variants",
      index: 0,
      total: 2,
      kind: "variants",
      label: "frontend",
    } as const;

    const { historyService, partialService, taskService } =
      await createBestOfTaskServiceTestHarness({
        parentId,
        children: [
          {
            id: childOneId,
            name: "agent_explore_frontend",
            taskStatus: "running",
            bestOf: taskGroup,
          },
          {
            id: childTwoId,
            name: "agent_explore_backend",
            taskStatus: "running",
            bestOf: { ...taskGroup, index: 1, label: "backend" },
          },
        ],
      });

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-variants-partial",
      toolCallId: "task-variants-call",
      title: "Split review",
      variants: ["frontend", "backend"],
      prompt: "Review ${variant} for regressions",
      timestamp: Date.now(),
    });

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childOneId,
      reportMarkdown: "Frontend findings",
      title: "Frontend review",
      prompt: "Review frontend for regressions",
    });

    const parentPartialAfterFirst = await partialService.readPartial(parentId);
    expect(getTaskToolPart(parentPartialAfterFirst)?.state).toBe("input-available");

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childTwoId,
      reportMarkdown: "Backend findings",
      title: "Backend review",
      prompt: "Review backend for regressions",
    });

    const parentPartialAfterSecond = await partialService.readPartial(parentId);
    expect(parentPartialAfterSecond).not.toBeNull();
    const toolPart = getTaskToolPart(parentPartialAfterSecond);
    expect(toolPart?.state).toBe("output-available");
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain(childOneId);
    expect(serializedOutput).toContain(childTwoId);
    expect(serializedOutput).toContain("Frontend findings");
    expect(serializedOutput).toContain("Backend findings");
    expect(serializedOutput).toContain('"groupKind":"variants"');
    expect(serializedOutput).toContain('"label":"frontend"');
    expect(serializedOutput).toContain('"label":"backend"');
  });

  // Test exercises real config + history + partial-on-disk I/O across many
  // sequential awaits. Under CI parallel-test contention this can momentarily
  // exceed Bun's default 5s per-test timeout even though it completes in
  // ~250ms locally; bump the budget for headroom.
  test(
    "agent_report finalizes interrupted best-of parent output after partial best-of spawn failure",
    async () => {
      const parentId = "parent-best-of-partial-spawn";
      const childOneId = "child-best-of-partial-1";
      const childTwoId = "child-best-of-partial-2";
      const bestOf = { groupId: "best-of-partial-group", index: 0, total: 3 } as const;

      const { config, historyService, partialService, taskService, remove } =
        await createBestOfTaskServiceTestHarness({
          parentId,
          children: [
            {
              id: childOneId,
              name: "agent_explore_child_1",
              taskStatus: "running",
              bestOf,
            },
            {
              id: childTwoId,
              name: "agent_explore_child_2",
              taskStatus: "running",
              bestOf: { ...bestOf, index: 1 },
            },
          ],
        });

      await writePendingBestOfParentPartial({
        partialService,
        parentId,
        messageId: "assistant-parent-best-of-partial-spawn",
        toolCallId: "task-best-of-partial-call",
        title: "Best of 3",
        n: 3,
        timestamp: Date.now(),
      });

      await finalizeReportedChildTaskForTest({
        historyService,
        partialService,
        taskService,
        childId: childOneId,
        reportMarkdown: "Report from child one",
        title: "Option one",
      });

      const parentHistoryAfterFirst = await collectFullHistory(historyService, parentId);
      expect(JSON.stringify(parentHistoryAfterFirst)).not.toContain("Report from child one");

      const afterFirstParentPartial = await partialService.readPartial(parentId);
      expect(afterFirstParentPartial).not.toBeNull();
      expect(getTaskToolPart(afterFirstParentPartial)?.state).toBe("input-available");
      expect(remove).not.toHaveBeenCalled();

      await finalizeReportedChildTaskForTest({
        historyService,
        partialService,
        taskService,
        childId: childTwoId,
        reportMarkdown: "Report from child two",
        title: "Option two",
      });

      const afterSecondParentPartial = await partialService.readPartial(parentId);
      expect(afterSecondParentPartial).not.toBeNull();
      const toolPart = getTaskToolPart(afterSecondParentPartial);
      expect(toolPart?.state).toBe("output-available");
      expect(toolPart?.output && typeof toolPart.output === "object").toBe(true);
      const serializedOutput = JSON.stringify(toolPart?.output);
      expect(serializedOutput).toContain(childOneId);
      expect(serializedOutput).toContain(childTwoId);
      expect(serializedOutput).toContain("Report from child one");
      expect(serializedOutput).toContain("Report from child two");

      const remainingTaskIds = getConfiguredWorkspaceIds(config);
      expect(remainingTaskIds).not.toContain(childOneId);
      expect(remainingTaskIds).not.toContain(childTwoId);
    },
    { timeout: 15_000 }
  );

  test("agent_report avoids duplicate synthetic parent reports after grouped partial finalization", async () => {
    const parentId = "parent-best-of-no-duplicate";
    const childOneId = "child-best-of-no-duplicate-1";
    const childTwoId = "child-best-of-no-duplicate-2";
    const bestOf = { groupId: "best-of-no-duplicate-group", index: 0, total: 2 } as const;

    const { config, historyService, partialService, taskService } =
      await createBestOfTaskServiceTestHarness({
        parentId,
        children: [
          {
            id: childOneId,
            name: "agent_explore_child_1",
            taskStatus: "running",
            bestOf,
          },
          {
            id: childTwoId,
            name: "agent_explore_child_2",
            taskStatus: "running",
            bestOf: { ...bestOf, index: 1 },
          },
        ],
      });

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-best-of-no-duplicate",
      toolCallId: "task-best-of-no-duplicate-call",
      title: "Best of 2",
      n: 2,
      timestamp: Date.now(),
    });
    await upsertTestSubagentReports({
      config,
      parentId,
      reports: [
        {
          childTaskId: childTwoId,
          reportMarkdown: "Report from child two",
          title: "Option two",
        },
      ],
    });

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childOneId,
      reportMarkdown: "Report from child one",
      title: "Option one",
    });

    const afterFirstParentPartial = await partialService.readPartial(parentId);
    expect(afterFirstParentPartial).not.toBeNull();
    const toolPart = getTaskToolPart(afterFirstParentPartial);
    expect(toolPart?.state).toBe("output-available");
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain(childOneId);
    expect(serializedOutput).toContain(childTwoId);

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childTwoId,
      reportMarkdown: "Report from child two",
      title: "Option two",
    });

    const parentHistoryAfterSecond = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistoryAfterSecond)).not.toContain("<mux_subagent_report>");
    expect(JSON.stringify(parentHistoryAfterSecond)).not.toContain("Report from child two");
  });

  test("agent_report falls back to synthetic parent reports when grouped recovery cannot finish", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-fallback";
    const childOneId = "child-best-of-fallback-1";
    const childTwoId = "child-best-of-fallback-2";
    const bestOf = { groupId: "best-of-fallback-group", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-fallback-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
        {
          type: "dynamic-tool",
          toolCallId: "task-secondary-pending-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "secondary task",
            title: "Secondary task",
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const childPrompt = createMuxMessage(`user-${childOneId}-prompt`, "user", "compare options", {
      timestamp: Date.now(),
    });
    expect((await historyService.appendToHistory(childOneId, childPrompt)).success).toBe(true);

    const childAssistantPlaceholder = createMuxMessage(
      `assistant-${childOneId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now() }
    );
    expect(
      (await historyService.appendToHistory(childOneId, childAssistantPlaceholder)).success
    ).toBe(true);

    const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
    if (typeof childHistorySequence !== "number") {
      throw new Error("Expected child historySequence to be a number");
    }

    const childPartial = createMuxMessage(
      `assistant-${childOneId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: childHistorySequence },
      [
        {
          type: "dynamic-tool",
          toolCallId: `agent-report-${childOneId}`,
          toolName: "agent_report",
          input: { reportMarkdown: "Report from child one", title: "Option one" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Report from child one" },
      ]
    );
    expect((await partialService.writePartial(childOneId, childPartial)).success).toBe(true);
    expect((await partialService.commitPartial(childOneId)).success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childOneId,
      messageId: `assistant-${childOneId}-partial`,
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    const parentHistory = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("Report from child one");

    const remainingTaskIds = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
    expect(remainingTaskIds).not.toContain(childOneId);
    expect(remainingTaskIds).toContain(childTwoId);
  });

  test("interrupted best-of siblings trigger deferred fallback delivery for earlier reports", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-deferred-fallback";
    const childOneId = "child-best-of-deferred-fallback-1";
    const childTwoId = "child-best-of-deferred-fallback-2";
    const bestOf = { groupId: "best-of-deferred-fallback-group", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-deferred-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-deferred-fallback-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    async function finalizeChildReport(
      childId: string,
      reportMarkdown: string,
      title: string
    ): Promise<void> {
      const childPrompt = createMuxMessage(`user-${childId}-prompt`, "user", "compare options", {
        timestamp: Date.now(),
      });
      expect((await historyService.appendToHistory(childId, childPrompt)).success).toBe(true);

      const childAssistantPlaceholder = createMuxMessage(
        `assistant-${childId}-partial`,
        "assistant",
        "",
        { timestamp: Date.now() }
      );
      expect(
        (await historyService.appendToHistory(childId, childAssistantPlaceholder)).success
      ).toBe(true);

      const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
      if (typeof childHistorySequence !== "number") {
        throw new Error("Expected child historySequence to be a number");
      }

      const childPartial = createMuxMessage(
        `assistant-${childId}-partial`,
        "assistant",
        "",
        { timestamp: Date.now(), historySequence: childHistorySequence },
        [
          {
            type: "dynamic-tool",
            toolCallId: `agent-report-${childId}`,
            toolName: "agent_report",
            input: { reportMarkdown, title },
            state: "output-available",
            output: { success: true },
          },
          { type: "text", text: reportMarkdown },
        ]
      );
      expect((await partialService.writePartial(childId, childPartial)).success).toBe(true);
      expect((await partialService.commitPartial(childId)).success).toBe(true);

      await handleTaskServiceStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: childId,
        messageId: `assistant-${childId}-partial`,
        metadata: { model: "test-model", finishReason: "stop" },
        parts: childPartial.parts as StreamEndEvent["parts"],
      });
    }

    await finalizeChildReport(childOneId, "Report from child one", "Option one");
    const parentHistoryBeforeInterrupt = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistoryBeforeInterrupt)).not.toContain("Report from child one");

    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const childTwo = project.workspaces.find((workspace) => workspace.id === childTwoId);
        if (childTwo) {
          childTwo.taskStatus = "interrupted";
        }
      }
      return cfg;
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childTwoId,
      messageId: "assistant-child-two-interrupted",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: [],
    });
    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childTwoId,
      messageId: "assistant-child-two-interrupted-repeat",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: [],
    });

    const parentHistoryAfterInterrupt = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistoryAfterInterrupt);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("Report from child one");
    expect(serializedParentHistory.match(/child-best-of-deferred-fallback-1/g)).toHaveLength(1);
  });

  test("agent_report uses legacy exec agentType for git format-patch eligibility", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    await fsPromises.mkdir(parentPath, { recursive: true });
    await fsPromises.mkdir(childPath, { recursive: true });

    initGitRepo(childPath);
    const baseCommitSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();

    execSync("bash -lc 'echo \"world\" >> README.md'", { cwd: childPath, stdio: "ignore" });
    execSync("git add README.md", { cwd: childPath, stdio: "ignore" });
    execSync('git commit -m "child change"', { cwd: childPath, stdio: "ignore" });

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: "parent",
          runtimeConfig: { type: "local" },
        },
        {
          path: childPath,
          id: childId,
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          agentId: "explore",
          taskStatus: "running",
          runtimeConfig: { type: "local" },
          taskBaseCommitSha: baseCommitSha,
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "exec", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    const parentSessionDir = config.getSessionDir(parentId);
    const patchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId, "repo");

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    const report = await waiter;
    expect(report).toEqual({ reportMarkdown: "Hello from child", title: "Result" });

    const artifactAfterStreamEnd = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(
      artifactAfterStreamEnd?.status === "pending" || artifactAfterStreamEnd?.status === "ready"
    ).toBe(true);

    const start = Date.now();
    let lastArtifact: unknown = null;
    while (true) {
      const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
      lastArtifact = artifact;

      if (artifact?.status === "ready") {
        try {
          await fsPromises.stat(patchPath);
          break;
        } catch {
          // Keep polling until the patch file exists.
        }
      } else if (artifact?.status === "failed" || artifact?.status === "skipped") {
        throw new Error(
          `Patch artifact generation failed with status=${artifact.status}: ${
            artifact.projectArtifacts.find((projectArtifact) => projectArtifact.status === "failed")
              ?.error ?? "unknown error"
          }`
        );
      }

      if (Date.now() - start > 20_000) {
        throw new Error(
          `Timed out waiting for patch artifact generation (lastArtifact=${JSON.stringify(lastArtifact)})`
        );
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(artifact?.status).toBe("ready");

    await fsPromises.stat(patchPath);
    await waitForWorkspaceRemoval(config, childId);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(childId, true);
    expect(findWorkspaceInConfig(config, childId)).toBeUndefined();
  }, 20_000);

  test("agent_report generates mixed per-project git format-patch artifacts for multi-project exec tasks before cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const primaryProjectPath = path.join(rootDir, "project-a");
    const secondaryProjectPath = path.join(rootDir, "project-b");
    const parentId = "parent-111";
    const childId = "child-222";

    const parentPath = path.join(primaryProjectPath, "parent");
    const childWorkspacePath = path.join(rootDir, "multi-project-container");
    await fsPromises.mkdir(parentPath, { recursive: true });
    await fsPromises.mkdir(childWorkspacePath, { recursive: true });
    await fsPromises.mkdir(primaryProjectPath, { recursive: true });
    await fsPromises.mkdir(secondaryProjectPath, { recursive: true });

    initGitRepo(primaryProjectPath);
    initGitRepo(secondaryProjectPath);
    const primaryBaseCommitSha = execSync("git rev-parse HEAD", {
      cwd: primaryProjectPath,
      encoding: "utf-8",
    }).trim();
    const secondaryBaseCommitSha = execSync("git rev-parse HEAD", {
      cwd: secondaryProjectPath,
      encoding: "utf-8",
    }).trim();

    execSync("bash -lc 'echo \"secondary\" >> README.md'", {
      cwd: secondaryProjectPath,
      stdio: "ignore",
    });
    execSync("git add README.md", { cwd: secondaryProjectPath, stdio: "ignore" });
    execSync('git commit -m "secondary change"', {
      cwd: secondaryProjectPath,
      stdio: "ignore",
    });

    await saveWorkspaces(
      config,
      primaryProjectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: "parent",
          runtimeConfig: { type: "local" },
        },
        {
          path: childWorkspacePath,
          id: childId,
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          agentId: "exec",
          taskStatus: "running",
          runtimeConfig: { type: "local" },
          taskBaseCommitSha: primaryBaseCommitSha,
          taskBaseCommitShaByProjectPath: {
            [primaryProjectPath]: primaryBaseCommitSha,
            [secondaryProjectPath]: secondaryBaseCommitSha,
          },
          projects: [
            { projectPath: primaryProjectPath, projectName: "project-a" },
            { projectPath: secondaryProjectPath, projectName: "project-b" },
          ],
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "exec", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    expect((await partialService.writePartial(childId, childPartial)).success).toBe(true);

    const parentSessionDir = config.getSessionDir(parentId);
    const secondaryPatchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId, "project-b");

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    await waiter;

    const start = Date.now();
    let artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    while (artifact?.status === "pending") {
      if (Date.now() - start > 20_000) {
        throw new Error(
          `Timed out waiting for multi-project patch generation: ${JSON.stringify(artifact)}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    }

    expect(artifact?.status).toBe("ready");
    expect(artifact?.readyProjectCount).toBe(1);
    expect(artifact?.skippedProjectCount).toBe(1);
    expect(artifact?.projectArtifacts).toEqual([
      expect.objectContaining({
        projectPath: primaryProjectPath,
        projectName: "project-a",
        status: "skipped",
        commitCount: 0,
      }),
      expect.objectContaining({
        projectPath: secondaryProjectPath,
        projectName: "project-b",
        status: "ready",
        commitCount: 1,
      }),
    ]);
    await fsPromises.stat(secondaryPatchPath);
  }, 20_000);
  test("agent_report generates git format-patch artifact for exec-derived custom tasks before cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    await fsPromises.mkdir(parentPath, { recursive: true });
    await fsPromises.mkdir(childPath, { recursive: true });

    // Custom agent definition stored in the parent workspace (.mux/agents).
    const agentsDir = path.join(parentPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "test-file.md"),
      `---\nname: Test File\ndescription: Exec-derived custom agent for tests\nbase: exec\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
      "utf-8"
    );

    initGitRepo(childPath);
    const baseCommitSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();

    execSync("bash -lc 'echo \\\"world\\\" >> README.md'", { cwd: childPath, stdio: "ignore" });
    execSync("git add README.md", { cwd: childPath, stdio: "ignore" });
    execSync('git commit -m "child change"', { cwd: childPath, stdio: "ignore" });

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: "parent",
          runtimeConfig: { type: "local" },
        },
        {
          path: childPath,
          id: childId,
          name: "agent_test_file_child",
          parentWorkspaceId: parentId,
          agentType: "test-file",
          agentId: "test-file",
          taskStatus: "running",
          runtimeConfig: { type: "local" },
          taskBaseCommitSha: baseCommitSha,
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "test-file", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    const parentSessionDir = config.getSessionDir(parentId);
    const patchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId, "repo");

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    const report = await waiter;
    expect(report).toEqual({ reportMarkdown: "Hello from child", title: "Result" });

    const artifactAfterStreamEnd = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(
      artifactAfterStreamEnd?.status === "pending" || artifactAfterStreamEnd?.status === "ready"
    ).toBe(true);

    const start = Date.now();
    let lastArtifact: unknown = null;
    while (true) {
      const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
      lastArtifact = artifact;

      if (artifact?.status === "ready") {
        try {
          await fsPromises.stat(patchPath);
          break;
        } catch {
          // Keep polling until the patch file exists.
        }
      } else if (artifact?.status === "failed" || artifact?.status === "skipped") {
        throw new Error(
          `Patch artifact generation failed with status=${artifact.status}: ${
            artifact.projectArtifacts.find((projectArtifact) => projectArtifact.status === "failed")
              ?.error ?? "unknown error"
          }`
        );
      }

      if (Date.now() - start > 20_000) {
        throw new Error(
          `Timed out waiting for patch artifact generation (lastArtifact=${JSON.stringify(lastArtifact)})`
        );
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(artifact?.status).toBe("ready");

    await fsPromises.stat(patchPath);
    await waitForWorkspaceRemoval(config, childId);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(childId, true);
    expect(findWorkspaceInConfig(config, childId)).toBeUndefined();
  }, 20_000);
  test("agent_report updates queued/running task tool output in parent history", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage: sendMessageMock } = createWorkspaceServiceMocks({
      remove,
    });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentHistoryMessage = createMuxMessage(
      "assistant-parent-history",
      "assistant",
      "Spawned subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", run_in_background: true },
          state: "output-available",
          output: { status: "running", taskId: childId },
        },
      ]
    );
    const appendParentHistory = await historyService.appendToHistory(
      parentId,
      parentHistoryMessage
    );
    expect(appendParentHistory.success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    const parentMessages = await collectFullHistory(historyService, parentId);
    // Original task tool call remains immutable ("running"), and a synthetic report message is appended.
    expect(parentMessages.length).toBeGreaterThanOrEqual(2);

    const taskCallMessage = parentMessages.find((m) => m.id === "assistant-parent-history") ?? null;
    expect(taskCallMessage).not.toBeNull();
    if (taskCallMessage) {
      const toolPart = taskCallMessage.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as { output?: unknown } | undefined;
      expect(JSON.stringify(toolPart?.output)).toContain('"status":"running"');
      expect(JSON.stringify(toolPart?.output)).toContain(childId);
    }

    const syntheticReport = parentMessages.find((m) => m.metadata?.synthetic) ?? null;
    expect(syntheticReport).not.toBeNull();
    if (syntheticReport) {
      expect(syntheticReport.role).toBe("user");
      const text = syntheticReport.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(text).toContain("Hello from child");
      expect(text).toContain(childId);
    }

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(childId, true);
    const fallbackHandoffPrompt = (
      sendMessageMock as unknown as { mock: { calls: Array<[string, string]> } }
    ).mock.calls[0]?.[1];
    assert(typeof fallbackHandoffPrompt === "string", "fallback handoff prompt is required");
    expect(fallbackHandoffPrompt).not.toContain("task_await");
    expect(sendMessageMock).toHaveBeenCalledWith(
      parentId,
      expect.stringContaining("sub-agent task(s) have completed"),
      expect.any(Object),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("stream-end with agent_report parts finalizes report and triggers cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ],
    });

    // No "agent_report reminder" sendMessage should fire (the report was in stream-end parts).
    // The only sendMessage call should be the parent auto-resume after the child reports.
    const sendCalls = (sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of sendCalls) {
      const msg = call[1] as string;
      expect(msg).not.toContain("agent_report");
    }

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("output-available");
      const outputJson = JSON.stringify(toolPart?.output);
      expect(outputJson).toContain("Hello from child");
      expect(outputJson).toContain("Result");
      expect(outputJson).not.toContain("fallback");
    }

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws).toBeUndefined();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(childId, true);
    // Parent auto-resume fires after the child report is finalized at stream-end.
    expect(sendMessage).toHaveBeenCalled();
  });

  test("agent_report attributes child usage to parent goal and emits one child-budget toast", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-goal-report";
    const childUnderId = "child-under-budget";
    const childOverId = "child-over-budget";
    const childModel = "openai:gpt-4o-mini";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child-under", childUnderId, {
          name: "agent_explore_under",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: childModel,
        }),
        projectWorkspace(projectPath, "child-over", childOverId, {
          name: "agent_explore_over",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: childModel,
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, emitChatEvent } = createWorkspaceServiceMocks({ remove });
    const historyService = new HistoryService(config);
    const sessionUsageService = new SessionUsageService(config, historyService);
    const extensionMetadata = new ExtensionMetadataService(
      path.join(rootDir, "task-report-goals-extensionMetadata.json")
    );
    const workspaceGoalService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata
    );
    workspaceGoalService.registerGoalContinuationConsumer(new IdleDispatcher(), {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: () => Promise.resolve(true),
    });
    const goalResult = await workspaceGoalService.setGoal({
      workspaceId: parentId,
      objective: "Parent budget",
      budgetCents: 100,
    });
    expect(goalResult.success).toBe(true);

    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
      sessionUsageService,
      workspaceGoalService,
    });
    async function finishChildReport(input: {
      workspaceId: string;
      costUsd: number;
      messageId: string;
      toolCallId: string;
      reportMarkdown: string;
      title: string;
    }): Promise<void> {
      await sessionUsageService.recordUsage(input.workspaceId, childModel, {
        input: { tokens: 100, cost_usd: input.costUsd },
        cached: { tokens: 0, cost_usd: 0 },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 0, cost_usd: 0 },
        reasoning: { tokens: 0, cost_usd: 0 },
        model: childModel,
      });
      await handleTaskServiceStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: input.workspaceId,
        messageId: input.messageId,
        metadata: { model: childModel, finishReason: "stop" },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: input.toolCallId,
            toolName: "agent_report",
            input: { reportMarkdown: input.reportMarkdown, title: input.title },
            state: "output-available",
            output: { success: true },
          },
          { type: "text", text: input.reportMarkdown },
        ],
      });
    }

    await finishChildReport({
      workspaceId: childUnderId,
      costUsd: 0.37,
      messageId: "assistant-child-under",
      toolCallId: "agent-report-under",
      reportMarkdown: "Under budget",
      title: "Under",
    });

    expect(await workspaceGoalService.getGoal(parentId)).toMatchObject({
      status: "active",
      costCents: 37,
      turnsUsed: 1,
      attributedChildren: [childUnderId],
    });
    expect(emitChatEvent).not.toHaveBeenCalledWith(
      parentId,
      expect.objectContaining({ type: "goal-budget-limited" })
    );

    await finishChildReport({
      workspaceId: childOverId,
      costUsd: 0.75,
      messageId: "assistant-child-over",
      toolCallId: "agent-report-over",
      reportMarkdown: "Over budget",
      title: "Over",
    });

    expect(await workspaceGoalService.getGoal(parentId)).toMatchObject({
      status: "budget_limited",
      costCents: 112,
      turnsUsed: 2,
      attributedChildren: [childUnderId, childOverId],
    });
    expect(emitChatEvent).toHaveBeenCalledTimes(1);
    expect(emitChatEvent).toHaveBeenCalledWith(
      parentId,
      expect.objectContaining({
        type: "goal-budget-limited",
        causedByChild: true,
        childWorkspaceId: childOverId,
        message: "Child workspace exceeded the parent's goal budget.",
      })
    );
  });

  test("task stream-end waits for task-local background workflows before final report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-workflow-wait";
    const childId = "child-workflow-wait";
    const workflowRunId = "wfr_child_active";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(childId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: childId,
      workflow: {
        name: "child-workflow",
        description: "Child workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: config.getSessionDir(childId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Premature report", title: "Premature" },
          state: "output-available",
          output: { success: true },
        },
      ],
    });

    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining(workflowRunId),
      expect.objectContaining({ model: "openai:gpt-4o-mini", agentId: "exec" }),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
  });

  test("task stream-end waits for completed task-local workflows before final report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-workflow-completed-wait";
    const childId = "child-workflow-completed-wait";
    const workflowRunId = "wfr_child_completed";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(childId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: childId,
      workflow: {
        name: "child-workflow",
        description: "Child workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await runStore.appendStatus(workflowRunId, "completed", "2026-06-04T00:00:02.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: config.getSessionDir(childId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage, isWorkflowInvocationCurrent } =
      createWorkspaceServiceMocks({
        remove,
      });
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Premature report", title: "Premature" },
          state: "output-available",
          output: { success: true },
        },
      ],
    });

    expect(isWorkflowInvocationCurrent).toHaveBeenCalledWith(childId, workflowRunId);
    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining(workflowRunId),
      expect.objectContaining({ model: "openai:gpt-4o-mini", agentId: "exec" }),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
  });

  test.each(["workflow_run", "workflow_resume"] as const)(
    "task stream-end accepts terminal %s output before final report",
    async (toolName) => {
      const config = await createTestConfig(rootDir);

      const projectPath = path.join(rootDir, "repo");
      const parentId = `parent-terminal-${toolName}`;
      const childId = `child-terminal-${toolName}`;
      const workflowRunId = `wfr_terminal_${toolName}`;

      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "parent", parentId),
          projectWorkspace(projectPath, "child", childId, {
            name: "agent_explore_child",
            parentWorkspaceId: parentId,
            agentType: "explore",
            taskStatus: "awaiting_report",
            taskModelString: "openai:gpt-4o-mini",
          }),
        ],
        testTaskSettings()
      );

      const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(childId) });
      await runStore.createRun({
        id: workflowRunId,
        workspaceId: childId,
        workflow: {
          name: "child-workflow",
          description: "Child workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        now: "2026-06-04T00:00:00.000Z",
      });
      await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
      await runStore.appendStatus(workflowRunId, "completed", "2026-06-04T00:00:02.000Z");

      const { aiService } = createAIServiceMocks(config);
      const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
        await removeWorkspaceFromTestConfig(config, workspaceId);
        return Ok(undefined);
      });
      const { workspaceService, sendMessage, isWorkflowInvocationCurrent } =
        createWorkspaceServiceMocks({ remove });
      const { taskService } = createTaskServiceHarness(config, {
        aiService,
        workspaceService,
      });

      await handleTaskServiceStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: childId,
        messageId: `assistant-${toolName}-output`,
        metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: `${toolName}-call-1`,
            toolName,
            input:
              toolName === "workflow_run"
                ? { script_path: "skill://test/workflow.js", run_in_background: false }
                : { run_id: workflowRunId, run_in_background: false, mode: "resume" },
            state: "output-available",
            output: {
              status: "completed",
              runId: workflowRunId,
              result: { reportMarkdown: "Workflow done" },
            },
          },
          {
            type: "dynamic-tool",
            toolCallId: "agent-report-call-1",
            toolName: "agent_report",
            input: { reportMarkdown: "Progress report", title: "Progress" },
            state: "output-available",
            output: { success: true },
          },
          { type: "text", text: "Final report" },
        ],
      });

      expect(isWorkflowInvocationCurrent).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalledWith(
        childId,
        expect.stringContaining(workflowRunId),
        expect.any(Object),
        expect.any(Object)
      );
      expect(remove).toHaveBeenCalledWith(childId, true);
    }
  );

  test("handleStreamEnd finalizes report when task status is interrupted", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const isStreaming = mock((workspaceId: string): boolean => workspaceId === childId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      completedReportsByTaskId: Map<string, unknown>;
    };

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Interrupted child report", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Interrupted child report" },
      ],
    });

    const report = await waiter;
    expect(report).toEqual({
      reportMarkdown: "Interrupted child report",
      title: "Result",
      model: "openai:gpt-4o-mini",
    });

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("reported");

    // Validate report persistence path (not just in-memory cache).
    internal.completedReportsByTaskId.clear();
    const persisted = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });
    expect(persisted).toEqual({
      reportMarkdown: "Interrupted child report",
      title: "Result",
      model: "openai:gpt-4o-mini",
    });
  });

  test("handleStreamEnd rejects waiters when interrupted task stream ends without report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    let childStreaming = true;
    const isStreaming = mock(
      (workspaceId: string): boolean => workspaceId === childId && childStreaming
    );
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const waiter = taskService
      .waitForAgentReport(childId, {
        timeoutMs: 10_000,
        requestingWorkspaceId: parentId,
      })
      .catch((error: unknown) => error);

    childStreaming = false;

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    const waiterError = await waiter;
    expect(waiterError).toBeInstanceOf(Error);
    if (waiterError instanceof Error) {
      expect(waiterError.message).toMatch(/Task interrupted/);
      expect(waiterError.message).not.toMatch(/Timed out/);
    }
  });

  test("handleStreamEnd interrupts workflow-owned tasks when owning workflow is already interrupted", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-stream-workflow-interrupted";
    const childId = "child-stream-workflow-interrupted";
    const workflowRunId = "wfr_stream_interrupted_owner";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "slow-step" },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "interrupted",
        description: "Interrupted",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "interrupted", "2026-05-29T00:00:01.000Z");

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const maybeStartQueuedTasks = spyOn(
      taskService as unknown as { maybeStartQueuedTasks: () => Promise<void> },
      "maybeStartQueuedTasks"
    ).mockResolvedValue(undefined);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("interrupted");
    expect(maybeStartQueuedTasks).toHaveBeenCalledTimes(1);
  });

  test("agent_report wakes the parent repeatedly without completing the subagent", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-progress";
    const childId = "child-progress";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_review_child",
          parentWorkspaceId: parentId,
          agentType: "review",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.reportAgentProgress(childId, "progress-1", {
      reportMarkdown: "Found a correctness issue.",
      title: "Finding",
    });
    await taskService.reportAgentProgress(childId, "progress-2", {
      reportMarkdown: "Found a second issue.",
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      parentId,
      expect.stringContaining("Found a correctness issue."),
      expect.any(Object),
      expect.objectContaining({
        synthetic: true,
        agentInitiated: true,
        startStreamInBackground: true,
        queueDedupeKey: "agent-report:child-progress:progress-1",
        foregroundWaitInterruption: {
          reason: "progress_report_received",
          sourceTaskId: childId,
          report: {
            agentType: "review",
            title: "Finding",
            reportMarkdown: "Found a correctness issue.",
            model: "openai:gpt-4o-mini",
          },
        },
      })
    );
    expect(sendMessage.mock.calls[0]?.[1]).toContain('"status": "in_progress"');
    expect(sendMessage.mock.calls[1]?.[1]).toContain("Found a second issue.");
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
    expect(await readSubagentReportArtifact(config.getSessionDir(parentId), childId)).toBeNull();
  });

  test("terminal report becomes a visible card after embedded progress was answered", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-progress-terminal-card";
    const childId = "child-progress-terminal-card";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskAttentionPolicy: "notify_on_terminal",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage, emitChatEvent } = createWorkspaceServiceMocks();
    const aiMocks = createAIServiceMocks(config, {
      isStreaming: mock(() => true),
      getStreamInfo: mock(() => ({
        messageId: "parent-active-assistant",
        model: "openai:gpt-5",
        historySequence: 9,
        startTime: 1,
        parts: [
          { type: "reasoning" as const, text: "reasoning " },
          { type: "reasoning" as const, text: "before report" },
        ],
        toolCompletionTimestamps: new Map(),
      })),
    });
    const { historyService, taskService } = createTaskServiceHarness(config, {
      workspaceService,
      aiService: aiMocks.aiService,
    });
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("accepted-progress", "assistant", "", { timestamp: Date.now() }, [
        {
          type: "dynamic-tool",
          toolCallId: "accepted-progress-task",
          toolName: "task",
          state: "output-available",
          input: {
            subagent_type: "explore",
            prompt: "Investigate the issue.",
            title: "Investigate",
            run_in_background: false,
          },
          output: {
            status: "running",
            taskId: childId,
            interruption: {
              reason: "progress_report_received",
              sourceTaskId: childId,
              report: {
                agentType: "explore",
                title: "Progress",
                reportMarkdown: "Initial investigation complete.",
              },
            },
            note: "Foreground wait paused because a queued message needs attention.",
          },
        },
      ])
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("progress-answer", "assistant", "I incorporated the progress update.", {
        timestamp: Date.now(),
      })
    );

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-terminal-report",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "Final investigation result." }],
    });
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).not.toHaveBeenCalled();
    const parentHistory = await collectFullHistory(historyService, parentId);
    const completedReport = parentHistory.find((message) => {
      const text = message.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const report = parseSubagentReportEnvelope(text);
      return report?.taskId === childId && report.status === "completed";
    });
    expect(completedReport?.metadata).toMatchObject({
      synthetic: true,
      uiVisible: true,
      transcriptAnchor: {
        messageId: "parent-active-assistant",
        historySequence: 9,
        textLength: 0,
        reasoningLength: 23,
        partIndex: 1,
      },
    });
    expect(emitChatEvent).toHaveBeenCalledTimes(1);
    expect(emitChatEvent.mock.calls[0]?.[1]).toMatchObject({
      id: completedReport?.id,
      metadata: { transcriptAnchor: completedReport?.metadata?.transcriptAnchor },
    });
  });

  test("terminal reports supersede queued incremental updates for the same child", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-queued-progress";
    const childId = "child-queued-progress";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const removeQueuedMessagesByDedupeKeyPrefix = mock((): Result<number> => Ok(1));
    const { workspaceService } = createWorkspaceServiceMocks();
    workspaceService.removeQueuedMessagesByDedupeKeyPrefix = removeQueuedMessagesByDedupeKeyPrefix;
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-final",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "Terminal result" }],
    });

    expect(removeQueuedMessagesByDedupeKeyPrefix).toHaveBeenCalledWith(
      parentId,
      `agent-report:${childId}:`,
      { cancelReason: "Incremental sub-agent update superseded by the terminal report." }
    );
  });

  test("workflow-owned agent_report updates do not wake the parent", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-workflow-progress";
    const childId = "child-workflow-progress";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_progress", stepId: "collect", outputSchema: {} },
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.reportAgentProgress(childId, "workflow-progress", {
      reportMarkdown: "Structured workflow update submitted.",
      structuredOutput: { claims: ["verified"] },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
  });

  test("non-plan subagent stream-end with final assistant text finalizes an implicit report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-progress-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Early finding", title: "Finding" },
          state: "output-available",
          output: { success: true },
        },
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-progress-2",
          toolName: "agent_report",
          input: { reportMarkdown: "Later finding", title: "Latest update" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "## Final answer\n\nImplicit report content from the child." },
      ],
    });

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("output-available");
      const outputJson = JSON.stringify(toolPart?.output);
      expect(outputJson).toContain("Implicit report content from the child.");
      expect(outputJson).not.toContain("fallback");
    }

    const report = await readSubagentReportArtifact(config.getSessionDir(parentId), childId);
    expect(report?.reportMarkdown).toBe(
      "## Final answer\n\nImplicit report content from the child."
    );
    expect(report?.title).toBe("Latest update");

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws).toBeUndefined();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(childId, true);
    const sendCalls = (sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of sendCalls) {
      const msg = call[1] as string;
      expect(msg).not.toContain("agent_report");
    }
  });

  test("workflow subagent reuses structured agent_report metadata from an earlier turn", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-structured-history";
    const childId = "child-structured-history";
    const workflowRunId = "wfr_structured_history";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["claims"],
              properties: { claims: { type: "array", items: { type: "string" } } },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "structured-history",
        description: "Structured history",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const progressMessage = createMuxMessage(
      "assistant-progress",
      "assistant",
      "",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-progress",
          toolName: "agent_report",
          input: { claims: ["persisted"] },
          state: "output-available",
          output: { success: true },
        },
      ]
    );
    expect((await historyService.appendToHistory(childId, progressMessage)).success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "## Final answer\n\nFinal prose after an earlier update." }],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const report = await readSubagentReportArtifact(config.getSessionDir(parentId), childId);
    expect(report?.reportMarkdown).toBe("## Final answer\n\nFinal prose after an earlier update.");
    expect(report?.structuredOutput).toEqual({ claims: ["persisted"] });
  });

  test("workflow subagent uses agent_report metadata with the final assistant response", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-structured-text";
    const childId = "child-structured-text";
    const workflowRunId = "wfr_structured_text";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["claims"],
              properties: { claims: { type: "array", items: { type: "string" } } },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "structured-text",
        description: "Structured text",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-structured",
          toolName: "agent_report",
          input: { claims: ["verified"] },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "## Final answer\n\nThis prose is the final workflow summary." },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(config.getSessionDir(parentId), childId);
    expect(report?.reportMarkdown).toBe(
      "## Final answer\n\nThis prose is the final workflow summary."
    );
    expect(report?.structuredOutput).toEqual({ claims: ["verified"] });
  });

  test("failed final workflow agent_report does not reuse stale structured output", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-stale-structured";
    const childId = "child-stale-structured";
    const workflowRunId = "wfr_stale_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "stale-structured",
        description: "Stale structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    expect(
      (
        await historyService.appendToHistory(
          childId,
          createMuxMessage("assistant-progress", "assistant", "", { timestamp: Date.now() }, [
            {
              type: "dynamic-tool",
              toolCallId: "agent-report-old",
              toolName: "agent_report",
              input: { claims: ["stale"] },
              state: "output-available",
              output: { success: true },
            },
          ])
        )
      ).success
    ).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-failed",
          toolName: "agent_report",
          input: { claims: [1] },
          state: "output-available",
          output: {
            success: false,
            message: "Structured output failed schema validation.",
            errors: [{ path: "$.claims[0]", message: "must be string" }],
          },
        },
        { type: "text", text: "Final summary should not reuse stale output." },
      ],
    });

    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(await readSubagentReportArtifact(config.getSessionDir(parentId), childId)).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("First call agent_report"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
  });

  test("failed newer in-turn workflow agent_report invalidates an earlier success", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-in-turn-stale-structured";
    const childId = "child-in-turn-stale-structured";
    const workflowRunId = "wfr_in_turn_stale_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "in-turn-stale-structured",
        description: "In-turn stale structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-success",
          toolName: "agent_report",
          input: { claims: ["stale"] },
          state: "output-available",
          output: { success: true },
        },
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-failed",
          toolName: "agent_report",
          input: { claims: [1] },
          state: "output-available",
          output: {
            success: false,
            message: "Structured output failed schema validation.",
            errors: [{ path: "$.claims[0]", message: "must be string" }],
          },
        },
        { type: "text", text: "Final summary after failed replacement." },
      ],
    });

    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(await readSubagentReportArtifact(config.getSessionDir(parentId), childId)).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("First call agent_report"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
  });

  test("newer valid in-turn workflow agent_report corrects an earlier failure", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-corrected-structured";
    const childId = "child-corrected-structured";
    const workflowRunId = "wfr_corrected_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "corrected-structured",
        description: "Corrected structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-failed",
          toolName: "agent_report",
          input: { claims: [1] },
          state: "output-available",
          output: {
            success: false,
            message: "Structured output failed schema validation.",
            errors: [{ path: "$.claims[0]", message: "must be string" }],
          },
        },
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-corrected",
          toolName: "agent_report",
          input: { claims: ["corrected"] },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Final summary after correcting structured output." },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const report = await readSubagentReportArtifact(config.getSessionDir(parentId), childId);
    expect(report?.reportMarkdown).toBe("Final summary after correcting structured output.");
    expect(report?.structuredOutput).toEqual({ claims: ["corrected"] });
  });

  test("recovery final text does not scan past a failed workflow agent_report", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-recovery-stale-structured";
    const childId = "child-recovery-stale-structured";
    const workflowRunId = "wfr_recovery_stale_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "recovery-stale-structured",
        description: "Recovery stale structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    for (const message of [
      createMuxMessage("assistant-old-progress", "assistant", "", { timestamp: Date.now() - 2 }, [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-old",
          toolName: "agent_report",
          input: { claims: ["stale"] },
          state: "output-available",
          output: { success: true },
        },
      ]),
      createMuxMessage(
        "assistant-failed-progress",
        "assistant",
        "",
        { timestamp: Date.now() - 1 },
        [
          {
            type: "dynamic-tool",
            toolCallId: "agent-report-failed",
            toolName: "agent_report",
            input: { claims: [1] },
            state: "output-available",
            output: {
              success: false,
              message: "Structured output failed schema validation.",
              errors: [{ path: "$.claims[0]", message: "must be string" }],
            },
          },
        ]
      ),
    ]) {
      expect((await historyService.appendToHistory(childId, message)).success).toBe(true);
    }

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-recovery-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "Recovery final text without a fresh structured report." }],
    });

    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(await readSubagentReportArtifact(config.getSessionDir(parentId), childId)).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("First call agent_report"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
  });

  test("workflow subagent invalid structured agent_report does not finalize", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-invalid-structured";
    const childId = "child-invalid-structured";
    const workflowRunId = "wfr_invalid_structured";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["claims"],
              properties: { claims: { type: "array", items: { type: "string" } } },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "invalid-structured",
        description: "Invalid structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Done",
            structuredOutput: { claims: [1] },
            title: null,
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Final summary with invalid structured metadata." },
      ],
    });

    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("The previous final assistant response attempt failed"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(await readSubagentReportArtifact(config.getSessionDir(parentId), childId)).toBeNull();
  });

  test("legacy workflow subagent with invalid old outputSchema can finalize markdown-only report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-legacy-invalid-schema";
    const childId = "child-legacy-invalid-schema";
    const workflowRunId = "wfr_legacy_invalid_schema";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: { $ref: "#/defs/pre-upgrade" },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "legacy-invalid-schema",
        description: "Legacy invalid schema",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Legacy report",
            title: null,
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Legacy report" },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(config.getSessionDir(parentId), childId);
    expect(report?.reportMarkdown).toBe("Legacy report");
    expect(report?.structuredOutput).toBeUndefined();
  });

  test("legacy invalid workflow schemas recover with a final response instead of structured agent_report", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-legacy-invalid-recovery";
    const childId = "child-legacy-invalid-recovery";
    const workflowRunId = "wfr_legacy_invalid_recovery";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: { $ref: "#/defs/pre-upgrade" },
          },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "legacy-invalid-recovery",
        description: "Legacy invalid recovery",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      promptTaskForRequiredCompletionTool: (workspaceId: string) => Promise<boolean>;
    };

    expect(await internal.promptTaskForRequiredCompletionTool(childId)).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("respond with your final assistant message"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain("First call agent_report");
  });

  test("workflow subagent treats strict-provider null optional fields as omitted", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-optional-null-structured";
    const childId = "child-optional-null-structured";
    const workflowRunId = "wfr_optional_null_structured";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["code", "nested"],
              properties: {
                code: { type: "string" },
                notes: { type: "string" },
                nullableNote: { type: ["string", "null"] },
                nested: {
                  type: "object",
                  required: ["id"],
                  properties: {
                    id: { type: "string" },
                    detail: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "optional-null-structured",
        description: "Optional null structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            code: "ABC",
            notes: null,
            nullableNote: null,
            nested: { id: "nested-1", detail: null },
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Optional fields normalized." },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(config.getSessionDir(parentId), childId);
    expect(report?.structuredOutput).toEqual({
      code: "ABC",
      nullableNote: null,
      nested: { id: "nested-1" },
    });
  });

  test("workflow subagent accepts direct schema-shaped report for object schema", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-missing-structured";
    const childId = "child-missing-structured";
    const workflowRunId = "wfr_missing_structured";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: { type: "object" },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "missing-structured",
        description: "Missing structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Done",
            title: null,
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Done" },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(config.getSessionDir(parentId), childId);
    expect(report?.reportMarkdown).toBe("Done");
    expect(report?.structuredOutput).toEqual({ reportMarkdown: "Done", title: null });
  });

  test("length-truncated final assistant text still requires explicit agent_report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "length" },
      parts: [{ type: "text", text: "Partial final-looking text that was cut off" }],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("awaiting_report");
  });

  test("missing agent_report keeps the task awaiting_report and retries with agent_report-only prompts", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      childId,
      expect.stringContaining("Do not continue investigating or call other tools"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("awaiting_report");

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("input-available");
      expect(toolPart?.output).toBeUndefined();
    }

    const report = await readSubagentReportArtifact(config.getSessionDir(parentId), childId);
    expect(report).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  test("parent stream-end rechecks cleanup for reported best-of children", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-cleanup-recheck";
    const childOneId = "child-best-of-cleanup-recheck-1";
    const childTwoId = "child-best-of-cleanup-recheck-2";
    const bestOf = { groupId: "best-of-cleanup-recheck", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentId,
      messageId: "assistant-parent-cleanup-recheck",
      metadata: { model: "test-model" },
      parts: [],
    });

    const parentHistory = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistory)).not.toContain("<mux_subagent_report>");

    const remainingTaskIds = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
    expect(remainingTaskIds).not.toContain(childOneId);
    expect(remainingTaskIds).not.toContain(childTwoId);

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith(childOneId, true);
    expect(remove).toHaveBeenCalledWith(childTwoId, true);
  });

  test("parent stream-end targets the pending best-of group when older groups still exist", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-pending-group-target";
    const staleChildOneId = "child-best-of-pending-group-target-stale-1";
    const staleChildTwoId = "child-best-of-pending-group-target-stale-2";
    const currentChildOneId = "child-best-of-pending-group-target-current-1";
    const currentChildTwoId = "child-best-of-pending-group-target-current-2";
    const partialTimestamp = Date.now();
    const staleCreatedAt = new Date(partialTimestamp - 60_000).toISOString();
    const currentCreatedAt = new Date(partialTimestamp + 60_000).toISOString();

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "stale-1", staleChildOneId, {
          name: "agent_explore_stale_1",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: staleCreatedAt,
          bestOf: { groupId: "best-of-stale-group", index: 0, total: 2 },
        }),
        projectWorkspace(projectPath, "stale-2", staleChildTwoId, {
          name: "agent_explore_stale_2",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: staleCreatedAt,
          bestOf: { groupId: "best-of-stale-group", index: 1, total: 2 },
        }),
        projectWorkspace(projectPath, "current-1", currentChildOneId, {
          name: "agent_explore_current_1",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf: { groupId: "best-of-current-group", index: 0, total: 2 },
        }),
        projectWorkspace(projectPath, "current-2", currentChildTwoId, {
          name: "agent_explore_current_2",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf: { groupId: "best-of-current-group", index: 1, total: 2 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-pending-group-target",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: partialTimestamp },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-pending-group-target-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    for (const [childTaskId, reportMarkdown, title] of [
      [staleChildOneId, "Stale report one", "Stale option one"],
      [staleChildTwoId, "Stale report two", "Stale option two"],
      [currentChildOneId, "Current report one", "Current option one"],
      [currentChildTwoId, "Current report two", "Current option two"],
    ] as const) {
      await upsertSubagentReportArtifact({
        workspaceId: parentId,
        workspaceSessionDir: config.getSessionDir(parentId),
        childTaskId,
        parentWorkspaceId: parentId,
        ancestorWorkspaceIds: [parentId],
        reportMarkdown,
        title,
        nowMs: Date.now(),
      });
    }

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentId,
      messageId: "assistant-parent-pending-group-target",
      metadata: { model: "test-model" },
      parts: [],
    });

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (part) => isDynamicToolPart(part) && part.toolName === "task"
      ) as (DynamicToolPart & { state: string; output?: unknown }) | undefined;
      expect(toolPart?.state).toBe("output-available");
      const outputJson = JSON.stringify(toolPart?.output);
      expect(outputJson).toContain(currentChildOneId);
      expect(outputJson).toContain(currentChildTwoId);
      expect(outputJson).toContain("Current report one");
      expect(outputJson).toContain("Current report two");
      expect(outputJson).not.toContain(staleChildOneId);
      expect(outputJson).not.toContain(staleChildTwoId);
      expect(outputJson).not.toContain("Stale report one");
      expect(outputJson).not.toContain("Stale report two");
    }
  });

  test("parent stream-end ignores a stale single best-of group that predates the pending partial", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-stale-single-group";
    const childOneId = "child-best-of-stale-single-group-1";
    const childTwoId = "child-best-of-stale-single-group-2";
    const partialTimestamp = Date.now();
    const staleCreatedAt = new Date(partialTimestamp - 60_000).toISOString();
    const bestOf = { groupId: "best-of-stale-single-group", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: staleCreatedAt,
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          title: "Best of 2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: staleCreatedAt,
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-stale-single-group",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: partialTimestamp },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-stale-single-group-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const parentSessionDir = config.getSessionDir(parentId);
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Stale report one",
      title: "Stale option one",
      nowMs: Date.now(),
    });
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childTwoId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Stale report two",
      title: "Stale option two",
      nowMs: Date.now(),
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentId,
      messageId: "assistant-parent-stale-single-group",
      metadata: { model: "test-model" },
      parts: [],
    });

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (part) => isDynamicToolPart(part) && part.toolName === "task"
      ) as (DynamicToolPart & { state: string; output?: unknown }) | undefined;
      expect(toolPart?.state).toBe("input-available");
      expect(toolPart?.output).toBeUndefined();
    }

    const parentHistory = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).not.toContain("<mux_subagent_report>");
    expect(serializedParentHistory).not.toContain("Stale report one");
    expect(serializedParentHistory).not.toContain("Stale report two");
  });

  test("parent stream-end finalizes ready best-of partials before cleanup rechecks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-finalize-ready";
    const childOneId = "child-best-of-finalize-ready-1";
    const childTwoId = "child-best-of-finalize-ready-2";
    const partialTimestamp = Date.now();
    const currentCreatedAt = new Date(partialTimestamp + 60_000).toISOString();
    const bestOf = { groupId: "best-of-finalize-ready", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-finalize-ready",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: partialTimestamp },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-finalize-ready-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const parentSessionDir = config.getSessionDir(parentId);
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child one",
      title: "Option one",
      nowMs: Date.now(),
    });
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childTwoId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child two",
      title: "Option two",
      nowMs: Date.now(),
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentId,
      messageId: "assistant-parent-finalize-ready",
      metadata: { model: "test-model" },
      parts: [],
    });

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("output-available");
      const outputJson = JSON.stringify(toolPart?.output);
      expect(outputJson).toContain(childOneId);
      expect(outputJson).toContain(childTwoId);
      expect(outputJson).toContain("Report from child one");
      expect(outputJson).toContain("Report from child two");
    }

    const remainingTaskIds = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
    expect(remainingTaskIds).not.toContain(childOneId);
    expect(remainingTaskIds).not.toContain(childTwoId);

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith(childOneId, true);
    expect(remove).toHaveBeenCalledWith(childTwoId, true);
  });

  test("concurrent deferred best-of fallback delivery does not duplicate synthetic reports", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-concurrent-deferred-fallback";
    const childOneId = "child-best-of-concurrent-deferred-fallback-1";
    const childTwoId = "child-best-of-concurrent-deferred-fallback-2";
    const childThreeId = "child-best-of-concurrent-deferred-fallback-3";
    const bestOf = {
      groupId: "best-of-concurrent-deferred-fallback-group",
      index: 0,
      total: 3,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
        projectWorkspace(projectPath, "child-3", childThreeId, {
          name: "agent_explore_child_3",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 2 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-concurrent-deferred-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-concurrent-deferred-fallback-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 3",
            n: 3,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child one",
      title: "Option one",
      structuredOutput: { score: 1 },
      nowMs: Date.now(),
    });

    const internal = taskService as unknown as {
      deliverDeferredBestOfSiblingReports: (params: {
        parentWorkspaceId: string;
        groupId: string;
        total: number;
      }) => Promise<void>;
    };

    await Promise.all([
      internal.deliverDeferredBestOfSiblingReports({
        parentWorkspaceId: parentId,
        groupId: bestOf.groupId,
        total: bestOf.total,
      }),
      internal.deliverDeferredBestOfSiblingReports({
        parentWorkspaceId: parentId,
        groupId: bestOf.groupId,
        total: bestOf.total,
      }),
    ]);

    const parentHistory = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("Report from child one");
    expect(serializedParentHistory).toContain("structuredOutput");
    expect(serializedParentHistory).toContain("score");
    expect(
      serializedParentHistory.match(/child-best-of-concurrent-deferred-fallback-1/g)
    ).toHaveLength(1);
  });

  test("deferred fallback honors partial task outputs carrying unknown future fields", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-future-fields-fallback";
    const childOneId = "child-best-of-future-fields-fallback-1";
    const childTwoId = "child-best-of-future-fields-fallback-2";
    const childThreeId = "child-best-of-future-fields-fallback-3";
    const bestOf = {
      groupId: "best-of-future-fields-fallback-group",
      index: 0,
      total: 3,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
        projectWorkspace(projectPath, "child-3", childThreeId, {
          name: "agent_explore_child_3",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 2 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    // An output written by a newer release: extra fields fail the strict result schema, but
    // the referenced-task bookkeeping must still see these IDs or recovery would append a
    // duplicate fallback report after a downgrade.
    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-future-fields-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-future-fields-fallback-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 3",
            n: 3,
          },
          state: "output-available",
          output: {
            status: "running",
            taskIds: [childOneId, childTwoId, childThreeId],
            tasks: [
              { taskId: childOneId, status: "completed", futureRowField: "x" },
              { taskId: childTwoId, status: "running" },
              { taskId: childThreeId, status: "running" },
            ],
            note: "use task_await to monitor progress",
            futureTopLevelField: "y",
          },
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child one",
      title: "Option one",
      nowMs: Date.now(),
    });

    const internal = taskService as unknown as {
      deliverDeferredBestOfSiblingReports: (params: {
        parentWorkspaceId: string;
        groupId: string;
        total: number;
      }) => Promise<void>;
    };

    await internal.deliverDeferredBestOfSiblingReports({
      parentWorkspaceId: parentId,
      groupId: bestOf.groupId,
      total: bestOf.total,
    });

    const parentHistory = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).not.toContain("<mux_subagent_report>");
    expect(serializedParentHistory).not.toContain("Report from child one");
  });

  test("incremental best-of updates do not suppress deferred terminal reports", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-progress-fallback";
    const childOneId = "child-best-of-progress-fallback-1";
    const childTwoId = "child-best-of-progress-fallback-2";
    const bestOf = { groupId: "best-of-progress-fallback-group", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child-1", childOneId, {
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        }),
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    expect(
      (
        await historyService.appendToHistory(
          parentId,
          createMuxMessage(
            "progress-report",
            "user",
            formatSubagentReportEnvelope({
              taskId: childOneId,
              agentType: "explore",
              status: "in_progress",
              title: "Finding",
              reportMarkdown: "Early finding",
            }),
            { timestamp: Date.now(), synthetic: true }
          )
        )
      ).success
    ).toBe(true);
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Terminal result",
      nowMs: Date.now(),
    });

    const internal = taskService as unknown as {
      deliverDeferredBestOfSiblingReports: (params: {
        parentWorkspaceId: string;
        groupId: string;
        total: number;
      }) => Promise<void>;
    };
    await internal.deliverDeferredBestOfSiblingReports({
      parentWorkspaceId: parentId,
      groupId: bestOf.groupId,
      total: bestOf.total,
    });

    const serialized = JSON.stringify(await collectFullHistory(historyService, parentId));
    expect(serialized).toContain("Early finding");
    expect(serialized).toContain("Terminal result");
  });

  test("completed best-of reports may quote the in-progress status tag without bypassing dedupe", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-status-quote";
    const childOneId = "child-best-of-status-quote-1";
    const childTwoId = "child-best-of-status-quote-2";
    const bestOf = { groupId: "best-of-status-quote-group", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child-1", childOneId, {
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        }),
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const quoted = "Terminal report quoting <status>in_progress</status>.";
    expect(
      (
        await historyService.appendToHistory(
          parentId,
          createMuxMessage(
            "completed-report",
            "user",
            formatSubagentReportEnvelope({
              taskId: childOneId,
              agentType: "explore",
              status: "completed",
              title: "Result",
              reportMarkdown: quoted,
            }),
            { timestamp: Date.now(), synthetic: true }
          )
        )
      ).success
    ).toBe(true);
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: quoted,
      nowMs: Date.now(),
    });

    const internal = taskService as unknown as {
      deliverDeferredBestOfSiblingReports: (params: {
        parentWorkspaceId: string;
        groupId: string;
        total: number;
      }) => Promise<void>;
    };
    await internal.deliverDeferredBestOfSiblingReports({
      parentWorkspaceId: parentId,
      groupId: bestOf.groupId,
      total: bestOf.total,
    });

    const serialized = JSON.stringify(await collectFullHistory(historyService, parentId));
    expect(serialized.match(/Terminal report quoting/g)).toHaveLength(1);
  });

  test("concurrent direct and deferred best-of fallback delivery does not duplicate reports", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-concurrent-direct-fallback";
    const childOneId = "child-best-of-concurrent-direct-fallback-1";
    const childTwoId = "child-best-of-concurrent-direct-fallback-2";
    const bestOf = {
      groupId: "best-of-concurrent-direct-fallback-group",
      index: 0,
      total: 2,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-concurrent-direct-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-concurrent-direct-fallback-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child one",
      title: "Option one",
      nowMs: Date.now(),
    });

    const cfg = config.loadConfigOrDefault();
    const childOneEntry = Array.from(cfg.projects.entries())
      .flatMap(([projectPathEntry, project]) =>
        project.workspaces.map((workspace) => ({ projectPath: projectPathEntry, workspace }))
      )
      .find((entry) => entry.workspace.id === childOneId);
    if (!childOneEntry) {
      throw new Error("Expected child one entry to exist");
    }

    const internal = taskService as unknown as {
      deliverReportToParent: (
        parentWorkspaceId: string,
        childWorkspaceId: string,
        childEntry: { projectPath: string; workspace: unknown },
        report: { reportMarkdown: string; title?: string }
      ) => Promise<void>;
      deliverDeferredBestOfSiblingReports: (params: {
        parentWorkspaceId: string;
        groupId: string;
        total: number;
      }) => Promise<void>;
    };

    await Promise.all([
      internal.deliverReportToParent(parentId, childOneId, childOneEntry, {
        reportMarkdown: "Report from child one",
        title: "Option one",
      }),
      internal.deliverDeferredBestOfSiblingReports({
        parentWorkspaceId: parentId,
        groupId: bestOf.groupId,
        total: bestOf.total,
      }),
    ]);

    const parentHistory = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("Report from child one");
    expect(
      serializedParentHistory.match(/child-best-of-concurrent-direct-fallback-1/g)
    ).toHaveLength(1);
  });

  test("initialize finalizes ready best-of partials before cleanup rechecks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-initialize-finalize-ready";
    const childOneId = "child-best-of-initialize-finalize-ready-1";
    const childTwoId = "child-best-of-initialize-finalize-ready-2";
    const partialTimestamp = Date.now();
    const currentCreatedAt = new Date(partialTimestamp + 60_000).toISOString();
    const bestOf = { groupId: "best-of-initialize-finalize-ready", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          createdAt: currentCreatedAt,
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-initialize-finalize-ready",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: partialTimestamp },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-initialize-finalize-ready-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const parentSessionDir = config.getSessionDir(parentId);
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childOneId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child one",
      title: "Option one",
      nowMs: Date.now(),
    });
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childTwoId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "Report from child two",
      title: "Option two",
      nowMs: Date.now(),
    });

    await taskService.initialize();

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("output-available");
      const outputJson = JSON.stringify(toolPart?.output);
      expect(outputJson).toContain(childOneId);
      expect(outputJson).toContain(childTwoId);
      expect(outputJson).toContain("Report from child one");
      expect(outputJson).toContain("Report from child two");
    }

    const remainingTaskIds = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
    expect(remainingTaskIds).not.toContain(childOneId);
    expect(remainingTaskIds).not.toContain(childTwoId);

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith(childOneId, true);
    expect(remove).toHaveBeenCalledWith(childTwoId, true);
  });

  async function setupPlanModeStreamEndHarness(options?: {
    childAgentId?: string;
    childTaskStatus?: WorkspaceConfigEntry["taskStatus"];
    childAiSettingsByAgent?: WorkspaceConfigEntry["aiSettingsByAgent"];
    workflowTask?: WorkspaceConfigEntry["workflowTask"];
    projectName?: string;
    maxTaskNestingDepth?: number;
    parentAiSettingsByAgent?: Record<string, { model: string; thinkingLevel: ThinkingLevel }>;
    agentAiDefaults?: Record<
      string,
      { modelString: string; thinkingLevel: ThinkingLevel; enabled?: boolean }
    >;
    subagentAiDefaults?: Record<string, { modelString?: string; thinkingLevel?: ThinkingLevel }>;
    sendMessageOverride?: ReturnType<typeof mock>;
    aiServiceOverrides?: Parameters<typeof createAIServiceMocks>[1];
  }) {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-plan-222";
    const childAgentId = options?.childAgentId ?? "plan";
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const parentWorkspacePath = path.join(projectPath, "parent");
    const childWorkspacePath = path.join(projectPath, "child-plan");

    if (childAgentId !== "plan") {
      const customAgentDir = path.join(parentWorkspacePath, ".mux", "agents");
      await fsPromises.mkdir(customAgentDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(customAgentDir, `${childAgentId}.md`),
        [
          "---",
          "name: Custom Plan Agent",
          "base: plan",
          "subagent:",
          "  runnable: true",
          "---",
          "Custom plan-like subagent used by taskService tests.",
          "",
        ].join("\n")
      );
    }

    const agentAiDefaults = { ...(options?.agentAiDefaults ?? {}) };

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentWorkspacePath,
          id: parentId,
          name: "parent",
          runtimeConfig,
          aiSettingsByAgent: options?.parentAiSettingsByAgent,
        },
        {
          path: childWorkspacePath,
          id: childId,
          name: "agent_plan_child",
          parentWorkspaceId: parentId,
          agentId: childAgentId,
          agentType: childAgentId,
          taskStatus: options?.childTaskStatus ?? "running",
          workflowTask: options?.workflowTask,
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "max" },
          aiSettingsByAgent: options?.childAiSettingsByAgent,
          taskModelString: "openai:gpt-4o-mini",
          runtimeConfig,
        },
      ],
      {
        taskSettings: {
          maxParallelAgentTasks: 3,
          maxTaskNestingDepth: options?.maxTaskNestingDepth ?? 3,
        },
        agentAiDefaults: Object.keys(agentAiDefaults).length > 0 ? agentAiDefaults : undefined,
        subagentAiDefaults: options?.subagentAiDefaults,
      }
    );

    const getInfo = mock(() => ({
      id: childId,
      name: "agent_plan_child",
      projectName: options?.projectName ?? "repo",
      projectPath,
      runtimeConfig,
      namedWorkspacePath: childWorkspacePath,
    }));
    const replaceHistory = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService, sendMessage, updateAgentStatus } = createWorkspaceServiceMocks({
      getInfo,
      replaceHistory,
      sendMessage: options?.sendMessageOverride,
    });

    const { aiService, createModel } = createAIServiceMocks(config, options?.aiServiceOverrides);
    const { taskService } = createTaskServiceHarness(config, { workspaceService, aiService });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    return {
      config,
      projectPath,
      childId,
      sendMessage,
      replaceHistory,
      createModel,
      updateAgentStatus,
      taskService,
      internal,
    };
  }

  function makeSuccessfulProposePlanStreamEndEvent(workspaceId: string): StreamEndEvent {
    return {
      type: "stream-end",
      workspaceId,
      messageId: "assistant-plan-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "propose-plan-call-1",
          toolName: "propose_plan",
          state: "output-available",
          output: { success: true, planPath: "/tmp/test-plan.md" },
          input: { plan: "test plan" },
        },
      ],
    };
  }

  test("stream-end with propose_plan success triggers handoff instead of awaiting_report reminder", async () => {
    const { config, childId, sendMessage, replaceHistory, internal } =
      await setupPlanModeStreamEndHarness();

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(replaceHistory).toHaveBeenCalledWith(
      childId,
      expect.anything(),
      expect.objectContaining({ mode: "append-compaction-boundary" })
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({
        agentId: "exec",
        model: "openai:gpt-4o-mini",
        thinkingLevel: "off",
      }),
      expect.objectContaining({ synthetic: true })
    );

    const kickoffMessage = (sendMessage as unknown as { mock: { calls: Array<[string, string]> } })
      .mock.calls[0]?.[1];
    expect(kickoffMessage).not.toContain("agent_report");

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.agentId).toBe("exec");
    expect(updatedTask?.taskStatus).toBe("running");
  });

  test("plan handoff preserves a pro mode persisted under the plan agent bucket", async () => {
    // A PRO toggle during the plan phase lands in aiSettingsByAgent.plan;
    // legacy workspace.aiSettings still holds the original standard setting.
    const { config, childId, sendMessage, internal } = await setupPlanModeStreamEndHarness({
      childAiSettingsByAgent: {
        plan: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
      },
    });

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({ agentId: "exec", reasoningMode: "pro" }),
      expect.objectContaining({ synthetic: true })
    );

    // The rewritten exec-phase settings persist it too.
    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(updatedTask?.aiSettings?.reasoningMode).toBe("pro");
  });

  test("stream-end with propose_plan success uses global exec defaults for handoff", async () => {
    const { config, childId, sendMessage, internal } = await setupPlanModeStreamEndHarness({
      parentAiSettingsByAgent: {
        exec: {
          model: "anthropic:claude-sonnet-4-5",
          thinkingLevel: "low",
        },
      },
      agentAiDefaults: {
        exec: {
          modelString: "openai:gpt-5.3-codex",
          thinkingLevel: "xhigh",
        },
      },
    });

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({
        agentId: "exec",
        model: "openai:gpt-5.3-codex",
        thinkingLevel: "xhigh",
      }),
      expect.objectContaining({ synthetic: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.agentId).toBe("exec");
    expect(updatedTask?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(updatedTask?.taskThinkingLevel).toBe("xhigh");
  });

  test("stream-end with propose_plan success uses subagent exec defaults before global exec defaults", async () => {
    const { config, childId, sendMessage, internal } = await setupPlanModeStreamEndHarness({
      agentAiDefaults: {
        exec: {
          modelString: "openai:gpt-5.2",
          thinkingLevel: "medium",
        },
      },
      subagentAiDefaults: {
        exec: {
          modelString: "openai:gpt-5.3-codex",
          thinkingLevel: "xhigh",
        },
      },
    });

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({
        agentId: "exec",
        model: "openai:gpt-5.3-codex",
        thinkingLevel: "xhigh",
      }),
      expect.objectContaining({ synthetic: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.agentId).toBe("exec");
    expect(updatedTask?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(updatedTask?.taskThinkingLevel).toBe("xhigh");
  });

  test("stream-end handoff falls back to default model when inherited task model is whitespace", async () => {
    const { config, childId, sendMessage, internal } = await setupPlanModeStreamEndHarness();

    const preCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(preCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childEntry).toBeTruthy();
    if (!childEntry) return;

    childEntry.taskModelString = "   ";
    await config.editConfig(() => preCfg);

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({
        agentId: "exec",
        model: defaultModel,
      }),
      expect.objectContaining({ synthetic: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.taskModelString).toBe(defaultModel);
  });

  test("stream-end with propose_plan success triggers handoff for custom plan-like agents", async () => {
    const { config, childId, sendMessage, replaceHistory, internal } =
      await setupPlanModeStreamEndHarness({
        childAgentId: "custom_plan_runner",
      });

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(replaceHistory).toHaveBeenCalledWith(
      childId,
      expect.anything(),
      expect.objectContaining({ mode: "append-compaction-boundary" })
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Implement the plan"),
      expect.objectContaining({ agentId: "exec" }),
      expect.objectContaining({ synthetic: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.agentId).toBe("exec");
    expect(updatedTask?.taskStatus).toBe("running");
  });

  test("workflow-owned plan propose_plan finalizes with plan markdown instead of exec handoff", async () => {
    const projectName = `repo-${path.basename(rootDir)}`;
    const planPath = path.join(os.homedir(), ".mux", "plans", projectName, "agent_plan_child.md");
    await fsPromises.mkdir(path.dirname(planPath), { recursive: true });
    await fsPromises.writeFile(
      planPath,
      "# Proposed workflow plan\n\nDo the tiny safe change.\n",
      "utf-8"
    );

    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    try {
      const { config, childId, sendMessage, replaceHistory, taskService, internal } =
        await setupPlanModeStreamEndHarness({
          projectName,
          workflowTask: { runId: "wfr_plan_step", stepId: "plan" },
        });

      const waiter = taskService.waitForAgentReport(childId, { timeoutMs: 5_000 });

      await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

      const report = await waiter;
      expect(report).toEqual({
        reportMarkdown: "# Proposed workflow plan\n\nDo the tiny safe change.\n",
        title: "Proposed plan",
        planFilePath: planPath,
        model: "openai:gpt-4o-mini",
      });
      expect(debugSpy).toHaveBeenCalledWith(
        "Workflow plan completion using canonical plan file path",
        expect.objectContaining({
          canonicalPlanPath: planPath,
          proposedPlanPath: "/tmp/test-plan.md",
        })
      );
      expect(replaceHistory).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();

      const updatedTask = findWorkspaceInConfig(config, childId);
      expect(updatedTask?.agentId).toBe("plan");
      expect(updatedTask?.taskStatus).toBe("reported");
    } finally {
      debugSpy.mockRestore();
      await fsPromises.rm(planPath, { force: true });
    }
  });

  test("workflow-owned plan propose_plan with missing plan file keeps requiring propose_plan", async () => {
    const projectName = `repo-missing-${path.basename(rootDir)}`;
    const planPath = path.join(os.homedir(), ".mux", "plans", projectName, "agent_plan_child.md");
    await fsPromises.rm(planPath, { force: true });

    const workflowRunId = "wfr_plan_missing";
    const { config, childId, sendMessage, replaceHistory, internal } =
      await setupPlanModeStreamEndHarness({
        projectName,
        workflowTask: { runId: workflowRunId, stepId: "plan" },
      });
    const parentId = findWorkspaceInConfig(config, childId)?.parentWorkspaceId;
    assert(parentId, "workflow-owned plan test requires a parent workspace id");
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "plan-missing",
        description: "Plan missing",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(replaceHistory).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const reminderMessage = (sendMessage as unknown as { mock: { calls: Array<[string, string]> } })
      .mock.calls[0]?.[1];
    expect(reminderMessage).toContain("propose_plan");
    expect(reminderMessage).not.toContain("agent_report");

    const updatedTask = findWorkspaceInConfig(config, childId);
    expect(updatedTask?.agentId).toBe("plan");
    expect(updatedTask?.taskStatus).toBe("awaiting_report");
  });

  test("interrupted workflow-owned plan with successful propose_plan resolves as plan output", async () => {
    const projectName = `repo-interrupted-${path.basename(rootDir)}`;
    const planPath = path.join(os.homedir(), ".mux", "plans", projectName, "agent_plan_child.md");
    await fsPromises.mkdir(path.dirname(planPath), { recursive: true });
    await fsPromises.writeFile(
      planPath,
      "# Interrupted workflow plan\n\nStill complete.\n",
      "utf-8"
    );

    try {
      const { config, childId, replaceHistory, sendMessage, taskService, internal } =
        await setupPlanModeStreamEndHarness({
          projectName,
          childTaskStatus: "interrupted",
          workflowTask: { runId: "wfr_plan_interrupted", stepId: "plan" },
        });

      await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

      const report = await taskService.waitForAgentReport(childId, { timeoutMs: 5_000 });
      expect(report).toEqual({
        reportMarkdown: "# Interrupted workflow plan\n\nStill complete.\n",
        title: "Proposed plan",
        planFilePath: planPath,
        model: "openai:gpt-4o-mini",
      });
      expect(replaceHistory).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    } finally {
      await fsPromises.rm(planPath, { force: true });
    }
  });

  test("workflow-owned plan with output schema fails instead of retrying propose_plan", async () => {
    const { config, childId, replaceHistory, sendMessage, taskService, internal } =
      await setupPlanModeStreamEndHarness({
        workflowTask: {
          runId: "wfr_plan_schema_fallback",
          stepId: "plan",
          outputSchema: { type: "object" },
        },
      });

    const waiter = taskService
      .waitForAgentReport(childId, { timeoutMs: 5_000 })
      .catch((error: unknown) => error);

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

    const waiterError = await waiter;
    expect(waiterError).toBeInstanceOf(Error);
    expect((waiterError as Error).message).toContain(
      "Workflow plan agents return { reportMarkdown, planFilePath }"
    );
    expect(replaceHistory).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const updatedTask = findWorkspaceInConfig(config, childId);
    expect(updatedTask?.taskStatus).toBe("interrupted");
    expect(updatedTask?.taskLaunchError).toContain(
      "Workflow plan agents return { reportMarkdown, planFilePath }"
    );
  });

  test("plan-to-exec auto-handoff resets the persisted recovery budget", async () => {
    const { config, childId, internal } = await setupPlanModeStreamEndHarness();

    // Budget consumed by propose_plan recovery prompts during the plan phase.
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const workspace = project.workspaces.find((ws) => ws.id === childId);
        if (workspace) {
          workspace.taskRecoveryAttempts = 4;
        }
      }
      return cfg;
    });

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

    // A successful propose_plan is a successful completion-tool outcome: the
    // exec phase starts with a fresh budget instead of inheriting the plan's.
    const updatedTask = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(updatedTask?.agentId).toBe("exec");
    expect(updatedTask?.taskRecoveryAttempts).toBeUndefined();
  });

  test("plan task stream-end with final assistant text still requires propose_plan", async () => {
    const { config, childId, sendMessage, internal } = await setupPlanModeStreamEndHarness();

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-plan-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "Here is the final plan in prose, but no propose_plan call." }],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const reminderMessage = (sendMessage as unknown as { mock: { calls: Array<[string, string]> } })
      .mock.calls[0]?.[1];
    expect(reminderMessage).toContain("propose_plan");
    expect(reminderMessage).not.toContain("agent_report");

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(updatedTask?.taskStatus).toBe("awaiting_report");
  });

  test("plan task stream-end without propose_plan sends propose_plan reminder (not agent_report)", async () => {
    const { config, childId, sendMessage, internal } = await setupPlanModeStreamEndHarness();

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-plan-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);

    const reminderMessage = (sendMessage as unknown as { mock: { calls: Array<[string, string]> } })
      .mock.calls[0]?.[1];
    expect(reminderMessage).toContain("propose_plan");
    expect(reminderMessage).not.toContain("agent_report");

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(updatedTask?.taskStatus).toBe("awaiting_report");
  });

  test("awaiting_report tasks keep retrying agent_report after recovery errors instead of fabricating fallback reports", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.5-pro",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child",
      metadata: { model: "openai:gpt-5.5-pro" },
      parts: [],
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await internal.handleTaskStreamError({
        type: "error",
        workspaceId: childId,
        messageId: `assistant-error-${attempt}`,
        error: "The model ended the stream before producing any assistant-visible output.",
        errorType: "empty_output",
      });
    }

    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      childId,
      expect.stringContaining(
        "The previous final assistant response attempt failed (last error: empty_output)"
      ),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );

    const report = await readSubagentReportArtifact(config.getSessionDir(parentId), childId);
    expect(report).toBeNull();

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("awaiting_report");
  });

  test("awaiting_report tasks interrupt instead of retrying forever after non-retryable errors", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.5-pro",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child",
      metadata: { model: "openai:gpt-5.5-pro" },
      parts: [],
    });

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-auth",
      error: "Authentication failed",
      errorType: "authentication",
    });

    // One recovery prompt to the child (stream-end), then — after the terminal
    // settlement — one failure handoff waking the idle parent (no waiter).
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage.mock.calls[1]?.[0]).toBe(parentId);
    // The failure details travel via the durable synthetic history message,
    // not the generic wake-up prompt.
    const serializedParentHistory = JSON.stringify(
      await collectFullHistory(historyService, parentId)
    );
    expect(serializedParentHistory).toContain("<mux_subagent_failure>");
    expect(serializedParentHistory).toContain("Authentication failed");

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("interrupted");
  });

  test("running tasks settle terminally on model_refusal without any recovery prompt", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "anthropic:claude-fable-5",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    const refusalMessage =
      "The model refused to continue (finishReason: content-filter): anthropic:claude-fable-5.";

    // Waiter registered before the failure must reject promptly with the refusal
    // text — not block until the 10-minute report timeout.
    const waiterOutcome = taskService
      .waitForAgentReport(childId, { timeoutMs: 10_000, requestingWorkspaceId: parentId })
      .then(
        () => null,
        (error: unknown) => error
      );

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-refusal",
      error: refusalMessage,
      errorType: "model_refusal",
    });

    const rejection = await waiterOutcome;
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe(refusalMessage);

    // Terminal settlement: no agent_report recovery prompt is sent afterwards.
    expect(sendMessage).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("interrupted");
    expect(childWorkspace?.taskLaunchError).toBe(refusalMessage);

    // Durable failure artifact persisted in the parent's session dir.
    const failure = await readSubagentFailureArtifact(config.getSessionDir(parentId), childId);
    expect(failure).not.toBeNull();
    expect(failure?.errorType).toBe("model_refusal");
    expect(failure?.errorMessage).toBe(refusalMessage);
  });

  test("awaiting_report tasks settle terminally on model_refusal", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: "anthropic:claude-fable-5",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    const refusalMessage =
      "The model refused to continue (finishReason: content-filter): anthropic:claude-fable-5.";

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-refusal",
      error: refusalMessage,
      errorType: "model_refusal",
    });

    // No agent_report recovery prompt goes to the child. The only send is the
    // failure handoff waking the idle parent (no foreground waiter existed).
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(parentId);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("failed terminally");

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("interrupted");
    expect(childWorkspace?.taskLaunchError).toBe(refusalMessage);
  });

  test("running tasks are NOT settled by aborted, context_exceeded, or retryable stream errors", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.5-pro",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    // A user interrupt (aborted) is a steerable pause: the user can still send a
    // follow-up message, so the task must not be terminally interrupted.
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-abort",
      error: "Aborted",
      errorType: "aborted",
    });

    // context_exceeded is non-retryable but has in-session recovery (compaction
    // retry / exec-subagent hard restart) racing on the same error event;
    // settling here would interrupt a child that was about to continue.
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-context",
      error: "Prompt is too long: 250000 tokens > 200000 maximum",
      errorType: "context_exceeded",
    });

    // Retryable transport errors stay owned by the agent session's retry loop.
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-network",
      error: "fetch failed",
      errorType: "network",
    });

    expect(sendMessage).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("running");
    expect(childWorkspace?.taskLaunchError).toBeUndefined();
  });

  test("background task refusal stays observable after cleanup and restart via failure artifact", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    const childWorkspaceEntry = projectWorkspace(projectPath, "child", childId, {
      name: "agent_explore_child",
      parentWorkspaceId: parentId,
      agentType: "explore",
      taskStatus: "running",
      taskModelString: "anthropic:claude-fable-5",
    });

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "parent", parentId), childWorkspaceEntry],
      testTaskSettings(1, 3)
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    const refusalMessage =
      "The model refused to continue (finishReason: content-filter): anthropic:claude-fable-5.";

    // No foreground waiter exists (background child) when the refusal lands.
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-refusal",
      error: refusalMessage,
      errorType: "model_refusal",
    });

    // Restart simulation: a fresh service instance over the same config still
    // surfaces the terminal failure from config status + taskLaunchError.
    const { taskService: restartedTaskService } = createTaskServiceHarness(config, {
      workspaceService: createWorkspaceServiceMocks().workspaceService,
    });
    const lateAwaitError = await restartedTaskService
      .waitForAgentReport(childId, { timeoutMs: 5_000, requestingWorkspaceId: parentId })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(lateAwaitError).toBeInstanceOf(Error);
    expect((lateAwaitError as Error).message).toBe(refusalMessage);

    // Cleanup simulation: the child workspace entry is gone, so only the
    // persisted failure artifact can explain the terminal outcome.
    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "parent", parentId)],
      testTaskSettings(1, 3)
    );

    const postCleanupError = await restartedTaskService
      .waitForAgentReport(childId, { timeoutMs: 5_000, requestingWorkspaceId: parentId })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(postCleanupError).toBeInstanceOf(Error);
    expect((postCleanupError as Error).message).toBe(refusalMessage);
  });

  test("terminal background-child failure wakes the idle parent once the last child settles", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childAId = "child-222";
    const childBId = "child-333";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child-a", childAId, {
          name: "agent_explore_child_a",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "anthropic:claude-fable-5",
        }),
        projectWorkspace(projectPath, "child-b", childBId, {
          name: "agent_explore_child_b",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "anthropic:claude-fable-5",
        }),
      ],
      testTaskSettings(2, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    const refusalMessage =
      "The model refused to continue (finishReason: content-filter): anthropic:claude-fable-5.";

    const readParentFailureMessages = async () => {
      const history = await collectFullHistory(historyService, parentId);
      return history
        .filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message))
        .filter((serialized) => serialized.includes("<mux_subagent_failure>"));
    };

    // First background child refuses while a sibling is still active: the
    // parent is NOT woken yet (the last settlement owns the wake-up), but the
    // failure details are already delivered durably into the parent context so
    // a later sibling REPORT cannot present the fanout as fully successful.
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childAId,
      messageId: "assistant-error-refusal-a",
      error: refusalMessage,
      errorType: "model_refusal",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    const messagesAfterFirstFailure = await readParentFailureMessages();
    expect(messagesAfterFirstFailure).toHaveLength(1);
    expect(messagesAfterFirstFailure[0]).toContain(childAId);
    expect(messagesAfterFirstFailure[0]).toContain("model_refusal");
    expect(messagesAfterFirstFailure[0]).toContain(refusalMessage);

    // Last background child refuses with no foreground waiter: its failure is
    // appended too, and the idle parent gets exactly one synthetic wake-up so
    // it does not sit at taskStatus "running" until a timeout or manual await.
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childBId,
      messageId: "assistant-error-refusal-b",
      error: refusalMessage,
      errorType: "model_refusal",
    });

    const messagesAfterSecondFailure = await readParentFailureMessages();
    expect(messagesAfterSecondFailure).toHaveLength(2);
    expect(messagesAfterSecondFailure[1]).toContain(childBId);

    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(parentId);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("failed terminally");
    expect(sendMessage.mock.calls[0]?.[3]).toMatchObject({
      synthetic: true,
      agentInitiated: true,
      skipAutoResumeReset: true,
    });
  });

  test("terminal workflow-owned child failure does not nudge the parent with a generic handoff", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "anthropic:claude-fable-5",
          // Workflow-owned: failures propagate through the WorkflowRunner step
          // result, mirroring the report path's auto-resume skip.
          workflowTask: { runId: "wfr_refusal", stepId: "verify" },
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-refusal",
      error: "The model refused to continue (finishReason: refusal): anthropic:claude-fable-5.",
      errorType: "model_refusal",
    });

    // Neither a wake-up send nor a synthetic failure message: the workflow
    // journal owns failure delivery for workflow-owned children.
    expect(sendMessage).not.toHaveBeenCalled();
    const serializedParentHistory = JSON.stringify(
      await collectFullHistory(historyService, parentId)
    );
    expect(serializedParentHistory).not.toContain("<mux_subagent_failure>");

    const childWorkspace = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("interrupted");
  });

  test("recovery circuit breaker interrupts the task once the persisted attempt budget is exhausted", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-5.5-pro",
          // Budget already consumed by prior recovery prompts (persisted, so
          // restarts cannot launder the count back to zero).
          taskRecoveryAttempts: 5,
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    // A retryable error that would normally trigger yet another recovery prompt.
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-empty",
      error: "The model ended the stream before producing any assistant-visible output.",
      errorType: "empty_output",
    });

    // Breaker tripped: no further recovery prompt to the child; the task
    // settles terminally and the only send wakes the idle parent.
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(parentId);

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("interrupted");
    expect(childWorkspace?.taskLaunchError).toContain("recovery attempts");
    expect(childWorkspace?.taskLaunchError).toContain("empty_output");

    // The terminal failure is durable: artifact carries the discriminated errorType.
    const failure = await readSubagentFailureArtifact(config.getSessionDir(parentId), childId);
    expect(failure?.errorType).toBe("task_recovery_limit");

    // Waiters observe the same descriptive failure instead of timing out.
    const awaitError = await taskService
      .waitForAgentReport(childId, { timeoutMs: 5_000, requestingWorkspaceId: parentId })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(awaitError).toBeInstanceOf(Error);
    expect((awaitError as Error).message).toBe(childWorkspace?.taskLaunchError ?? "");
  });

  test("recovery prompts increment a persisted counter that survives service restarts", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.5-pro",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // Stream ends without a report: first recovery prompt consumes budget.
    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child",
      metadata: { model: "openai:gpt-5.5-pro" },
      parts: [],
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const readAttempts = () =>
      Array.from(config.loadConfigOrDefault().projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === childId)?.taskRecoveryAttempts;
    expect(readAttempts()).toBe(1);

    // Restart simulation: a fresh service instance keeps counting from disk
    // instead of starting over at zero.
    const restartedMocks = createWorkspaceServiceMocks();
    const { taskService: restartedTaskService } = createTaskServiceHarness(config, {
      workspaceService: restartedMocks.workspaceService,
    });
    const restartedInternal = restartedTaskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };
    await restartedInternal.handleTaskStreamError({
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-empty",
      error: "The model ended the stream before producing any assistant-visible output.",
      errorType: "empty_output",
    });
    expect(restartedMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(readAttempts()).toBe(2);
  });

  test("a successful agent_report resets the persisted recovery counter", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-5.5-pro",
          taskRecoveryAttempts: 3,
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-report",
      metadata: { model: "openai:gpt-5.5-pro", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "All done", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "All done" },
      ],
    });

    const postCfg = config.loadConfigOrDefault();
    const childWorkspace = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("reported");
    expect(childWorkspace?.taskRecoveryAttempts).toBeUndefined();
  });

  test("recovery prompt consumes budget before sending so a failed send still counts", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-5.5-pro",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const readAttempts = () =>
      Array.from(config.loadConfigOrDefault().projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === childId)?.taskRecoveryAttempts;

    // Capture the persisted counter at send time: the budget must already be
    // consumed BEFORE the send so a crash mid-send cannot launder the attempt.
    let attemptsAtSendTime: number | undefined;
    const sendMessage = mock((): Promise<Result<void>> => {
      attemptsAtSendTime = readAttempts();
      return Promise.resolve(Err("send failed"));
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: childId,
      messageId: "assistant-error-empty",
      error: "The model ended the stream before producing any assistant-visible output.",
      errorType: "empty_output",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(attemptsAtSendTime).toBe(1);
    expect(readAttempts()).toBe(1);

    // A failed recovery send is not a terminal settlement: the task keeps
    // awaiting its report (restart recovery can retry with budget intact).
    const childWorkspace = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("awaiting_report");
    expect(childWorkspace?.taskLaunchError).toBeUndefined();
  });

  test("user resume of an interrupted task clears the persisted recovery budget", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          // Breaker previously tripped; a user-initiated resume is a fresh
          // chance and must not instantly re-fail on its first recovery prompt.
          taskRecoveryAttempts: 5,
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);

    const childWorkspace = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);
    expect(childWorkspace?.taskStatus).toBe("running");
    expect(childWorkspace?.taskRecoveryAttempts).toBeUndefined();
  });

  test("waitForAgentReport prefers the persisted report when a failure artifact also exists", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    // Both artifacts exist for the same child (e.g. a refusal settled the task
    // while a racing stream-end still finalized agent_report). Report
    // monotonicity: a completed report must win over the failure.
    await upsertSubagentReportArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "real report",
      title: "done",
      nowMs: Date.now(),
    });
    await upsertSubagentFailureArtifact({
      workspaceId: parentId,
      workspaceSessionDir: config.getSessionDir(parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      errorType: "model_refusal",
      errorMessage: "Model refused (finishReason: refusal): anthropic:claude-fable-5",
    });

    // Exercise the post-cleanup lookup path, where both artifacts are consulted.
    await config.removeWorkspace(childId);

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10,
      requestingWorkspaceId: parentId,
    });
    expect(report).toEqual({ reportMarkdown: "real report", title: "done" });
  });

  test("handoff kickoff sendMessage failure keeps task status as running for restart recovery", async () => {
    const sendMessageFailure = mock(
      (): Promise<Result<void>> => Promise.resolve(Err("kickoff failed"))
    );
    const { config, childId, internal } = await setupPlanModeStreamEndHarness({
      sendMessageOverride: sendMessageFailure,
    });

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(sendMessageFailure).toHaveBeenCalledTimes(1);

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    // Task stays "running" so initialize() can retry the kickoff on next startup,
    // rather than "awaiting_report" which could finalize it prematurely.
    expect(updatedTask?.taskStatus).toBe("running");
  });

  test("falls back to default trunk when parent branch does not exist locally", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });

    const initLogger = createNullInitLogger();

    // Create a worktree for the parent on main
    const parentName = "parent";
    const parentCreate = await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    expect(parentCreate.success).toBe(true);

    const parentId = "1111111111";
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    // Register parent with a name that does NOT exist as a local branch.
    // This simulates the case where parent workspace name (e.g., from SSH)
    // doesn't correspond to a local branch in the project repository.
    const nonExistentBranchName = "non-existent-branch-xyz";
    await config.editConfig(() => ({
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              {
                path: parentPath,
                id: parentId,
                name: nonExistentBranchName, // This branch doesn't exist locally
                createdAt: new Date().toISOString(),
                runtimeConfig,
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    }));
    const { taskService } = createTaskServiceHarness(config);

    // Creating a task should succeed by falling back to "main" as trunkBranch
    // instead of failing with "fatal: 'non-existent-branch-xyz' is not a commit"
    const created = await createAgentTask(taskService, parentId, "explore this repo");
    expect(created.success).toBe(true);
    if (!created.success) return;

    // Verify the child workspace was created
    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.workspaceId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.runtimeConfig?.type).toBe("worktree");
  }, 20_000);

  async function removeWorkspaceFromTestConfig(config: Config, workspaceId: string): Promise<void> {
    const cfg = config.loadConfigOrDefault();
    let removed = false;

    for (const project of cfg.projects.values()) {
      const nextWorkspaces = project.workspaces.filter((workspace) => workspace.id !== workspaceId);
      if (nextWorkspaces.length === project.workspaces.length) {
        continue;
      }

      project.workspaces = nextWorkspaces;
      removed = true;
    }

    assert(removed, `Expected workspace ${workspaceId} to exist in test config`);
    await config.editConfig(() => cfg);
  }

  test("reported leaf cleanup deletes the finished leaf but keeps siblings and parents", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "parent-222";
    const childTaskAId = "child-a-333";
    const childTaskBId = "child-b-444";

    await config.editConfig(() => ({
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              projectWorkspace(projectPath, "root", rootWorkspaceId),
              projectWorkspace(projectPath, "parent-task", parentTaskId, {
                name: "agent_exec_parent",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "reported",
              }),
              projectWorkspace(projectPath, "child-task-a", childTaskAId, {
                name: "agent_explore_child_a",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "reported",
              }),
              projectWorkspace(projectPath, "child-task-b", childTaskBId, {
                name: "agent_explore_child_b",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "reported",
              }),
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    }));

    const isStreaming = mock(() => false);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      cleanupReportedLeafTask: (workspaceId: string) => Promise<void>;
    };

    await internal.cleanupReportedLeafTask(childTaskAId);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(childTaskAId, true);

    const postCfg = config.loadConfigOrDefault();
    const remainingWorkspaceIds = new Set(
      Array.from(postCfg.projects.values())
        .flatMap((project) => project.workspaces)
        .map((workspace) => workspace.id)
    );
    expect(remainingWorkspaceIds.has(parentTaskId)).toBe(true);
    expect(remainingWorkspaceIds.has(childTaskAId)).toBe(false);
    expect(remainingWorkspaceIds.has(childTaskBId)).toBe(true);
  });

  test("reported leaf cleanup cascades through newly empty reported ancestors", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const grandparentTaskId = "grandparent-000";
    const parentTaskId = "parent-222";
    const childTaskId = "child-a-333";

    await config.editConfig(() => ({
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              projectWorkspace(projectPath, "root", rootWorkspaceId),
              projectWorkspace(projectPath, "grandparent-task", grandparentTaskId, {
                name: "agent_exec_grandparent",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "reported",
              }),
              projectWorkspace(projectPath, "parent-task", parentTaskId, {
                name: "agent_exec_parent",
                parentWorkspaceId: grandparentTaskId,
                agentType: "exec",
                taskStatus: "reported",
              }),
              projectWorkspace(projectPath, "child-task-a", childTaskId, {
                name: "agent_explore_child_a",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "reported",
              }),
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    }));

    const isStreaming = mock(() => false);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      cleanupReportedLeafTask: (workspaceId: string) => Promise<void>;
    };

    await internal.cleanupReportedLeafTask(childTaskId);

    const isStreamingCalls = (isStreaming as unknown as { mock: { calls: Array<[string]> } }).mock
      .calls;
    const checkedWorkspaceIds = new Set(isStreamingCalls.map((call) => call[0]));
    expect(checkedWorkspaceIds.has(childTaskId)).toBe(true);
    expect(checkedWorkspaceIds.has(parentTaskId)).toBe(true);
    expect(checkedWorkspaceIds.has(grandparentTaskId)).toBe(true);
    expect(remove.mock.calls).toEqual([
      [childTaskId, true],
      [parentTaskId, true],
      [grandparentTaskId, true],
    ]);

    const postCfg = config.loadConfigOrDefault();
    const remainingWorkspaceIds = new Set(
      Array.from(postCfg.projects.values())
        .flatMap((project) => project.workspaces)
        .map((workspace) => workspace.id)
    );
    expect(remainingWorkspaceIds).toEqual(new Set([rootWorkspaceId]));
  });

  test("cleanupReportedLeafTask deletes interrupted tasks that still have completed reports", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const grandparentTaskId = "grandparent-000";
    const parentTaskId = "parent-222";
    const childTaskId = "child-a-333";
    const completedAt = "2026-03-09T11:05:58.780Z";

    await config.editConfig(() => ({
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              projectWorkspace(projectPath, "root", rootWorkspaceId),
              projectWorkspace(projectPath, "grandparent-task", grandparentTaskId, {
                name: "agent_exec_grandparent",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "interrupted",
                reportedAt: completedAt,
              }),
              projectWorkspace(projectPath, "parent-task", parentTaskId, {
                name: "agent_exec_parent",
                parentWorkspaceId: grandparentTaskId,
                agentType: "exec",
                taskStatus: "interrupted",
                reportedAt: completedAt,
              }),
              projectWorkspace(projectPath, "child-task-a", childTaskId, {
                name: "agent_explore_child_a",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "interrupted",
                reportedAt: completedAt,
              }),
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    }));

    const isStreaming = mock(() => false);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      cleanupReportedLeafTask: (workspaceId: string) => Promise<void>;
    };

    await internal.cleanupReportedLeafTask(childTaskId);

    const isStreamingCalls = (isStreaming as unknown as { mock: { calls: Array<[string]> } }).mock
      .calls;
    const checkedWorkspaceIds = new Set(isStreamingCalls.map((call) => call[0]));
    expect(checkedWorkspaceIds.has(childTaskId)).toBe(true);
    expect(checkedWorkspaceIds.has(parentTaskId)).toBe(true);
    expect(checkedWorkspaceIds.has(grandparentTaskId)).toBe(true);
    expect(remove.mock.calls).toEqual([
      [childTaskId, true],
      [parentTaskId, true],
      [grandparentTaskId, true],
    ]);

    const postCfg = config.loadConfigOrDefault();
    const remainingWorkspaceIds = new Set(
      Array.from(postCfg.projects.values())
        .flatMap((project) => project.workspaces)
        .map((workspace) => workspace.id)
    );
    expect(remainingWorkspaceIds).toEqual(new Set([rootWorkspaceId]));
  });

  describe("canonical reported task cleanup", () => {
    interface CleanupInternals {
      canCleanupReportedTask: (workspaceId: string) => Promise<
        | {
            ok: true;
            cleanup: "legacy-remove" | "retire-to-transcript";
            parentWorkspaceId: string;
          }
        | { ok: false; reason: string }
      >;
      cleanupReportedLeafTask: (workspaceId: string) => Promise<void>;
    }

    async function setupCanonicalCleanup(options?: {
      retentionPolicy?: "delete_workspace_on_completion" | "retain_workspace";
      nested?: boolean;
      retireToTranscript?: ReturnType<typeof mock>;
    }) {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      const rootWorkspaceId = "root-canonical-cleanup";
      const parentTaskId = "parent-canonical-cleanup";
      const childTaskId = options?.nested ? "child-canonical-cleanup" : parentTaskId;
      const parentExecutionId = "exe_parent-canonical-cleanup" as const;
      const childExecutionId = options?.nested
        ? ("exe_child-canonical-cleanup" as const)
        : parentExecutionId;
      const completedAt = "2026-08-06T12:00:00.000Z";

      const workspaces = [projectWorkspace(projectPath, "root", rootWorkspaceId)];
      workspaces.push(
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: completedAt,
          executionId: parentExecutionId,
        })
      );
      if (options?.nested) {
        workspaces.push(
          projectWorkspace(projectPath, "child-task", childTaskId, {
            parentWorkspaceId: parentTaskId,
            agentType: "explore",
            taskStatus: "reported",
            reportedAt: completedAt,
            executionId: childExecutionId,
          })
        );
      }
      await saveWorkspaces(config, projectPath, workspaces, {
        taskSettings: {
          ...testTaskSettings(3, 5),
          preserveSubagentsUntilArchive: false,
        },
      });

      const executionStore = new ExecutionStore(config);
      await executionStore.upsert({
        version: 1,
        executionId: parentExecutionId,
        aliases: [parentTaskId],
        ownerSessionId: rootWorkspaceId,
        requesterWorkspaceId: rootWorkspaceId,
        target: { kind: "workspace", workspaceId: parentTaskId, origin: "created" },
        launchPolicy: { kind: "agent_task", agentId: "exec" },
        completionPolicy: { kind: "final_assistant_message" },
        retentionPolicy: {
          kind: options?.retentionPolicy ?? "delete_workspace_on_completion",
        },
        attentionPolicy: "blocking_until_terminal",
        status: "completed",
        result: { kind: "completed", reportMarkdown: "Parent complete" },
        createdAt: completedAt,
        updatedAt: completedAt,
        startedAt: completedAt,
        terminalAt: completedAt,
      });
      if (options?.nested) {
        await executionStore.upsert({
          version: 1,
          executionId: childExecutionId,
          aliases: [childTaskId],
          parentExecutionId,
          ownerSessionId: rootWorkspaceId,
          requesterWorkspaceId: parentTaskId,
          target: { kind: "workspace", workspaceId: childTaskId, origin: "created" },
          launchPolicy: { kind: "agent_task", agentId: "explore" },
          completionPolicy: { kind: "final_assistant_message" },
          retentionPolicy: {
            kind: options.retentionPolicy ?? "delete_workspace_on_completion",
          },
          attentionPolicy: "blocking_until_terminal",
          status: "completed",
          result: { kind: "completed", reportMarkdown: "Child complete" },
          createdAt: completedAt,
          updatedAt: completedAt,
          startedAt: completedAt,
          terminalAt: completedAt,
        });
      }

      const retireToTranscript =
        options?.retireToTranscript ??
        mock(async (workspaceId: string) => {
          await config.editConfig((cfg) => {
            const workspace = Array.from(cfg.projects.values())
              .flatMap((project) => project.workspaces)
              .find((entry) => entry.id === workspaceId);
            assert(workspace, "canonical cleanup workspace must exist");
            workspace.transcriptOnly = true;
            workspace.archivedAt = completedAt;
            return cfg;
          });
          return Ok({ kind: "transcript-only" as const, cleanup: "worktree-deleted" as const });
        });
      const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
      const { workspaceService } = createWorkspaceServiceMocks({ retireToTranscript, remove });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      return {
        config,
        taskService,
        internal: taskService as unknown as CleanupInternals,
        retireToTranscript,
        remove,
        rootWorkspaceId,
        parentTaskId,
        childTaskId,
        parentExecutionId,
        childExecutionId,
      };
    }

    test("delete-on-completion retires a canonical workspace without removing its config entry", async () => {
      const { config, internal, retireToTranscript, remove, childTaskId, rootWorkspaceId } =
        await setupCanonicalCleanup();

      expect(await internal.canCleanupReportedTask(childTaskId)).toEqual({
        ok: true,
        cleanup: "retire-to-transcript",
        parentWorkspaceId: rootWorkspaceId,
      });
      await internal.cleanupReportedLeafTask(childTaskId);

      expect(retireToTranscript).toHaveBeenCalledWith(childTaskId);
      expect(remove).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)?.transcriptOnly).toBe(true);
    });

    test("retain_workspace leaves a completed canonical workspace untouched", async () => {
      const { internal, retireToTranscript, remove, childTaskId } = await setupCanonicalCleanup({
        retentionPolicy: "retain_workspace",
      });

      expect(await internal.canCleanupReportedTask(childTaskId)).toEqual({
        ok: false,
        reason: "canonical_workspace_retained",
      });
      await internal.cleanupReportedLeafTask(childTaskId);

      expect(retireToTranscript).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    test("incomplete canonical retirement never falls back to legacy removal", async () => {
      const retireToTranscript = mock()
        .mockResolvedValueOnce(
          Ok({
            kind: "archived-only" as const,
            cleanup: "unsupported" as const,
            runtimeType: "local",
          })
        )
        .mockResolvedValueOnce(Err("retirement failed"));
      const { internal, remove, childTaskId } = await setupCanonicalCleanup({
        retireToTranscript,
      });

      await internal.cleanupReportedLeafTask(childTaskId);
      await internal.cleanupReportedLeafTask(childTaskId);

      expect(retireToTranscript.mock.calls).toEqual([[childTaskId], [childTaskId]]);
      expect(remove).not.toHaveBeenCalled();
    });

    test("transcript-only terminal children do not block their canonical parent or get recursively cleaned", async () => {
      const {
        config,
        taskService,
        internal,
        retireToTranscript,
        remove,
        rootWorkspaceId,
        parentTaskId,
        childTaskId,
        childExecutionId,
      } = await setupCanonicalCleanup({ nested: true });

      await internal.cleanupReportedLeafTask(childTaskId);

      expect(retireToTranscript.mock.calls).toEqual([[childTaskId]]);
      expect(remove).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)?.transcriptOnly).toBe(true);
      expect(findWorkspaceInConfig(config, parentTaskId)?.transcriptOnly).toBeUndefined();
      expect(await internal.canCleanupReportedTask(parentTaskId)).toEqual({
        ok: true,
        cleanup: "retire-to-transcript",
        parentWorkspaceId: rootWorkspaceId,
      });

      expect(
        await taskService.sendMessageToDescendantAgentTask(
          rootWorkspaceId,
          childExecutionId,
          "More guidance",
          "tool-end"
        )
      ).toMatchObject({ success: false, error: { code: "not_active" } });
      expect(
        await taskService.terminateDescendantAgentTask(rootWorkspaceId, childExecutionId)
      ).toEqual(Err("Task transcript is retained and cannot be directly terminated"));
    });
  });

  describe("preserve subagents until archive", () => {
    interface ReportedTaskNode {
      id: string;
      directoryName: string;
      name: string;
      agentType: string;
      taskStatus?: "reported" | "interrupted";
      reportedAt?: string;
      taskSticky?: boolean;
      workflowTask?: WorkspaceConfigEntry["workflowTask"];
    }

    type TaskCleanupEligibility =
      | {
          ok: true;
          cleanup: "legacy-remove" | "retire-to-transcript";
          parentWorkspaceId: string;
        }
      | { ok: false; reason: string };

    interface TaskServiceCleanupInternals {
      canCleanupReportedTask: (workspaceId: string) => Promise<TaskCleanupEligibility>;
      cleanupReportedLeafTask: (workspaceId: string) => Promise<void>;
    }

    async function archiveWorkspaceInTestConfig(
      config: Config,
      workspaceId: string,
      archivedAt = "2026-03-10T00:00:00.000Z"
    ): Promise<void> {
      let archived = false;
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const workspace = project.workspaces.find((entry) => entry.id === workspaceId);
          if (!workspace) {
            continue;
          }

          workspace.archivedAt = archivedAt;
          workspace.unarchivedAt = undefined;
          archived = true;
          break;
        }
        return cfg;
      });
      assert(archived, `Expected workspace ${workspaceId} to exist in test config`);
    }

    async function setupReportedTaskChain(options?: {
      preserveSubagentsUntilArchive?: boolean;
      taskChain?: ReportedTaskNode[];
    }) {
      const config = await createTestConfig(rootDir);

      const projectPath = path.join(rootDir, "repo");
      const rootWorkspaceId = "root-111";
      const taskChain = options?.taskChain ?? [
        {
          id: "parent-222",
          directoryName: "parent-task",
          name: "agent_exec_parent",
          agentType: "exec",
          taskStatus: "reported" as const,
        },
        {
          id: "child-333",
          directoryName: "child-task",
          name: "agent_explore_child",
          agentType: "explore",
          taskStatus: "reported" as const,
        },
      ];

      const workspaces: WorkspaceConfigEntry[] = [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
      ];
      let parentWorkspaceId = rootWorkspaceId;
      for (const task of taskChain) {
        workspaces.push({
          path: path.join(projectPath, task.directoryName),
          id: task.id,
          name: task.name,
          parentWorkspaceId,
          agentType: task.agentType,
          taskStatus: task.taskStatus ?? "reported",
          reportedAt: task.reportedAt,
          taskSticky: task.taskSticky,
          ...(task.workflowTask !== undefined ? { workflowTask: task.workflowTask } : {}),
        });
        parentWorkspaceId = task.id;
      }

      await saveWorkspaces(config, projectPath, workspaces, {
        taskSettings: {
          ...testTaskSettings(3, 5),
          preserveSubagentsUntilArchive: options?.preserveSubagentsUntilArchive ?? true,
        },
      });

      const isStreaming = mock(() => false);
      const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
        await removeWorkspaceFromTestConfig(config, workspaceId);
        return Ok(undefined);
      });
      const { aiService } = createAIServiceMocks(config, { isStreaming });
      const { workspaceService } = createWorkspaceServiceMocks({ remove });
      const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
      const internal = taskService as unknown as TaskServiceCleanupInternals;

      return {
        config,
        taskService,
        remove,
        rootWorkspaceId,
        taskChain,
        internal,
      };
    }

    test("cleanup is blocked when toggle is on and no ancestor is archived", async () => {
      const { config, remove, taskChain, internal } = await setupReportedTaskChain();
      const childTaskId = taskChain[1]?.id;
      expect(childTaskId).toBe("child-333");
      if (!childTaskId) {
        return;
      }

      const cleanupEligibility = await internal.canCleanupReportedTask(childTaskId);
      expect(cleanupEligibility).toEqual({ ok: false, reason: "preserved_until_archive" });

      await internal.cleanupReportedLeafTask(childTaskId);

      expect(remove).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)).toBeTruthy();
    });

    test("detects only unarchived sticky descendants across nested task trees", async () => {
      const stickyTaskId = "sticky-333";
      const { config, taskService, rootWorkspaceId } = await setupReportedTaskChain({
        preserveSubagentsUntilArchive: false,
        taskChain: [
          {
            id: "parent-222",
            directoryName: "parent-task",
            name: "agent_exec_parent",
            agentType: "exec",
            taskStatus: "reported",
          },
          {
            id: stickyTaskId,
            directoryName: "sticky-task",
            name: "agent_exec_sticky",
            agentType: "exec",
            taskStatus: "reported",
            taskSticky: true,
          },
        ],
      });

      expect(taskService.hasStickyDescendants(rootWorkspaceId)).toBe(true);
      expect(taskService.hasUnarchivedStickyDescendants(rootWorkspaceId)).toBe(true);
      // The sticky marker protects ancestors, not the sticky workspace's own explicit lifecycle action.
      expect(taskService.hasStickyDescendants(stickyTaskId)).toBe(false);
      expect(taskService.hasUnarchivedStickyDescendants(stickyTaskId)).toBe(false);

      await archiveWorkspaceInTestConfig(config, stickyTaskId);

      expect(taskService.hasStickyDescendants(rootWorkspaceId)).toBe(true);
      expect(taskService.hasUnarchivedStickyDescendants(rootWorkspaceId)).toBe(false);
    });

    test("sticky completed tasks are never auto-cleaned", async () => {
      const childTaskId = "child-333";
      const { config, remove, internal } = await setupReportedTaskChain({
        preserveSubagentsUntilArchive: false,
        taskChain: [
          {
            id: childTaskId,
            directoryName: "child-task",
            name: "agent_exec_child",
            agentType: "exec",
            taskStatus: "reported",
            taskSticky: true,
          },
        ],
      });

      expect(await internal.canCleanupReportedTask(childTaskId)).toEqual({
        ok: false,
        reason: "sticky",
      });

      await internal.cleanupReportedLeafTask(childTaskId);

      expect(remove).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)?.taskSticky).toBe(true);
    });

    test("cleanup prunes transient descendants but stops at a sticky ancestor", async () => {
      const parentTaskId = "parent-222";
      const childTaskId = "child-333";
      const { config, remove, internal } = await setupReportedTaskChain({
        preserveSubagentsUntilArchive: false,
        taskChain: [
          {
            id: parentTaskId,
            directoryName: "parent-task",
            name: "agent_exec_parent",
            agentType: "exec",
            taskStatus: "reported",
            taskSticky: true,
          },
          {
            id: childTaskId,
            directoryName: "child-task",
            name: "agent_explore_child",
            agentType: "explore",
            taskStatus: "reported",
          },
        ],
      });

      await internal.cleanupReportedLeafTask(childTaskId);

      expect(remove.mock.calls).toEqual([[childTaskId, true]]);
      expect(findWorkspaceInConfig(config, childTaskId)).toBeUndefined();
      expect(findWorkspaceInConfig(config, parentTaskId)?.taskSticky).toBe(true);
    });

    test("workflow-owned completed descendants bypass preserve-until-archive cleanup", async () => {
      const workflowTaskId = "workflow-222";
      const childTaskId = "child-333";
      const { config, taskService, remove, rootWorkspaceId, internal } =
        await setupReportedTaskChain({
          taskChain: [
            {
              id: workflowTaskId,
              directoryName: "workflow-task",
              name: "agent_explore_workflow",
              agentType: "explore",
              taskStatus: "reported",
              workflowTask: { runId: "wfr_cleanup", stepId: "review" },
            },
            {
              id: childTaskId,
              directoryName: "child-task",
              name: "agent_exec_child",
              agentType: "exec",
              taskStatus: "reported",
            },
          ],
        });

      expect(await internal.canCleanupReportedTask(childTaskId)).toEqual({
        ok: true,
        cleanup: "legacy-remove",
        parentWorkspaceId: workflowTaskId,
      });
      expect(taskService.hasPreservedCompletedDescendants(rootWorkspaceId)).toBe(false);

      await internal.cleanupReportedLeafTask(childTaskId);

      expect(remove.mock.calls).toEqual([
        [childTaskId, true],
        [workflowTaskId, true],
      ]);
      expect(findWorkspaceInConfig(config, childTaskId)).toBeUndefined();
      expect(findWorkspaceInConfig(config, workflowTaskId)).toBeUndefined();
    });

    test("startup recovery leaves preserved descendants alone before archive", async () => {
      const { config, taskService, remove, taskChain } = await setupReportedTaskChain();
      const childTaskId = taskChain[1]?.id;
      expect(childTaskId).toBe("child-333");
      if (!childTaskId) {
        return;
      }

      await taskService.initialize();

      expect(remove).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)).toBeTruthy();
    });

    test("nested descendant becomes eligible once any archived ancestor exists", async () => {
      const grandparentTaskId = "grandparent-000";
      const parentTaskId = "parent-222";
      const childTaskId = "child-333";
      const { config, remove, internal } = await setupReportedTaskChain({
        taskChain: [
          {
            id: grandparentTaskId,
            directoryName: "grandparent-task",
            name: "agent_exec_grandparent",
            agentType: "exec",
            taskStatus: "reported",
          },
          {
            id: parentTaskId,
            directoryName: "parent-task",
            name: "agent_exec_parent",
            agentType: "exec",
            taskStatus: "reported",
          },
          {
            id: childTaskId,
            directoryName: "child-task",
            name: "agent_explore_child",
            agentType: "explore",
            taskStatus: "reported",
          },
        ],
      });

      await archiveWorkspaceInTestConfig(config, grandparentTaskId);

      const cleanupEligibility = await internal.canCleanupReportedTask(childTaskId);
      expect(cleanupEligibility).toEqual({
        ok: true,
        cleanup: "legacy-remove",
        parentWorkspaceId: parentTaskId,
      });

      await internal.cleanupReportedLeafTask(childTaskId);

      expect(remove.mock.calls).toEqual([
        [childTaskId, true],
        [parentTaskId, true],
      ]);
      expect(findWorkspaceInConfig(config, grandparentTaskId)).toBeTruthy();
    });

    test("pending patch artifacts still defer cleanup after archive", async () => {
      const { config, remove, rootWorkspaceId, taskChain, internal } =
        await setupReportedTaskChain();
      const parentTaskId = taskChain[0]?.id;
      const childTaskId = taskChain[1]?.id;
      expect(parentTaskId).toBe("parent-222");
      expect(childTaskId).toBe("child-333");
      if (!parentTaskId || !childTaskId) {
        return;
      }

      await archiveWorkspaceInTestConfig(config, rootWorkspaceId);

      const pendingArtifact: Awaited<
        ReturnType<typeof subagentGitPatchArtifacts.readSubagentGitPatchArtifact>
      > = {
        childTaskId,
        parentWorkspaceId: parentTaskId,
        createdAtMs: 1,
        status: "pending",
        projectArtifacts: [
          {
            projectPath: path.join(rootDir, "repo"),
            projectName: "repo",
            storageKey: "repo",
            status: "pending",
          },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 0,
      };
      const patchArtifactSpy = spyOn(
        subagentGitPatchArtifacts,
        "readSubagentGitPatchArtifact"
      ).mockResolvedValue(pendingArtifact);

      try {
        const cleanupEligibility = await internal.canCleanupReportedTask(childTaskId);
        expect(cleanupEligibility).toEqual({ ok: false, reason: "patch_pending" });

        await internal.cleanupReportedLeafTask(childTaskId);

        expect(remove).not.toHaveBeenCalled();
        expect(findWorkspaceInConfig(config, childTaskId)).toBeTruthy();
      } finally {
        patchArtifactSpy.mockRestore();
      }
    });

    test("with toggle off, current cleanup behavior remains unchanged", async () => {
      const { config, remove, taskChain, internal } = await setupReportedTaskChain({
        preserveSubagentsUntilArchive: false,
      });
      const parentTaskId = taskChain[0]?.id;
      const childTaskId = taskChain[1]?.id;
      expect(parentTaskId).toBe("parent-222");
      expect(childTaskId).toBe("child-333");
      if (!parentTaskId || !childTaskId) {
        return;
      }

      await internal.cleanupReportedLeafTask(childTaskId);

      expect(remove.mock.calls).toEqual([
        [childTaskId, true],
        [parentTaskId, true],
      ]);
      expect(findWorkspaceInConfig(config, childTaskId)).toBeUndefined();
      expect(findWorkspaceInConfig(config, parentTaskId)).toBeUndefined();
    });

    test("archive-triggered cleanup removes descendants deepest-first", async () => {
      const childTaskId = "child-222";
      const grandchildTaskId = "grandchild-333";
      const { config, taskService, remove, rootWorkspaceId } = await setupReportedTaskChain({
        taskChain: [
          {
            id: childTaskId,
            directoryName: "child-task",
            name: "agent_exec_child",
            agentType: "exec",
            taskStatus: "reported",
          },
          {
            id: grandchildTaskId,
            directoryName: "grandchild-task",
            name: "agent_explore_grandchild",
            agentType: "explore",
            taskStatus: "reported",
          },
        ],
      });

      await archiveWorkspaceInTestConfig(config, rootWorkspaceId);

      await taskService.cleanupReportedDescendantsAfterArchive(rootWorkspaceId);

      expect(remove.mock.calls).toEqual([
        [grandchildTaskId, true],
        [childTaskId, true],
      ]);
    });

    test("hasCompletedDescendants returns true when archived parent has pending-cleanup descendants", async () => {
      const childTaskId = "child-333";
      const { config, taskService, rootWorkspaceId } = await setupReportedTaskChain({
        taskChain: [
          {
            id: childTaskId,
            directoryName: "child-task",
            name: "agent_explore_child",
            agentType: "explore",
            taskStatus: "reported",
          },
        ],
      });

      await archiveWorkspaceInTestConfig(config, rootWorkspaceId);

      const pendingArtifact: Awaited<
        ReturnType<typeof subagentGitPatchArtifacts.readSubagentGitPatchArtifact>
      > = {
        childTaskId,
        parentWorkspaceId: rootWorkspaceId,
        createdAtMs: 1,
        status: "pending",
        projectArtifacts: [
          {
            projectPath: path.join(rootDir, "repo"),
            projectName: "repo",
            storageKey: "repo",
            status: "pending",
          },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 0,
      };
      const patchArtifactSpy = spyOn(
        subagentGitPatchArtifacts,
        "readSubagentGitPatchArtifact"
      ).mockResolvedValue(pendingArtifact);

      try {
        await taskService.cleanupReportedDescendantsAfterArchive(rootWorkspaceId);

        expect(taskService.hasCompletedDescendants(rootWorkspaceId)).toBe(true);
      } finally {
        patchArtifactSpy.mockRestore();
      }
    });

    test("hasPreservedCompletedDescendants returns true when descendants exist and toggle is on", async () => {
      const { taskService, rootWorkspaceId } = await setupReportedTaskChain();

      expect(taskService.hasPreservedCompletedDescendants(rootWorkspaceId)).toBe(true);
    });

    test("hasPreservedCompletedDescendants returns false when toggle is off", async () => {
      const { taskService, rootWorkspaceId } = await setupReportedTaskChain({
        preserveSubagentsUntilArchive: false,
      });

      expect(taskService.hasPreservedCompletedDescendants(rootWorkspaceId)).toBe(false);
    });
  });

  describe("parent auto-resume flood protection", () => {
    async function setupParentWithActiveChild(rootDirPath: string) {
      const config = await createTestConfig(rootDirPath);
      const projectPath = path.join(rootDirPath, "repo");
      await fsPromises.mkdir(projectPath, { recursive: true });

      const rootWorkspaceId = "root-resume-111";
      const childTaskId = "child-resume-222";

      await config.editConfig(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [
                projectWorkspace(projectPath, "root", rootWorkspaceId, {
                  aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" as const },
                }),
                projectWorkspace(projectPath, "child-task", childTaskId, {
                  parentWorkspaceId: rootWorkspaceId,
                  agentType: "explore",
                  taskStatus: "running" as const,
                  taskModelString: "openai:gpt-5.2",
                }),
              ],
            },
          ],
        ]),
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
      }));

      const { aiService } = createAIServiceMocks(config);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, {
        aiService,
        workspaceService,
      });

      const internal = taskService as unknown as {
        handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      };

      const makeStreamEndEvent = (): StreamEndEvent => ({
        type: "stream-end",
        workspaceId: rootWorkspaceId,
        messageId: `assistant-${Date.now()}`,
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });

      return {
        config,
        taskService,
        internal,
        sendMessage,
        rootWorkspaceId,
        childTaskId,
        projectPath,
        makeStreamEndEvent,
      };
    }

    test("stops auto-resuming after MAX_CONSECUTIVE_PARENT_AUTO_RESUMES (3)", async () => {
      const { internal, sendMessage, makeStreamEndEvent } =
        await setupParentWithActiveChild(rootDir);

      // First 3 calls should trigger sendMessage (limit is 3)
      for (let i = 0; i < 3; i++) {
        await internal.handleStreamEnd(makeStreamEndEvent());
      }
      expect(sendMessage).toHaveBeenCalledTimes(3);

      // 4th call should NOT trigger sendMessage (limit exceeded)
      await internal.handleStreamEnd(makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(3); // still 3
    });

    test("resetAutoResumeCount allows more resumes after limit", async () => {
      const { internal, sendMessage, taskService, rootWorkspaceId, makeStreamEndEvent } =
        await setupParentWithActiveChild(rootDir);

      // Exhaust the auto-resume limit
      for (let i = 0; i < 3; i++) {
        await internal.handleStreamEnd(makeStreamEndEvent());
      }
      expect(sendMessage).toHaveBeenCalledTimes(3);

      // Blocked (limit reached)
      await internal.handleStreamEnd(makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(3);

      // User sends a message → resets the counter
      taskService.resetAutoResumeCount(rootWorkspaceId);

      // Now auto-resume should work again
      await internal.handleStreamEnd(makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(4);
    });

    test("workflow-only quiescence resets the auto-resume budget", async () => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      await fsPromises.mkdir(projectPath, { recursive: true });

      const rootWorkspaceId = "root-workflow-budget";
      const firstRunId = "wfr_budget_first";
      const secondRunId = "wfr_budget_second";
      await config.editConfig(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [projectWorkspace(projectPath, "root", rootWorkspaceId)],
            },
          ],
        ]),
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
      }));

      const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
      await runStore.createRun({
        id: firstRunId,
        workspaceId: rootWorkspaceId,
        workflow: {
          name: "first-workflow",
          description: "First workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        now: "2026-06-04T00:00:00.000Z",
      });
      await runStore.appendStatus(firstRunId, "running", "2026-06-04T00:00:01.000Z");
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: config.getSessionDir(rootWorkspaceId),
        runId: firstRunId,
        createdAtMs: 1_000,
      });

      const { aiService } = createAIServiceMocks(config);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
      const internal = taskService as unknown as {
        handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      };
      const makeStreamEndEvent = (): StreamEndEvent => ({
        type: "stream-end",
        workspaceId: rootWorkspaceId,
        messageId: `assistant-${Date.now()}`,
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });

      for (let i = 0; i < 3; i++) {
        await internal.handleStreamEnd(makeStreamEndEvent());
      }
      expect(sendMessage).toHaveBeenCalledTimes(3);
      await internal.handleStreamEnd(makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(3);

      await runStore.appendStatus(firstRunId, "completed", "2026-06-04T00:00:02.000Z");
      await internal.handleStreamEnd(makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(3);

      await runStore.createRun({
        id: secondRunId,
        workspaceId: rootWorkspaceId,
        workflow: {
          name: "second-workflow",
          description: "Second workflow",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
        args: {},
        now: "2026-06-04T00:00:03.000Z",
      });
      await runStore.appendStatus(secondRunId, "running", "2026-06-04T00:00:04.000Z");
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: config.getSessionDir(rootWorkspaceId),
        runId: secondRunId,
        createdAtMs: 3_000,
      });

      await internal.handleStreamEnd(makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(4);
      expect(sendMessage).toHaveBeenLastCalledWith(
        rootWorkspaceId,
        expect.stringContaining(secondRunId),
        expect.anything(),
        expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
      );
    });

    test("markParentWorkspaceInterrupted suppresses parent auto-resume until reset", async () => {
      const { internal, sendMessage, taskService, rootWorkspaceId, makeStreamEndEvent } =
        await setupParentWithActiveChild(rootDir);

      taskService.markParentWorkspaceInterrupted(rootWorkspaceId);

      await internal.handleStreamEnd(makeStreamEndEvent());
      expect(sendMessage).not.toHaveBeenCalled();

      taskService.resetAutoResumeCount(rootWorkspaceId);

      await internal.handleStreamEnd(makeStreamEndEvent());
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    test("counter is per-workspace (different workspaces are independent)", async () => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      await fsPromises.mkdir(projectPath, { recursive: true });

      const rootA = "root-A";
      const rootB = "root-B";
      const childA = "child-A";
      const childB = "child-B";

      await config.editConfig(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [
                projectWorkspace(projectPath, "root-a", rootA, {
                  aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" as const },
                }),
                projectWorkspace(projectPath, "child-a", childA, {
                  parentWorkspaceId: rootA,
                  taskStatus: "running" as const,
                  taskModelString: "openai:gpt-5.2",
                }),
                projectWorkspace(projectPath, "root-b", rootB, {
                  aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" as const },
                }),
                projectWorkspace(projectPath, "child-b", childB, {
                  parentWorkspaceId: rootB,
                  taskStatus: "running" as const,
                  taskModelString: "openai:gpt-5.2",
                }),
              ],
            },
          ],
        ]),
        taskSettings: { maxParallelAgentTasks: 5, maxTaskNestingDepth: 3 },
      }));

      const { aiService } = createAIServiceMocks(config);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, {
        aiService,
        workspaceService,
      });

      // Exhaust limit on workspace A
      for (let i = 0; i < 3; i++) {
        await handleTaskServiceStreamEndForTest(taskService, {
          type: "stream-end",
          workspaceId: rootA,
          messageId: `a-${i}`,
          metadata: { model: "openai:gpt-5.2" },
          parts: [],
        });
      }
      expect(sendMessage).toHaveBeenCalledTimes(3);

      // Workspace A is now blocked
      await handleTaskServiceStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: rootA,
        messageId: "a-blocked",
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });
      expect(sendMessage).toHaveBeenCalledTimes(3); // still 3

      // Workspace B should still work (independent counter)
      await handleTaskServiceStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: rootB,
        messageId: "b-0",
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });
      expect(sendMessage).toHaveBeenCalledTimes(4); // B worked
    });
  });
});
