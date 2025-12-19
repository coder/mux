import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";

import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { log } from "@/node/services/log";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { WorkspaceCreationResult } from "@/node/runtime/Runtime";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import { Ok, Err, type Result } from "@/common/types/result";
import type { TaskSettings } from "@/common/types/tasks";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { defaultModel, normalizeGatewayModel } from "@/common/utils/ai/models";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { ToolCallEndEvent, StreamEndEvent } from "@/common/types/stream";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";
import {
  AgentReportToolArgsSchema,
  TaskToolResultSchema,
  TaskToolArgsSchema,
} from "@/common/utils/tools/toolDefinitions";
import { formatSendMessageError } from "@/node/services/utils/sendMessageError";
import { enforceThinkingPolicy } from "@/browser/utils/thinking/policy";

export type TaskKind = "agent";

export type AgentTaskStatus = NonNullable<WorkspaceConfigEntry["taskStatus"]>;

export interface TaskCreateArgs {
  parentWorkspaceId: string;
  kind: TaskKind;
  agentType: string;
  prompt: string;
  description?: string;
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface TaskCreateResult {
  taskId: string;
  kind: TaskKind;
  status: "queued" | "running";
}

export interface TerminateAgentTaskResult {
  /** Task IDs terminated (includes descendants). */
  terminatedTaskIds: string[];
}

export interface DescendantAgentTaskInfo {
  taskId: string;
  status: AgentTaskStatus;
  parentWorkspaceId: string;
  agentType?: string;
  workspaceName?: string;
  title?: string;
  createdAt?: string;
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
  depth: number;
}

interface PendingTaskWaiter {
  createdAt: number;
  resolve: (report: { reportMarkdown: string; title?: string }) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface PendingTaskStartWaiter {
  createdAt: number;
  start: () => void;
  cleanup: () => void;
}

function isToolCallEndEvent(value: unknown): value is ToolCallEndEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type: unknown }).type === "tool-call-end" &&
    "workspaceId" in value &&
    typeof (value as { workspaceId: unknown }).workspaceId === "string"
  );
}

function isStreamEndEvent(value: unknown): value is StreamEndEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type: unknown }).type === "stream-end" &&
    "workspaceId" in value &&
    typeof (value as { workspaceId: unknown }).workspaceId === "string"
  );
}

function coerceNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSuccessfulToolResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    (value as { success?: unknown }).success === true
  );
}

function sanitizeAgentTypeForName(agentType: string): string {
  const normalized = agentType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/-+/g, "-")
    .replace(/^[_-]+|[_-]+$/g, "");

  return normalized.length > 0 ? normalized : "agent";
}

function buildAgentWorkspaceName(agentType: string, workspaceId: string): string {
  const safeType = sanitizeAgentTypeForName(agentType);
  const base = `agent_${safeType}_${workspaceId}`;
  // Hard cap to validation limit (64). Ensure stable suffix is preserved.
  if (base.length <= 64) return base;

  const suffix = `_${workspaceId}`;
  const maxPrefixLen = 64 - suffix.length;
  const prefix = `agent_${safeType}`.slice(0, Math.max(0, maxPrefixLen));
  const name = `${prefix}${suffix}`;
  return name.length <= 64 ? name : `agent_${workspaceId}`.slice(0, 64);
}

function getIsoNow(): string {
  return new Date().toISOString();
}

