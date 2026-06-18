import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execSync } from "node:child_process";

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
import { TaskService, ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import type { WorkspaceForkParams } from "@/node/runtime/Runtime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as forkOrchestrator from "@/node/services/utils/forkOrchestrator";
import { Ok, Err, type Result } from "@/common/types/result";
import { defaultModel } from "@/common/utils/ai/models";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { ErrorEvent, StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";
import {
  buildWorkflowRunCardMessage,
  WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
} from "@/common/utils/workflowRunMessages";
import type { WorkspaceMetadata } from "@/common/types/workspace";
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
  await config.saveConfig({
    projects: new Map(projects),
    ...overrides,
  });
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

  const on = overrides?.on ?? mock(() => undefined);
  const off = overrides?.off ?? mock(() => undefined);

  return {
    aiService: {
      isStreaming,
      getWorkspaceMetadata,
      stopStream,
      createModel,
      getStreamInfo,
      on,
      off,
    } as unknown as AIService,
    isStreaming,
    getWorkspaceMetadata,
    stopStream,
    createModel,
    getStreamInfo,
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
    hasPendingQueuedOrPreparingTurn: ReturnType<typeof mock>;
    remove: ReturnType<typeof mock>;
    emit: ReturnType<typeof mock>;
    getInfo: ReturnType<typeof mock>;
    replaceHistory: ReturnType<typeof mock>;
    updateAgentStatus: ReturnType<typeof mock>;
    isExperimentEnabled: ReturnType<typeof mock>;
    emitChatEvent: ReturnType<typeof mock>;
    isWorkflowInvocationCurrent: ReturnType<typeof mock>;
  }>
): {
  workspaceService: WorkspaceService;
  sendMessage: ReturnType<typeof mock>;
  resumeStream: ReturnType<typeof mock>;
  clearQueue: ReturnType<typeof mock>;
  hasPendingQueuedOrPreparingTurn: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
  emit: ReturnType<typeof mock>;
  getInfo: ReturnType<typeof mock>;
  replaceHistory: ReturnType<typeof mock>;
  updateAgentStatus: ReturnType<typeof mock>;
  isExperimentEnabled: ReturnType<typeof mock>;
  emitChatEvent: ReturnType<typeof mock>;
  isWorkflowInvocationCurrent: ReturnType<typeof mock>;
} {
  const sendMessage =
    overrides?.sendMessage ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const resumeStream =
    overrides?.resumeStream ??
    mock((): Promise<Result<{ started: boolean }>> => Promise.resolve(Ok({ started: true })));
  const clearQueue = overrides?.clearQueue ?? mock((): Result<void> => Ok(undefined));
  const hasPendingQueuedOrPreparingTurn =
    overrides?.hasPendingQueuedOrPreparingTurn ?? mock(() => false);
  const remove =
    overrides?.remove ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const emit = overrides?.emit ?? mock(() => true);
  const getInfo = overrides?.getInfo ?? mock(() => Promise.resolve(null));
  const replaceHistory =
    overrides?.replaceHistory ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const updateAgentStatus =
    overrides?.updateAgentStatus ?? mock((): Promise<void> => Promise.resolve());
  const isExperimentEnabled = overrides?.isExperimentEnabled ?? mock(() => false);
  const emitChatEvent = overrides?.emitChatEvent ?? mock(() => undefined);
  const isWorkflowInvocationCurrent =
    overrides?.isWorkflowInvocationCurrent ?? mock(() => Promise.resolve(true));

  return {
    workspaceService: {
      sendMessage,
      resumeStream,
      clearQueue,
      hasPendingQueuedOrPreparingTurn,
      remove,
      emit,
      getInfo,
      replaceHistory,
      updateAgentStatus,
      isExperimentEnabled,
      emitChatEvent,
      isWorkflowInvocationCurrent,
    } as unknown as WorkspaceService,
    sendMessage,
    resumeStream,
    clearQueue,
    hasPendingQueuedOrPreparingTurn,
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

  const taskService = new TaskService(
    config,
    historyService,
    aiService,
    workspaceService,
    initStateManager,
    undefined,
    overrides?.sessionUsageService,
    overrides?.workspaceGoalService
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

    const second = await createAgentTask(taskService, first.data.taskId, "nested explore");
    expect(second.success).toBe(true);
    if (!second.success) return;

    const third = await createAgentTask(taskService, second.data.taskId, "nested explore again");
    expect(third.success).toBe(false);
    if (!third.success) {
      expect(third.error).toContain("maxTaskNestingDepth");
    }
  }, 20_000);

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

    const tasks = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .filter((workspace) => workspace.parentWorkspaceId === parentId);
    expect(tasks.map((task) => task.taskStatus)).toEqual(["starting", "starting", "queued"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createMany persists taskOnRefusal for both admitted and queued tasks", async () => {
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
        // Verifier-style opt-out: a refusal must fail honestly, not silently
        // continue on a configured fallback model.
        onRefusal: "fail" as const,
      }))
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((task) => task.status)).toEqual(["starting", "queued"]);

    // Both the immediately-admitted and the queued task must persist the
    // opt-out so the send path (and post-restart resumes) can honor it.
    const tasks = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .filter((workspace) => workspace.parentWorkspaceId === parentId);
    expect(tasks.map((task) => task.taskOnRefusal)).toEqual(["fail", "fail"]);
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
    assert(typeof taskId === "string" && taskId.length > 0, "created task id is required");

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
      .find((workspace) => workspace.id === taskId);
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
        const ws = project.workspaces.find((w) => w.id === running.data.taskId);
        if (ws) {
          ws.taskStatus = "reported";
        }
        const queuedWs = project.workspaces.find((w) => w.id === queued.data.taskId);
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
        queued.data.taskId,
        "task 2",
        expect.objectContaining({ agentId: "explore" }),
        expect.objectContaining({ allowQueuedAgentTask: true })
      );
      expect(runBackgroundInitSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ skipInitHook: true }),
        queued.data.taskId
      );
    } finally {
      runBackgroundInitSpy.mockRestore();
    }

    const cfg = config.loadConfigOrDefault();
    const started = Array.from(cfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queued.data.taskId);
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
    streamingWorkspaceId = parentTask.data.taskId;

    // With maxParallelAgentTasks=1, nested tasks will be created as queued.
    const childTask = await createAgentTask(taskService, parentTask.data.taskId, "child task");
    expect(childTask.success).toBe(true);
    if (!childTask.success) return;
    expect(childTask.data.status).toBe("queued");

    // Simulate a foreground await from the parent task workspace. This should allow the queued child
    // to start despite maxParallelAgentTasks=1, avoiding a scheduler deadlock.
    const waiter = taskService.waitForAgentReport(childTask.data.taskId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentTask.data.taskId,
    });

    const internal = taskService as unknown as {
      maybeStartQueuedTasks: () => Promise<void>;
      resolveWaiters: (taskId: string, report: { reportMarkdown: string; title?: string }) => void;
    };

    await internal.maybeStartQueuedTasks();

    expect(sendMessage).toHaveBeenCalledWith(
      childTask.data.taskId,
      "child task",
      expect.anything(),
      expect.objectContaining({ allowQueuedAgentTask: true })
    );

    const cfgAfterStart = config.loadConfigOrDefault();
    const startedEntry = Array.from(cfgAfterStart.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childTask.data.taskId);
    expect(startedEntry?.taskStatus).toBe("running");

    internal.resolveWaiters(childTask.data.taskId, { reportMarkdown: "ok" });
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
          const ws = project.workspaces.find((w) => w.id === running.data.taskId);
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
      const childEntry = workspaces.find((w) => w.id === queued.data.taskId);
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

    await config.saveConfig({
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
    });

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
      expect(result.data.taskId).toBe(childTaskId);

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

    await config.saveConfig({
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
    });

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
    await initStateManager.waitForInit(running.data.taskId);

    const queued = await createAgentTask(taskService, parentId, "task 2");
    expect(queued.success).toBe(true);
    if (!queued.success) return;
    expect(queued.data.status).toBe("queued");

    // Queued tasks should not create a worktree directory until they're dequeued.
    const cfgBeforeStart = config.loadConfigOrDefault();
    const queuedEntryBeforeStart = Array.from(cfgBeforeStart.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queued.data.taskId);
    expect(queuedEntryBeforeStart).toBeTruthy();
    await fsPromises.stat(queuedEntryBeforeStart!.path).then(
      () => {
        throw new Error("Expected queued task workspace path to not exist before start");
      },
      () => undefined
    );

    const queuedInitStatusPath = path.join(
      config.getSessionDir(queued.data.taskId),
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
        const ws = project.workspaces.find((w) => w.id === running.data.taskId);
        if (ws) {
          ws.taskStatus = "reported";
        }
      }
      return cfg;
    });

    await taskService.initialize();

    expect(sendMessage).toHaveBeenCalledWith(
      queued.data.taskId,
      "task 2",
      expect.anything(),
      expect.objectContaining({ allowQueuedAgentTask: true })
    );

    // Init should start only once the task is dequeued.
    await initStateManager.waitForInit(queued.data.taskId);
    expect(await fsPromises.stat(queuedInitStatusPath)).toBeTruthy();

    const cfgAfterStart = config.loadConfigOrDefault();
    const queuedEntryAfterStart = Array.from(cfgAfterStart.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queued.data.taskId);
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
      .find((w) => w.id === created.data.taskId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.path).toBe(projectPath);
    expect(childEntry?.runtimeConfig?.type).toBe("local");
    expect(childEntry?.aiSettings).toEqual({ model: "openai:gpt-5.2", thinkingLevel: "medium" });
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.2");
    expect(childEntry?.taskThinkingLevel).toBe("medium");
  }, 20_000);

  test("appends file-backed report instructions to ordinary subagent prompts", async () => {
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
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "do the thing", {
      experiments: { subagentFileReports: true },
    });

    expect(created.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      "aaaaaaaaaa",
      expect.any(String),
      expect.objectContaining({ experiments: { subagentFileReports: true } }),
      expect.anything()
    );
    const sentPrompt = (sendMessage as unknown as { mock: { calls: Array<[string, string]> } }).mock
      .calls[0]?.[1];
    assert(typeof sentPrompt === "string", "sendMessage prompt is required");
    expect(sentPrompt.startsWith("do the thing")).toBe(true);
    expect(sentPrompt).toContain("report.md");
    expect(sentPrompt).toContain("agent_report");
    expect(sentPrompt).toContain("reportMarkdownPath");
    expect(sentPrompt).toContain("structuredOutputPath");
    expect(sentPrompt).toContain("title");
    expect(sentPrompt).not.toContain("structured-output.json");
  }, 20_000);

  test("passes workflow output schema through file-backed report instructions", async () => {
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
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: {
        claims: { type: "array", items: { type: "string" } },
      },
    };

    const created = await createAgentTask(taskService, parentId, "collect claims", {
      experiments: { subagentFileReports: true },
      workflowTask: {
        runId: "wfr_123",
        stepId: "collect-claims",
        outputSchema,
      },
    });

    expect(created.success).toBe(true);
    const sentPrompt = (sendMessage as unknown as { mock: { calls: Array<[string, string]> } }).mock
      .calls[0]?.[1];
    assert(typeof sentPrompt === "string", "sendMessage prompt is required");
    const schemaStart = sentPrompt.indexOf("{");
    const schemaEnd = sentPrompt.lastIndexOf("}");
    assert(
      schemaStart >= 0 && schemaEnd > schemaStart,
      "file-report prompt must include a JSON schema"
    );
    expect(JSON.parse(sentPrompt.slice(schemaStart, schemaEnd + 1))).toEqual(outputSchema);
    expect(sentPrompt).toContain("structured-output.json");
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
      created.data.taskId,
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
      .find((w) => w.id === created.data.taskId);
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
      created.data.taskId,
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
      .find((w) => w.id === created.data.taskId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
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
      created.data.taskId,
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
      .find((w) => w.id === created.data.taskId);
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
      created.data.taskId,
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
      .find((w) => w.id === created.data.taskId);
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
      created.data.taskId,
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
      .find((w) => w.id === created.data.taskId);
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
      created.data.taskId,
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
    expect(await workspaceGoalFileExists(config, created.data.taskId)).toBe(false);
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
      created.data.taskId,
      "run exec task with parent runtime fallback",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "exec",
        thinkingLevel: "medium",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
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
      created.data.taskId,
      "run exec task with configured default",
      {
        model: "anthropic:claude-haiku-4-5",
        agentId: "exec",
        thinkingLevel: "off",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
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
      created.data.taskId,
      "run exec task with parent runtime thinking fallback",
      {
        model: resolvedModel,
        agentId: "exec",
        thinkingLevel: expectedThinkingLevel,
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
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
      created.data.taskId,
      "run exec task with subagent defaults",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "exec",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
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
      created.data.taskId,
      "run exec task with explicit args",
      {
        model: "openai:gpt-5.2",
        agentId: "exec",
        thinkingLevel: "medium",
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
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
      created.data.taskId,
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
      created.data.taskId,
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
      created.data.taskId,
      "run exec task with clamped default thinking",
      {
        model: resolvedModel,
        agentId: "exec",
        thinkingLevel: expectedThinkingLevel,
        experiments: undefined,
      },
      { agentInitiated: true }
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
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
      created.data.taskId,
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

  test("TaskService extracts file-backed agent_report payloads from tool output", async () => {
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
        input: { reportMarkdownPath: "report.md", structuredOutputPath: "structured-output.json" },
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

  test("TaskService preserves null structuredOutput from inline agent_report args", async () => {
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
        input: { reportMarkdown: "# Done", structuredOutput: null, title: null },
        output: { success: true },
      },
    ]);

    expect(report).toEqual({
      reportMarkdown: "# Done",
      structuredOutput: null,
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

    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
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
      definition: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
      definition: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
      definition: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
      definition: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
      definition: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
      metadata: { model: "openai:gpt-5.2" },
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
      definition: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
      metadata: { model: "openai:gpt-5.2" },
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
      definition: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
      definition: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
      definition: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
      definition: {
        name: "background-research",
        description: "Background research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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

  test("one-shot exemption — first stream-end suppressed, second stream-end nudges", async () => {
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

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root-1",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    // First stream-end: exemption active → no nudge.
    expect(sendMessage).not.toHaveBeenCalled();

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: rootWorkspaceId,
      messageId: "assistant-root-2",
      metadata: { model: "openai:gpt-5.2" },
      parts: [],
    });

    // Second stream-end: exemption consumed → nudge fires.
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

  test("multiple queue-backgrounded tasks — one-shot exemptions consumed together", async () => {
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

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(taskAId),
      expect.objectContaining({
        model: "openai:gpt-5.2",
        thinkingLevel: "medium",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
    expect(sendMessage).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.stringContaining(taskBId),
      expect.objectContaining({
        model: "openai:gpt-5.2",
        thinkingLevel: "medium",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("renewed foreground wait clears stale queue-backgrounded exemption", async () => {
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
      metadata: { model: "openai:gpt-5.2" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Hello from child",
            title: "Result",
            structuredOutput: { claims: ["fast handoff"] },
          },
          state: "output-available",
          output: { success: true },
        },
      ],
    });

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
    expect(serializedParentHistory).toContain("<structured_output_json>");
    expect(serializedParentHistory).toContain("claims");
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
      metadata: { model: "openai:gpt-5.2" },
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
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const parentHistory = await collectFullHistory(historyService, parentWorkspaceId);
    expect(JSON.stringify(parentHistory)).not.toContain("<mux_subagent_report>");
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
      metadata: { model: "openai:gpt-5.2" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
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
      metadata: { model: "openai:gpt-5.2" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
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

    const waiter = taskService.waitForAgentReport(taskId, { timeoutMs: 10_000 });

    const terminateResult = await taskService.terminateDescendantAgentTask(rootWorkspaceId, taskId);
    expect(terminateResult.success).toBe(true);

    let caught: unknown = null;
    try {
      await waiter;
    } catch (error: unknown) {
      caught = error;
    }
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
      new Set(taskService.listDescendantAgentTasks(rootWorkspaceId).map((task) => task.taskId))
    ).toEqual(new Set([regularTaskId, workflowChildTaskId, workflowTaskId]));
    expect(
      taskService
        .listDescendantAgentTasks(rootWorkspaceId, {
          excludeWorkflowTasks: true,
        })
        .map((task) => task.taskId)
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
      definition: {
        name: "interrupted",
        description: "Interrupted",
        scope: "built-in",
        executable: true,
      },
      definitionSource: "export default function workflow() { return {}; }\n",
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
      definition: {
        name: "inner-running",
        description: "Inner running",
        scope: "built-in",
        executable: true,
      },
      definitionSource: "export default function workflow() { return {}; }\n",
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
      definition: {
        name: "interrupted",
        description: "Interrupted",
        scope: "built-in",
        executable: true,
      },
      definitionSource: "export default function workflow() { return {}; }\n",
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
      expect.stringContaining("awaiting its final agent_report"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      }),
      expect.objectContaining({ synthetic: true })
    );
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
      definition: {
        name: "interrupted",
        description: "Interrupted",
        scope: "built-in",
        executable: true,
      },
      definitionSource: "export default function workflow() { return {}; }\n",
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
      expect.stringContaining("awaiting its final agent_report"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      }),
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
      expect.stringContaining("awaiting its final propose_plan"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^propose_plan$", action: "require" }],
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
      expect.stringContaining("awaiting its final propose_plan"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^propose_plan$", action: "require" }],
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

      const count = taskService.backgroundForegroundWaitsForWorkspace(parentId);
      expect(count).toBe(1);

      const err = await waitPromise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForegroundWaitBackgroundedError);

      const count2 = taskService.backgroundForegroundWaitsForWorkspace(parentId);
      expect(count2).toBe(0);
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
      expect.stringContaining("Your stream ended without calling agent_report"),
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
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    expect(report).toEqual({ reportMarkdown: "persisted report", title: "persisted title" });
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
            structuredOutput: { claims: ["durable"] },
          },
          state: "output-available",
          output: { success: true },
        },
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
      metadata: { model: "test-model" },
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
    expect(reportArtifact?.structuredOutput).toEqual({ claims: ["durable"] });

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
      metadata: { model: "test-model" },
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
      ]
    );
    expect((await partialService.writePartial(childOneId, childPartial)).success).toBe(true);
    expect((await partialService.commitPartial(childOneId)).success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childOneId,
      messageId: `assistant-${childOneId}-partial`,
      metadata: { model: "test-model" },
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
        ]
      );
      expect((await partialService.writePartial(childId, childPartial)).success).toBe(true);
      expect((await partialService.commitPartial(childId)).success).toBe(true);

      await handleTaskServiceStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: childId,
        messageId: `assistant-${childId}-partial`,
        metadata: { model: "test-model" },
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
      metadata: { model: "test-model" },
      parts: [],
    });
    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childTwoId,
      messageId: "assistant-child-two-interrupted-repeat",
      metadata: { model: "test-model" },
      parts: [],
    });

    const parentHistoryAfterInterrupt = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistoryAfterInterrupt);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("Report from child one");
    expect(
      serializedParentHistory.match(/<task_id>child-best-of-deferred-fallback-1<\/task_id>/g)
    ).toHaveLength(1);
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
      metadata: { model: "test-model" },
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
      metadata: { model: "test-model" },
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
      metadata: { model: "test-model" },
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
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model" },
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
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
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
        metadata: { model: childModel },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: input.toolCallId,
            toolName: "agent_report",
            input: { reportMarkdown: input.reportMarkdown, title: input.title },
            state: "output-available",
            output: { success: true },
          },
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
      definition: {
        name: "child-workflow",
        description: "Child workflow",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
      metadata: { model: "openai:gpt-4o-mini" },
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
      definition: {
        name: "child-workflow",
        description: "Child workflow",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
      metadata: { model: "openai:gpt-4o-mini" },
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
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Interrupted child report", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
      ],
    });

    const report = await waiter;
    expect(report).toEqual({ reportMarkdown: "Interrupted child report", title: "Result" });

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
    expect(persisted).toEqual({ reportMarkdown: "Interrupted child report", title: "Result" });
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

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    childStreaming = false;

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    const waiterError = await waiter.catch((error: unknown) => error);
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
      definition: {
        name: "interrupted",
        description: "Interrupted",
        scope: "built-in",
        executable: true,
      },
      definitionSource: "export default function workflow() { return {}; }\n",
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
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("interrupted");
    expect(maybeStartQueuedTasks).toHaveBeenCalledTimes(1);
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
      parts: [{ type: "text", text: "## Final answer\n\nImplicit report content from the child." }],
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
    expect(report?.title).toBeUndefined();

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
      expect.stringContaining("Your stream ended without calling agent_report"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      }),
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
      expect.stringContaining("Your stream ended without calling agent_report"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      }),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      childId,
      expect.stringContaining("Do not continue investigating or call other tools"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      }),
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
    expect(serializedParentHistory).toContain("<structured_output_json>");
    expect(serializedParentHistory).toContain("score");
    expect(
      serializedParentHistory.match(
        /<task_id>child-best-of-concurrent-deferred-fallback-1<\/task_id>/g
      )
    ).toHaveLength(1);
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
      serializedParentHistory.match(
        /<task_id>child-best-of-concurrent-direct-fallback-1<\/task_id>/g
      )
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
          taskStatus: "running",
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "max" },
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
      projectName: "repo",
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
    await config.saveConfig(preCfg);

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
      expect.stringContaining("Your stream ended without calling agent_report"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      }),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      childId,
      expect.stringContaining(
        "The previous agent_report attempt failed (last error: empty_output)"
      ),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      }),
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
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      childId,
      expect.stringContaining("Your stream ended without calling agent_report"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      }),
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
      metadata: { model: "openai:gpt-5.5-pro" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "All done", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
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
    await config.saveConfig({
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
    });
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
      .find((w) => w.id === created.data.taskId);
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
    await config.saveConfig(cfg);
  }

  test("reported leaf cleanup deletes the finished leaf but keeps siblings and parents", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "parent-222";
    const childTaskAId = "child-a-333";
    const childTaskBId = "child-b-444";

    await config.saveConfig({
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
    });

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

    await config.saveConfig({
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
    });

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

    await config.saveConfig({
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
    });

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

  describe("preserve subagents until archive", () => {
    interface ReportedTaskNode {
      id: string;
      directoryName: string;
      name: string;
      agentType: string;
      taskStatus?: "reported" | "interrupted";
      reportedAt?: string;
      workflowTask?: WorkspaceConfigEntry["workflowTask"];
    }

    type TaskCleanupEligibility =
      | { ok: true; parentWorkspaceId: string }
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
      expect(cleanupEligibility).toEqual({ ok: true, parentWorkspaceId: parentTaskId });

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

      await config.saveConfig({
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
      });

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
      await config.saveConfig({
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
      });

      const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(rootWorkspaceId) });
      await runStore.createRun({
        id: firstRunId,
        workspaceId: rootWorkspaceId,
        definition: {
          name: "first-workflow",
          description: "First workflow",
          scope: "built-in",
          executable: true,
        },
        definitionSource:
          "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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
        definition: {
          name: "second-workflow",
          description: "Second workflow",
          scope: "built-in",
          executable: true,
        },
        definitionSource:
          "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
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

      await config.saveConfig({
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
      });

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
