import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";

import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { log } from "@/node/services/log";
import { detectDefaultTrunkBranch, listLocalBranches } from "@/node/git";
import { readAgentDefinition } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { InitLogger, WorkspaceCreationResult } from "@/node/runtime/Runtime";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import { Ok, Err, type Result } from "@/common/types/result";
import type { TaskSettings } from "@/common/types/tasks";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { defaultModel, normalizeGatewayModel } from "@/common/utils/ai/models";
import type { RuntimeConfig } from "@/common/types/runtime";
import { AgentIdSchema } from "@/common/orpc/schemas";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { ToolCallEndEvent, StreamEndEvent } from "@/common/types/stream";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";
import {
  AgentReportToolArgsSchema,
  TaskToolResultSchema,
  TaskToolArgsSchema,
} from "@/common/utils/tools/toolDefinitions";
import { formatSendMessageError } from "@/node/services/utils/sendMessageError";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import { taskQueueDebug } from "@/node/services/taskQueueDebug";

export type TaskKind = "agent";

export type AgentTaskStatus = NonNullable<WorkspaceConfigEntry["taskStatus"]>;

export interface TaskCreateArgs {
  parentWorkspaceId: string;
  kind: TaskKind;
  /** Preferred identifier (matches agent definition id). */
  agentId?: string;
  /** @deprecated Legacy alias for agentId (kept for on-disk compatibility). */
  agentType?: string;
  prompt: string;
  /** Human-readable title for the task (displayed in sidebar) */
  title: string;
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
  /** PTC experiments to inherit to subagent */
  experiments?: { programmaticToolCalling?: boolean; programmaticToolCallingExclusive?: boolean };
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

type AgentTaskWorkspaceEntry = WorkspaceConfigEntry & { projectPath: string };

const COMPLETED_REPORT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const COMPLETED_REPORT_CACHE_MAX_ENTRIES = 128;

interface AgentTaskIndex {
  byId: Map<string, AgentTaskWorkspaceEntry>;
  childrenByParent: Map<string, string[]>;
  parentById: Map<string, string>;
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
  // Serialize stream-end/tool-call-end processing per workspace to avoid races (e.g.
  // stream-end observing awaiting_report before agent_report handling flips the status).
  private readonly workspaceEventLocks = new MutexMap<string>();
  private readonly mutex = new AsyncMutex();
  private readonly pendingWaitersByTaskId = new Map<string, PendingTaskWaiter[]>();
  private readonly pendingStartWaitersByTaskId = new Map<string, PendingTaskStartWaiter[]>();
  // Tracks workspaces currently blocked in a foreground wait (e.g. a task tool call awaiting
  // agent_report). Used to avoid scheduler deadlocks when maxParallelAgentTasks is low and tasks
  // spawn nested tasks in the foreground.
  private readonly foregroundAwaitCountByWorkspaceId = new Map<string, number>();
  // Cache completed reports so callers can retrieve them even after the task workspace is removed.
  // Bounded by TTL + max entries (see COMPLETED_REPORT_CACHE_*).
  private readonly completedReportsByTaskId = new Map<
    string,
    { reportMarkdown: string; title?: string; expiresAtMs: number }
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
      // Ignore failed agent_report attempts (e.g. tool rejected due to active descendants).
      if (!isSuccessfulToolResult(payload.result)) return;