export class TaskService {
  private readonly mutex = new AsyncMutex();
  private readonly pendingWaitersByTaskId = new Map<string, PendingTaskWaiter[]>();
  private readonly pendingStartWaitersByTaskId = new Map<string, PendingTaskStartWaiter[]>();
  private readonly completedReportsByTaskId = new Map<
    string,
    { reportMarkdown: string; title?: string }
  >();
  private readonly remindedAwaitingReport = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly partialService: PartialService,
    private readonly aiService: AIService,
    private readonly workspaceService: WorkspaceService,
    private readonly initStateManager: InitStateManager
  ) {
    this.aiService.on("tool-call-end", (payload: unknown) => {
      if (!isToolCallEndEvent(payload)) return;
      if (payload.toolName !== "agent_report") return;
      void this.handleAgentReport(payload).catch((error: unknown) => {
        log.error("TaskService.handleAgentReport failed", { error });
      });
    });

    this.aiService.on("stream-end", (payload: unknown) => {
      if (!isStreamEndEvent(payload)) return;
      void this.handleStreamEnd(payload).catch((error: unknown) => {
        log.error("TaskService.handleStreamEnd failed", { error });
      });
    });
  }

  async initialize(): Promise<void> {
    await this.maybeStartQueuedTasks();

    const config = this.config.loadConfigOrDefault();
    const awaitingReportTasks = this.listAgentTaskWorkspaces(config).filter(
      (t) => t.taskStatus === "awaiting_report"
    );
    const runningTasks = this.listAgentTaskWorkspaces(config).filter(
      (t) => t.taskStatus === "running"
    );

    for (const task of awaitingReportTasks) {
      if (!task.id) continue;

      // Avoid resuming a task while it still has active descendants (it shouldn't report yet).
      const hasActiveDescendants = this.hasActiveDescendantAgentTasks(config, task.id);
      if (hasActiveDescendants) {
        continue;
      }

      // Restart-safety: if this task stream ends again without agent_report, fall back immediately.
      this.remindedAwaitingReport.add(task.id);

      const model = task.taskModelString ?? defaultModel;
      const resumeResult = await this.workspaceService.resumeStream(task.id, {
        model,
        thinkingLevel: task.taskThinkingLevel,
        toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
        additionalSystemInstructions:
          "This task is awaiting its final agent_report. Call agent_report exactly once now.",
      });
      if (!resumeResult.success) {
        log.error("Failed to resume awaiting_report task on startup", {
          taskId: task.id,
          error: resumeResult.error,
        });

        await this.fallbackReportMissingAgentReport({
          projectPath: task.projectPath,
          workspace: task,
        });
      }
    }

    for (const task of runningTasks) {
      if (!task.id) continue;
      // Best-effort: if mux restarted mid-stream, nudge the agent to continue and report.
      // Only do this when the task has no running descendants, to avoid duplicate spawns.
      const hasActiveDescendants = this.hasActiveDescendantAgentTasks(config, task.id);
      if (hasActiveDescendants) {
        continue;
      }

      const model = task.taskModelString ?? defaultModel;
      await this.workspaceService.sendMessage(
        task.id,
        "Mux restarted while this task was running. Continue where you left off. " +
          "When you have a final answer, call agent_report exactly once.",
        { model, thinkingLevel: task.taskThinkingLevel }
      );
    }
  }

  async create(args: TaskCreateArgs): Promise<Result<TaskCreateResult, string>> {
    const parentWorkspaceId = coerceNonEmptyString(args.parentWorkspaceId);
    if (!parentWorkspaceId) {
      return Err("Task.create: parentWorkspaceId is required");
    }
    if (args.kind !== "agent") {
      return Err("Task.create: unsupported kind");
    }

    const prompt = coerceNonEmptyString(args.prompt);
    if (!prompt) {
      return Err("Task.create: prompt is required");
    }

    const agentType = coerceNonEmptyString(args.agentType);
    if (!agentType) {
      return Err("Task.create: agentType is required");
    }

    await using _lock = await this.mutex.acquire();

    // Validate parent exists and fetch runtime context.
    const parentMetaResult = await this.aiService.getWorkspaceMetadata(parentWorkspaceId);
    if (!parentMetaResult.success) {
      return Err(`Task.create: parent workspace not found (${parentMetaResult.error})`);
    }
    const parentMeta = parentMetaResult.data;

    // Enforce nesting depth.
    const cfg = this.config.loadConfigOrDefault();
    const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;

    const parentEntry = this.findWorkspaceEntry(cfg, parentWorkspaceId);
    if (parentEntry?.workspace.taskStatus === "reported") {
      return Err("Task.create: cannot spawn new tasks after agent_report");
    }

    const requestedDepth = this.getTaskDepth(cfg, parentWorkspaceId) + 1;
    if (requestedDepth > taskSettings.maxTaskNestingDepth) {
      return Err(
        `Task.create: maxTaskNestingDepth exceeded (requestedDepth=${requestedDepth}, max=${taskSettings.maxTaskNestingDepth})`
      );
    }

    // Enforce parallelism (global).
    const activeCount = this.countActiveAgentTasks(cfg);
    const shouldQueue = activeCount >= taskSettings.maxParallelAgentTasks;

    const taskId = this.config.generateStableId();
    const workspaceName = buildAgentWorkspaceName(agentType, taskId);

    const nameValidation = validateWorkspaceName(workspaceName);
    if (!nameValidation.valid) {
      return Err(
        `Task.create: generated workspace name invalid (${nameValidation.error ?? "unknown error"})`
      );
    }

    const inheritedModelString =
      typeof args.modelString === "string" && args.modelString.trim().length > 0
        ? args.modelString.trim()
        : (parentMeta.aiSettings?.model ?? defaultModel);
    const inheritedThinkingLevel: ThinkingLevel =
      args.thinkingLevel ?? parentMeta.aiSettings?.thinkingLevel ?? "off";

    const normalizedAgentType = agentType.trim().toLowerCase();
    const subagentDefaults = cfg.subagentAiDefaults?.[normalizedAgentType];

    const taskModelString = subagentDefaults?.modelString ?? inheritedModelString;
    const canonicalModel = normalizeGatewayModel(taskModelString).trim();

    const requestedThinkingLevel = subagentDefaults?.thinkingLevel ?? inheritedThinkingLevel;
    const effectiveThinkingLevel = enforceThinkingPolicy(canonicalModel, requestedThinkingLevel);

    const parentRuntimeConfig = parentMeta.runtimeConfig;
    const taskRuntimeConfig: RuntimeConfig = parentRuntimeConfig;

    const runtime = createRuntime(taskRuntimeConfig, {
      projectPath: parentMeta.projectPath,
    });

    // Init status streaming (mirrors WorkspaceService.create)
    this.initStateManager.startInit(taskId, parentMeta.projectPath);
    const initLogger = {
      logStep: (message: string) => this.initStateManager.appendOutput(taskId, message, false),
      logStdout: (line: string) => this.initStateManager.appendOutput(taskId, line, false),
      logStderr: (line: string) => this.initStateManager.appendOutput(taskId, line, true),
      logComplete: (exitCode: number) => void this.initStateManager.endInit(taskId, exitCode),
    };

    const createdAt = getIsoNow();

    // Note: Local project-dir runtimes share the same directory (unsafe by design).
    // For worktree/ssh runtimes we attempt a fork first; otherwise fall back to createWorkspace.
    const forkResult = await runtime.forkWorkspace({
      projectPath: parentMeta.projectPath,
      sourceWorkspaceName: parentMeta.name,
      newWorkspaceName: workspaceName,
      initLogger,
    });

    const trunkBranch = forkResult.success
      ? (forkResult.sourceBranch ?? parentMeta.name)
      : parentMeta.name;
    const createResult: WorkspaceCreationResult = forkResult.success
      ? { success: true as const, workspacePath: forkResult.workspacePath }
      : await runtime.createWorkspace({
          projectPath: parentMeta.projectPath,
          branchName: workspaceName,
          trunkBranch,
          directoryName: workspaceName,
          initLogger,
        });

    if (!createResult.success || !createResult.workspacePath) {
      return Err(
        `Task.create: failed to create agent workspace (${createResult.error ?? "unknown error"})`
      );
    }

    const workspacePath = createResult.workspacePath;

    // Persist workspace entry before starting work so it's durable across crashes.
    await this.config.editConfig((config) => {
      let projectConfig = config.projects.get(parentMeta.projectPath);
      if (!projectConfig) {
        projectConfig = { workspaces: [] };
        config.projects.set(parentMeta.projectPath, projectConfig);
      }

      projectConfig.workspaces.push({
        path: workspacePath,
        id: taskId,
        name: workspaceName,
        title: args.description,
        createdAt,
        runtimeConfig: taskRuntimeConfig,
        aiSettings: { model: canonicalModel, thinkingLevel: effectiveThinkingLevel },
        parentWorkspaceId,
        agentType,
        taskStatus: shouldQueue ? "queued" : "running",
        taskModelString,
        taskThinkingLevel: effectiveThinkingLevel,
      });
      return config;
    });

    // Emit metadata update so the UI sees the workspace immediately.
    const allMetadata = await this.config.getAllWorkspaceMetadata();
    const childMeta = allMetadata.find((m) => m.id === taskId) ?? null;
    this.workspaceService.emit("metadata", { workspaceId: taskId, metadata: childMeta });

    // Kick init hook (best-effort, async).
    void runtime
      .initWorkspace({
        projectPath: parentMeta.projectPath,
        branchName: workspaceName,
        trunkBranch,
        workspacePath,
        initLogger,
      })
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        initLogger.logStderr(`Initialization failed: ${errorMessage}`);
        initLogger.logComplete(-1);
      });

    if (shouldQueue) {
      // Persist the prompt as the first user message so the task can be resumed later.
      const messageId = `user-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      const userMessage = createMuxMessage(messageId, "user", prompt, {
        timestamp: Date.now(),
      });

      const appendResult = await this.historyService.appendToHistory(taskId, userMessage);
      if (!appendResult.success) {
        await this.rollbackFailedTaskCreate(runtime, parentMeta.projectPath, workspaceName, taskId);
        return Err(`Task.create: failed to persist queued prompt (${appendResult.error})`);
      }

      // Schedule queue processing (best-effort).
      void this.maybeStartQueuedTasks();
      return Ok({ taskId, kind: "agent", status: "queued" });
    }

    // Start immediately (counts towards parallel limit).
    const sendResult = await this.workspaceService.sendMessage(taskId, prompt, {
      model: taskModelString,
      thinkingLevel: effectiveThinkingLevel,
    });
    if (!sendResult.success) {
      const message =
        typeof sendResult.error === "string"
          ? sendResult.error
          : formatSendMessageError(sendResult.error).message;
      await this.rollbackFailedTaskCreate(runtime, parentMeta.projectPath, workspaceName, taskId);
      return Err(message);
    }

    return Ok({ taskId, kind: "agent", status: "running" });
  }

  async terminateDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string
  ): Promise<Result<TerminateAgentTaskResult, string>> {
    assert(
      ancestorWorkspaceId.length > 0,
      "terminateDescendantAgentTask: ancestorWorkspaceId must be non-empty"
    );
    assert(taskId.length > 0, "terminateDescendantAgentTask: taskId must be non-empty");

    const terminatedTaskIds: string[] = [];

    {
      await using _lock = await this.mutex.acquire();

      const cfg = this.config.loadConfigOrDefault();
      const entry = this.findWorkspaceEntry(cfg, taskId);
      if (!entry?.workspace.parentWorkspaceId) {
        return Err("Task not found");
      }

      if (!this.isDescendantAgentTask(ancestorWorkspaceId, taskId)) {
        return Err("Task is not a descendant of this workspace");
      }

      // Terminate the entire subtree to avoid orphaned descendant tasks.
      const descendants = this.listDescendantAgentTaskIds(cfg, taskId);
      const toTerminate = Array.from(new Set([taskId, ...descendants]));

      // Delete leaves first to avoid leaving children with missing parents.
      const depthById = new Map<string, number>();
      for (const id of toTerminate) {
        depthById.set(id, this.getTaskDepth(cfg, id));
      }
      toTerminate.sort((a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0));

      const terminationError = new Error("Task terminated");

      for (const id of toTerminate) {
        // Best-effort: stop any active stream immediately to avoid further token usage.
        try {
          const stopResult = await this.aiService.stopStream(id, { abandonPartial: true });
          if (!stopResult.success) {
            log.debug("terminateDescendantAgentTask: stopStream failed", { taskId: id });
          }
        } catch (error: unknown) {
          log.debug("terminateDescendantAgentTask: stopStream threw", { taskId: id, error });
        }

        this.remindedAwaitingReport.delete(id);
        this.completedReportsByTaskId.delete(id);
        this.rejectWaiters(id, terminationError);

        const removeResult = await this.workspaceService.remove(id, true);
        if (!removeResult.success) {
          return Err(`Failed to remove task workspace (${id}): ${removeResult.error}`);
        }

        terminatedTaskIds.push(id);
      }
    }

    // Free slots and start any queued tasks (best-effort).
    await this.maybeStartQueuedTasks();

    return Ok({ terminatedTaskIds });
  }

  private async rollbackFailedTaskCreate(
    runtime: ReturnType<typeof createRuntime>,
    projectPath: string,
    workspaceName: string,
    taskId: string
  ): Promise<void> {
    try {
      await this.config.removeWorkspace(taskId);
    } catch (error: unknown) {
      log.error("Task.create rollback: failed to remove workspace from config", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.workspaceService.emit("metadata", { workspaceId: taskId, metadata: null });

    try {
      const deleteResult = await runtime.deleteWorkspace(projectPath, workspaceName, true);
      if (!deleteResult.success) {
        log.error("Task.create rollback: failed to delete workspace", {
          taskId,
          error: deleteResult.error,
        });
      }
    } catch (error: unknown) {
      log.error("Task.create rollback: runtime.deleteWorkspace threw", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const sessionDir = this.config.getSessionDir(taskId);
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
    } catch (error: unknown) {
      log.error("Task.create rollback: failed to remove session directory", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  waitForAgentReport(
    taskId: string,
    options?: { timeoutMs?: number; abortSignal?: AbortSignal }
  ): Promise<{ reportMarkdown: string; title?: string }> {
    assert(taskId.length > 0, "waitForAgentReport: taskId must be non-empty");

    const cached = this.completedReportsByTaskId.get(taskId);
    if (cached) {
      return Promise.resolve(cached);
    }

    const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000; // 10 minutes
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "waitForAgentReport: timeoutMs invalid");

    return new Promise<{ reportMarkdown: string; title?: string }>((resolve, reject) => {
      // Validate existence early to avoid waiting on never-resolving task IDs.
      const cfg = this.config.loadConfigOrDefault();
      const taskWorkspaceEntry = this.findWorkspaceEntry(cfg, taskId);
      if (!taskWorkspaceEntry) {
        reject(new Error("Task not found"));
        return;
      }

      let timeout: ReturnType<typeof setTimeout> | null = null;
      let startWaiter: PendingTaskStartWaiter | null = null;
      let abortListener: (() => void) | null = null;

      const startReportTimeout = () => {
        if (timeout) return;
        timeout = setTimeout(() => {
          entry.cleanup();
          reject(new Error("Timed out waiting for agent_report"));
        }, timeoutMs);
      };

      const cleanupStartWaiter = () => {
        if (!startWaiter) return;
        startWaiter.cleanup();
        startWaiter = null;
      };

      const entry: PendingTaskWaiter = {
        createdAt: Date.now(),
        resolve: (report) => {
          entry.cleanup();
          resolve(report);
        },
        reject: (error) => {
          entry.cleanup();
          reject(error);
        },
        cleanup: () => {
          const current = this.pendingWaitersByTaskId.get(taskId);
          if (current) {
            const next = current.filter((w) => w !== entry);
            if (next.length === 0) {
              this.pendingWaitersByTaskId.delete(taskId);
            } else {
              this.pendingWaitersByTaskId.set(taskId, next);
            }
          }

          cleanupStartWaiter();

          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }

          if (abortListener && options?.abortSignal) {
            options.abortSignal.removeEventListener("abort", abortListener);
            abortListener = null;
          }
        },
      };

      const list = this.pendingWaitersByTaskId.get(taskId) ?? [];
      list.push(entry);
      this.pendingWaitersByTaskId.set(taskId, list);

      // Don't start the execution timeout while the task is still queued.
      // The timer starts once the child actually begins running (queued -> running).
      const initialStatus = taskWorkspaceEntry.workspace.taskStatus;
      if (initialStatus === "queued") {
        const startWaiterEntry: PendingTaskStartWaiter = {
          createdAt: Date.now(),
          start: startReportTimeout,
          cleanup: () => {
            const currentStartWaiters = this.pendingStartWaitersByTaskId.get(taskId);
            if (currentStartWaiters) {
              const next = currentStartWaiters.filter((w) => w !== startWaiterEntry);
              if (next.length === 0) {
                this.pendingStartWaitersByTaskId.delete(taskId);
              } else {
                this.pendingStartWaitersByTaskId.set(taskId, next);
              }
            }
          },
        };
        startWaiter = startWaiterEntry;

        const currentStartWaiters = this.pendingStartWaitersByTaskId.get(taskId) ?? [];
        currentStartWaiters.push(startWaiterEntry);
        this.pendingStartWaitersByTaskId.set(taskId, currentStartWaiters);

        // Close the race where the task starts between the initial config read and registering the waiter.
        const cfgAfterRegister = this.config.loadConfigOrDefault();
        const afterEntry = this.findWorkspaceEntry(cfgAfterRegister, taskId);
        if (afterEntry?.workspace.taskStatus !== "queued") {
          cleanupStartWaiter();
          startReportTimeout();
        }
      } else {
        startReportTimeout();
      }

      if (options?.abortSignal) {
        if (options.abortSignal.aborted) {
          entry.cleanup();
          reject(new Error("Interrupted"));
          return;
        }

        abortListener = () => {
          entry.cleanup();
          reject(new Error("Interrupted"));
        };
        options.abortSignal.addEventListener("abort", abortListener, { once: true });
      }
    });
  }

  getAgentTaskStatus(taskId: string): AgentTaskStatus | null {
    assert(taskId.length > 0, "getAgentTaskStatus: taskId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const entry = this.findWorkspaceEntry(cfg, taskId);
    const status = entry?.workspace.taskStatus;
    return status ?? null;
  }

  hasActiveDescendantAgentTasksForWorkspace(workspaceId: string): boolean {
    assert(
      workspaceId.length > 0,
      "hasActiveDescendantAgentTasksForWorkspace: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    return this.hasActiveDescendantAgentTasks(cfg, workspaceId);
  }

  listActiveDescendantAgentTaskIds(workspaceId: string): string[] {
    assert(
      workspaceId.length > 0,
      "listActiveDescendantAgentTaskIds: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const childrenByParent = new Map<string, string[]>();
    const statusById = new Map<string, AgentTaskStatus | undefined>();

    for (const task of this.listAgentTaskWorkspaces(cfg)) {
      statusById.set(task.id!, task.taskStatus);
      const parent = task.parentWorkspaceId;
      if (!parent) continue;
      const list = childrenByParent.get(parent) ?? [];
      list.push(task.id!);
      childrenByParent.set(parent, list);
    }

    const activeStatuses = new Set<AgentTaskStatus>(["queued", "running", "awaiting_report"]);
    const result: string[] = [];
    const stack: string[] = [...(childrenByParent.get(workspaceId) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      const status = statusById.get(next);
      if (status && activeStatuses.has(status)) {
        result.push(next);
      }
      const children = childrenByParent.get(next);
      if (children) {
        for (const child of children) {
          stack.push(child);
        }
      }
    }
    return result;
  }

  listDescendantAgentTasks(
    workspaceId: string,
    options?: { statuses?: AgentTaskStatus[] }
  ): DescendantAgentTaskInfo[] {
    assert(workspaceId.length > 0, "listDescendantAgentTasks: workspaceId must be non-empty");

    const statuses = options?.statuses;
    const statusFilter = statuses && statuses.length > 0 ? new Set(statuses) : null;

    const cfg = this.config.loadConfigOrDefault();
    const tasks = this.listAgentTaskWorkspaces(cfg);

    const childrenByParent = new Map<
      string,
      Array<WorkspaceConfigEntry & { projectPath: string }>
    >();
    const byId = new Map<string, WorkspaceConfigEntry & { projectPath: string }>();

    for (const task of tasks) {
      const taskId = task.id!;
      byId.set(taskId, task);

      const parent = task.parentWorkspaceId;
      if (!parent) continue;
      const list = childrenByParent.get(parent) ?? [];
      list.push(task);
      childrenByParent.set(parent, list);
    }

    const result: DescendantAgentTaskInfo[] = [];

    const stack: Array<{ taskId: string; depth: number }> = [];
    for (const child of childrenByParent.get(workspaceId) ?? []) {
      stack.push({ taskId: child.id!, depth: 1 });
    }

    while (stack.length > 0) {
      const next = stack.pop()!;
      const entry = byId.get(next.taskId);
      if (!entry) continue;

      assert(
        entry.parentWorkspaceId,
        `listDescendantAgentTasks: task ${next.taskId} is missing parentWorkspaceId`
      );

      const status: AgentTaskStatus = entry.taskStatus ?? "running";
      if (!statusFilter || statusFilter.has(status)) {
        result.push({
          taskId: next.taskId,
          status,
          parentWorkspaceId: entry.parentWorkspaceId,
          agentType: entry.agentType,
          workspaceName: entry.name,
          title: entry.title,
          createdAt: entry.createdAt,
          modelString: entry.aiSettings?.model,
          thinkingLevel: entry.aiSettings?.thinkingLevel,
          depth: next.depth,
        });
      }

      for (const child of childrenByParent.get(next.taskId) ?? []) {
        stack.push({ taskId: child.id!, depth: next.depth + 1 });
      }
    }

    // Stable ordering: oldest first, then depth (ties by taskId for determinism).
    result.sort((a, b) => {
      const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (aTime !== bTime) return aTime - bTime;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.taskId.localeCompare(b.taskId);
    });

    return result;
  }

  private listDescendantAgentTaskIds(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): string[] {
    assert(workspaceId.length > 0, "listDescendantAgentTaskIds: workspaceId must be non-empty");

    const childrenByParent = new Map<string, string[]>();

    for (const task of this.listAgentTaskWorkspaces(config)) {
      const parent = task.parentWorkspaceId;
      if (!parent) continue;
      const list = childrenByParent.get(parent) ?? [];
      list.push(task.id!);
      childrenByParent.set(parent, list);
    }

    const result: string[] = [];
    const stack: string[] = [...(childrenByParent.get(workspaceId) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      result.push(next);
      const children = childrenByParent.get(next);
      if (children) {
        for (const child of children) {
          stack.push(child);
        }
      }
    }
    return result;
  }

  isDescendantAgentTask(ancestorWorkspaceId: string, taskId: string): boolean {
    assert(ancestorWorkspaceId.length > 0, "isDescendantAgentTask: ancestorWorkspaceId required");
    assert(taskId.length > 0, "isDescendantAgentTask: taskId required");

    const cfg = this.config.loadConfigOrDefault();
    const parentById = new Map<string, string | undefined>();
    for (const task of this.listAgentTaskWorkspaces(cfg)) {
      parentById.set(task.id!, task.parentWorkspaceId);
    }

    let current = taskId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) return false;
      if (parent === ancestorWorkspaceId) return true;
      current = parent;
    }

    throw new Error(
      `isDescendantAgentTask: possible parentWorkspaceId cycle starting at ${taskId}`
    );
  }

  // --- Internal orchestration ---

  private listAgentTaskWorkspaces(
    config: ReturnType<Config["loadConfigOrDefault"]>
  ): Array<WorkspaceConfigEntry & { projectPath: string }> {
    const tasks: Array<WorkspaceConfigEntry & { projectPath: string }> = [];
    for (const [projectPath, project] of config.projects) {
      for (const workspace of project.workspaces) {
        if (!workspace.id) continue;
        if (!workspace.parentWorkspaceId) continue;
        tasks.push({ ...workspace, projectPath });
      }
    }
    return tasks;
  }

  private countActiveAgentTasks(config: ReturnType<Config["loadConfigOrDefault"]>): number {
    let activeCount = 0;
    for (const task of this.listAgentTaskWorkspaces(config)) {
      const status: AgentTaskStatus = task.taskStatus ?? "running";
      if (status === "running" || status === "awaiting_report") {
        activeCount += 1;
        continue;
      }

      // Defensive: a task may still be streaming even after it transitioned to another status
      // (e.g. tool-call-end happened but the stream hasn't ended yet). Count it as active so we
      // never exceed the configured parallel limit.
      if (task.id && this.aiService.isStreaming(task.id)) {
        activeCount += 1;
      }
    }

    return activeCount;
  }

  private hasActiveDescendantAgentTasks(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): boolean {
    assert(workspaceId.length > 0, "hasActiveDescendantAgentTasks: workspaceId must be non-empty");

    const childrenByParent = new Map<string, string[]>();
    const statusById = new Map<string, AgentTaskStatus | undefined>();

    for (const task of this.listAgentTaskWorkspaces(config)) {
      statusById.set(task.id!, task.taskStatus);
      const parent = task.parentWorkspaceId;
      if (!parent) continue;
      const list = childrenByParent.get(parent) ?? [];
      list.push(task.id!);
      childrenByParent.set(parent, list);
    }

    const activeStatuses = new Set<AgentTaskStatus>(["queued", "running", "awaiting_report"]);
    const stack: string[] = [...(childrenByParent.get(workspaceId) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      const status = statusById.get(next);
      if (status && activeStatuses.has(status)) {
        return true;
      }
      const children = childrenByParent.get(next);
      if (children) {
        for (const child of children) {
          stack.push(child);
        }
      }
    }

    return false;
  }

  private getTaskDepth(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): number {
    assert(workspaceId.length > 0, "getTaskDepth: workspaceId must be non-empty");

    const parentById = new Map<string, string | undefined>();
    for (const task of this.listAgentTaskWorkspaces(config)) {
      parentById.set(task.id!, task.parentWorkspaceId);
    }

    let depth = 0;
    let current = workspaceId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) break;
      depth += 1;
      current = parent;
    }

    if (depth >= 32) {
      throw new Error(`getTaskDepth: possible parentWorkspaceId cycle starting at ${workspaceId}`);
    }

    return depth;
  }

  private async maybeStartQueuedTasks(): Promise<void> {
    await using _lock = await this.mutex.acquire();

    const config = this.config.loadConfigOrDefault();
    const taskSettings: TaskSettings = config.taskSettings ?? DEFAULT_TASK_SETTINGS;

    const activeCount = this.countActiveAgentTasks(config);
    const availableSlots = Math.max(0, taskSettings.maxParallelAgentTasks - activeCount);
    if (availableSlots === 0) return;

    const queued = this.listAgentTaskWorkspaces(config)
      .filter((t) => t.taskStatus === "queued")
      .sort((a, b) => {
        const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
        return aTime - bTime;
      })
      .slice(0, availableSlots);

    for (const task of queued) {
      if (!task.id) continue;

      // Start by resuming from the queued prompt in history.
      const model = task.taskModelString ?? defaultModel;
      const resumeResult = await this.workspaceService.resumeStream(task.id, {
        model,
        thinkingLevel: task.taskThinkingLevel,
      });

      if (!resumeResult.success) {
        log.error("Failed to start queued task", { taskId: task.id, error: resumeResult.error });
        continue;
      }

      await this.setTaskStatus(task.id, "running");
    }
  }

  private async setTaskStatus(workspaceId: string, status: AgentTaskStatus): Promise<void> {
    assert(workspaceId.length > 0, "setTaskStatus: workspaceId must be non-empty");

    await this.config.editConfig((config) => {
      for (const [_projectPath, project] of config.projects) {
        const ws = project.workspaces.find((w) => w.id === workspaceId);
        if (ws) {
          ws.taskStatus = status;
          return config;
        }
      }
      throw new Error(`setTaskStatus: workspace ${workspaceId} not found`);
    });

    const allMetadata = await this.config.getAllWorkspaceMetadata();
    const metadata = allMetadata.find((m) => m.id === workspaceId) ?? null;
    this.workspaceService.emit("metadata", { workspaceId, metadata });

    if (status === "running") {
      const waiters = this.pendingStartWaitersByTaskId.get(workspaceId);
      if (!waiters || waiters.length === 0) return;
      this.pendingStartWaitersByTaskId.delete(workspaceId);
      for (const waiter of waiters) {
        try {
          waiter.start();
        } catch (error: unknown) {
          log.error("Task start waiter callback failed", { workspaceId, error });
        }
      }
    }
  }

  private async handleStreamEnd(event: StreamEndEvent): Promise<void> {
    const workspaceId = event.workspaceId;

    const cfg = this.config.loadConfigOrDefault();
    const entry = this.findWorkspaceEntry(cfg, workspaceId);
    if (!entry) return;

    // Parent workspaces must not end while they have active background tasks.
    // Enforce by auto-resuming the stream with a directive to await outstanding tasks.
    if (!entry.workspace.parentWorkspaceId) {
      const hasActiveDescendants = this.hasActiveDescendantAgentTasks(cfg, workspaceId);
      if (!hasActiveDescendants) {
        return;
      }

      if (this.aiService.isStreaming(workspaceId)) {
        return;
      }

      const activeTaskIds = this.listActiveDescendantAgentTaskIds(workspaceId);
      const model = entry.workspace.aiSettings?.model ?? defaultModel;

      const resumeResult = await this.workspaceService.resumeStream(workspaceId, {
        model,
        thinkingLevel: entry.workspace.aiSettings?.thinkingLevel,
        additionalSystemInstructions:
          `You have active background sub-agent task(s) (${activeTaskIds.join(", ")}). ` +
          "You MUST NOT end your turn while any sub-agent tasks are queued/running/awaiting_report. " +
          "Call task_await now to wait for them to finish (omit timeout_secs to wait up to 10 minutes). " +
          "If any tasks are still queued/running/awaiting_report after that, call task_await again. " +
          "Only once all tasks are completed should you write your final response, integrating their reports.",
      });
      if (!resumeResult.success) {
        log.error("Failed to resume parent with active background tasks", {
          workspaceId,
          error: resumeResult.error,
        });
      }
      return;
    }

    const status = entry.workspace.taskStatus;
    if (status === "reported") return;

    // Never allow a task to finish/report while it still has active descendant tasks.
    // We'll auto-resume this task once the last descendant reports.
    const hasActiveDescendants = this.hasActiveDescendantAgentTasks(cfg, workspaceId);
    if (hasActiveDescendants) {
      if (status === "awaiting_report") {
        await this.setTaskStatus(workspaceId, "running");
      }
      return;
    }

    // If a task stream ends without agent_report, request it once.
    if (status === "awaiting_report" && this.remindedAwaitingReport.has(workspaceId)) {
      await this.fallbackReportMissingAgentReport(entry);
      return;
    }

    await this.setTaskStatus(workspaceId, "awaiting_report");

    this.remindedAwaitingReport.add(workspaceId);

    const model = entry.workspace.taskModelString ?? defaultModel;
    await this.workspaceService.sendMessage(
      workspaceId,
      "Your stream ended without calling agent_report. Call agent_report exactly once now with your final report.",
      {
        model,
        thinkingLevel: entry.workspace.taskThinkingLevel,
        toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      }
    );
  }

  private async fallbackReportMissingAgentReport(entry: {
    projectPath: string;
    workspace: WorkspaceConfigEntry;
  }): Promise<void> {
    const childWorkspaceId = entry.workspace.id;
    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    if (!childWorkspaceId || !parentWorkspaceId) {
      return;
    }

    const agentType = entry.workspace.agentType ?? "agent";
    const lastText = await this.readLatestAssistantText(childWorkspaceId);

    const reportMarkdown =
      "*(Note: this agent task did not call `agent_report`; " +
      "posting its last assistant output as a fallback.)*\n\n" +
      (lastText?.trim().length ? lastText : "(No assistant output found.)");

    await this.config.editConfig((config) => {
      for (const [_projectPath, project] of config.projects) {
        const ws = project.workspaces.find((w) => w.id === childWorkspaceId);
        if (ws) {
          ws.taskStatus = "reported";
          ws.reportedAt = getIsoNow();
          return config;
        }
      }
      return config;
    });

    // Notify clients immediately even if we can't delete the workspace yet.
    const updatedMetadata = (await this.config.getAllWorkspaceMetadata()).find(
      (m) => m.id === childWorkspaceId
    );
    this.workspaceService.emit("metadata", {
      workspaceId: childWorkspaceId,
      metadata: updatedMetadata ?? null,
    });

    await this.deliverReportToParent(parentWorkspaceId, entry, {
      reportMarkdown,
      title: `Subagent (${agentType}) report (fallback)`,
    });

    this.resolveWaiters(childWorkspaceId, {
      reportMarkdown,
      title: `Subagent (${agentType}) report (fallback)`,
    });

    await this.maybeStartQueuedTasks();
    await this.cleanupReportedLeafTask(childWorkspaceId);

    const postCfg = this.config.loadConfigOrDefault();
    const hasActiveDescendants = this.hasActiveDescendantAgentTasks(postCfg, parentWorkspaceId);
    if (!hasActiveDescendants && !this.aiService.isStreaming(parentWorkspaceId)) {
      const resumeResult = await this.workspaceService.resumeStream(parentWorkspaceId, {
        model: entry.workspace.taskModelString ?? defaultModel,
      });
      if (!resumeResult.success) {
        log.error("Failed to auto-resume parent after fallback report", {
          parentWorkspaceId,
          error: resumeResult.error,
        });
      }
    }
  }

  private async readLatestAssistantText(workspaceId: string): Promise<string | null> {
    const partial = await this.partialService.readPartial(workspaceId);
    if (partial && partial.role === "assistant") {
      const text = this.concatTextParts(partial).trim();
      if (text.length > 0) return text;
    }

    const historyResult = await this.historyService.getHistory(workspaceId);
    if (!historyResult.success) {
      log.error("Failed to read history for fallback report", {
        workspaceId,
        error: historyResult.error,
      });
      return null;
    }

    const ordered = [...historyResult.data].sort((a, b) => {
      const aSeq = a.metadata?.historySequence ?? -1;
      const bSeq = b.metadata?.historySequence ?? -1;
      return aSeq - bSeq;
    });

    for (let i = ordered.length - 1; i >= 0; i--) {
      const msg = ordered[i];
      if (msg?.role !== "assistant") continue;
      const text = this.concatTextParts(msg).trim();
      if (text.length > 0) return text;
    }

    return null;
  }

  private concatTextParts(msg: MuxMessage): string {
    let combined = "";
    for (const part of msg.parts) {
      if (!part || typeof part !== "object") continue;
      const maybeText = part as { type?: unknown; text?: unknown };
      if (maybeText.type !== "text") continue;
      if (typeof maybeText.text !== "string") continue;
      combined += maybeText.text;
    }
    return combined;
  }

  private async handleAgentReport(event: ToolCallEndEvent): Promise<void> {
    const childWorkspaceId = event.workspaceId;

    if (!isSuccessfulToolResult(event.result)) {
      return;
    }

    const cfgBeforeReport = this.config.loadConfigOrDefault();
    if (this.hasActiveDescendantAgentTasks(cfgBeforeReport, childWorkspaceId)) {
      log.error("agent_report called while task has active descendants; ignoring", {
        childWorkspaceId,
      });
      return;
    }

    // Read report payload from the tool-call input (persisted in partial/history).
    const reportArgs = await this.readLatestAgentReportArgs(childWorkspaceId);
    if (!reportArgs) {
      log.error("agent_report tool-call args not found", { childWorkspaceId });
      return;
    }

    await this.config.editConfig((config) => {
      for (const [_projectPath, project] of config.projects) {
        const ws = project.workspaces.find((w) => w.id === childWorkspaceId);
        if (ws) {
          ws.taskStatus = "reported";
          ws.reportedAt = getIsoNow();
          return config;
        }
      }
      return config;
    });

    // Notify clients immediately even if we can't delete the workspace yet.
    const updatedMetadata = (await this.config.getAllWorkspaceMetadata()).find(
      (m) => m.id === childWorkspaceId
    );
    this.workspaceService.emit("metadata", {
      workspaceId: childWorkspaceId,
      metadata: updatedMetadata ?? null,
    });

    // `agent_report` is terminal. Stop the child stream immediately to prevent any further token
    // usage and to ensure parallelism accounting never "frees" a slot while the stream is still
    // active (Claude/Anthropic can emit tool calls before the final assistant block completes).
    try {
      const stopResult = await this.aiService.stopStream(childWorkspaceId, {
        abandonPartial: true,
      });
      if (!stopResult.success) {
        log.debug("Failed to stop task stream after agent_report", {
          workspaceId: childWorkspaceId,
          error: stopResult.error,
        });
      }
    } catch (error: unknown) {
      log.debug("Failed to stop task stream after agent_report (threw)", {
        workspaceId: childWorkspaceId,
        error,
      });
    }

    const cfgAfterReport = this.config.loadConfigOrDefault();
    const childEntry = this.findWorkspaceEntry(cfgAfterReport, childWorkspaceId);
    const parentWorkspaceId = childEntry?.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      log.error("agent_report called from non-task workspace", { childWorkspaceId });
      return;
    }

    await this.deliverReportToParent(parentWorkspaceId, childEntry, reportArgs);

    // Resolve foreground waiters.
    this.resolveWaiters(childWorkspaceId, reportArgs);

    // Free slot and start queued tasks.
    await this.maybeStartQueuedTasks();

    // Attempt cleanup of reported tasks (leaf-first).
    await this.cleanupReportedLeafTask(childWorkspaceId);

    // Auto-resume any parent stream that was waiting on a task tool call (restart-safe).
    const postCfg = this.config.loadConfigOrDefault();
    const hasActiveDescendants = this.hasActiveDescendantAgentTasks(postCfg, parentWorkspaceId);
    if (!hasActiveDescendants && !this.aiService.isStreaming(parentWorkspaceId)) {
      const resumeResult = await this.workspaceService.resumeStream(parentWorkspaceId, {
        model: childEntry?.workspace.taskModelString ?? defaultModel,
      });
      if (!resumeResult.success) {
        log.error("Failed to auto-resume parent after agent_report", {
          parentWorkspaceId,
          error: resumeResult.error,
        });
      }
    }
  }

  private resolveWaiters(taskId: string, report: { reportMarkdown: string; title?: string }): void {
    this.completedReportsByTaskId.set(taskId, report);

    const waiters = this.pendingWaitersByTaskId.get(taskId);
    if (!waiters || waiters.length === 0) {
      return;
    }

    this.pendingWaitersByTaskId.delete(taskId);
    for (const waiter of waiters) {
      try {
        waiter.cleanup();
        waiter.resolve(report);
      } catch {
        // ignore
      }
    }
  }

  private rejectWaiters(taskId: string, error: Error): void {
    const waiters = this.pendingWaitersByTaskId.get(taskId);
    if (!waiters || waiters.length === 0) {
      return;
    }

    for (const waiter of [...waiters]) {
      try {
        waiter.reject(error);
      } catch (rejectError: unknown) {
        log.error("Task waiter reject callback failed", { taskId, error: rejectError });
      }
    }
  }

  private async readLatestAgentReportArgs(
    workspaceId: string
  ): Promise<{ reportMarkdown: string; title?: string } | null> {
    const partial = await this.partialService.readPartial(workspaceId);
    if (partial) {
      const args = this.findAgentReportArgsInMessage(partial);
      if (args) return args;
    }

    const historyResult = await this.historyService.getHistory(workspaceId);
    if (!historyResult.success) {
      log.error("Failed to read history for agent_report args", {
        workspaceId,
        error: historyResult.error,
      });
      return null;
    }

    // Scan newest-first.
    const ordered = [...historyResult.data].sort((a, b) => {
      const aSeq = a.metadata?.historySequence ?? -1;
      const bSeq = b.metadata?.historySequence ?? -1;
      return bSeq - aSeq;
    });

    for (const msg of ordered) {
      const args = this.findAgentReportArgsInMessage(msg);
      if (args) return args;
    }

    return null;
  }

  private findAgentReportArgsInMessage(
    msg: MuxMessage
  ): { reportMarkdown: string; title?: string } | null {
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      const part = msg.parts[i];
      if (!isDynamicToolPart(part)) continue;
      if (part.toolName !== "agent_report") continue;
      if (part.state !== "output-available") continue;
      if (!isSuccessfulToolResult(part.output)) continue;
      const parsed = AgentReportToolArgsSchema.safeParse(part.input);
      if (!parsed.success) continue;
      return parsed.data;
    }
    return null;
  }

  private async deliverReportToParent(
    parentWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    report: { reportMarkdown: string; title?: string }
  ): Promise<void> {
    const agentType = childEntry?.workspace.agentType ?? "agent";
    const childWorkspaceId = childEntry?.workspace.id;

    const output = {
      status: "completed" as const,
      ...(childWorkspaceId ? { taskId: childWorkspaceId } : {}),
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      agentType,
    };
    const parsedOutput = TaskToolResultSchema.safeParse(output);
    if (!parsedOutput.success) {
      log.error("Task tool output schema validation failed", { error: parsedOutput.error.message });
      return;
    }

    // If someone is actively awaiting this report (foreground task tool call or task_await),
    // skip injecting a synthetic history message to avoid duplicating the report in context.
    if (childWorkspaceId) {
      const waiters = this.pendingWaitersByTaskId.get(childWorkspaceId);
      if (waiters && waiters.length > 0) {
        return;
      }
    }

    // Restart-safe: if the parent has a pending task tool call in partial.json (interrupted stream),
    // finalize it with the report. Avoid rewriting persisted history to keep earlier messages immutable.
    if (!this.aiService.isStreaming(parentWorkspaceId)) {
      const finalizedPending = await this.tryFinalizePendingTaskToolCallInPartial(
        parentWorkspaceId,
        parsedOutput.data
      );
      if (finalizedPending) {
        return;
      }
    }

    // Background tasks: append a synthetic user message containing the report so earlier history
    // remains immutable (append-only) and prompt caches can still reuse the prefix.
    const titlePrefix = report.title ?? `Subagent (${agentType}) report`;
    const xml = [
      "<mux_subagent_report>",
      `<task_id>${childWorkspaceId ?? ""}</task_id>`,
      `<agent_type>${agentType}</agent_type>`,
      `<title>${titlePrefix}</title>`,
      "<report_markdown>",
      report.reportMarkdown,
      "</report_markdown>",
      "</mux_subagent_report>",
    ].join("\n");

    const messageId = `task-report-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const reportMessage = createMuxMessage(messageId, "user", xml, {
      timestamp: Date.now(),
      synthetic: true,
    });

    const appendResult = await this.historyService.appendToHistory(
      parentWorkspaceId,
      reportMessage
    );
    if (!appendResult.success) {
      log.error("Failed to append synthetic subagent report to parent history", {
        parentWorkspaceId,
        error: appendResult.error,
      });
    }
  }

  private async tryFinalizePendingTaskToolCallInPartial(
    workspaceId: string,
    output: unknown
  ): Promise<boolean> {
    const parsedOutput = TaskToolResultSchema.safeParse(output);
    if (!parsedOutput.success || parsedOutput.data.status !== "completed") {
      log.error("tryFinalizePendingTaskToolCallInPartial: invalid output", {
        error: parsedOutput.success ? "status is not 'completed'" : parsedOutput.error.message,
      });
      return false;
    }

    const partial = await this.partialService.readPartial(workspaceId);
    if (!partial) {
      return false;
    }

    type PendingTaskToolPart = DynamicToolPart & { toolName: "task"; state: "input-available" };
    const pendingParts = partial.parts.filter(
      (p): p is PendingTaskToolPart =>
        isDynamicToolPart(p) && p.toolName === "task" && p.state === "input-available"
    );

    if (pendingParts.length === 0) {
      return false;
    }
    if (pendingParts.length > 1) {
      log.error("tryFinalizePendingTaskToolCallInPartial: multiple pending task tool calls", {
        workspaceId,
      });
      return false;
    }

    const toolCallId = pendingParts[0].toolCallId;
    const parsedInput = TaskToolArgsSchema.safeParse(pendingParts[0].input);
    if (!parsedInput.success) {
      log.error("tryFinalizePendingTaskToolCallInPartial: task input validation failed", {
        workspaceId,
        error: parsedInput.error.message,
      });
      return false;
    }

    const updated: MuxMessage = {
      ...partial,
      parts: partial.parts.map((part) => {
        if (!isDynamicToolPart(part)) return part;
        if (part.toolCallId !== toolCallId) return part;
        if (part.toolName !== "task") return part;
        if (part.state === "output-available") return part;
        return { ...part, state: "output-available" as const, output: parsedOutput.data };
      }),
    };

    const writeResult = await this.partialService.writePartial(workspaceId, updated);
    if (!writeResult.success) {
      log.error("Failed to write finalized task tool output to partial", {
        workspaceId,
        error: writeResult.error,
      });
      return false;
    }

    this.workspaceService.emit("chat", {
      workspaceId,
      message: {
        type: "tool-call-end",
        workspaceId,
        messageId: updated.id,
        toolCallId,
        toolName: "task",
        result: parsedOutput.data,
        timestamp: Date.now(),
      },
    });

    return true;
  }

  private async cleanupReportedLeafTask(workspaceId: string): Promise<void> {
    const config = this.config.loadConfigOrDefault();
    const entry = this.findWorkspaceEntry(config, workspaceId);
    if (!entry) return;

    const ws = entry.workspace;
    if (!ws.parentWorkspaceId) return;
    if (ws.taskStatus !== "reported") return;

    const hasChildren = this.listAgentTaskWorkspaces(config).some(
      (t) => t.parentWorkspaceId === workspaceId
    );
    if (hasChildren) {
      return;
    }

    const removeResult = await this.workspaceService.remove(workspaceId, true);
    if (!removeResult.success) {
      log.error("Failed to auto-delete reported task workspace", {
        workspaceId,
        error: removeResult.error,
      });
      return;
    }

    // Recursively attempt cleanup on parent if it's also a reported agent task.
    await this.cleanupReportedLeafTask(ws.parentWorkspaceId);
  }

  private findWorkspaceEntry(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): { projectPath: string; workspace: WorkspaceConfigEntry } | null {
    for (const [projectPath, project] of config.projects) {
      for (const workspace of project.workspaces) {
        if (workspace.id === workspaceId) {
          return { projectPath, workspace };
        }
      }
    }
    return null;
  }
}
