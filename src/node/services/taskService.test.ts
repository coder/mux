import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { TaskService } from "./taskService";
import type { Config } from "@/node/config";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { AIService } from "@/node/services/aiService";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { MuxMessage } from "@/common/types/message";
import type { TaskSettings, TaskState } from "@/common/types/task";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { SendMessageError } from "@/common/types/errors";
import { Err, Ok, type Result } from "@/common/types/result";
import assert from "@/common/utils/assert";

interface SendMessageCall {
  workspaceId: string;
  message: string;
  options: SendMessageOptions | undefined;
}

interface CreateCall {
  projectPath: string;
  branchName: string;
  trunkBranch: string | undefined;
  title: string | undefined;
  runtimeConfig: RuntimeConfig | undefined;
}

class FakeAIService extends EventEmitter {
  private readonly streaming = new Set<string>();
  private readonly metadataById = new Map<string, FrontendWorkspaceMetadata>();

  setStreaming(workspaceId: string, value: boolean): void {
    if (value) {
      this.streaming.add(workspaceId);
    } else {
      this.streaming.delete(workspaceId);
    }
  }

  isStreaming(workspaceId: string): boolean {
    return this.streaming.has(workspaceId);
  }

  setWorkspaceMetadata(metadata: FrontendWorkspaceMetadata): void {
    this.metadataById.set(metadata.id, metadata);
  }

  getWorkspaceMetadata(workspaceId: string): Promise<Result<FrontendWorkspaceMetadata, string>> {
    const metadata = this.metadataById.get(workspaceId);
    return Promise.resolve(metadata ? Ok(metadata) : Err(`Workspace ${workspaceId} not found`));
  }
}

class FakeConfig {
  private readonly workspaceInfo = new Map<
    string,
    { projectPath: string; workspacePath: string }
  >();
  private readonly metadataById = new Map<string, FrontendWorkspaceMetadata>();
  private readonly taskStateById = new Map<string, TaskState | undefined>();
  private taskSettings: TaskSettings = { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 };

  setTaskSettings(settings: Partial<TaskSettings>): void {
    this.taskSettings = { ...this.taskSettings, ...settings };
  }

  addWorkspace(metadata: FrontendWorkspaceMetadata, workspacePath?: string): void {
    this.metadataById.set(metadata.id, metadata);
    this.workspaceInfo.set(metadata.id, {
      projectPath: metadata.projectPath,
      workspacePath: workspacePath ?? metadata.namedWorkspacePath,
    });
  }

  removeWorkspace(workspaceId: string): void {
    this.metadataById.delete(workspaceId);
    this.workspaceInfo.delete(workspaceId);
    this.taskStateById.delete(workspaceId);
  }

  findWorkspace(workspaceId: string): { workspacePath: string; projectPath: string } | null {
    return this.workspaceInfo.get(workspaceId) ?? null;
  }

  getTaskSettings(): TaskSettings {
    return this.taskSettings;
  }

  getWorkspaceTaskState(workspaceId: string): TaskState | undefined {
    return this.taskStateById.get(workspaceId);
  }

  setWorkspaceTaskState(workspaceId: string, taskState: TaskState): Promise<void> {
    this.taskStateById.set(workspaceId, taskState);

    const existing = this.metadataById.get(workspaceId);
    if (existing) {
      this.metadataById.set(workspaceId, {
        ...existing,
        parentWorkspaceId: taskState.parentWorkspaceId,
        agentType: taskState.agentType,
        taskState,
      });
    }
    return Promise.resolve();
  }

  countRunningAgentTasks(): number {
    let count = 0;
    for (const taskState of this.taskStateById.values()) {
      if (!taskState) continue;
      if (taskState.taskStatus === "running" || taskState.taskStatus === "awaiting_report") {
        count++;
      }
    }
    return count;
  }