      void this.workspaceEventLocks
        .withLock(payload.workspaceId, async () => {
          await this.handleAgentReport(payload);
        })
        .catch((error: unknown) => {
          log.error("TaskService.handleAgentReport failed", { error });
        });
    });

    this.aiService.on("stream-end", (payload: unknown) => {
      if (!isStreamEndEvent(payload)) return;

      void this.workspaceEventLocks
        .withLock(payload.workspaceId, async () => {
          await this.handleStreamEnd(payload);
        })
        .catch((error: unknown) => {
          log.error("TaskService.handleStreamEnd failed", { error });
        });
    });
  }

  private async emitWorkspaceMetadata(workspaceId: string): Promise<void> {
    assert(workspaceId.length > 0, "emitWorkspaceMetadata: workspaceId must be non-empty");

    const allMetadata = await this.config.getAllWorkspaceMetadata();
    const metadata = allMetadata.find((m) => m.id === workspaceId) ?? null;
    this.workspaceService.emit("metadata", { workspaceId, metadata });
  }

  private async editWorkspaceEntry(
    workspaceId: string,
    updater: (workspace: WorkspaceConfigEntry) => void,
    options?: { allowMissing?: boolean }
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "editWorkspaceEntry: workspaceId must be non-empty");

    let found = false;
    await this.config.editConfig((config) => {
      for (const [_projectPath, project] of config.projects) {
        const ws = project.workspaces.find((w) => w.id === workspaceId);
        if (!ws) continue;
        updater(ws);
        found = true;
        return config;
      }

      if (options?.allowMissing) {
        return config;
      }

      throw new Error(`editWorkspaceEntry: workspace ${workspaceId} not found`);
    });

    return found;
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
        { model, thinkingLevel: task.taskThinkingLevel, experiments: task.taskExperiments }
      );
    }
  }

  private startWorkspaceInit(workspaceId: string, projectPath: string): InitLogger {
    assert(workspaceId.length > 0, "startWorkspaceInit: workspaceId must be non-empty");
    assert(projectPath.length > 0, "startWorkspaceInit: projectPath must be non-empty");

    this.initStateManager.startInit(workspaceId, projectPath);
    return {
      logStep: (message: string) => this.initStateManager.appendOutput(workspaceId, message, false),
      logStdout: (line: string) => this.initStateManager.appendOutput(workspaceId, line, false),
      logStderr: (line: string) => this.initStateManager.appendOutput(workspaceId, line, true),
      logComplete: (exitCode: number) => void this.initStateManager.endInit(workspaceId, exitCode),
    };
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

    const agentIdRaw = coerceNonEmptyString(args.agentId ?? args.agentType);
    if (!agentIdRaw) {
      return Err("Task.create: agentId is required");
    }

    const normalizedAgentId = agentIdRaw.trim().toLowerCase();
    const parsedAgentId = AgentIdSchema.safeParse(normalizedAgentId);
    if (!parsedAgentId.success) {
      return Err(`Task.create: invalid agentId (${normalizedAgentId})`);
    }

    const agentId = parsedAgentId.data;
    const agentType = agentId; // Legacy alias for on-disk compatibility.

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
    const workspaceName = buildAgentWorkspaceName(agentId, taskId);

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

    const subagentDefaults = cfg.agentAiDefaults?.[agentId] ?? cfg.subagentAiDefaults?.[agentId];

    const taskModelString = subagentDefaults?.modelString ?? inheritedModelString;
    const canonicalModel = normalizeGatewayModel(taskModelString).trim();

    const requestedThinkingLevel = subagentDefaults?.thinkingLevel ?? inheritedThinkingLevel;
    const effectiveThinkingLevel = enforceThinkingPolicy(canonicalModel, requestedThinkingLevel);

    const parentRuntimeConfig = parentMeta.runtimeConfig;
    const taskRuntimeConfig: RuntimeConfig = parentRuntimeConfig;

    const runtime = createRuntime(taskRuntimeConfig, {
      projectPath: parentMeta.projectPath,
    });

    // Validate the agent definition exists and is runnable as a sub-agent.
    const isInPlace = parentMeta.projectPath === parentMeta.name;
    const parentWorkspacePath = isInPlace
      ? parentMeta.projectPath
      : runtime.getWorkspacePath(parentMeta.projectPath, parentMeta.name);

    try {
      const definition = await readAgentDefinition(runtime, parentWorkspacePath, agentId);
      if (definition.frontmatter.subagent?.runnable !== true) {
        return Err(`Task.create: agentId is not runnable as a sub-agent (${agentId})`);
      }
    } catch {
      return Err(`Task.create: unknown agentId (${agentId})`);
    }

    const createdAt = getIsoNow();

    taskQueueDebug("TaskService.create decision", {
      parentWorkspaceId,
      taskId,
      agentId,
      workspaceName,
      createdAt,
      activeCount,
      maxParallelAgentTasks: taskSettings.maxParallelAgentTasks,
      shouldQueue,
      runtimeType: taskRuntimeConfig.type,
      promptLength: prompt.length,
      model: taskModelString,
      thinkingLevel: effectiveThinkingLevel,
    });

    if (shouldQueue) {
      const trunkBranch = coerceNonEmptyString(parentMeta.name);
      if (!trunkBranch) {
        return Err("Task.create: parent workspace name missing (cannot queue task)");
      }

      // NOTE: Queued tasks are persisted immediately, but their workspace is created later
      // when a parallel slot is available. This ensures queued tasks don't create worktrees
      // or run init hooks until they actually start.
      const workspacePath = runtime.getWorkspacePath(parentMeta.projectPath, workspaceName);

      taskQueueDebug("TaskService.create queued (persist-only)", {
        taskId,
        workspaceName,
        parentWorkspaceId,
        trunkBranch,
        workspacePath,
      });

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
          title: args.title,
          createdAt,
          runtimeConfig: taskRuntimeConfig,
          aiSettings: { model: canonicalModel, thinkingLevel: effectiveThinkingLevel },
          parentWorkspaceId,
          agentId,
          agentType,
          taskStatus: "queued",
          taskPrompt: prompt,
          taskTrunkBranch: trunkBranch,
          taskModelString,
          taskThinkingLevel: effectiveThinkingLevel,
          taskExperiments: args.experiments,
        });
        return config;
      });

      // Emit metadata update so the UI sees the workspace immediately.
      await this.emitWorkspaceMetadata(taskId);

      // NOTE: Do NOT persist the prompt into chat history until the task actually starts.
      // Otherwise the frontend treats "last message is user" as an interrupted stream and
      // will auto-retry / backoff-spam resume attempts while the task is queued.
      taskQueueDebug("TaskService.create queued persisted (prompt stored in config)", {
        taskId,
        workspaceName,
      });

      // Schedule queue processing (best-effort).
      void this.maybeStartQueuedTasks();
      taskQueueDebug("TaskService.create queued scheduled maybeStartQueuedTasks", { taskId });
      return Ok({ taskId, kind: "agent", status: "queued" });
    }

    const initLogger = this.startWorkspaceInit(taskId, parentMeta.projectPath);

    // Note: Local project-dir runtimes share the same directory (unsafe by design).
    // For worktree/ssh runtimes we attempt a fork first; otherwise fall back to createWorkspace.
    const forkResult = await runtime.forkWorkspace({
      projectPath: parentMeta.projectPath,
      sourceWorkspaceName: parentMeta.name,
      newWorkspaceName: workspaceName,
      initLogger,
    });

    let trunkBranch: string;
    if (forkResult.success && forkResult.sourceBranch) {
      trunkBranch = forkResult.sourceBranch;
    } else {
      // Fork failed - validate parentMeta.name is a valid local branch.
      // For non-git projects (LocalRuntime), git commands fail - fall back to "main".
      try {
        const localBranches = await listLocalBranches(parentMeta.projectPath);
        if (localBranches.includes(parentMeta.name)) {
          trunkBranch = parentMeta.name;
        } else {
          trunkBranch = await detectDefaultTrunkBranch(parentMeta.projectPath, localBranches);
        }
      } catch {
        trunkBranch = "main";
      }
    }
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
      initLogger.logComplete(-1);
      return Err(
        `Task.create: failed to create agent workspace (${createResult.error ?? "unknown error"})`
      );
    }

    const workspacePath = createResult.workspacePath;

    taskQueueDebug("TaskService.create started (workspace created)", {
      taskId,
      workspaceName,
      workspacePath,
      trunkBranch,
      forkSuccess: forkResult.success,
    });

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
        title: args.title,
        createdAt,
        runtimeConfig: taskRuntimeConfig,
        aiSettings: { model: canonicalModel, thinkingLevel: effectiveThinkingLevel },
        agentId,
        parentWorkspaceId,
        agentType,
        taskStatus: "running",
        taskTrunkBranch: trunkBranch,
        taskModelString,
        taskThinkingLevel: effectiveThinkingLevel,
        taskExperiments: args.experiments,
      });
      return config;
    });

    // Emit metadata update so the UI sees the workspace immediately.
    await this.emitWorkspaceMetadata(taskId);

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

    // Start immediately (counts towards parallel limit).
    const sendResult = await this.workspaceService.sendMessage(taskId, prompt, {
      model: taskModelString,
      thinkingLevel: effectiveThinkingLevel,
      experiments: args.experiments,
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

      const index = this.buildAgentTaskIndex(cfg);
      if (
        !this.isDescendantAgentTaskUsingParentById(index.parentById, ancestorWorkspaceId, taskId)
      ) {
        return Err("Task is not a descendant of this workspace");
      }

      // Terminate the entire subtree to avoid orphaned descendant tasks.
      const descendants = this.listDescendantAgentTaskIdsFromIndex(index, taskId);
      const toTerminate = Array.from(new Set([taskId, ...descendants]));

      // Delete leaves first to avoid leaving children with missing parents.
      const parentById = index.parentById;
      const depthById = new Map<string, number>();
      for (const id of toTerminate) {
        depthById.set(id, this.getTaskDepthFromParentById(parentById, id));
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

  private isForegroundAwaiting(workspaceId: string): boolean {
    const count = this.foregroundAwaitCountByWorkspaceId.get(workspaceId);
    return typeof count === "number" && count > 0;
  }

  private startForegroundAwait(workspaceId: string): () => void {
    assert(workspaceId.length > 0, "startForegroundAwait: workspaceId must be non-empty");

    const current = this.foregroundAwaitCountByWorkspaceId.get(workspaceId) ?? 0;
    assert(
      Number.isInteger(current) && current >= 0,
      "startForegroundAwait: expected non-negative integer counter"
    );

    this.foregroundAwaitCountByWorkspaceId.set(workspaceId, current + 1);

    return () => {
      const current = this.foregroundAwaitCountByWorkspaceId.get(workspaceId) ?? 0;
      assert(
        Number.isInteger(current) && current > 0,
        "startForegroundAwait cleanup: expected positive integer counter"
      );
      if (current <= 1) {
        this.foregroundAwaitCountByWorkspaceId.delete(workspaceId);
      } else {
        this.foregroundAwaitCountByWorkspaceId.set(workspaceId, current - 1);
      }
    };
  }

  waitForAgentReport(
    taskId: string,
    options?: { timeoutMs?: number; abortSignal?: AbortSignal; requestingWorkspaceId?: string }
  ): Promise<{ reportMarkdown: string; title?: string }> {
    assert(taskId.length > 0, "waitForAgentReport: taskId must be non-empty");

    const cached = this.completedReportsByTaskId.get(taskId);
    if (cached) {
      const nowMs = Date.now();
      if (cached.expiresAtMs > nowMs) {
        return Promise.resolve({ reportMarkdown: cached.reportMarkdown, title: cached.title });
      }
      this.completedReportsByTaskId.delete(taskId);
    }

    const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000; // 10 minutes
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "waitForAgentReport: timeoutMs invalid");

    const requestingWorkspaceId = coerceNonEmptyString(options?.requestingWorkspaceId);

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
      let stopBlockingRequester: (() => void) | null = requestingWorkspaceId
        ? this.startForegroundAwait(requestingWorkspaceId)
        : null;

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

          if (stopBlockingRequester) {
            try {
              stopBlockingRequester();
            } finally {
              stopBlockingRequester = null;
            }
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

        // If the awaited task is queued and the caller is blocked in the foreground, ensure the
        // scheduler runs after the waiter is registered. This avoids deadlocks when
        // maxParallelAgentTasks is low.
        if (requestingWorkspaceId) {
          void this.maybeStartQueuedTasks();
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
    const index = this.buildAgentTaskIndex(cfg);

    const activeStatuses = new Set<AgentTaskStatus>(["queued", "running", "awaiting_report"]);
    const result: string[] = [];
    const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      const status = index.byId.get(next)?.taskStatus;
      if (status && activeStatuses.has(status)) {
        result.push(next);
      }
      const children = index.childrenByParent.get(next);
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
    const index = this.buildAgentTaskIndex(cfg);

    const result: DescendantAgentTaskInfo[] = [];

    const stack: Array<{ taskId: string; depth: number }> = [];
    for (const childTaskId of index.childrenByParent.get(workspaceId) ?? []) {
      stack.push({ taskId: childTaskId, depth: 1 });
    }

    while (stack.length > 0) {
      const next = stack.pop()!;
      const entry = index.byId.get(next.taskId);
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

      for (const childTaskId of index.childrenByParent.get(next.taskId) ?? []) {
        stack.push({ taskId: childTaskId, depth: next.depth + 1 });
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

  filterDescendantAgentTaskIds(ancestorWorkspaceId: string, taskIds: string[]): string[] {
    assert(
      ancestorWorkspaceId.length > 0,
      "filterDescendantAgentTaskIds: ancestorWorkspaceId required"
    );
    assert(Array.isArray(taskIds), "filterDescendantAgentTaskIds: taskIds must be an array");

    const cfg = this.config.loadConfigOrDefault();
    const parentById = this.buildAgentTaskIndex(cfg).parentById;

    const result: string[] = [];
    for (const taskId of taskIds) {
      if (typeof taskId !== "string" || taskId.length === 0) continue;
      if (this.isDescendantAgentTaskUsingParentById(parentById, ancestorWorkspaceId, taskId)) {
        result.push(taskId);
      }
    }

    return result;
  }

  private listDescendantAgentTaskIdsFromIndex(
    index: AgentTaskIndex,
    workspaceId: string
  ): string[] {
    assert(
      workspaceId.length > 0,
      "listDescendantAgentTaskIdsFromIndex: workspaceId must be non-empty"
    );

    const result: string[] = [];
    const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      result.push(next);
      const children = index.childrenByParent.get(next);
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
    const parentById = this.buildAgentTaskIndex(cfg).parentById;
    return this.isDescendantAgentTaskUsingParentById(parentById, ancestorWorkspaceId, taskId);
  }

  private isDescendantAgentTaskUsingParentById(
    parentById: Map<string, string>,
    ancestorWorkspaceId: string,
    taskId: string
  ): boolean {
    let current = taskId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) return false;
      if (parent === ancestorWorkspaceId) return true;
      current = parent;
    }

    throw new Error(
      `isDescendantAgentTaskUsingParentById: possible parentWorkspaceId cycle starting at ${taskId}`
    );
  }

  // --- Internal orchestration ---

  private listAgentTaskWorkspaces(
    config: ReturnType<Config["loadConfigOrDefault"]>
  ): AgentTaskWorkspaceEntry[] {
    const tasks: AgentTaskWorkspaceEntry[] = [];
    for (const [projectPath, project] of config.projects) {
      for (const workspace of project.workspaces) {
        if (!workspace.id) continue;
        if (!workspace.parentWorkspaceId) continue;
        tasks.push({ ...workspace, projectPath });
      }
    }
    return tasks;
  }

  private buildAgentTaskIndex(config: ReturnType<Config["loadConfigOrDefault"]>): AgentTaskIndex {
    const byId = new Map<string, AgentTaskWorkspaceEntry>();
    const childrenByParent = new Map<string, string[]>();
    const parentById = new Map<string, string>();

    for (const task of this.listAgentTaskWorkspaces(config)) {
      const taskId = task.id!;
      byId.set(taskId, task);

      const parent = task.parentWorkspaceId;
      if (!parent) continue;

      parentById.set(taskId, parent);
      const list = childrenByParent.get(parent) ?? [];
      list.push(taskId);
      childrenByParent.set(parent, list);
    }

    return { byId, childrenByParent, parentById };
  }

  private countActiveAgentTasks(config: ReturnType<Config["loadConfigOrDefault"]>): number {
    let activeCount = 0;
    for (const task of this.listAgentTaskWorkspaces(config)) {
      const status: AgentTaskStatus = task.taskStatus ?? "running";
      // If this task workspace is blocked in a foreground wait, do not count it towards parallelism.
      // This prevents deadlocks where a task spawns a nested task in the foreground while
      // maxParallelAgentTasks is low (e.g. 1).
      // Note: StreamManager can still report isStreaming() while a tool call is executing, so
      // isStreaming is not a reliable signal for "actively doing work" here.
      if (status === "running" && task.id && this.isForegroundAwaiting(task.id)) {
        continue;
      }
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

    const index = this.buildAgentTaskIndex(config);

    const activeStatuses = new Set<AgentTaskStatus>(["queued", "running", "awaiting_report"]);
    const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      const status = index.byId.get(next)?.taskStatus;
      if (status && activeStatuses.has(status)) {
        return true;
      }
      const children = index.childrenByParent.get(next);
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

    return this.getTaskDepthFromParentById(
      this.buildAgentTaskIndex(config).parentById,
      workspaceId
    );
  }

  private getTaskDepthFromParentById(parentById: Map<string, string>, workspaceId: string): number {
    let depth = 0;
    let current = workspaceId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) break;
      depth += 1;
      current = parent;
    }

    if (depth >= 32) {
      throw new Error(
        `getTaskDepthFromParentById: possible parentWorkspaceId cycle starting at ${workspaceId}`
      );
    }

    return depth;
  }

  async maybeStartQueuedTasks(): Promise<void> {
    await using _lock = await this.mutex.acquire();

    const configAtStart = this.config.loadConfigOrDefault();
    const taskSettingsAtStart: TaskSettings = configAtStart.taskSettings ?? DEFAULT_TASK_SETTINGS;

    const activeCount = this.countActiveAgentTasks(configAtStart);
    const availableSlots = Math.max(0, taskSettingsAtStart.maxParallelAgentTasks - activeCount);
    taskQueueDebug("TaskService.maybeStartQueuedTasks summary", {
      activeCount,
      maxParallelAgentTasks: taskSettingsAtStart.maxParallelAgentTasks,
      availableSlots,
    });
    if (availableSlots === 0) return;

    const queuedTaskIds = this.listAgentTaskWorkspaces(configAtStart)
      .filter((t) => t.taskStatus === "queued" && typeof t.id === "string")
      .sort((a, b) => {
        const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
        return aTime - bTime;
      })
      .map((t) => t.id!);

    taskQueueDebug("TaskService.maybeStartQueuedTasks candidates", {
      queuedCount: queuedTaskIds.length,
      queuedIds: queuedTaskIds,
    });

    for (const taskId of queuedTaskIds) {
      const config = this.config.loadConfigOrDefault();
      const taskSettings: TaskSettings = config.taskSettings ?? DEFAULT_TASK_SETTINGS;
      assert(
        Number.isFinite(taskSettings.maxParallelAgentTasks) &&
          taskSettings.maxParallelAgentTasks > 0,
        "TaskService.maybeStartQueuedTasks: maxParallelAgentTasks must be a positive number"
      );

      const activeCount = this.countActiveAgentTasks(config);
      if (activeCount >= taskSettings.maxParallelAgentTasks) {
        break;
      }

      const taskEntry = this.findWorkspaceEntry(config, taskId);
      if (!taskEntry?.workspace.parentWorkspaceId) continue;
      const task = taskEntry.workspace;
      if (task.taskStatus !== "queued") continue;

      // Defensive: tasks can begin streaming before taskStatus flips to "running".
      if (this.aiService.isStreaming(taskId)) {
        taskQueueDebug("TaskService.maybeStartQueuedTasks queued-but-streaming; marking running", {
          taskId,
        });
        await this.setTaskStatus(taskId, "running");
        continue;
      }

      assert(typeof task.name === "string" && task.name.trim().length > 0, "Task name missing");

      const parentId = coerceNonEmptyString(task.parentWorkspaceId);
      if (!parentId) {
        log.error("Queued task missing parentWorkspaceId; cannot start", { taskId });
        continue;
      }

      const parentEntry = this.findWorkspaceEntry(config, parentId);
      if (!parentEntry) {
        log.error("Queued task parent not found; cannot start", { taskId, parentId });
        continue;
      }

      const parentWorkspaceName = coerceNonEmptyString(parentEntry.workspace.name);
      if (!parentWorkspaceName) {
        log.error("Queued task parent missing workspace name; cannot start", {
          taskId,
          parentId,
        });
        continue;
      }

      const runtimeConfig = task.runtimeConfig ?? parentEntry.workspace.runtimeConfig;
      if (!runtimeConfig) {
        log.error("Queued task missing runtimeConfig; cannot start", { taskId });
        continue;
      }

      const runtime = createRuntime(runtimeConfig, {
        projectPath: taskEntry.projectPath,
      });

      const workspaceName = task.name.trim();
      let workspacePath =
        coerceNonEmptyString(task.path) ??
        runtime.getWorkspacePath(taskEntry.projectPath, workspaceName);

      let workspaceExists = false;
      try {
        await runtime.stat(workspacePath);
        workspaceExists = true;
      } catch {
        workspaceExists = false;
      }

      const inMemoryInit = this.initStateManager.getInitState(taskId);
      const persistedInit = inMemoryInit
        ? null
        : await this.initStateManager.readInitStatus(taskId);

      // Re-check capacity after awaiting IO to avoid dequeuing work (worktree creation/init) when
      // another task became active in the meantime.
      const latestConfig = this.config.loadConfigOrDefault();
      const latestTaskSettings: TaskSettings = latestConfig.taskSettings ?? DEFAULT_TASK_SETTINGS;
      const latestActiveCount = this.countActiveAgentTasks(latestConfig);
      if (latestActiveCount >= latestTaskSettings.maxParallelAgentTasks) {
        taskQueueDebug("TaskService.maybeStartQueuedTasks became full mid-loop", {
          taskId,
          activeCount: latestActiveCount,
          maxParallelAgentTasks: latestTaskSettings.maxParallelAgentTasks,
        });
        break;
      }

      // Ensure the workspace exists before starting. Queued tasks should not create worktrees/directories
      // until they are actually dequeued.
      let trunkBranch =
        typeof task.taskTrunkBranch === "string" && task.taskTrunkBranch.trim().length > 0
          ? task.taskTrunkBranch.trim()
          : parentWorkspaceName;
      if (trunkBranch.length === 0) {
        trunkBranch = "main";
      }

      let shouldRunInit = !inMemoryInit && !persistedInit;
      let initLogger: InitLogger | null = null;
      const getInitLogger = (): InitLogger => {
        if (initLogger) return initLogger;
        initLogger = this.startWorkspaceInit(taskId, taskEntry.projectPath);
        return initLogger;
      };

      taskQueueDebug("TaskService.maybeStartQueuedTasks start attempt", {
        taskId,
        workspaceName,
        parentId,
        parentWorkspaceName,
        runtimeType: runtimeConfig.type,
        workspacePath,
        workspaceExists,
        trunkBranch,
        shouldRunInit,
        inMemoryInit: Boolean(inMemoryInit),
        persistedInit: Boolean(persistedInit),
      });

      // If the workspace doesn't exist yet, create it now (fork preferred, else createWorkspace).
      if (!workspaceExists) {
        shouldRunInit = true;
        const initLogger = getInitLogger();

        const forkResult = await runtime.forkWorkspace({
          projectPath: taskEntry.projectPath,
          sourceWorkspaceName: parentWorkspaceName,
          newWorkspaceName: workspaceName,
          initLogger,
        });

        trunkBranch = forkResult.success ? (forkResult.sourceBranch ?? trunkBranch) : trunkBranch;
        const createResult: WorkspaceCreationResult = forkResult.success
          ? { success: true as const, workspacePath: forkResult.workspacePath }
          : await runtime.createWorkspace({
              projectPath: taskEntry.projectPath,
              branchName: workspaceName,
              trunkBranch,
              directoryName: workspaceName,
              initLogger,
            });

        if (!createResult.success || !createResult.workspacePath) {
          initLogger.logComplete(-1);
          const errorMessage = createResult.error ?? "unknown error";
          log.error("Failed to create queued task workspace", { taskId, error: errorMessage });
          taskQueueDebug("TaskService.maybeStartQueuedTasks createWorkspace failed", {
            taskId,
            error: errorMessage,
            forkSuccess: forkResult.success,
          });
          continue;
        }

        workspacePath = createResult.workspacePath;
        workspaceExists = true;

        taskQueueDebug("TaskService.maybeStartQueuedTasks workspace created", {
          taskId,
          workspacePath,
          forkSuccess: forkResult.success,
          trunkBranch,
        });

        // Persist any corrected path/trunkBranch for restart-safe init.
        await this.editWorkspaceEntry(
          taskId,
          (ws) => {
            ws.path = workspacePath;
            ws.taskTrunkBranch = trunkBranch;
          },
          { allowMissing: true }
        );
      }

      // If init has not yet run for this workspace, start it now (best-effort, async).
      // This is intentionally coupled to task start so queued tasks don't run init hooks
      // (SSH sync, .mux/init scripts, etc.) until they actually begin execution.
      if (shouldRunInit) {
        const initLogger = getInitLogger();
        taskQueueDebug("TaskService.maybeStartQueuedTasks initWorkspace starting", {
          taskId,
          workspacePath,
          trunkBranch,
        });
        void runtime
          .initWorkspace({
            projectPath: taskEntry.projectPath,
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
      }

      const model = task.taskModelString ?? defaultModel;
      const queuedPrompt = coerceNonEmptyString(task.taskPrompt);
      if (queuedPrompt) {
        taskQueueDebug("TaskService.maybeStartQueuedTasks sendMessage starting (dequeue)", {
          taskId,
          model,
          promptLength: queuedPrompt.length,
        });
        const sendResult = await this.workspaceService.sendMessage(
          taskId,
          queuedPrompt,
          { model, thinkingLevel: task.taskThinkingLevel, experiments: task.taskExperiments },
          { allowQueuedAgentTask: true }
        );
        if (!sendResult.success) {
          log.error("Failed to start queued task via sendMessage", {
            taskId,
            error: sendResult.error,
          });
          continue;
        }
      } else {
        // Backward compatibility: older queued tasks persisted their prompt in chat history.
        taskQueueDebug("TaskService.maybeStartQueuedTasks resumeStream starting (legacy dequeue)", {
          taskId,
          model,
        });
        const resumeResult = await this.workspaceService.resumeStream(
          taskId,
          { model, thinkingLevel: task.taskThinkingLevel, experiments: task.taskExperiments },
          { allowQueuedAgentTask: true }
        );

        if (!resumeResult.success) {
          log.error("Failed to start queued task", { taskId, error: resumeResult.error });
          taskQueueDebug("TaskService.maybeStartQueuedTasks resumeStream failed", {
            taskId,
            error: resumeResult.error,
          });
          continue;
        }
      }

      await this.setTaskStatus(taskId, "running");
      taskQueueDebug("TaskService.maybeStartQueuedTasks started", { taskId });
    }
  }

  private async setTaskStatus(workspaceId: string, status: AgentTaskStatus): Promise<void> {
    assert(workspaceId.length > 0, "setTaskStatus: workspaceId must be non-empty");

    await this.editWorkspaceEntry(workspaceId, (ws) => {
      ws.taskStatus = status;
      if (status === "running") {
        ws.taskPrompt = undefined;
      }
    });

    await this.emitWorkspaceMetadata(workspaceId);

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

    const reportArgs = this.findAgentReportArgsInParts(event.parts);
    if (reportArgs) {
      await this.finalizeAgentTaskReport(workspaceId, entry, reportArgs);
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

    // Notify clients immediately even if we can't delete the workspace yet.
    await this.editWorkspaceEntry(
      childWorkspaceId,
      (ws) => {
        ws.taskStatus = "reported";
        ws.reportedAt = getIsoNow();
      },
      { allowMissing: true }
    );

    await this.emitWorkspaceMetadata(childWorkspaceId);

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
    const childEntryBeforeReport = this.findWorkspaceEntry(cfgBeforeReport, childWorkspaceId);
    if (childEntryBeforeReport?.workspace.taskStatus === "reported") {
      return;
    }

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

    await this.finalizeAgentTaskReport(childWorkspaceId, childEntryBeforeReport, reportArgs, {
      stopStream: true,
    });
  }

  private async finalizeAgentTaskReport(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    reportArgs: { reportMarkdown: string; title?: string },
    options?: { stopStream?: boolean }
  ): Promise<void> {
    assert(
      childWorkspaceId.length > 0,
      "finalizeAgentTaskReport: childWorkspaceId must be non-empty"
    );
    assert(
      typeof reportArgs.reportMarkdown === "string" && reportArgs.reportMarkdown.length > 0,
      "finalizeAgentTaskReport: reportMarkdown must be non-empty"
    );

    const cfgBeforeReport = this.config.loadConfigOrDefault();
    const statusBefore = this.findWorkspaceEntry(cfgBeforeReport, childWorkspaceId)?.workspace
      .taskStatus;
    if (statusBefore === "reported") {
      return;
    }

    // Notify clients immediately even if we can't delete the workspace yet.
    await this.editWorkspaceEntry(
      childWorkspaceId,
      (ws) => {
        ws.taskStatus = "reported";
        ws.reportedAt = getIsoNow();
      },
      { allowMissing: true }
    );

    await this.emitWorkspaceMetadata(childWorkspaceId);

    if (options?.stopStream) {
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
    }

    const cfgAfterReport = this.config.loadConfigOrDefault();
    const latestChildEntry =
      this.findWorkspaceEntry(cfgAfterReport, childWorkspaceId) ?? childEntry;
    const parentWorkspaceId = latestChildEntry?.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      const reason = latestChildEntry
        ? "missing parentWorkspaceId"
        : "workspace not found in config";
      log.debug("Ignoring agent_report: workspace is not an agent task", {
        childWorkspaceId,
        reason,
      });
      // Best-effort: resolve any foreground waiters even if we can't deliver to a parent.
      this.resolveWaiters(childWorkspaceId, reportArgs);
      void this.maybeStartQueuedTasks();
      return;
    }

    await this.deliverReportToParent(parentWorkspaceId, latestChildEntry, reportArgs);

    // Resolve foreground waiters.
    this.resolveWaiters(childWorkspaceId, reportArgs);

    // Free slot and start queued tasks.
    await this.maybeStartQueuedTasks();

    // Attempt cleanup of reported tasks (leaf-first).
    await this.cleanupReportedLeafTask(childWorkspaceId);

    // Auto-resume any parent stream that was waiting on a task tool call (restart-safe).
    const postCfg = this.config.loadConfigOrDefault();
    if (!this.findWorkspaceEntry(postCfg, parentWorkspaceId)) {
      // Parent may have been cleaned up (e.g. it already reported and this was its last descendant).
      return;
    }
    const hasActiveDescendants = this.hasActiveDescendantAgentTasks(postCfg, parentWorkspaceId);
    if (!hasActiveDescendants && !this.aiService.isStreaming(parentWorkspaceId)) {
      const resumeResult = await this.workspaceService.resumeStream(parentWorkspaceId, {
        model: latestChildEntry?.workspace.taskModelString ?? defaultModel,
      });
      if (!resumeResult.success) {
        log.error("Failed to auto-resume parent after agent_report", {
          parentWorkspaceId,
          error: resumeResult.error,
        });
      }
    }
  }

  private cleanupExpiredCompletedReports(nowMs = Date.now()): void {
    for (const [taskId, entry] of this.completedReportsByTaskId) {
      if (entry.expiresAtMs <= nowMs) {
        this.completedReportsByTaskId.delete(taskId);
      }
    }
  }

  private enforceCompletedReportCacheLimit(): void {
    while (this.completedReportsByTaskId.size > COMPLETED_REPORT_CACHE_MAX_ENTRIES) {
      const first = this.completedReportsByTaskId.keys().next();
      if (first.done) break;
      this.completedReportsByTaskId.delete(first.value);
    }
  }

  private resolveWaiters(taskId: string, report: { reportMarkdown: string; title?: string }): void {
    const nowMs = Date.now();
    this.cleanupExpiredCompletedReports(nowMs);
    this.completedReportsByTaskId.set(taskId, {
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      expiresAtMs: nowMs + COMPLETED_REPORT_CACHE_TTL_MS,
    });
    this.enforceCompletedReportCacheLimit();

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

  private findAgentReportArgsInParts(
    parts: readonly unknown[]
  ): { reportMarkdown: string; title?: string } | null {
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
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

  private findAgentReportArgsInMessage(
    msg: MuxMessage
  ): { reportMarkdown: string; title?: string } | null {
    return this.findAgentReportArgsInParts(msg.parts);
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
    assert(workspaceId.length > 0, "cleanupReportedLeafTask: workspaceId must be non-empty");

    let currentWorkspaceId = workspaceId;
    const visited = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (visited.has(currentWorkspaceId)) {
        log.error("cleanupReportedLeafTask: possible parentWorkspaceId cycle", {
          workspaceId: currentWorkspaceId,
        });
        return;
      }
      visited.add(currentWorkspaceId);

      const config = this.config.loadConfigOrDefault();
      const entry = this.findWorkspaceEntry(config, currentWorkspaceId);
      if (!entry) return;

      const ws = entry.workspace;
      const parentWorkspaceId = ws.parentWorkspaceId;
      if (!parentWorkspaceId) return;
      if (ws.taskStatus !== "reported") return;

      const hasChildren = this.listAgentTaskWorkspaces(config).some(
        (t) => t.parentWorkspaceId === currentWorkspaceId
      );
      if (hasChildren) return;

      const removeResult = await this.workspaceService.remove(currentWorkspaceId, true);
      if (!removeResult.success) {
        log.error("Failed to auto-delete reported task workspace", {
          workspaceId: currentWorkspaceId,
          error: removeResult.error,
        });
        return;
      }

      currentWorkspaceId = parentWorkspaceId;
    }

    log.error("cleanupReportedLeafTask: exceeded max parent traversal depth", {
      workspaceId,
    });
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
