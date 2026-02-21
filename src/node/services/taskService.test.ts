import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execSync } from "node:child_process";

import { Config } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import {
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { upsertSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
import { TaskService } from "@/node/services/taskService";
import type { WorkspaceForkParams } from "@/node/runtime/Runtime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { Ok, Err, type Result } from "@/common/types/result";
import { defaultModel } from "@/common/utils/ai/models";
import type { PlanSubagentExecutorRouting } from "@/common/types/tasks";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
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
    on: ReturnType<typeof mock>;
    off: ReturnType<typeof mock>;
  }>
): {
  aiService: AIService;
  isStreaming: ReturnType<typeof mock>;
  getWorkspaceMetadata: ReturnType<typeof mock>;
  stopStream: ReturnType<typeof mock>;
  createModel: ReturnType<typeof mock>;
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

  const on = overrides?.on ?? mock(() => undefined);
  const off = overrides?.off ?? mock(() => undefined);

  return {
    aiService: {
      isStreaming,
      getWorkspaceMetadata,
      stopStream,
      createModel,
      on,
      off,
    } as unknown as AIService,
    isStreaming,
    getWorkspaceMetadata,
    stopStream,
    createModel,
    on,
    off,
  };
}

function createWorkspaceServiceMocks(
  overrides?: Partial<{
    sendMessage: ReturnType<typeof mock>;
    resumeStream: ReturnType<typeof mock>;
    remove: ReturnType<typeof mock>;
    emit: ReturnType<typeof mock>;
    getInfo: ReturnType<typeof mock>;
    replaceHistory: ReturnType<typeof mock>;
  }>
): {
  workspaceService: WorkspaceService;
  sendMessage: ReturnType<typeof mock>;
  resumeStream: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
  emit: ReturnType<typeof mock>;
  getInfo: ReturnType<typeof mock>;
  replaceHistory: ReturnType<typeof mock>;
} {
  const sendMessage =
    overrides?.sendMessage ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const resumeStream =
    overrides?.resumeStream ??
    mock((): Promise<Result<{ started: boolean }>> => Promise.resolve(Ok({ started: true })));
  const remove =
    overrides?.remove ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const emit = overrides?.emit ?? mock(() => true);
  const getInfo = overrides?.getInfo ?? mock(() => Promise.resolve(null));
  const replaceHistory =
    overrides?.replaceHistory ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));

  return {
    workspaceService: {
      sendMessage,
      resumeStream,
      remove,
      emit,
      getInfo,
      replaceHistory,
    } as unknown as WorkspaceService,
    sendMessage,
    resumeStream,
    remove,
    emit,
    getInfo,
    replaceHistory,
  };
}