  getWorkspaceNestingDepth(workspaceId: string): number {
    // Match behavior of Config.getWorkspaceNestingDepth() (but with cycle protection)
    let depth = 0;
    let current: string | undefined = workspaceId;
    const seen = new Set<string>();

    while (current) {
      if (seen.has(current)) break;
      seen.add(current);

      const meta = this.metadataById.get(current);
      const parentId = meta?.parentWorkspaceId;
      if (!parentId) break;
      depth++;
      current = parentId;
    }

    return depth;
  }

  getActiveAgentTaskWorkspaces(): Array<{ workspaceId: string; taskState: TaskState }> {
    const result: Array<{ workspaceId: string; taskState: TaskState }> = [];
    for (const [workspaceId, taskState] of this.taskStateById.entries()) {
      if (!taskState) continue;
      if (
        taskState.taskStatus === "queued" ||
        taskState.taskStatus === "running" ||
        taskState.taskStatus === "awaiting_report"
      ) {
        result.push({ workspaceId, taskState });
      }
    }
    return result;
  }

  getAllWorkspaceMetadata(): Promise<FrontendWorkspaceMetadata[]> {
    return Promise.resolve([...this.metadataById.values()]);
  }
}

class FakePartialService {
  private readonly partialByWorkspaceId = new Map<string, MuxMessage>();

  setPartial(workspaceId: string, partial: MuxMessage): void {
    this.partialByWorkspaceId.set(workspaceId, partial);
  }

  readPartial(workspaceId: string): Promise<MuxMessage | null> {
    return Promise.resolve(this.partialByWorkspaceId.get(workspaceId) ?? null);
  }

  writePartial(workspaceId: string, msg: MuxMessage): Promise<Result<void, string>> {
    this.partialByWorkspaceId.set(workspaceId, msg);
    return Promise.resolve(Ok(undefined));
  }
}

class FakeHistoryService {
  private readonly historyByWorkspaceId = new Map<string, MuxMessage[]>();

  setHistory(workspaceId: string, history: MuxMessage[]): void {
    this.historyByWorkspaceId.set(workspaceId, history);
  }

  getHistory(workspaceId: string): Promise<Result<MuxMessage[], string>> {
    return Promise.resolve(Ok(this.historyByWorkspaceId.get(workspaceId) ?? []));
  }

  updateHistory(workspaceId: string, msg: MuxMessage): Promise<Result<void, string>> {
    const existing = this.historyByWorkspaceId.get(workspaceId) ?? [];
    const idx = existing.findIndex((m) => m.id === msg.id);
    if (idx === -1) {
      return Promise.resolve(Err(`Message ${msg.id} not found`));
    }
    const updated = [...existing];
    updated[idx] = msg;
    this.historyByWorkspaceId.set(workspaceId, updated);
    return Promise.resolve(Ok(undefined));
  }
}

class FakeWorkspaceService {
  private nextWorkspaceId = 1;
  readonly createCalls: CreateCall[] = [];
  readonly sendMessageCalls: SendMessageCall[] = [];
  readonly resumeStreamCalls: Array<{
    workspaceId: string;
    options: SendMessageOptions | undefined;
  }> = [];
  readonly removedWorkspaceIds: string[] = [];
  readonly appendedMessages: Array<{ workspaceId: string; message: MuxMessage }> = [];

  sendMessageResult: Result<void, SendMessageError> = Ok(undefined);

  constructor(
    private readonly config: FakeConfig,
    private readonly aiService: FakeAIService
  ) {}

  create(
    projectPath: string,
    branchName: string,
    trunkBranch: string | undefined,
    title?: string,
    runtimeConfig?: RuntimeConfig
  ): Promise<Result<{ metadata: FrontendWorkspaceMetadata }, string>> {
    this.createCalls.push({ projectPath, branchName, trunkBranch, title, runtimeConfig });

    const id = `task_${this.nextWorkspaceId++}`;
    const metadata: FrontendWorkspaceMetadata = {
      id,
      name: branchName,
      projectName: "project",
      projectPath,
      runtimeConfig: runtimeConfig ?? { type: "local" },
      namedWorkspacePath: `/tmp/${branchName}`,
    };

    this.config.addWorkspace(metadata, metadata.namedWorkspacePath);
    this.aiService.setWorkspaceMetadata(metadata);

    return Promise.resolve(Ok({ metadata }));
  }

