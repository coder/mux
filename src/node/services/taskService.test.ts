import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execSync } from "node:child_process";

import { Config } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { PartialService } from "@/node/services/partialService";
import { TaskService } from "@/node/services/taskService";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { Ok, Err, type Result } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { AIService } from "@/node/services/aiService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { InitStateManager as RealInitStateManager } from "@/node/services/initStateManager";

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

function createNullInitLogger() {
  return {
    logStep: (_message: string) => undefined,
    logStdout: (_line: string) => undefined,
    logStderr: (_line: string) => undefined,
    logComplete: (_exitCode: number) => undefined,
  };
}

function createMockInitStateManager(): InitStateManager {
  return {
    startInit: mock(() => undefined),
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
    on: ReturnType<typeof mock>;
    off: ReturnType<typeof mock>;
  }>
): {
  aiService: AIService;
  isStreaming: ReturnType<typeof mock>;
  getWorkspaceMetadata: ReturnType<typeof mock>;
  stopStream: ReturnType<typeof mock>;
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

  const on = overrides?.on ?? mock(() => undefined);
  const off = overrides?.off ?? mock(() => undefined);

  return {
    aiService: { isStreaming, getWorkspaceMetadata, stopStream, on, off } as unknown as AIService,
    isStreaming,
    getWorkspaceMetadata,
    stopStream,
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
  }>
): {
  workspaceService: WorkspaceService;
  sendMessage: ReturnType<typeof mock>;
  resumeStream: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
  emit: ReturnType<typeof mock>;
} {
  const sendMessage =
    overrides?.sendMessage ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const resumeStream =
    overrides?.resumeStream ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const remove =
    overrides?.remove ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const emit = overrides?.emit ?? mock(() => true);

  return {
    workspaceService: {
      sendMessage,
      resumeStream,
      remove,
      emit,
    } as unknown as WorkspaceService,
    sendMessage,
    resumeStream,
    remove,
    emit,
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
  partialService: PartialService;
  taskService: TaskService;
  aiService: AIService;
  workspaceService: WorkspaceService;
  initStateManager: InitStateManager;
} {
  const historyService = new HistoryService(config);
  const partialService = new PartialService(config, historyService);

  const aiService = overrides?.aiService ?? createAIServiceMocks(config).aiService;
  const workspaceService =
    overrides?.workspaceService ?? createWorkspaceServiceMocks().workspaceService;
  const initStateManager = overrides?.initStateManager ?? createMockInitStateManager();

  const taskService = new TaskService(
    config,
    historyService,
    partialService,
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
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 1 },
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
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error).toContain("maxTaskNestingDepth");
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
    const { workspaceService, resumeStream } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    expect(resumeStream).not.toHaveBeenCalled();

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

  test("applies subagentAiDefaults model + thinking overrides on task create", async () => {
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
              },
            ],
          },
        ],
      ]),
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
      subagentAiDefaults: {
        explore: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
      },
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentType: "explore",
      prompt: "run task with overrides",
      title: "Test task",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(created.data.taskId, "run task with overrides", {
      model: "anthropic:claude-haiku-4-5",
      thinkingLevel: "off",
    });

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
    const { workspaceService, resumeStream } = createWorkspaceServiceMocks();
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

    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(resumeStream).toHaveBeenCalledWith(
      rootWorkspaceId,
      expect.objectContaining({
        model: "openai:gpt-5.2",
        thinkingLevel: "medium",
      })
    );

    const resumeCalls = (resumeStream as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const options = resumeCalls[0]?.[1];
    if (!options || typeof options !== "object") {
      throw new Error("Expected resumeStream to be called with an options object");
    }

    const additionalSystemInstructions = (options as { additionalSystemInstructions?: unknown })
      .additionalSystemInstructions;
    expect(typeof additionalSystemInstructions).toBe("string");
    expect(additionalSystemInstructions).toContain(childTaskId);
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
    const { workspaceService, resumeStream } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    expect(resumeStream).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      })
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

  test("waitForAgentReport returns cached report even after workspace is removed", async () => {
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

    const internal = taskService as unknown as {
      resolveWaiters: (taskId: string, report: { reportMarkdown: string; title?: string }) => void;
    };
    internal.resolveWaiters(childId, { reportMarkdown: "ok", title: "t" });

    await config.removeWorkspace(childId);

    const report = await taskService.waitForAgentReport(childId, { timeoutMs: 10 });
    expect(report.reportMarkdown).toBe("ok");
    expect(report.title).toBe("t");
  });

  test("isDescendantAgentTask consults cached ancestry after workspace is removed", async () => {
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

    const internal = taskService as unknown as {
      resolveWaiters: (taskId: string, report: { reportMarkdown: string; title?: string }) => void;
    };
    internal.resolveWaiters(childId, { reportMarkdown: "ok", title: "t" });

    await config.removeWorkspace(childId);

    expect(taskService.isDescendantAgentTask(parentId, childId)).toBe(true);
    expect(taskService.isDescendantAgentTask("other-parent", childId)).toBe(false);
  });

  test("filterDescendantAgentTaskIds consults completed-report cache after cleanup", async () => {
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

    const internal = taskService as unknown as {
      resolveWaiters: (taskId: string, report: { reportMarkdown: string; title?: string }) => void;
    };
    internal.resolveWaiters(childId, { reportMarkdown: "ok", title: "t" });

    await config.removeWorkspace(childId);

    expect(taskService.filterDescendantAgentTaskIds(parentId, [childId])).toEqual([childId]);
    expect(taskService.filterDescendantAgentTaskIds("other-parent", [childId])).toEqual([]);
  });

  test("waitForAgentReport cache is cleared by TTL cleanup", async () => {
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

    const internal = taskService as unknown as {
      resolveWaiters: (taskId: string, report: { reportMarkdown: string; title?: string }) => void;
      cleanupExpiredCompletedReports: (nowMs: number) => void;
    };
    internal.resolveWaiters(childId, { reportMarkdown: "ok", title: "t" });

    await config.removeWorkspace(childId);

    internal.cleanupExpiredCompletedReports(Date.now() + 2 * 60 * 60 * 1000);

    let caught: unknown = null;
    try {
      await taskService.waitForAgentReport(childId, { timeoutMs: 10 });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/not found/i);
    }
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
    const { workspaceService, resumeStream, remove, emit } = createWorkspaceServiceMocks();
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

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now() },
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
      handleAgentReport: (event: {
        type: "tool-call-end";
        workspaceId: string;
        messageId: string;
        toolCallId: string;
        toolName: string;
        result: unknown;
        timestamp: number;
      }) => Promise<void>;
    };
    await internal.handleAgentReport({
      type: "tool-call-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      toolCallId: "agent-report-call-1",
      toolName: "agent_report",
      result: { success: true },
      timestamp: Date.now(),
    });

    const parentHistory = await historyService.getHistory(parentId);
    expect(parentHistory.success).toBe(true);

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
    expect(resumeStream).toHaveBeenCalled();
    expect(emit).toHaveBeenCalled();
  });

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
    const { workspaceService, resumeStream, remove } = createWorkspaceServiceMocks();
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
      { timestamp: Date.now() },
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
      handleAgentReport: (event: {
        type: "tool-call-end";
        workspaceId: string;
        messageId: string;
        toolCallId: string;
        toolName: string;
        result: unknown;
        timestamp: number;
      }) => Promise<void>;
    };
    await internal.handleAgentReport({
      type: "tool-call-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      toolCallId: "agent-report-call-1",
      toolName: "agent_report",
      result: { success: true },
      timestamp: Date.now(),
    });

    const parentHistory = await historyService.getHistory(parentId);
    expect(parentHistory.success).toBe(true);
    if (parentHistory.success) {
      // Original task tool call remains immutable ("running"), and a synthetic report message is appended.
      expect(parentHistory.data.length).toBeGreaterThanOrEqual(2);

      const taskCallMessage =
        parentHistory.data.find((m) => m.id === "assistant-parent-history") ?? null;
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

      const syntheticReport = parentHistory.data.find((m) => m.metadata?.synthetic) ?? null;
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
    }

    expect(remove).toHaveBeenCalled();
    expect(resumeStream).toHaveBeenCalled();
  });

  test("uses agent_report from stream-end parts instead of fallback", async () => {
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
    const { workspaceService, sendMessage, resumeStream, remove } = createWorkspaceServiceMocks();
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

    expect(sendMessage).not.toHaveBeenCalled();

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
    expect(resumeStream).toHaveBeenCalled();
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
    const { workspaceService, sendMessage, resumeStream, remove, emit } =
      createWorkspaceServiceMocks();
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

    const parentHistory = await historyService.getHistory(parentId);
    expect(parentHistory.success).toBe(true);

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
    expect(resumeStream).toHaveBeenCalled();
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
});