function createTaskServiceHarness(
  config: Config,
  overrides?: {
    aiService?: AIService;
    workspaceService?: WorkspaceService;
    initStateManager?: InitStateManager;
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
    initStateManager
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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: parentPath,
                id: parentId,
                name: parentName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 2 },
    });
    const { taskService } = createTaskServiceHarness(config);

    const first = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "explore this repo",
      title: "Test task",
    });
    expect(first.success).toBe(true);
    if (!first.success) return;

    const second = await taskService.create({
      parentWorkspaceId: first.data.taskId,
      kind: "agent",
      agentType: "explore",
      prompt: "nested explore",
      title: "Test task",
    });
    expect(second.success).toBe(true);
    if (!second.success) return;

    const third = await taskService.create({
      parentWorkspaceId: second.data.taskId,
      kind: "agent",
      agentType: "explore",
      prompt: "nested explore again",
      title: "Test task",
    });
    expect(third.success).toBe(false);
    if (!third.success) {
      expect(third.error).toContain("maxTaskNestingDepth");
    }
  }, 20_000);

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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
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
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const running = await taskService.create({
      parentWorkspaceId: parent1Id,
      kind: "agent",
      agentType: "explore",
      prompt: "task 1",
      title: "Test task",
    });
    expect(running.success).toBe(true);
    if (!running.success) return;

    const queued = await taskService.create({
      parentWorkspaceId: parent2Id,
      kind: "agent",
      agentType: "explore",
      prompt: "task 2",
      title: "Test task",
    });
    expect(queued.success).toBe(true);
    if (!queued.success) return;
    expect(queued.data.status).toBe("queued");

    // Free the slot by marking the first task as reported.
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

    const cfg = config.loadConfigOrDefault();
    const started = Array.from(cfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queued.data.taskId);
    expect(started?.taskStatus).toBe("running");
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
    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: runtime.getWorkspacePath(projectPath, rootName),
                id: rootWorkspaceId,
                name: rootName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const parentTask = await taskService.create({
      parentWorkspaceId: rootWorkspaceId,
      kind: "agent",
      agentType: "explore",
      prompt: "parent task",
      title: "Test task",
    });
    expect(parentTask.success).toBe(true);
    if (!parentTask.success) return;
    streamingWorkspaceId = parentTask.data.taskId;

    // With maxParallelAgentTasks=1, nested tasks will be created as queued.
    const childTask = await taskService.create({
      parentWorkspaceId: parentTask.data.taskId,
      kind: "agent",
      agentType: "explore",
      prompt: "child task",
      title: "Test task",
    });
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
    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: runtime.getWorkspacePath(projectPath, parentName),
                id: parentId,
                name: parentName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

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

      const running = await taskService.create({
        parentWorkspaceId: parentId,
        kind: "agent",
        agentType: "explore",
        prompt: "task 1",
        title: "Test task",
      });
      expect(running.success).toBe(true);
      if (!running.success) return;

      const queued = await taskService.create({
        parentWorkspaceId: parentId,
        kind: "agent",
        agentType: "explore",
        prompt: "task 2",
        title: "Test task",
      });
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
    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: runtime.getWorkspacePath(projectPath, parentName),
                id: parentId,
                name: parentName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

    const initStateManager = new RealInitStateManager(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService,
      initStateManager: initStateManager as unknown as InitStateManager,
    });

    const running = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "task 1",
      title: "Test task",
    });
    expect(running.success).toBe(true);
    if (!running.success) return;

    // Wait for running task init (fire-and-forget) so the init-status file exists.
    await initStateManager.waitForInit(running.data.taskId);

    const queued = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "task 2",
      title: "Test task",
    });
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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "root"), id: rootWorkspaceId, name: "root" },
              {
                path: path.join(projectPath, "reported"),
                id: reportedTaskId,
                name: "agent_explore_reported",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "explore",
                taskStatus: "reported",
              },
              {
                path: path.join(projectPath, "queued"),
                id: queuedTaskId,
                name: "agent_explore_queued",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "explore",
                taskStatus: "queued",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: parentPath,
                id: parentId,
                name: parentName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 2, maxTaskNestingDepth: 3 },
    });
    const { taskService } = createTaskServiceHarness(config);

    const first = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "task 1",
      title: "Test task",
    });
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.data.status).toBe("running");

    const second = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "task 2",
      title: "Test task",
    });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.status).toBe("running");

    const third = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "task 3",
      title: "Test task",
    });
    expect(third.success).toBe(true);
    if (!third.success) return;
    expect(third.data.status).toBe("queued");
  }, 20_000);

  test("supports creating agent tasks from local (project-dir) workspaces without requiring git", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: projectPath,
                id: parentId,
                name: "parent",
                createdAt: new Date().toISOString(),
                runtimeConfig: { type: "local" },
                aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });
    const { taskService } = createTaskServiceHarness(config);

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "run task from local workspace",
      title: "Test task",
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

  test("inherits parent model + thinking when target agent has no global defaults", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: projectPath,
                id: parentId,
                name: "parent",
                createdAt: new Date().toISOString(),
                runtimeConfig: { type: "local" },
                aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "run task with inherited model",
      title: "Test task",
      modelString: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(created.data.taskId, "run task with inherited model", {
      model: "openai:gpt-5.3-codex",
      agentId: "explore",
      thinkingLevel: "xhigh",
      experiments: undefined,
    });

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
    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: projectPath,
                id: parentId,
                name: "parent",
                createdAt: new Date().toISOString(),
                runtimeConfig: { type: "local" },
                aiSettings: { model: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "run task inheriting parent settings",
      title: "Test task",
    });
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
      }
    );

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.taskId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);

  test("agentAiDefaults outrank workspace aiSettingsByAgent for same agent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
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
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
      agentAiDefaults: {
        explore: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "run task with same-agent conflicts",
      title: "Test task",
    });
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
      }
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
    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: projectPath,
                id: parentId,
                name: "parent",
                createdAt: new Date().toISOString(),
                runtimeConfig: { type: "local" },
                aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
      agentAiDefaults: {
        exec: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "custom",
      prompt: "run task with custom agent",
      title: "Test task",
      modelString: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(created.data.taskId, "run task with custom agent", {
      model: "openai:gpt-5.3-codex",
      agentId: "custom",
      thinkingLevel: "xhigh",
      experiments: undefined,
    });

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

  test("agentAiDefaults override inherited parent model on task create", async () => {
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
    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: projectPath,
                id: parentId,
                name: "parent",
                createdAt: new Date().toISOString(),
                runtimeConfig: { type: "local" },
                aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
      agentAiDefaults: {
        custom: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "custom",
      prompt: "run task with custom agent",
      title: "Test task",
      modelString: "openai:gpt-4o-mini",
      thinkingLevel: "off",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(created.data.taskId, "run task with custom agent", {
      model: "openai:gpt-5.3-codex",
      agentId: "custom",
      thinkingLevel: "xhigh",
      experiments: undefined,
    });
  }, 20_000);
  test("auto-resumes a parent workspace until background tasks finish", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: path.join(projectPath, "root"),
                id: rootWorkspaceId,
                name: "root",
                aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
              },
              {
                path: path.join(projectPath, "child-task"),
                id: childTaskId,
                name: "agent_explore_child",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "explore",
                taskStatus: "running",
                taskModelString: "openai:gpt-5.2",
                taskThinkingLevel: "medium",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
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

  test("auto-resume preserves parent agentId from stream-end event metadata", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-222";

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: path.join(projectPath, "root"),
                id: rootWorkspaceId,
                name: "root",
                aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
              },
              {
                path: path.join(projectPath, "child-task"),
                id: childTaskId,
                name: "agent_explore_child",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "explore",
                taskStatus: "running",
                taskModelString: "openai:gpt-5.2",
                taskThinkingLevel: "medium",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: path.join(projectPath, "root"),
                id: rootWorkspaceId,
                name: "root",
                aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
              },
              {
                path: path.join(projectPath, "child-task"),
                id: childTaskId,
                name: "agent_explore_child",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "explore",
                taskStatus: "running",
                taskModelString: "openai:gpt-5.2",
                taskThinkingLevel: "medium",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

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

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: path.join(projectPath, "root"),
                id: rootWorkspaceId,
                name: "root",
                aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
              },
              {
                path: path.join(projectPath, "child-task"),
                id: childTaskId,
                name: "agent_explore_child",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "explore",
                taskStatus: "running",
                taskModelString: "openai:gpt-5.2",
                taskThinkingLevel: "medium",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: path.join(projectPath, "parent"),
                id: parentWorkspaceId,
                name: "parent",
                aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
              },
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
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

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

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
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

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      parentWorkspaceId,
      expect.stringContaining("sub-agent task(s) have completed"),
      expect.objectContaining({
        agentId: "plan",
      }),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  test("terminateDescendantAgentTask stops stream, removes workspace, and rejects waiters", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const taskId = "task-222";

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "root"), id: rootWorkspaceId, name: "root" },
              {
                path: path.join(projectPath, "task"),
                id: taskId,
                name: "agent_exec_task",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "running",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "root"), id: rootWorkspaceId, name: "root" },
              {
                path: path.join(projectPath, "parent-task"),
                id: parentTaskId,
                name: "agent_exec_parent",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "running",
              },
              {
                path: path.join(projectPath, "child-task"),
                id: childTaskId,
                name: "agent_explore_child",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "running",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

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

  test("initialize resumes awaiting_report tasks after restart", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "parent"), id: parentId, name: "parent" },
              {
                path: path.join(projectPath, "child"),
                id: childId,
                name: "agent_explore_child",
                parentWorkspaceId: parentId,
                agentType: "explore",
                taskStatus: "awaiting_report",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

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

  test("initialize uses propose_plan reminders for plan-inheriting awaiting_report tasks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-custom-plan-222";
    const customAgentId = "custom_plan_runner";
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const childWorkspacePath = path.join(projectPath, "child-custom-plan");

    const customAgentDir = path.join(childWorkspacePath, ".mux", "agents");
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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: path.join(projectPath, "parent"),
                id: parentId,
                name: "parent",
                runtimeConfig,
              },
              {
                path: childWorkspacePath,
                id: childId,
                name: "agent_custom_plan_child",
                parentWorkspaceId: parentId,
                agentId: customAgentId,
                agentType: customAgentId,
                taskStatus: "awaiting_report",
                runtimeConfig,
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

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

  test("waitForAgentReport does not time out while task is queued", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "parent"), id: parentId, name: "parent" },
              {
                path: path.join(projectPath, "child"),
                id: childId,
                name: "agent_explore_child",
                parentWorkspaceId: parentId,
                agentType: "explore",
                taskStatus: "queued",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

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

  test("waitForAgentReport returns persisted report after workspace is removed", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "parent"), id: parentId, name: "parent" },
              {
                path: path.join(projectPath, "child"),
                id: childId,
                name: "agent_explore_child",
                parentWorkspaceId: parentId,
                agentType: "explore",
                taskStatus: "running",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "parent"), id: parentId, name: "parent" },
              {
                path: path.join(projectPath, "child"),
                id: childId,
                name: "agent_explore_child",
                parentWorkspaceId: parentId,
                agentType: "explore",
                taskStatus: "running",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "parent"), id: parentId, name: "parent" },
              {
                path: path.join(projectPath, "child"),
                id: childId,
                name: "agent_explore_child",
                parentWorkspaceId: parentId,
                agentType: "explore",
                taskStatus: "running",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

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

  test("waitForAgentReport falls back to persisted report after cache is cleared", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "parent"), id: parentId, name: "parent" },
              {
                path: path.join(projectPath, "child"),
                id: childId,
                name: "agent_explore_child",
                parentWorkspaceId: parentId,
                agentType: "explore",
                taskStatus: "running",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    });

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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "root"), id: rootWorkspaceId, name: "root" },
              {
                path: path.join(projectPath, "parent-task"),
                id: parentTaskId,
                name: "agent_exec_parent",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "running",
              },
              {
                path: path.join(projectPath, "child-task"),
                id: descendantTaskId,
                name: "agent_explore_child",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "running",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "root"), id: rootWorkspaceId, name: "root" },
              {
                path: path.join(projectPath, "parent-task"),
                id: parentTaskId,
                name: "agent_exec_parent",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "awaiting_report",
              },
              {
                path: path.join(projectPath, "child-task"),
                id: descendantTaskId,
                name: "agent_explore_child",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "running",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: parentPath,
                id: parentId,
                name: parentName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });
    const { aiService } = createAIServiceMocks(config);
    const failingSendMessage = mock(() => Promise.resolve(Err("send failed")));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage: failingSendMessage });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "do the thing",
      title: "Test task",
    });

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

  test("agent_report posts report to parent, finalizes pending task tool output, and triggers cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "parent"), id: parentId, name: "parent" },
              {
                path: path.join(projectPath, "child"),
                id: childId,
                name: "agent_explore_child",
                parentWorkspaceId: parentId,
                agentType: "explore",
                taskStatus: "running",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage, remove, emit } = createWorkspaceServiceMocks();
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
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    // Simulate stream manager committing the final partial right before natural stream end.
    const commitChildPartial = await partialService.commitPartial(childId);
    expect(commitChildPartial.success).toBe(true);

    await internal.handleStreamEnd({
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
    expect(ws?.taskStatus).toBe("reported");
    expect(ws?.reportedAt).toBeTruthy();

    expect(emit).toHaveBeenCalledWith(
      "metadata",
      expect.objectContaining({ workspaceId: childId })
    );

    expect(remove).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      parentId,
      expect.stringContaining("sub-agent task(s) have completed"),
      expect.any(Object),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
    expect(emit).toHaveBeenCalled();
  });

  test("agent_report generates git format-patch artifact for exec tasks and defers cleanup", async () => {
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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
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
                agentId: "exec",
                taskStatus: "running",
                runtimeConfig: { type: "local" },
                taskBaseCommitSha: baseCommitSha,
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, remove } = createWorkspaceServiceMocks();
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

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    const parentSessionDir = config.getSessionDir(parentId);
    const patchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId);

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    await internal.handleStreamEnd({
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
          if (remove.mock.calls.length > 0) {
            break;
          }
        } catch {
          // Keep polling until the patch file exists.
        }
      } else if (artifact?.status === "failed" || artifact?.status === "skipped") {
        throw new Error(
          `Patch artifact generation failed with status=${artifact.status}: ${artifact.error ?? "unknown error"}`
        );
      }

      if (Date.now() - start > 20_000) {
        throw new Error(
          `Timed out waiting for patch artifact generation (removeCalled=${remove.mock.calls.length > 0}, lastArtifact=${JSON.stringify(lastArtifact)})`
        );
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(artifact?.status).toBe("ready");

    await fsPromises.stat(patchPath);
    expect(remove).toHaveBeenCalled();
  }, 20_000);

  test("agent_report generates git format-patch artifact for exec-derived custom tasks", async () => {
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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
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
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, remove } = createWorkspaceServiceMocks();
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

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    const parentSessionDir = config.getSessionDir(parentId);
    const patchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId);

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    await internal.handleStreamEnd({
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
          if (remove.mock.calls.length > 0) {
            break;
          }
        } catch {
          // Keep polling until the patch file exists.
        }
      } else if (artifact?.status === "failed" || artifact?.status === "skipped") {
        throw new Error(
          `Patch artifact generation failed with status=${artifact.status}: ${artifact.error ?? "unknown error"}`
        );
      }

      if (Date.now() - start > 20_000) {
        throw new Error(
          `Timed out waiting for patch artifact generation (removeCalled=${remove.mock.calls.length > 0}, lastArtifact=${JSON.stringify(lastArtifact)})`
        );
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(artifact?.status).toBe("ready");

    await fsPromises.stat(patchPath);
    expect(remove).toHaveBeenCalled();
  }, 20_000);
  test("agent_report updates queued/running task tool output in parent history", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "parent"), id: parentId, name: "parent" },
              {
                path: path.join(projectPath, "child"),
                id: childId,
                name: "agent_explore_child",
                parentWorkspaceId: parentId,
                agentType: "explore",
                taskStatus: "running",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { aiService } = createAIServiceMocks(config);
    const {
      workspaceService,
      sendMessage: sendMessageMock,
      remove,
    } = createWorkspaceServiceMocks();
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

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
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

    expect(remove).toHaveBeenCalled();
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

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "parent"), id: parentId, name: "parent" },
              {
                path: path.join(projectPath, "child"),
                id: childId,
                name: "agent_explore_child",
                parentWorkspaceId: parentId,
                agentType: "explore",
                taskStatus: "awaiting_report",
                taskModelString: "openai:gpt-4o-mini",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage, remove } = createWorkspaceServiceMocks();
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    // Simulate the "second attempt" state (the task was already reminded).
    (taskService as unknown as { remindedAwaitingReport: Set<string> }).remindedAwaitingReport.add(
      childId
    );

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

    const internal = taskService as unknown as {
      handleStreamEnd: (event: unknown) => Promise<void>;
    };

    await internal.handleStreamEnd({
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
    expect(ws?.taskStatus).toBe("reported");

    expect(remove).toHaveBeenCalled();
    // Parent auto-resume fires after the child report is finalized at stream-end.
    expect(sendMessage).toHaveBeenCalled();
  });

  test("missing agent_report triggers one reminder, then posts fallback output and cleans up", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: path.join(projectPath, "parent"), id: parentId, name: "parent" },
              {
                path: path.join(projectPath, "child"),
                id: childId,
                name: "agent_explore_child",
                parentWorkspaceId: parentId,
                agentType: "explore",
                taskStatus: "running",
                taskModelString: "openai:gpt-4o-mini",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage, remove, emit } = createWorkspaceServiceMocks();
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

    const assistantOutput = createMuxMessage(
      "assistant-child-output",
      "assistant",
      "Final output without agent_report",
      { timestamp: Date.now() }
    );
    const appendChildHistory = await historyService.appendToHistory(childId, assistantOutput);
    expect(appendChildHistory.success).toBe(true);

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });
    expect(sendMessage).toHaveBeenCalled();

    const midCfg = config.loadConfigOrDefault();
    const midWs = Array.from(midCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(midWs?.taskStatus).toBe("awaiting_report");

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    const emitCalls = (emit as unknown as { mock: { calls: Array<[string, unknown]> } }).mock.calls;
    const metadataEmitsForChild = emitCalls.filter((call) => {
      const [eventName, payload] = call;
      if (eventName !== "metadata") return false;
      if (!payload || typeof payload !== "object") return false;
      const maybePayload = payload as { workspaceId?: unknown };
      return maybePayload.workspaceId === childId;
    });
    expect(metadataEmitsForChild).toHaveLength(2);

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
      expect(JSON.stringify(toolPart?.output)).toContain("Final output without agent_report");
      expect(JSON.stringify(toolPart?.output)).toContain("fallback");
    }

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("reported");

    expect(remove).toHaveBeenCalled();
    // Parent auto-resume now uses sendMessage instead of resumeStream
    expect(sendMessage).toHaveBeenCalledWith(
      parentId,
      expect.stringContaining("sub-agent task(s) have completed"),
      expect.any(Object),
      expect.objectContaining({ skipAutoResumeReset: true, synthetic: true })
    );
  });

  async function setupPlanModeStreamEndHarness(options?: {
    planSubagentExecutorRouting?: PlanSubagentExecutorRouting;
    planSubagentDefaultsToOrchestrator?: boolean;
    childAgentId?: string;
    disableOrchestrator?: boolean;
    parentAiSettingsByAgent?: Record<string, { model: string; thinkingLevel: ThinkingLevel }>;
    agentAiDefaults?: Record<
      string,
      { modelString: string; thinkingLevel: ThinkingLevel; enabled?: boolean }
    >;
    sendMessageOverride?: ReturnType<typeof mock>;
    aiServiceOverrides?: Parameters<typeof createAIServiceMocks>[1];
  }) {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-plan-222";
    const childAgentId = options?.childAgentId ?? "plan";
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const childWorkspacePath = path.join(projectPath, "child-plan");

    if (childAgentId !== "plan") {
      const customAgentDir = path.join(childWorkspacePath, ".mux", "agents");
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

    const agentAiDefaults = {
      ...(options?.agentAiDefaults ?? {}),
      ...(options?.disableOrchestrator
        ? {
            orchestrator: {
              modelString: "openai:gpt-4o-mini",
              thinkingLevel: "off" as ThinkingLevel,
              enabled: false,
            },
          }
        : {}),
    };

    await config.saveConfig({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: path.join(projectPath, "parent"),
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
          },
        ],
      ]),
      taskSettings: {
        maxParallelAgentTasks: 3,
        maxTaskNestingDepth: 3,
        planSubagentExecutorRouting:
          options?.planSubagentExecutorRouting ??
          (options?.planSubagentDefaultsToOrchestrator ? "orchestrator" : "exec"),
        ...(typeof options?.planSubagentDefaultsToOrchestrator === "boolean"
          ? {
              planSubagentDefaultsToOrchestrator: options.planSubagentDefaultsToOrchestrator,
            }
          : {}),
      },
      agentAiDefaults: Object.keys(agentAiDefaults).length > 0 ? agentAiDefaults : undefined,
    });

    const getInfo = mock(() => ({
      id: childId,
      name: "agent_plan_child",
      projectName: "repo",
      projectPath,
      runtimeConfig,
      namedWorkspacePath: childWorkspacePath,
    }));
    const replaceHistory = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
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
      childId,
      sendMessage,
      replaceHistory,
      createModel,
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

  test("stream-end with propose_plan success in auto routing falls back to exec when plan content is unavailable", async () => {
    const { config, childId, sendMessage, createModel, internal } =
      await setupPlanModeStreamEndHarness({
        planSubagentExecutorRouting: "auto",
      });

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

    expect(createModel).not.toHaveBeenCalled();
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

  test("stream-end with propose_plan success hands off to orchestrator when routing is orchestrator", async () => {
    const { config, childId, sendMessage, replaceHistory, internal } =
      await setupPlanModeStreamEndHarness({
        planSubagentExecutorRouting: "orchestrator",
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
      expect.stringContaining("orchestrating"),
      expect.objectContaining({ agentId: "orchestrator" }),
      expect.objectContaining({ synthetic: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.agentId).toBe("orchestrator");
    expect(updatedTask?.taskStatus).toBe("running");
  });

  test("orchestrator handoff inherits parent model when orchestrator defaults are unset", async () => {
    const { config, childId, sendMessage, internal } = await setupPlanModeStreamEndHarness({
      planSubagentExecutorRouting: "orchestrator",
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
      expect.stringContaining("orchestrating"),
      expect.objectContaining({
        agentId: "orchestrator",
        model: "openai:gpt-4o-mini",
        thinkingLevel: "off",
      }),
      expect.objectContaining({ synthetic: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const updatedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === childId);

    expect(updatedTask?.agentId).toBe("orchestrator");
    expect(updatedTask?.taskModelString).toBe("openai:gpt-4o-mini");
    expect(updatedTask?.taskThinkingLevel).toBe("off");
  });

  test("stream-end with propose_plan success falls back to exec when orchestrator is disabled", async () => {
    const { config, childId, sendMessage, internal } = await setupPlanModeStreamEndHarness({
      planSubagentExecutorRouting: "orchestrator",
      disableOrchestrator: true,
    });

    await internal.handleStreamEnd(makeSuccessfulProposePlanStreamEndEvent(childId));

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
    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "explore this repo",
      title: "Test task",
    });
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

  test("sibling reported task blocks parent deletion during cleanup", async () => {
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
            workspaces: [
              { path: path.join(projectPath, "root"), id: rootWorkspaceId, name: "root" },
              {
                path: path.join(projectPath, "parent-task"),
                id: parentTaskId,
                name: "agent_exec_parent",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "reported",
              },
              {
                path: path.join(projectPath, "child-task-a"),
                id: childTaskAId,
                name: "agent_explore_child_a",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "reported",
              },
              {
                path: path.join(projectPath, "child-task-b"),
                id: childTaskBId,
                name: "agent_explore_child_b",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "reported",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const isStreaming = mock(() => false);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const remove = mock(async (workspaceId: string): Promise<Result<void>> => {
      await config.removeWorkspace(workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: childTaskAId,
      messageId: "assistant-child-a",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(remove).toHaveBeenCalledWith(childTaskAId, true);

    const removedWorkspaceIds = (
      remove as unknown as { mock: { calls: Array<[string, boolean]> } }
    ).mock.calls.map((call) => call[0]);
    expect(removedWorkspaceIds).not.toContain(parentTaskId);
  });

  test("parent deletes only after all sibling children are cleaned up", async () => {
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
            workspaces: [
              { path: path.join(projectPath, "root"), id: rootWorkspaceId, name: "root" },
              {
                path: path.join(projectPath, "parent-task"),
                id: parentTaskId,
                name: "agent_exec_parent",
                parentWorkspaceId: rootWorkspaceId,
                agentType: "exec",
                taskStatus: "reported",
              },
              {
                path: path.join(projectPath, "child-task-a"),
                id: childTaskAId,
                name: "agent_explore_child_a",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "reported",
              },
              {
                path: path.join(projectPath, "child-task-b"),
                id: childTaskBId,
                name: "agent_explore_child_b",
                parentWorkspaceId: parentTaskId,
                agentType: "explore",
                taskStatus: "reported",
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
    });

    const isStreaming = mock(() => false);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const remove = mock(async (workspaceId: string): Promise<Result<void>> => {
      await config.removeWorkspace(workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: childTaskAId,
      messageId: "assistant-child-a",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: childTaskBId,
      messageId: "assistant-child-b",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(remove).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenNthCalledWith(1, childTaskAId, true);
    expect(remove).toHaveBeenNthCalledWith(2, childTaskBId, true);
    expect(remove).toHaveBeenNthCalledWith(3, parentTaskId, true);
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
              workspaces: [
                {
                  path: path.join(projectPath, "root"),
                  id: rootWorkspaceId,
                  name: "root",
                  aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" as const },
                },
                {
                  path: path.join(projectPath, "child-task"),
                  id: childTaskId,
                  name: "child-task",
                  parentWorkspaceId: rootWorkspaceId,
                  agentType: "explore",
                  taskStatus: "running" as const,
                  taskModelString: "openai:gpt-5.2",
                },
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
              workspaces: [
                {
                  path: path.join(projectPath, "root-a"),
                  id: rootA,
                  name: "root-a",
                  aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" as const },
                },
                {
                  path: path.join(projectPath, "child-a"),
                  id: childA,
                  name: "child-a",
                  parentWorkspaceId: rootA,
                  taskStatus: "running" as const,
                  taskModelString: "openai:gpt-5.2",
                },
                {
                  path: path.join(projectPath, "root-b"),
                  id: rootB,
                  name: "root-b",
                  aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" as const },
                },
                {
                  path: path.join(projectPath, "child-b"),
                  id: childB,
                  name: "child-b",
                  parentWorkspaceId: rootB,
                  taskStatus: "running" as const,
                  taskModelString: "openai:gpt-5.2",
                },
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

      const internal = taskService as unknown as {
        handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      };

      // Exhaust limit on workspace A
      for (let i = 0; i < 3; i++) {
        await internal.handleStreamEnd({
          type: "stream-end",
          workspaceId: rootA,
          messageId: `a-${i}`,
          metadata: { model: "openai:gpt-5.2" },
          parts: [],
        });
      }
      expect(sendMessage).toHaveBeenCalledTimes(3);

      // Workspace A is now blocked
      await internal.handleStreamEnd({
        type: "stream-end",
        workspaceId: rootA,
        messageId: "a-blocked",
        metadata: { model: "openai:gpt-5.2" },
        parts: [],
      });
      expect(sendMessage).toHaveBeenCalledTimes(3); // still 3

      // Workspace B should still work (independent counter)
      await internal.handleStreamEnd({
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