  sendMessage(
    workspaceId: string,
    message: string,
    options: SendMessageOptions | undefined = undefined
  ): Promise<Result<void, SendMessageError>> {
    this.sendMessageCalls.push({ workspaceId, message, options });
    return Promise.resolve(this.sendMessageResult);
  }

  resumeStream(
    workspaceId: string,
    options: SendMessageOptions | undefined = undefined
  ): Promise<Result<void, SendMessageError>> {
    this.resumeStreamCalls.push({ workspaceId, options });
    return Promise.resolve(Ok(undefined));
  }

  remove(workspaceId: string): Promise<Result<void, string>> {
    this.removedWorkspaceIds.push(workspaceId);
    this.config.removeWorkspace(workspaceId);
    return Promise.resolve(Ok(undefined));
  }

  appendToHistoryAndEmit(
    workspaceId: string,
    muxMessage: MuxMessage
  ): Promise<Result<void, string>> {
    this.appendedMessages.push({ workspaceId, message: muxMessage });
    return Promise.resolve(Ok(undefined));
  }
}

function createWorkspaceMetadata(
  id: string,
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  const base: FrontendWorkspaceMetadata = {
    id,
    name: id,
    projectName: "project",
    projectPath: "/project",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: `/tmp/${id}`,
  };

  return { ...base, ...overrides };
}

function createParentPartialWithPendingTask(toolCallId: string): MuxMessage {
  return {
    id: "parent_partial_msg",
    role: "assistant",
    parts: [
      { type: "text", text: "Working..." },
      {
        type: "dynamic-tool",
        toolCallId,
        toolName: "task",
        input: { subagent_type: "research", prompt: "do thing" },
        state: "input-available",
      },
    ],
    metadata: {
      partial: true,
      model: "anthropic:claude-sonnet-4-20250514",
      mode: "exec",
    },
  };
}

describe("TaskService", () => {
  let realSetTimeout: typeof globalThis.setTimeout;
  let realClearTimeout: typeof globalThis.clearTimeout;
  let scheduledTimeouts: Array<Parameters<typeof globalThis.clearTimeout>[0]>;

  beforeEach(() => {
    realSetTimeout = globalThis.setTimeout;
    realClearTimeout = globalThis.clearTimeout;
    scheduledTimeouts = [];

    type SetTimeoutHandler = Parameters<typeof realSetTimeout>[0];
    type SetTimeoutDelay = Parameters<typeof realSetTimeout>[1];

    const patched: typeof globalThis.setTimeout = ((
      handler: SetTimeoutHandler,
      _timeout?: SetTimeoutDelay,
      ...args: unknown[]
    ) => {
      const id = realSetTimeout(handler, 0, ...args);
      scheduledTimeouts.push(id as unknown as Parameters<typeof realClearTimeout>[0]);
      return id;
    }) as unknown as typeof globalThis.setTimeout;

    globalThis.setTimeout = patched;
  });

  afterEach(() => {
    for (const id of scheduledTimeouts) {
      realClearTimeout(id);
    }
    globalThis.setTimeout = realSetTimeout;
  });

  it("throws if parent workspace not found", () => {
    const config = new FakeConfig();
    const aiService = new FakeAIService();
    const workspaceService = new FakeWorkspaceService(config, aiService);
    const historyService = new FakeHistoryService();
    const partialService = new FakePartialService();

    const taskService = new TaskService(
      config as unknown as Config,
      workspaceService as unknown as WorkspaceService,
      historyService as unknown as HistoryService,
      partialService as unknown as PartialService,
      aiService as unknown as AIService
    );

    return expect(
      taskService.createTask({
        parentWorkspaceId: "missing",
        agentType: "research",
        prompt: "hello",
        runInBackground: true,
      })
    ).rejects.toThrow("Parent workspace missing not found");
  });

  it("enforces maxTaskNestingDepth", () => {
    const config = new FakeConfig();
    config.setTaskSettings({ maxTaskNestingDepth: 1 });

    const parent = createWorkspaceMetadata("parent");
    const child = createWorkspaceMetadata("child", { parentWorkspaceId: "parent" });
    config.addWorkspace(parent);
    config.addWorkspace(child);

    const aiService = new FakeAIService();
    aiService.setWorkspaceMetadata(parent);

    const workspaceService = new FakeWorkspaceService(config, aiService);
    const historyService = new FakeHistoryService();
    const partialService = new FakePartialService();

    const taskService = new TaskService(
      config as unknown as Config,
      workspaceService as unknown as WorkspaceService,
      historyService as unknown as HistoryService,
      partialService as unknown as PartialService,
      aiService as unknown as AIService
    );

    return expect(
      taskService.createTask({
        parentWorkspaceId: "child",
        agentType: "research",
        prompt: "too deep",
        runInBackground: true,
      })
    ).rejects.toThrow(/Maximum task nesting depth/);
  });

  it("queues tasks when maxParallelAgentTasks reached and inherits parent runtime", async () => {
    const config = new FakeConfig();
    config.setTaskSettings({ maxParallelAgentTasks: 1 });

    const parentRuntime: RuntimeConfig = { type: "local" };
    const parent = createWorkspaceMetadata("parent", { runtimeConfig: parentRuntime });
    config.addWorkspace(parent);

    // Simulate an existing running task occupying the only slot.
    const existingTask = createWorkspaceMetadata("running_task", { parentWorkspaceId: "parent" });
    config.addWorkspace(existingTask);
    await config.setWorkspaceTaskState("running_task", {
      taskStatus: "running",
      agentType: "research",
      parentWorkspaceId: "parent",
      prompt: "existing",
    });

    const aiService = new FakeAIService();
    aiService.setWorkspaceMetadata(parent);

    const workspaceService = new FakeWorkspaceService(config, aiService);
    const historyService = new FakeHistoryService();
    const partialService = new FakePartialService();

    const taskService = new TaskService(
      config as unknown as Config,
      workspaceService as unknown as WorkspaceService,
      historyService as unknown as HistoryService,
      partialService as unknown as PartialService,
      aiService as unknown as AIService
    );

    const result = await taskService.createTask({
      parentWorkspaceId: "parent",
      agentType: "research",
      prompt: "queued",
      runInBackground: true,
    });

    expect(result.status).toBe("queued");
    expect(workspaceService.createCalls).toHaveLength(1);
    expect(workspaceService.createCalls[0]?.runtimeConfig).toEqual(parentRuntime);
    expect(workspaceService.sendMessageCalls).toHaveLength(0);
  });

  it("starts queued tasks once a slot frees up", async () => {
    const config = new FakeConfig();
    config.setTaskSettings({ maxParallelAgentTasks: 1 });

    const parent = createWorkspaceMetadata("parent");
    config.addWorkspace(parent);

    const aiService = new FakeAIService();
    aiService.setWorkspaceMetadata(parent);

    const workspaceService = new FakeWorkspaceService(config, aiService);
    const historyService = new FakeHistoryService();
    const partialService = new FakePartialService();

    const taskService = new TaskService(
      config as unknown as Config,
      workspaceService as unknown as WorkspaceService,
      historyService as unknown as HistoryService,
      partialService as unknown as PartialService,
      aiService as unknown as AIService
    );

    // Start one task immediately.
    const task1 = await taskService.createTask({
      parentWorkspaceId: "parent",
      agentType: "research",
      prompt: "task 1",
      runInBackground: true,
    });
    expect(task1.status).toBe("running");

    // Second task should queue.
    const task2 = await taskService.createTask({
      parentWorkspaceId: "parent",
      agentType: "research",
      prompt: "task 2",
      runInBackground: true,
    });
    expect(task2.status).toBe("queued");

    // Mark first task reported to free slot.
    const task1State = config.getWorkspaceTaskState(task1.taskId);
    assert(task1State, "expected task1 to have task state");
    await config.setWorkspaceTaskState(task1.taskId, {
      ...task1State,
      taskStatus: "reported",
      reportedAt: new Date().toISOString(),
    });

    const internal = taskService as unknown as { processQueue: () => Promise<void> };
    await internal.processQueue();

    // Task 2 should start.
    expect(workspaceService.sendMessageCalls.map((c) => c.message)).toContain("task 2");
  });

  it("injects foreground task output into parent partial and auto-resumes the parent stream", async () => {
    const config = new FakeConfig();
    const parent = createWorkspaceMetadata("parent", {
      aiSettings: { model: "anthropic:claude-sonnet-4-20250514", thinkingLevel: "medium" },
    });
    config.addWorkspace(parent);

    const aiService = new FakeAIService();
    aiService.setWorkspaceMetadata(parent);
    aiService.setStreaming("parent", false);

    const workspaceService = new FakeWorkspaceService(config, aiService);
    const historyService = new FakeHistoryService();
    const partialService = new FakePartialService();

    // Parent has a pending `task` tool call.
    partialService.setPartial("parent", createParentPartialWithPendingTask("call_1"));

    // Child task workspace exists + is running.
    const child = createWorkspaceMetadata("task_1", { parentWorkspaceId: "parent" });
    config.addWorkspace(child);
    await config.setWorkspaceTaskState("task_1", {
      taskStatus: "running",
      agentType: "research",
      parentWorkspaceId: "parent",
      prompt: "do child thing",
      parentToolCallId: "call_1",
    });

    const taskService = new TaskService(
      config as unknown as Config,
      workspaceService as unknown as WorkspaceService,
      historyService as unknown as HistoryService,
      partialService as unknown as PartialService,
      aiService as unknown as AIService
    );

    const toolCallEndEvents: unknown[] = [];
    aiService.on("tool-call-end", (event: unknown) => {
      toolCallEndEvents.push(event);
    });

    const internal = taskService as unknown as {
      handleAgentReport: (
        workspaceId: string,
        args: { reportMarkdown: string; title?: string }
      ) => Promise<void>;
    };
    await internal.handleAgentReport("task_1", {
      reportMarkdown: "report body",
      title: "Report Title",
    });

    const parentPartialAfter = await partialService.readPartial("parent");
    assert(parentPartialAfter, "expected parent partial to exist after injection");
    const taskPart = parentPartialAfter.parts.find(
      (p) => p.type === "dynamic-tool" && p.toolName === "task" && p.toolCallId === "call_1"
    );
    assert(taskPart?.type === "dynamic-tool", "expected dynamic tool part");
    expect(taskPart.state).toBe("output-available");

    // Synthetic tool-call-end for the task tool should be emitted for UI update.
    const syntheticTaskToolEnd = toolCallEndEvents.find((e) => {
      const ev = e as { toolName?: string; toolCallId?: string };
      return ev.toolName === "task" && ev.toolCallId === "call_1";
    });
    expect(syntheticTaskToolEnd).toBeTruthy();

    // Parent should be resumed (safe auto-resume).
    expect(workspaceService.resumeStreamCalls).toHaveLength(1);
    expect(workspaceService.resumeStreamCalls[0]?.workspaceId).toBe("parent");

    // Report is posted as a parent-visible assistant message.
    expect(workspaceService.appendedMessages).toHaveLength(1);
    expect(workspaceService.appendedMessages[0]?.workspaceId).toBe("parent");
  });

  it("handles agent_report via tool-call-end events", async () => {
    const config = new FakeConfig();
    const parent = createWorkspaceMetadata("parent");
    const child = createWorkspaceMetadata("task_1", { parentWorkspaceId: "parent" });
    config.addWorkspace(parent);
    config.addWorkspace(child);
    await config.setWorkspaceTaskState("task_1", {
      taskStatus: "running",
      agentType: "research",
      parentWorkspaceId: "parent",
      prompt: "do work",
    });

    const aiService = new FakeAIService();
    const workspaceService = new FakeWorkspaceService(config, aiService);
    const historyService = new FakeHistoryService();
    const partialService = new FakePartialService();

    new TaskService(
      config as unknown as Config,
      workspaceService as unknown as WorkspaceService,
      historyService as unknown as HistoryService,
      partialService as unknown as PartialService,
      aiService as unknown as AIService
    );

    aiService.emit("tool-call-end", {
      workspaceId: "task_1",
      toolName: "agent_report",
      args: { reportMarkdown: "hello from report", title: "Hi" },
    });

    // Wait a tick for async handler to complete.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(config.getWorkspaceTaskState("task_1")?.taskStatus).toBe("reported");
    expect(workspaceService.appendedMessages).toHaveLength(1);
    expect(workspaceService.appendedMessages[0]?.workspaceId).toBe("parent");
  });

  it("sends an agent_report reminder when a task stream ends without reporting", async () => {
    const config = new FakeConfig();
    const parent = createWorkspaceMetadata("parent");
    const child = createWorkspaceMetadata("task_1", { parentWorkspaceId: "parent" });
    config.addWorkspace(parent);
    config.addWorkspace(child);
    await config.setWorkspaceTaskState("task_1", {
      taskStatus: "running",
      agentType: "research",
      parentWorkspaceId: "parent",
      prompt: "do work",
    });

    const aiService = new FakeAIService();
    const workspaceService = new FakeWorkspaceService(config, aiService);
    const historyService = new FakeHistoryService();
    const partialService = new FakePartialService();

    const taskService = new TaskService(
      config as unknown as Config,
      workspaceService as unknown as WorkspaceService,
      historyService as unknown as HistoryService,
      partialService as unknown as PartialService,
      aiService as unknown as AIService
    );

    const internal = taskService as unknown as { handleStreamEnd: (id: string) => Promise<void> };
    await internal.handleStreamEnd("task_1");

    expect(config.getWorkspaceTaskState("task_1")?.taskStatus).toBe("awaiting_report");
    expect(workspaceService.sendMessageCalls).toHaveLength(1);
    expect(workspaceService.sendMessageCalls[0]?.message).toMatch(/agent_report/);
    expect(workspaceService.sendMessageCalls[0]?.options?.toolPolicy).toEqual([
      { regex_match: "agent_report", action: "require" },
    ]);
  });

  it("falls back to a best-effort report if reminder send fails", async () => {
    const config = new FakeConfig();
    const parent = createWorkspaceMetadata("parent");
    const child = createWorkspaceMetadata("task_1", { parentWorkspaceId: "parent" });
    config.addWorkspace(parent);
    config.addWorkspace(child);
    await config.setWorkspaceTaskState("task_1", {
      taskStatus: "running",
      agentType: "research",
      parentWorkspaceId: "parent",
      prompt: "do work",
    });

    const aiService = new FakeAIService();
    const workspaceService = new FakeWorkspaceService(config, aiService);
    workspaceService.sendMessageResult = Err({
      type: "unknown",
      raw: "boom",
    });
    const historyService = new FakeHistoryService();
    const partialService = new FakePartialService();
    // Capture some assistant output so fallback report can include it.
    partialService.setPartial("task_1", {
      id: "child_partial",
      role: "assistant",
      parts: [{ type: "text", text: "final assistant output" }],
      metadata: { partial: true },
    });

    const taskService = new TaskService(
      config as unknown as Config,
      workspaceService as unknown as WorkspaceService,
      historyService as unknown as HistoryService,
      partialService as unknown as PartialService,
      aiService as unknown as AIService
    );

    const internal = taskService as unknown as { handleStreamEnd: (id: string) => Promise<void> };
    await internal.handleStreamEnd("task_1");

    const state = config.getWorkspaceTaskState("task_1");
    expect(state?.taskStatus).toBe("reported");
    expect(state?.reportMarkdown).toContain("final assistant output");
    expect(workspaceService.appendedMessages).toHaveLength(1);
  });

  it("rehydrates queued/running/awaiting_report tasks on startup", async () => {
    const config = new FakeConfig();
    config.setTaskSettings({ maxParallelAgentTasks: 5 });

    const parent = createWorkspaceMetadata("parent");
    config.addWorkspace(parent);

    const queued = createWorkspaceMetadata("task_q", { parentWorkspaceId: "parent" });
    const running = createWorkspaceMetadata("task_r", { parentWorkspaceId: "parent" });
    const awaiting = createWorkspaceMetadata("task_a", { parentWorkspaceId: "parent" });
    config.addWorkspace(queued);
    config.addWorkspace(running);
    config.addWorkspace(awaiting);

    await config.setWorkspaceTaskState("task_q", {
      taskStatus: "queued",
      agentType: "research",
      parentWorkspaceId: "parent",
      prompt: "queued prompt",
    });
    await config.setWorkspaceTaskState("task_r", {
      taskStatus: "running",
      agentType: "research",
      parentWorkspaceId: "parent",
      prompt: "running prompt",
    });
    await config.setWorkspaceTaskState("task_a", {
      taskStatus: "awaiting_report",
      agentType: "research",
      parentWorkspaceId: "parent",
      prompt: "awaiting prompt",
    });

    const aiService = new FakeAIService();
    const workspaceService = new FakeWorkspaceService(config, aiService);
    const historyService = new FakeHistoryService();
    const partialService = new FakePartialService();

    const taskService = new TaskService(
      config as unknown as Config,
      workspaceService as unknown as WorkspaceService,
      historyService as unknown as HistoryService,
      partialService as unknown as PartialService,
      aiService as unknown as AIService
    );

    await taskService.rehydrateTasks();

    // Queued tasks should be started by processQueue.
    expect(workspaceService.sendMessageCalls.map((c) => c.workspaceId)).toContain("task_q");
    expect(workspaceService.sendMessageCalls.map((c) => c.message)).toContain("queued prompt");

    // Running task should receive restart continuation message.
    expect(
      workspaceService.sendMessageCalls.some(
        (c) => c.workspaceId === "task_r" && c.message.includes("Mux was restarted")
      )
    ).toBe(true);

    // Awaiting_report should receive reminder requiring only agent_report.
    const awaitingCall = workspaceService.sendMessageCalls.find((c) => c.workspaceId === "task_a");
    expect(awaitingCall?.options?.toolPolicy).toEqual([
      { regex_match: "agent_report", action: "require" },
    ]);
  });

  it("does not remove a completed task workspace until its subtree is gone", async () => {
    const config = new FakeConfig();
    const parent = createWorkspaceMetadata("task_parent");
    const child = createWorkspaceMetadata("task_child", { parentWorkspaceId: "task_parent" });
    config.addWorkspace(parent);
    config.addWorkspace(child);

    await config.setWorkspaceTaskState("task_parent", {
      taskStatus: "reported",
      agentType: "research",
      parentWorkspaceId: "root",
      prompt: "parent",
    });
    await config.setWorkspaceTaskState("task_child", {
      taskStatus: "running",
      agentType: "research",
      parentWorkspaceId: "task_parent",
      prompt: "child",
    });

    const aiService = new FakeAIService();
    const workspaceService = new FakeWorkspaceService(config, aiService);
    const historyService = new FakeHistoryService();
    const partialService = new FakePartialService();

    const taskService = new TaskService(
      config as unknown as Config,
      workspaceService as unknown as WorkspaceService,
      historyService as unknown as HistoryService,
      partialService as unknown as PartialService,
      aiService as unknown as AIService
    );

    const internal = taskService as unknown as {
      cleanupTaskSubtree: (taskId: string) => Promise<void>;
    };

    await internal.cleanupTaskSubtree("task_parent");
    expect(workspaceService.removedWorkspaceIds).toHaveLength(0);

    // Remove child, then parent becomes eligible.
    config.removeWorkspace("task_child");
    await internal.cleanupTaskSubtree("task_parent");
    expect(workspaceService.removedWorkspaceIds).toEqual(["task_parent"]);
  });
});
