import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";

import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { log } from "@/node/services/log";
import {
  discoverAgentDefinitions,
  readAgentDefinition,
  resolveAgentFrontmatter,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { orchestrateFork } from "@/node/services/utils/forkOrchestrator";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { runBackgroundInit } from "@/node/runtime/runtimeFactory";
import type { InitLogger, Runtime } from "@/node/runtime/Runtime";
import { readPlanFile } from "@/node/utils/runtime/helpers";
import { routePlanToExecutor } from "@/node/services/planExecutorRouter";
import {
  coerceNonEmptyString,
  tryReadGitHeadCommitSha,
  findWorkspaceEntry,
} from "@/node/services/taskUtils";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import { Ok, Err, type Result } from "@/common/types/result";
import {
  DEFAULT_TASK_SETTINGS,
  type PlanSubagentExecutorRouting,
  type TaskSettings,
} from "@/common/types/tasks";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  createCompactionSummaryMessageId,
  createTaskReportMessageId,
} from "@/node/services/utils/messageIds";
import { defaultModel, normalizeGatewayModel } from "@/common/utils/ai/models";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { AgentIdSchema } from "@/common/orpc/schemas";
import { GitPatchArtifactService } from "@/node/services/gitPatchArtifactService";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { StreamEndEvent } from "@/common/types/stream";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";
import {
  AgentReportToolArgsSchema,
  TaskToolResultSchema,
  TaskToolArgsSchema,
} from "@/common/utils/tools/toolDefinitions";
import { isPlanLikeInResolvedChain } from "@/common/utils/agentTools";
import { formatSendMessageError } from "@/node/services/utils/sendMessageError";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import {
  PLAN_AUTO_ROUTING_STATUS_EMOJI,
  PLAN_AUTO_ROUTING_STATUS_MESSAGE,
} from "@/common/constants/planAutoRoutingStatus";
import { taskQueueDebug } from "@/node/services/taskQueueDebug";
import { readSubagentGitPatchArtifact } from "@/node/services/subagentGitPatchArtifacts";
import {
  readSubagentReportArtifact,
  readSubagentReportArtifactsFile,
  upsertSubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";
import { secretsToRecord } from "@/common/types/secrets";
import { getErrorMessage } from "@/common/utils/errors";

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
  /** Experiments to inherit to subagent */
  experiments?: {
    programmaticToolCalling?: boolean;
    programmaticToolCallingExclusive?: boolean;
    execSubagentHardRestart?: boolean;
  };
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

const COMPLETED_REPORT_CACHE_MAX_ENTRIES = 128;

/** Maximum consecutive auto-resumes before stopping. Prevents infinite loops when descendants are stuck. */
// Task-recovery paths must stay deterministic and editing-capable even when
// workspace/default agent preferences evolve (e.g., auto router defaults).
const TASK_RECOVERY_FALLBACK_AGENT_ID = "exec";

const MAX_CONSECUTIVE_PARENT_AUTO_RESUMES = 3;

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

interface CompletedAgentReportCacheEntry {
  reportMarkdown: string;
  title?: string;
  // Ancestor workspace IDs captured when the report was cached.
  // Used to keep descendant-scope checks working even if the task workspace is cleaned up.
  ancestorWorkspaceIds: string[];
}

interface ParentAutoResumeHint {
  agentId?: string;
}

function isTypedWorkspaceEvent(value: unknown, type: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type: unknown }).type === type &&
    "workspaceId" in value &&
    typeof (value as { workspaceId: unknown }).workspaceId === "string"
  );
}

function isStreamEndEvent(value: unknown): value is StreamEndEvent {
  return isTypedWorkspaceEvent(value, "stream-end");
}

function hasAncestorWorkspaceId(
  entry: { ancestorWorkspaceIds?: unknown } | null | undefined,
  ancestorWorkspaceId: string
): boolean {
  const ids = entry?.ancestorWorkspaceIds;
  return Array.isArray(ids) && ids.includes(ancestorWorkspaceId);
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
  // Serialize stream-end processing per workspace to avoid races when
  // finalizing reported tasks and cleanup state transitions.
  private readonly workspaceEventLocks = new MutexMap<string>();
  private readonly mutex = new AsyncMutex();
  private readonly pendingWaitersByTaskId = new Map<string, PendingTaskWaiter[]>();
  private readonly pendingStartWaitersByTaskId = new Map<string, PendingTaskStartWaiter[]>();
  // Tracks workspaces currently blocked in a foreground wait (e.g. a task tool call awaiting
  // agent_report). Used to avoid scheduler deadlocks when maxParallelAgentTasks is low and tasks
  // spawn nested tasks in the foreground.
  private readonly foregroundAwaitCountByWorkspaceId = new Map<string, number>();
  // Cache completed reports so callers can retrieve them without re-reading disk.
  // Bounded by max entries; disk persistence is the source of truth for restart-safety.
  private readonly completedReportsByTaskId = new Map<string, CompletedAgentReportCacheEntry>();
  private readonly gitPatchArtifactService: GitPatchArtifactService;
  private readonly remindedAwaitingReport = new Set<string>();
  private readonly handoffInProgress = new Set<string>();
  /**
   * Hard-interrupted parent workspaces must not auto-resume until the next user message.
   * This closes races where descendants could report between parent interrupt and cascade cleanup.
   */
  private interruptedParentWorkspaceIds = new Set<string>();
  /** Tracks consecutive auto-resumes per workspace. Reset when a user message is sent. */
  private consecutiveAutoResumes = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly aiService: AIService,
    private readonly workspaceService: WorkspaceService,
    private readonly initStateManager: InitStateManager
  ) {
    this.gitPatchArtifactService = new GitPatchArtifactService(config);

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

  // Prefer per-agent settings so tasks inherit the correct agent defaults;
  // fall back to legacy workspace settings for older configs.
  private resolveWorkspaceAISettings(
    workspace: {
      aiSettingsByAgent?: Record<string, { model: string; thinkingLevel?: ThinkingLevel }>;
      aiSettings?: { model: string; thinkingLevel?: ThinkingLevel };
    },
    agentId: string | undefined
  ): { model: string; thinkingLevel?: ThinkingLevel } | undefined {
    const normalizedAgentId =
      typeof agentId === "string" && agentId.trim().length > 0
        ? agentId.trim().toLowerCase()
        : undefined;
    return (
      (normalizedAgentId ? workspace.aiSettingsByAgent?.[normalizedAgentId] : undefined) ??
      workspace.aiSettings
    );
  }
  /**
   * Derives auto-resume send options (agentId, model, thinkingLevel) from durable
   * conversation metadata, so synthetic resumes preserve the parent's active agent.
   *
   * Precedence: stream-end event metadata → last assistant message in history → workspace AI settings → defaults.
   */
  private async resolveParentAutoResumeOptions(
    parentWorkspaceId: string,
    parentEntry: {
      workspace: {
        aiSettingsByAgent?: Record<string, { model: string; thinkingLevel?: ThinkingLevel }>;
        aiSettings?: { model: string; thinkingLevel?: ThinkingLevel };
      };
    },
    fallbackModel: string,
    hint?: ParentAutoResumeHint
  ): Promise<{ model: string; agentId: string; thinkingLevel?: ThinkingLevel }> {
    // 1) Try stream-end hint metadata (available in handleStreamEnd path)
    let agentId = hint?.agentId;

    // 2) Fall back to latest assistant message metadata in history (restart-safe)
    if (!agentId) {
      try {
        const historyResult = await this.historyService.getLastMessages(parentWorkspaceId, 20);
        if (historyResult.success) {
          for (let i = historyResult.data.length - 1; i >= 0; i--) {
            const msg = historyResult.data[i];
            if (msg?.role === "assistant" && msg.metadata?.agentId) {
              agentId = msg.metadata.agentId;
              break;
            }
          }
        }
      } catch {
        // Best-effort; fall through to defaults
      }
    }

    // 3) Default
    // Keep task auto-resume recovery on exec even if the workspace default agent changes.
    // This path needs a deterministic editing-capable fallback for legacy/incomplete metadata.
    agentId = agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID;

    const aiSettings = this.resolveWorkspaceAISettings(parentEntry.workspace, agentId);
    return {
      model: aiSettings?.model ?? fallbackModel,
      agentId,
      thinkingLevel: aiSettings?.thinkingLevel,
    };
  }

  private async isPlanLikeTaskWorkspace(entry: {
    projectPath: string;
    workspace: Pick<
      WorkspaceConfigEntry,
      "id" | "name" | "path" | "runtimeConfig" | "agentId" | "agentType"
    >;
  }): Promise<boolean> {
    assert(entry.projectPath.length > 0, "isPlanLikeTaskWorkspace: projectPath must be non-empty");

    const rawAgentId = coerceNonEmptyString(entry.workspace.agentId ?? entry.workspace.agentType);
    if (!rawAgentId) {
      return false;
    }

    const normalizedAgentId = rawAgentId.trim().toLowerCase();
    const parsedAgentId = AgentIdSchema.safeParse(normalizedAgentId);
    if (!parsedAgentId.success) {
      return normalizedAgentId === "plan";
    }

    const workspacePath = coerceNonEmptyString(entry.workspace.path);
    const workspaceName = coerceNonEmptyString(entry.workspace.name) ?? entry.workspace.id;
    const runtimeConfig = entry.workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG;
    if (!workspacePath || !workspaceName) {
      return parsedAgentId.data === "plan";
    }

    try {
      const runtime = createRuntimeForWorkspace({
        runtimeConfig,
        projectPath: entry.projectPath,
        name: workspaceName,
      });
      const agentDefinition = await readAgentDefinition(runtime, workspacePath, parsedAgentId.data);
      const chain = await resolveAgentInheritanceChain({
        runtime,
        workspacePath,
        agentId: agentDefinition.id,
        agentDefinition,
        workspaceId: entry.workspace.id ?? workspaceName,
      });

      if (agentDefinition.id === "compact") {
        return false;
      }

      return isPlanLikeInResolvedChain(chain);
    } catch (error: unknown) {
      log.debug("Failed to resolve task agent mode; falling back to agentId check", {
        workspaceId: entry.workspace.id,
        agentId: parsedAgentId.data,
        error: error instanceof Error ? error.message : String(error),
      });
      return parsedAgentId.data === "plan";
    }
  }

  private async isAgentEnabledForTaskWorkspace(args: {
    workspaceId: string;
    projectPath: string;
    workspace: Pick<WorkspaceConfigEntry, "id" | "name" | "path" | "runtimeConfig">;
    agentId: "exec" | "orchestrator";
  }): Promise<boolean> {
    assert(
      args.workspaceId.length > 0,
      "isAgentEnabledForTaskWorkspace: workspaceId must be non-empty"
    );
    assert(
      args.projectPath.length > 0,
      "isAgentEnabledForTaskWorkspace: projectPath must be non-empty"
    );

    const workspaceName = coerceNonEmptyString(args.workspace.name) ?? args.workspace.id;
    if (!workspaceName) {
      return false;
    }

    const runtimeConfig = args.workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG;
    const runtime = createRuntimeForWorkspace({
      runtimeConfig,
      projectPath: args.projectPath,
      name: workspaceName,
    });
    const workspacePath =
      coerceNonEmptyString(args.workspace.path) ??
      runtime.getWorkspacePath(args.projectPath, workspaceName);

    if (!workspacePath) {
      return false;
    }

    try {
      const resolvedFrontmatter = await resolveAgentFrontmatter(
        runtime,
        workspacePath,
        args.agentId
      );
      const cfg = this.config.loadConfigOrDefault();
      const effectivelyDisabled = isAgentEffectivelyDisabled({
        cfg,
        agentId: args.agentId,
        resolvedFrontmatter,
      });
      return !effectivelyDisabled;
    } catch (error: unknown) {
      log.warn("Failed to resolve task handoff target agent availability", {
        workspaceId: args.workspaceId,
        agentId: args.agentId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  private async resolvePlanAutoHandoffTargetAgentId(args: {
    workspaceId: string;
    entry: {
      projectPath: string;
      workspace: Pick<
        WorkspaceConfigEntry,
        "id" | "name" | "path" | "runtimeConfig" | "taskModelString"
      >;
    };
    routing: PlanSubagentExecutorRouting;
    planContent: string | null;
  }): Promise<"exec" | "orchestrator"> {
    assert(
      args.workspaceId.length > 0,
      "resolvePlanAutoHandoffTargetAgentId: workspaceId must be non-empty"
    );
    assert(
      args.routing === "exec" || args.routing === "orchestrator" || args.routing === "auto",
      "resolvePlanAutoHandoffTargetAgentId: routing must be exec, orchestrator, or auto"
    );

    const resolveOrchestratorAvailability = async (): Promise<"exec" | "orchestrator"> => {
      const orchestratorEnabled = await this.isAgentEnabledForTaskWorkspace({
        workspaceId: args.workspaceId,
        projectPath: args.entry.projectPath,
        workspace: args.entry.workspace,
        agentId: "orchestrator",
      });
      if (orchestratorEnabled) {
        return "orchestrator";
      }

      // If orchestrator is disabled/unavailable, fall back to exec before mutating
      // workspace agent state so the handoff stream can still proceed.
      log.warn("Plan-task auto-handoff falling back to exec because orchestrator is unavailable", {
        workspaceId: args.workspaceId,
      });
      return "exec";
    };

    if (args.routing === "exec") {
      return "exec";
    }

    if (args.routing === "orchestrator") {
      return resolveOrchestratorAvailability();
    }

    if (!args.planContent || args.planContent.trim().length === 0) {
      log.warn("Plan-task auto-handoff auto-routing has no plan content; defaulting to exec", {
        workspaceId: args.workspaceId,
      });
      return "exec";
    }

    const modelString = normalizeGatewayModel(
      coerceNonEmptyString(args.entry.workspace.taskModelString) ?? defaultModel
    );
    assert(
      modelString.trim().length > 0,
      "resolvePlanAutoHandoffTargetAgentId: modelString must be non-empty"
    );

    const modelResult = await this.aiService.createModel(modelString);
    if (!modelResult.success) {
      log.warn("Plan-task auto-handoff auto-routing failed to create model; defaulting to exec", {
        workspaceId: args.workspaceId,
        model: modelString,
        error: modelResult.error,
      });
      return "exec";
    }

    const decision = await routePlanToExecutor({
      model: modelResult.data,
      planContent: args.planContent,
    });

    log.info("Plan-task auto-handoff routing decision", {
      workspaceId: args.workspaceId,
      target: decision.target,
      reasoning: decision.reasoning,
      model: modelString,
    });

    if (decision.target === "orchestrator") {
      return resolveOrchestratorAvailability();
    }

    return "exec";
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

      // Restart-safety: if this task stream ends again without its required completion tool,
      // fall back immediately.
      this.remindedAwaitingReport.add(task.id);

      const isPlanLike = await this.isPlanLikeTaskWorkspace({
        projectPath: task.projectPath,
        workspace: task,
      });
      const completionToolName = isPlanLike ? "propose_plan" : "agent_report";

      const model = task.taskModelString ?? defaultModel;
      const sendResult = await this.workspaceService.sendMessage(
        task.id,
        isPlanLike
          ? "This task is awaiting its final propose_plan. Call propose_plan exactly once now."
          : "This task is awaiting its final agent_report. Call agent_report exactly once now.",
        {
          model,
          agentId: task.agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID,
          thinkingLevel: task.taskThinkingLevel,
          toolPolicy: [{ regex_match: `^${completionToolName}$`, action: "require" }],
        },
        { synthetic: true }
      );
      if (!sendResult.success) {
        log.error("Failed to resume awaiting_report task on startup", {
          taskId: task.id,
          error: sendResult.error,
        });

        await this.fallbackReportMissingCompletionTool(
          {
            projectPath: task.projectPath,
            workspace: task,
          },
          completionToolName
        );
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

      const isPlanLike = await this.isPlanLikeTaskWorkspace({
        projectPath: task.projectPath,
        workspace: task,
      });

      const model = task.taskModelString ?? defaultModel;
      await this.workspaceService.sendMessage(
        task.id,
        isPlanLike
          ? "Mux restarted while this task was running. Continue where you left off. " +
              "When you have a final plan, call propose_plan exactly once."
          : "Mux restarted while this task was running. Continue where you left off. " +
              "When you have a final answer, call agent_report exactly once.",
        {
          model,
          agentId: task.agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID,
          thinkingLevel: task.taskThinkingLevel,
          experiments: task.taskExperiments,
        },
        { synthetic: true }
      );
    }

    // Restart-safety for git patch artifacts:
    // - If mux crashed mid-generation, patch artifacts can be left "pending".
    // - Reported tasks are auto-deleted once they're leaves; defer deletion while patches are pending.
    const reportedTasks = this.listAgentTaskWorkspaces(config).filter(
      (t) => t.taskStatus === "reported" && typeof t.id === "string" && t.id.length > 0
    );

    for (const task of reportedTasks) {
      if (!task.parentWorkspaceId) continue;
      try {
        await this.gitPatchArtifactService.maybeStartGeneration(
          task.parentWorkspaceId,
          task.id!,
          (wsId) => this.requestReportedTaskCleanupRecheck(wsId)
        );
      } catch (error: unknown) {
        log.error("Failed to resume subagent git patch generation on startup", {
          parentWorkspaceId: task.parentWorkspaceId,
          childWorkspaceId: task.id,
          error,
        });
      }
    }

    // Best-effort cleanup of reported leaf tasks (will no-op when patch artifacts are pending).
    for (const task of reportedTasks) {
      if (!task.id) continue;
      await this.cleanupReportedLeafTask(task.id);
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
      enterHookPhase: () => this.initStateManager.enterHookPhase(workspaceId),
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

    const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
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

    // User-requested precedence: use global per-agent defaults when configured;
    // otherwise inherit the parent workspace's active model/thinking.
    const parentAiSettings = this.resolveWorkspaceAISettings(parentMeta, agentId);
    const inheritedModelCandidate =
      typeof args.modelString === "string" && args.modelString.trim().length > 0
        ? args.modelString
        : parentAiSettings?.model;
    const parentActiveModel =
      typeof inheritedModelCandidate === "string" && inheritedModelCandidate.trim().length > 0
        ? inheritedModelCandidate.trim()
        : defaultModel;
    const globalDefault = cfg.agentAiDefaults?.[agentId];
    const configuredModel = globalDefault?.modelString?.trim();
    const taskModelString =
      configuredModel && configuredModel.length > 0 ? configuredModel : parentActiveModel;
    const canonicalModel = normalizeGatewayModel(taskModelString).trim();
    assert(canonicalModel.length > 0, "Task.create: resolved model must be non-empty");

    const requestedThinkingLevel: ThinkingLevel =
      globalDefault?.thinkingLevel ??
      args.thinkingLevel ??
      parentAiSettings?.thinkingLevel ??
      "off";
    const effectiveThinkingLevel = enforceThinkingPolicy(canonicalModel, requestedThinkingLevel);

    const parentRuntimeConfig = parentMeta.runtimeConfig;
    const taskRuntimeConfig: RuntimeConfig = parentRuntimeConfig;

    const runtime = createRuntimeForWorkspace({
      runtimeConfig: taskRuntimeConfig,
      projectPath: parentMeta.projectPath,
      name: parentMeta.name,
    });

    // Validate the agent definition exists and is runnable as a sub-agent.
    const isInPlace = parentMeta.projectPath === parentMeta.name;
    const parentWorkspacePath = isInPlace
      ? parentMeta.projectPath
      : runtime.getWorkspacePath(parentMeta.projectPath, parentMeta.name);

    // Helper to build error hint with all available runnable agents.
    // NOTE: This resolves frontmatter inheritance so same-name overrides (e.g. project exec.md
    // with base: exec) still count as runnable.
    const getRunnableHint = async (): Promise<string> => {
      try {
        const allAgents = await discoverAgentDefinitions(runtime, parentWorkspacePath);

        const runnableIds = (
          await Promise.all(
            allAgents.map(async (agent) => {
              try {
                const frontmatter = await resolveAgentFrontmatter(
                  runtime,
                  parentWorkspacePath,
                  agent.id
                );
                if (frontmatter.subagent?.runnable !== true) {
                  return null;
                }

                const effectivelyDisabled = isAgentEffectivelyDisabled({
                  cfg,
                  agentId: agent.id,
                  resolvedFrontmatter: frontmatter,
                });
                return effectivelyDisabled ? null : agent.id;
              } catch {
                return null;
              }
            })
          )
        ).filter((id): id is string => typeof id === "string");

        return runnableIds.length > 0
          ? `Runnable agentIds: ${runnableIds.join(", ")}`
          : "No runnable agents available";
      } catch {
        return "Could not discover available agents";
      }
    };

    let skipInitHook = false;
    try {
      const frontmatter = await resolveAgentFrontmatter(runtime, parentWorkspacePath, agentId);
      if (frontmatter.subagent?.runnable !== true) {
        const hint = await getRunnableHint();
        return Err(`Task.create: agentId is not runnable as a sub-agent (${agentId}). ${hint}`);
      }

      if (
        isAgentEffectivelyDisabled({
          cfg,
          agentId,
          resolvedFrontmatter: frontmatter,
        })
      ) {
        const hint = await getRunnableHint();
        return Err(`Task.create: agentId is disabled (${agentId}). ${hint}`);
      }
      skipInitHook = frontmatter.subagent?.skip_init_hook === true;
    } catch {
      const hint = await getRunnableHint();
      return Err(`Task.create: unknown agentId (${agentId}). ${hint}`);
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

    const forkResult = await orchestrateFork({
      sourceRuntime: runtime,
      projectPath: parentMeta.projectPath,
      sourceWorkspaceName: parentMeta.name,
      newWorkspaceName: workspaceName,
      initLogger,
      config: this.config,
      sourceWorkspaceId: parentWorkspaceId,
      sourceRuntimeConfig: parentRuntimeConfig,
      allowCreateFallback: true,
    });

    if (forkResult.success && forkResult.data.sourceRuntimeConfigUpdate) {
      await this.config.updateWorkspaceMetadata(parentWorkspaceId, {
        runtimeConfig: forkResult.data.sourceRuntimeConfigUpdate,
      });
      // Ensure UI gets the updated runtimeConfig for the parent workspace.
      await this.emitWorkspaceMetadata(parentWorkspaceId);
    }

    if (!forkResult.success) {
      initLogger.logComplete(-1);
      return Err(`Task fork failed: ${forkResult.error}`);
    }

    const {
      workspacePath,
      trunkBranch,
      forkedRuntimeConfig,
      targetRuntime: runtimeForTaskWorkspace,
      forkedFromSource,
    } = forkResult.data;
    const taskBaseCommitSha = await tryReadGitHeadCommitSha(runtimeForTaskWorkspace, workspacePath);

    taskQueueDebug("TaskService.create started (workspace created)", {
      taskId,
      workspaceName,
      workspacePath,
      trunkBranch,
      forkSuccess: forkedFromSource,
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
        runtimeConfig: forkedRuntimeConfig,
        aiSettings: { model: canonicalModel, thinkingLevel: effectiveThinkingLevel },
        agentId,
        parentWorkspaceId,
        agentType,
        taskStatus: "running",
        taskTrunkBranch: trunkBranch,
        taskBaseCommitSha: taskBaseCommitSha ?? undefined,
        taskModelString,
        taskThinkingLevel: effectiveThinkingLevel,
        taskExperiments: args.experiments,
      });
      return config;
    });

    // Emit metadata update so the UI sees the workspace immediately.
    await this.emitWorkspaceMetadata(taskId);

    // Kick init (best-effort, async).
    const secrets = secretsToRecord(this.config.getEffectiveSecrets(parentMeta.projectPath));
    runBackgroundInit(
      runtimeForTaskWorkspace,
      {
        projectPath: parentMeta.projectPath,
        branchName: workspaceName,
        trunkBranch,
        workspacePath,
        initLogger,
        env: secrets,
        skipInitHook,
      },
      taskId
    );

    // Start immediately (counts towards parallel limit).
    const sendResult = await this.workspaceService.sendMessage(taskId, prompt, {
      model: taskModelString,
      agentId,
      thinkingLevel: effectiveThinkingLevel,
      experiments: args.experiments,
    });
    if (!sendResult.success) {
      const message =
        typeof sendResult.error === "string"
          ? sendResult.error
          : formatSendMessageError(sendResult.error).message;
      await this.rollbackFailedTaskCreate(
        runtimeForTaskWorkspace,
        parentMeta.projectPath,
        workspaceName,
        taskId
      );
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
      const entry = findWorkspaceEntry(cfg, taskId);
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

  /**
   * Terminate all descendant agent tasks for a workspace (leaf-first).
   *
   * Rationale: when a user hard-interrupts a parent workspace, descendants must
   * also stop so they cannot later auto-resume the interrupted parent.
   */
  async terminateAllDescendantAgentTasks(workspaceId: string): Promise<string[]> {
    assert(
      workspaceId.length > 0,
      "terminateAllDescendantAgentTasks: workspaceId must be non-empty"
    );

    const terminatedTaskIds: string[] = [];

    {
      await using _lock = await this.mutex.acquire();

      const cfg = this.config.loadConfigOrDefault();
      const index = this.buildAgentTaskIndex(cfg);
      const descendants = this.listDescendantAgentTaskIdsFromIndex(index, workspaceId);
      if (descendants.length === 0) {
        return terminatedTaskIds;
      }

      // Delete leaves first to avoid leaving children with missing parents.
      const parentById = index.parentById;
      const depthById = new Map<string, number>();
      for (const id of descendants) {
        depthById.set(id, this.getTaskDepthFromParentById(parentById, id));
      }
      descendants.sort((a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0));

      const terminationError = new Error("Parent workspace interrupted");

      for (const id of descendants) {
        // Best-effort: stop any active stream immediately to avoid further token usage.
        try {
          const stopResult = await this.aiService.stopStream(id, { abandonPartial: true });
          if (!stopResult.success) {
            log.debug("terminateAllDescendantAgentTasks: stopStream failed", { taskId: id });
          }
        } catch (error: unknown) {
          log.debug("terminateAllDescendantAgentTasks: stopStream threw", { taskId: id, error });
        }

        this.remindedAwaitingReport.delete(id);
        this.completedReportsByTaskId.delete(id);
        this.rejectWaiters(id, terminationError);

        const removeResult = await this.workspaceService.remove(id, true);
        if (!removeResult.success) {
          log.error("terminateAllDescendantAgentTasks: failed to remove task workspace", {
            taskId: id,
            error: removeResult.error,
          });
          continue;
        }

        terminatedTaskIds.push(id);
      }
    }

    // Free slots and start any queued tasks (best-effort).
    await this.maybeStartQueuedTasks();

    return terminatedTaskIds;
  }

  private async rollbackFailedTaskCreate(
    runtime: Runtime,
    projectPath: string,
    workspaceName: string,
    taskId: string
  ): Promise<void> {
    try {
      await this.config.removeWorkspace(taskId);
    } catch (error: unknown) {
      log.error("Task.create rollback: failed to remove workspace from config", {
        taskId,
        error: getErrorMessage(error),
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
        error: getErrorMessage(error),
      });
    }

    try {
      const sessionDir = this.config.getSessionDir(taskId);
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
    } catch (error: unknown) {
      log.error("Task.create rollback: failed to remove session directory", {
        taskId,
        error: getErrorMessage(error),
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

  async waitForAgentReport(
    taskId: string,
    options?: { timeoutMs?: number; abortSignal?: AbortSignal; requestingWorkspaceId?: string }
  ): Promise<{ reportMarkdown: string; title?: string }> {
    assert(taskId.length > 0, "waitForAgentReport: taskId must be non-empty");

    const cached = this.completedReportsByTaskId.get(taskId);
    if (cached) {
      return { reportMarkdown: cached.reportMarkdown, title: cached.title };
    }

    const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000; // 10 minutes
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "waitForAgentReport: timeoutMs invalid");

    const requestingWorkspaceId = coerceNonEmptyString(options?.requestingWorkspaceId);

    const tryReadPersistedReport = async (): Promise<{
      reportMarkdown: string;
      title?: string;
    } | null> => {
      if (!requestingWorkspaceId) {
        return null;
      }

      const sessionDir = this.config.getSessionDir(requestingWorkspaceId);
      const artifact = await readSubagentReportArtifact(sessionDir, taskId);
      if (!artifact) {
        return null;
      }

      // Cache for the current process (best-effort). Disk is the source of truth.
      this.completedReportsByTaskId.set(taskId, {
        reportMarkdown: artifact.reportMarkdown,
        title: artifact.title,
        ancestorWorkspaceIds: artifact.ancestorWorkspaceIds,
      });
      this.enforceCompletedReportCacheLimit();

      return { reportMarkdown: artifact.reportMarkdown, title: artifact.title };
    };

    // Fast-path: if the task is already gone (cleanup) or already reported (restart), return the
    // persisted artifact from the requesting workspace session dir.
    const cfg = this.config.loadConfigOrDefault();
    const taskWorkspaceEntry = findWorkspaceEntry(cfg, taskId);
    if (!taskWorkspaceEntry || taskWorkspaceEntry.workspace.taskStatus === "reported") {
      const persisted = await tryReadPersistedReport();
      if (persisted) {
        return persisted;
      }

      throw new Error("Task not found");
    }

    return await new Promise<{ reportMarkdown: string; title?: string }>((resolve, reject) => {
      void (async () => {
        // Validate existence early to avoid waiting on never-resolving task IDs.
        const cfg = this.config.loadConfigOrDefault();
        const taskWorkspaceEntry = findWorkspaceEntry(cfg, taskId);
        if (!taskWorkspaceEntry) {
          const persisted = await tryReadPersistedReport();
          if (persisted) {
            resolve(persisted);
            return;
          }

          reject(new Error("Task not found"));
          return;
        }

        if (taskWorkspaceEntry.workspace.taskStatus === "reported") {
          const persisted = await tryReadPersistedReport();
          if (persisted) {
            resolve(persisted);
            return;
          }

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
          const afterEntry = findWorkspaceEntry(cfgAfterRegister, taskId);
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
      })().catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  getAgentTaskStatus(taskId: string): AgentTaskStatus | null {
    assert(taskId.length > 0, "getAgentTaskStatus: taskId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, taskId);
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

  async filterDescendantAgentTaskIds(
    ancestorWorkspaceId: string,
    taskIds: string[]
  ): Promise<string[]> {
    assert(
      ancestorWorkspaceId.length > 0,
      "filterDescendantAgentTaskIds: ancestorWorkspaceId required"
    );
    assert(Array.isArray(taskIds), "filterDescendantAgentTaskIds: taskIds must be an array");

    const cfg = this.config.loadConfigOrDefault();
    const parentById = this.buildAgentTaskIndex(cfg).parentById;

    const result: string[] = [];
    const maybePersisted: string[] = [];

    for (const taskId of taskIds) {
      if (typeof taskId !== "string" || taskId.length === 0) continue;

      if (this.isDescendantAgentTaskUsingParentById(parentById, ancestorWorkspaceId, taskId)) {
        result.push(taskId);
        continue;
      }

      const cached = this.completedReportsByTaskId.get(taskId);
      if (hasAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
        result.push(taskId);
        continue;
      }

      maybePersisted.push(taskId);
    }

    if (maybePersisted.length === 0) {
      return result;
    }

    const sessionDir = this.config.getSessionDir(ancestorWorkspaceId);
    const persisted = await readSubagentReportArtifactsFile(sessionDir);
    for (const taskId of maybePersisted) {
      const entry = persisted.artifactsByChildTaskId[taskId];
      if (!entry) continue;
      if (hasAncestorWorkspaceId(entry, ancestorWorkspaceId)) {
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

  async isDescendantAgentTask(ancestorWorkspaceId: string, taskId: string): Promise<boolean> {
    assert(ancestorWorkspaceId.length > 0, "isDescendantAgentTask: ancestorWorkspaceId required");
    assert(taskId.length > 0, "isDescendantAgentTask: taskId required");

    const cfg = this.config.loadConfigOrDefault();
    const parentById = this.buildAgentTaskIndex(cfg).parentById;
    if (this.isDescendantAgentTaskUsingParentById(parentById, ancestorWorkspaceId, taskId)) {
      return true;
    }

    // The task workspace may have been removed after it reported (cleanup/restart). Preserve scope
    // checks by consulting persisted report artifacts in the ancestor session dir.
    const cached = this.completedReportsByTaskId.get(taskId);
    if (hasAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
      return true;
    }

    const sessionDir = this.config.getSessionDir(ancestorWorkspaceId);
    const persisted = await readSubagentReportArtifactsFile(sessionDir);
    const entry = persisted.artifactsByChildTaskId[taskId];
    return hasAncestorWorkspaceId(entry, ancestorWorkspaceId);
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

  private listAncestorWorkspaceIdsUsingParentById(
    parentById: Map<string, string>,
    taskId: string
  ): string[] {
    const ancestors: string[] = [];

    let current = taskId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) return ancestors;
      ancestors.push(parent);
      current = parent;
    }

    throw new Error(
      `listAncestorWorkspaceIdsUsingParentById: possible parentWorkspaceId cycle starting at ${taskId}`
    );
  }

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

      // Defensive: task status and runtime stream state can be briefly out of sync during
      // termination/cleanup boundaries. Count streaming tasks as active so we never exceed
      // the configured parallel limit.
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

  /**
   * Topology predicate: does this workspace still have child agent-task nodes in config?
   * Unlike hasActiveDescendantAgentTasks (which checks runtime activity for scheduling),
   * this checks structural tree shape — any child node blocks parent deletion regardless
   * of its status.
   */
  private hasChildAgentTasks(index: AgentTaskIndex, workspaceId: string): boolean {
    return (index.childrenByParent.get(workspaceId)?.length ?? 0) > 0;
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

      const taskEntry = findWorkspaceEntry(config, taskId);
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

      const parentEntry = findWorkspaceEntry(config, parentId);
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

      const taskRuntimeConfig = task.runtimeConfig ?? parentEntry.workspace.runtimeConfig;
      if (!taskRuntimeConfig) {
        log.error("Queued task missing runtimeConfig; cannot start", { taskId });
        continue;
      }

      const parentRuntimeConfig = parentEntry.workspace.runtimeConfig ?? taskRuntimeConfig;
      const workspaceName = task.name.trim();
      const runtime = createRuntimeForWorkspace({
        runtimeConfig: taskRuntimeConfig,
        projectPath: taskEntry.projectPath,
        name: workspaceName,
      });
      let runtimeForTaskWorkspace = runtime;
      let forkedRuntimeConfig = taskRuntimeConfig;

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
        runtimeType: taskRuntimeConfig.type,
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

        const forkOrchestratorResult = await orchestrateFork({
          sourceRuntime: runtime,
          projectPath: taskEntry.projectPath,
          sourceWorkspaceName: parentWorkspaceName,
          newWorkspaceName: workspaceName,
          initLogger,
          config: this.config,
          sourceWorkspaceId: parentId,
          sourceRuntimeConfig: parentRuntimeConfig,
          allowCreateFallback: true,
          preferredTrunkBranch: trunkBranch,
        });

        if (
          forkOrchestratorResult.success &&
          forkOrchestratorResult.data.sourceRuntimeConfigUpdate
        ) {
          await this.config.updateWorkspaceMetadata(parentId, {
            runtimeConfig: forkOrchestratorResult.data.sourceRuntimeConfigUpdate,
          });
          // Ensure UI gets the updated runtimeConfig for the parent workspace.
          await this.emitWorkspaceMetadata(parentId);
        }

        if (!forkOrchestratorResult.success) {
          initLogger.logComplete(-1);
          log.error("Task fork failed", { taskId, error: forkOrchestratorResult.error });
          taskQueueDebug("TaskService.maybeStartQueuedTasks fork failed", {
            taskId,
            error: forkOrchestratorResult.error,
          });
          continue;
        }

        const {
          forkedRuntimeConfig: resolvedForkedRuntimeConfig,
          targetRuntime,
          workspacePath: resolvedWorkspacePath,
          trunkBranch: resolvedTrunkBranch,
          forkedFromSource,
        } = forkOrchestratorResult.data;

        forkedRuntimeConfig = resolvedForkedRuntimeConfig;
        runtimeForTaskWorkspace = targetRuntime;
        workspacePath = resolvedWorkspacePath;
        trunkBranch = resolvedTrunkBranch;
        workspaceExists = true;

        taskQueueDebug("TaskService.maybeStartQueuedTasks workspace created", {
          taskId,
          workspacePath,
          forkSuccess: forkedFromSource,
          trunkBranch,
        });

        // Persist any corrected path/trunkBranch for restart-safe init.
        await this.editWorkspaceEntry(
          taskId,
          (ws) => {
            ws.path = workspacePath;
            ws.taskTrunkBranch = trunkBranch;
            ws.runtimeConfig = forkedRuntimeConfig;
          },
          { allowMissing: true }
        );
      }

      // If init has not yet run for this workspace, start it now (best-effort, async).
      // This is intentionally coupled to task start so queued tasks don't run init hooks
      // Capture base commit for git-format-patch generation before the agent starts.
      // This must reflect the *actual* workspace HEAD after creation/fork, not the parent's current HEAD
      // (queued tasks can start much later).
      if (!coerceNonEmptyString(task.taskBaseCommitSha)) {
        const taskBaseCommitSha = await tryReadGitHeadCommitSha(
          runtimeForTaskWorkspace,
          workspacePath
        );
        if (taskBaseCommitSha) {
          await this.editWorkspaceEntry(
            taskId,
            (ws) => {
              ws.taskBaseCommitSha = taskBaseCommitSha;
            },
            { allowMissing: true }
          );
        }
      }

      // (SSH sync, .mux/init scripts, etc.) until they actually begin execution.
      if (shouldRunInit) {
        const initLogger = getInitLogger();
        taskQueueDebug("TaskService.maybeStartQueuedTasks initWorkspace starting", {
          taskId,
          workspacePath,
          trunkBranch,
        });
        const secrets = secretsToRecord(this.config.getEffectiveSecrets(taskEntry.projectPath));
        let skipInitHook = false;
        const agentIdRaw = coerceNonEmptyString(task.agentId ?? task.agentType);
        if (agentIdRaw) {
          const parsedAgentId = AgentIdSchema.safeParse(agentIdRaw.trim().toLowerCase());
          if (parsedAgentId.success) {
            const isInPlace = taskEntry.projectPath === parentWorkspaceName;
            const parentWorkspacePath =
              coerceNonEmptyString(parentEntry.workspace.path) ??
              (isInPlace
                ? taskEntry.projectPath
                : runtime.getWorkspacePath(taskEntry.projectPath, parentWorkspaceName));

            try {
              const frontmatter = await resolveAgentFrontmatter(
                runtime,
                parentWorkspacePath,
                parsedAgentId.data
              );
              skipInitHook = frontmatter.subagent?.skip_init_hook === true;
            } catch (error: unknown) {
              log.debug("Queued task: failed to read agent definition for skip_init_hook", {
                taskId,
                agentId: parsedAgentId.data,
                error: getErrorMessage(error),
              });
            }
          }
        }

        runBackgroundInit(
          runtimeForTaskWorkspace,
          {
            projectPath: taskEntry.projectPath,
            branchName: workspaceName,
            trunkBranch,
            workspacePath,
            initLogger,
            env: secrets,
            skipInitHook,
          },
          taskId
        );
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
          {
            model,
            agentId: task.agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID,
            thinkingLevel: task.taskThinkingLevel,
            experiments: task.taskExperiments,
          },
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
          {
            model,
            agentId: task.agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID,
            thinkingLevel: task.taskThinkingLevel,
            experiments: task.taskExperiments,
          },
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

  /**
   * Reset interrupt + auto-resume state for a workspace (called when user sends a real message).
   */
  resetAutoResumeCount(workspaceId: string): void {
    assert(workspaceId.length > 0, "resetAutoResumeCount: workspaceId must be non-empty");
    this.consecutiveAutoResumes.delete(workspaceId);
    this.interruptedParentWorkspaceIds.delete(workspaceId);
  }

  /** Mark a parent workspace as hard-interrupted by the user. */
  markParentWorkspaceInterrupted(workspaceId: string): void {
    assert(workspaceId.length > 0, "markParentWorkspaceInterrupted: workspaceId must be non-empty");
    this.consecutiveAutoResumes.delete(workspaceId);
    this.interruptedParentWorkspaceIds.add(workspaceId);
  }

  private async handleStreamEnd(event: StreamEndEvent): Promise<void> {
    const workspaceId = event.workspaceId;

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
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

      if (this.interruptedParentWorkspaceIds.has(workspaceId)) {
        log.debug("Skipping parent auto-resume after hard interrupt", { workspaceId });
        return;
      }

      const activeTaskIds = this.listActiveDescendantAgentTaskIds(workspaceId);

      // Check for auto-resume flood protection
      const resumeCount = this.consecutiveAutoResumes.get(workspaceId) ?? 0;
      if (resumeCount >= MAX_CONSECUTIVE_PARENT_AUTO_RESUMES) {
        log.warn("Auto-resume limit reached for parent workspace with active descendants", {
          workspaceId,
          resumeCount,
          activeTaskIds,
          limit: MAX_CONSECUTIVE_PARENT_AUTO_RESUMES,
        });
        return;
      }
      this.consecutiveAutoResumes.set(workspaceId, resumeCount + 1);

      const resumeOptions = await this.resolveParentAutoResumeOptions(
        workspaceId,
        entry,
        defaultModel,
        event.metadata
      );

      const sendResult = await this.workspaceService.sendMessage(
        workspaceId,
        `You have active background sub-agent task(s) (${activeTaskIds.join(", ")}). ` +
          "You MUST NOT end your turn while any sub-agent tasks are queued/running/awaiting_report. " +
          "Call task_await now to wait for them to finish (omit timeout_secs to wait up to 10 minutes). " +
          "If any tasks are still queued/running/awaiting_report after that, call task_await again. " +
          "Only once all tasks are completed should you write your final response, integrating their reports.",
        {
          model: resumeOptions.model,
          agentId: resumeOptions.agentId,
          thinkingLevel: resumeOptions.thinkingLevel,
        },
        // Skip auto-resume counter reset — this IS an auto-resume, not a user message.
        { skipAutoResumeReset: true, synthetic: true }
      );
      if (!sendResult.success) {
        log.error("Failed to resume parent with active background tasks", {
          workspaceId,
          error: sendResult.error,
        });
      }
      return;
    }

    const status = entry.workspace.taskStatus;
    if (status === "reported") {
      await this.finalizeTerminationPhaseForReportedTask(workspaceId);
      return;
    }

    const isPlanLike = await this.isPlanLikeTaskWorkspace(entry);

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
      await this.finalizeTerminationPhaseForReportedTask(workspaceId);
      return;
    }

    const proposePlanResult = this.findProposePlanSuccessInParts(event.parts);
    if (isPlanLike && proposePlanResult) {
      await this.handleSuccessfulProposePlanAutoHandoff({
        workspaceId,
        entry,
        proposePlanResult,
        planSubagentExecutorRouting:
          (cfg.taskSettings ?? DEFAULT_TASK_SETTINGS).planSubagentExecutorRouting ?? "exec",
      });
      return;
    }

    const missingCompletionToolName = isPlanLike ? "propose_plan" : "agent_report";

    // If a task stream ends without its required completion tool, request it once.
    if (status === "awaiting_report" && this.remindedAwaitingReport.has(workspaceId)) {
      await this.fallbackReportMissingCompletionTool(entry, missingCompletionToolName);
      await this.finalizeTerminationPhaseForReportedTask(workspaceId);
      return;
    }

    await this.setTaskStatus(workspaceId, "awaiting_report");

    this.remindedAwaitingReport.add(workspaceId);

    const model = entry.workspace.taskModelString ?? defaultModel;
    await this.workspaceService.sendMessage(
      workspaceId,
      isPlanLike
        ? "Your stream ended without calling propose_plan. Call propose_plan exactly once now."
        : "Your stream ended without calling agent_report. Call agent_report exactly once now with your final report.",
      {
        model,
        agentId: entry.workspace.agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID,
        thinkingLevel: entry.workspace.taskThinkingLevel,
        toolPolicy: [{ regex_match: `^${missingCompletionToolName}$`, action: "require" }],
      },
      { synthetic: true }
    );
  }

  private async handleSuccessfulProposePlanAutoHandoff(args: {
    workspaceId: string;
    entry: { projectPath: string; workspace: WorkspaceConfigEntry };
    proposePlanResult: { planPath: string };
    planSubagentExecutorRouting: PlanSubagentExecutorRouting;
  }): Promise<void> {
    assert(
      args.workspaceId.length > 0,
      "handleSuccessfulProposePlanAutoHandoff: workspaceId must be non-empty"
    );
    assert(
      args.proposePlanResult.planPath.length > 0,
      "handleSuccessfulProposePlanAutoHandoff: planPath must be non-empty"
    );

    if (this.handoffInProgress.has(args.workspaceId)) {
      log.debug("Skipping duplicate plan-task auto-handoff", { workspaceId: args.workspaceId });
      return;
    }

    this.handoffInProgress.add(args.workspaceId);

    try {
      let planSummary: { content: string; path: string } | null = null;

      try {
        const info = await this.workspaceService.getInfo(args.workspaceId);
        if (!info) {
          log.error("Plan-task auto-handoff could not read workspace metadata", {
            workspaceId: args.workspaceId,
          });
        } else {
          const runtime = createRuntimeForWorkspace(info);
          const planResult = await readPlanFile(
            runtime,
            info.name,
            info.projectName,
            args.workspaceId
          );
          if (planResult.exists) {
            planSummary = { content: planResult.content, path: planResult.path };
          } else {
            log.error("Plan-task auto-handoff did not find plan file content", {
              workspaceId: args.workspaceId,
              planPath: args.proposePlanResult.planPath,
            });
          }
        }
      } catch (error: unknown) {
        log.error("Plan-task auto-handoff failed to read plan file", {
          workspaceId: args.workspaceId,
          planPath: args.proposePlanResult.planPath,
          error,
        });
      }

      const targetAgentId = await (async () => {
        const shouldShowRoutingStatus = args.planSubagentExecutorRouting === "auto";
        if (shouldShowRoutingStatus) {
          // Auto routing can pause for up to the LLM timeout; surface progress in the sidebar.
          await this.workspaceService.updateAgentStatus(args.workspaceId, {
            emoji: PLAN_AUTO_ROUTING_STATUS_EMOJI,
            message: PLAN_AUTO_ROUTING_STATUS_MESSAGE,
            // ExtensionMetadataService carries forward the previous status URL when url is omitted.
            // Use an explicit empty string sentinel to clear stale links for this transient status.
            url: "",
          });
        }

        try {
          return await this.resolvePlanAutoHandoffTargetAgentId({
            workspaceId: args.workspaceId,
            entry: {
              projectPath: args.entry.projectPath,
              workspace: {
                id: args.entry.workspace.id,
                name: args.entry.workspace.name,
                path: args.entry.workspace.path,
                runtimeConfig: args.entry.workspace.runtimeConfig,
                taskModelString: args.entry.workspace.taskModelString,
              },
            },
            routing: args.planSubagentExecutorRouting,
            planContent: planSummary?.content ?? null,
          });
        } finally {
          if (shouldShowRoutingStatus) {
            await this.workspaceService.updateAgentStatus(args.workspaceId, null);
          }
        }
      })();

      const summaryContent = planSummary
        ? `# Plan\n\n${planSummary.content}\n\nNote: This chat already contains the full plan; no need to re-open the plan file.\n\n---\n\n*Plan file preserved at:* \`${planSummary.path}\``
        : `A plan was proposed at ${args.proposePlanResult.planPath}. Read the plan file and implement it.`;

      const summaryMessage = createMuxMessage(
        createCompactionSummaryMessageId(),
        "assistant",
        summaryContent,
        {
          timestamp: Date.now(),
          compacted: "user",
          agentId: "plan",
        }
      );

      const replaceHistoryResult = await this.workspaceService.replaceHistory(
        args.workspaceId,
        summaryMessage,
        {
          mode: "append-compaction-boundary",
          deletePlanFile: false,
        }
      );
      if (!replaceHistoryResult.success) {
        log.error("Plan-task auto-handoff failed to compact history", {
          workspaceId: args.workspaceId,
          error: replaceHistoryResult.error,
        });
      }

      // Handoff resolution follows the same precedence as Task.create:
      // global per-agent defaults, else inherit the plan task's active model.
      const latestCfg = this.config.loadConfigOrDefault();
      const globalDefault = latestCfg.agentAiDefaults?.[targetAgentId];
      const parentActiveModelCandidate =
        typeof args.entry.workspace.taskModelString === "string"
          ? args.entry.workspace.taskModelString.trim()
          : "";
      const parentActiveModel =
        parentActiveModelCandidate.length > 0 ? parentActiveModelCandidate : defaultModel;

      const configuredModel = globalDefault?.modelString?.trim();
      const preferredModel =
        configuredModel && configuredModel.length > 0 ? configuredModel : parentActiveModel;
      const resolvedModel = normalizeGatewayModel(
        preferredModel.length > 0 ? preferredModel : defaultModel
      );
      assert(
        resolvedModel.trim().length > 0,
        "handleSuccessfulProposePlanAutoHandoff: resolved model must be non-empty"
      );
      const requestedThinking: ThinkingLevel =
        globalDefault?.thinkingLevel ?? args.entry.workspace.taskThinkingLevel ?? "off";
      const resolvedThinking = enforceThinkingPolicy(resolvedModel, requestedThinking);

      await this.editWorkspaceEntry(args.workspaceId, (workspace) => {
        workspace.agentId = targetAgentId;
        workspace.agentType = targetAgentId;
        workspace.taskModelString = resolvedModel;
        workspace.taskThinkingLevel = resolvedThinking;
      });

      await this.setTaskStatus(args.workspaceId, "running");
      this.remindedAwaitingReport.delete(args.workspaceId);

      const kickoffMsg =
        targetAgentId === "orchestrator"
          ? "Start orchestrating the implementation of this plan."
          : "Implement the plan.";
      try {
        const sendKickoffResult = await this.workspaceService.sendMessage(
          args.workspaceId,
          kickoffMsg,
          {
            model: resolvedModel,
            agentId: targetAgentId,
            thinkingLevel: resolvedThinking,
            experiments: args.entry.workspace.taskExperiments,
          },
          { synthetic: true }
        );
        if (!sendKickoffResult.success) {
          // Keep status as "running" so the restart handler in initialize() can
          // re-attempt the kickoff on next startup, rather than moving to
          // "awaiting_report" which could finalize the task prematurely.
          log.error(
            "Plan-task auto-handoff failed to send kickoff message; task stays running for retry on restart",
            {
              workspaceId: args.workspaceId,
              targetAgentId,
              error: sendKickoffResult.error,
            }
          );
        }
      } catch (error: unknown) {
        // Same as above: leave status as "running" for restart recovery.
        log.error(
          "Plan-task auto-handoff failed to send kickoff message; task stays running for retry on restart",
          {
            workspaceId: args.workspaceId,
            targetAgentId,
            error,
          }
        );
      }
    } catch (error: unknown) {
      log.error("Plan-task auto-handoff failed", {
        workspaceId: args.workspaceId,
        planPath: args.proposePlanResult.planPath,
        error,
      });
    } finally {
      this.handoffInProgress.delete(args.workspaceId);
    }
  }

  private async finalizeTerminationPhaseForReportedTask(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "finalizeTerminationPhaseForReportedTask: workspaceId must be non-empty"
    );

    await this.cleanupReportedLeafTask(workspaceId);
  }

  private async maybeStartPatchGenerationForReportedTask(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "maybeStartPatchGenerationForReportedTask: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const parentWorkspaceId = findWorkspaceEntry(cfg, workspaceId)?.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      return;
    }

    try {
      await this.gitPatchArtifactService.maybeStartGeneration(
        parentWorkspaceId,
        workspaceId,
        (wsId) => this.requestReportedTaskCleanupRecheck(wsId)
      );
    } catch (error: unknown) {
      log.error("Failed to start subagent git patch generation", {
        parentWorkspaceId,
        childWorkspaceId: workspaceId,
        error,
      });
    }
  }

  private requestReportedTaskCleanupRecheck(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "requestReportedTaskCleanupRecheck: workspaceId must be non-empty"
    );

    return this.workspaceEventLocks.withLock(workspaceId, async () => {
      await this.cleanupReportedLeafTask(workspaceId);
    });
  }

  private async fallbackReportMissingCompletionTool(
    entry: {
      projectPath: string;
      workspace: WorkspaceConfigEntry;
    },
    completionToolName: "agent_report" | "propose_plan"
  ): Promise<void> {
    const childWorkspaceId = entry.workspace.id;
    if (!childWorkspaceId) {
      return;
    }

    const agentType = entry.workspace.agentType ?? "agent";
    const lastText = await this.readLatestAssistantText(childWorkspaceId);
    const completionToolLabel =
      completionToolName === "propose_plan" ? "`propose_plan`" : "`agent_report`";

    const reportMarkdown =
      `*(Note: this agent task did not call ${completionToolLabel}; posting its last assistant output as a fallback.)*\n\n` +
      (lastText?.trim().length ? lastText : "(No assistant output found.)");

    await this.finalizeAgentTaskReport(childWorkspaceId, entry, {
      reportMarkdown,
      title: `Subagent (${agentType}) report (fallback)`,
    });
  }

  private async readLatestAssistantText(workspaceId: string): Promise<string | null> {
    const partial = await this.historyService.readPartial(workspaceId);
    if (partial && partial.role === "assistant") {
      const text = this.concatTextParts(partial).trim();
      if (text.length > 0) return text;
    }

    // Only need recent messages to find last assistant text — avoid full-file read.
    // getLastMessages returns messages in chronological order.
    const historyResult = await this.historyService.getLastMessages(workspaceId, 20);
    if (!historyResult.success) {
      log.error("Failed to read history for fallback report", {
        workspaceId,
        error: historyResult.error,
      });
      return null;
    }

    for (let i = historyResult.data.length - 1; i >= 0; i--) {
      const msg = historyResult.data[i];
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

  private async finalizeAgentTaskReport(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    reportArgs: { reportMarkdown: string; title?: string }
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
    const statusBefore = findWorkspaceEntry(cfgBeforeReport, childWorkspaceId)?.workspace
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

    // NOTE: Stream continues — we intentionally do NOT abort it.
    // Deterministic termination is enforced by StreamManager stopWhen logic that
    // waits for an agent_report tool result where output.success === true at the
    // step boundary (preserving usage accounting). recordSessionUsage runs when
    // the stream ends naturally.

    const cfgAfterReport = this.config.loadConfigOrDefault();
    const latestChildEntry = findWorkspaceEntry(cfgAfterReport, childWorkspaceId) ?? childEntry;
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

    const parentById = this.buildAgentTaskIndex(cfgAfterReport).parentById;
    const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
      parentById,
      childWorkspaceId
    );

    // Persist the completed report in the session dirs of all ancestors so `task_await` can
    // retrieve it after cleanup/restart (even if the task workspace itself is deleted).
    const persistedAtMs = Date.now();
    for (const ancestorWorkspaceId of ancestorWorkspaceIds) {
      try {
        const ancestorSessionDir = this.config.getSessionDir(ancestorWorkspaceId);
        await upsertSubagentReportArtifact({
          workspaceId: ancestorWorkspaceId,
          workspaceSessionDir: ancestorSessionDir,
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          ancestorWorkspaceIds,
          reportMarkdown: reportArgs.reportMarkdown,
          model: latestChildEntry?.workspace.taskModelString,
          thinkingLevel: latestChildEntry?.workspace.taskThinkingLevel,
          title: reportArgs.title,
          nowMs: persistedAtMs,
        });
      } catch (error: unknown) {
        log.error("Failed to persist subagent report artifact", {
          workspaceId: ancestorWorkspaceId,
          childTaskId: childWorkspaceId,
          error,
        });
      }
    }

    await this.maybeStartPatchGenerationForReportedTask(childWorkspaceId);

    await this.deliverReportToParent(
      parentWorkspaceId,
      childWorkspaceId,
      latestChildEntry,
      reportArgs
    );

    // Resolve foreground waiters.
    this.resolveWaiters(childWorkspaceId, reportArgs);

    // Free slot and start queued tasks.
    await this.maybeStartQueuedTasks();

    // Auto-resume any parent stream that was waiting on a task tool call (restart-safe).
    const postCfg = this.config.loadConfigOrDefault();
    const parentEntry = findWorkspaceEntry(postCfg, parentWorkspaceId);
    if (!parentEntry) {
      // Parent may have been cleaned up (e.g. it already reported and this was its last descendant).
      return;
    }
    const hasActiveDescendants = this.hasActiveDescendantAgentTasks(postCfg, parentWorkspaceId);
    if (!hasActiveDescendants) {
      this.consecutiveAutoResumes.delete(parentWorkspaceId);
    }

    if (this.interruptedParentWorkspaceIds.has(parentWorkspaceId)) {
      log.debug("Skipping post-report parent auto-resume after hard interrupt", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      return;
    }

    if (!hasActiveDescendants && !this.aiService.isStreaming(parentWorkspaceId)) {
      const resumeOptions = await this.resolveParentAutoResumeOptions(
        parentWorkspaceId,
        parentEntry,
        latestChildEntry?.workspace.taskModelString ?? defaultModel
      );
      const sendResult = await this.workspaceService.sendMessage(
        parentWorkspaceId,
        "Your background sub-agent task(s) have completed. Use task_await to retrieve their reports and integrate the results.",
        {
          model: resumeOptions.model,
          agentId: resumeOptions.agentId,
          thinkingLevel: resumeOptions.thinkingLevel,
        },
        // Skip auto-resume counter reset — this IS an auto-resume, not a user message.
        { skipAutoResumeReset: true, synthetic: true }
      );
      if (!sendResult.success) {
        log.error("Failed to auto-resume parent after agent_report", {
          parentWorkspaceId,
          error: sendResult.error,
        });
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
    const cfg = this.config.loadConfigOrDefault();
    const parentById = this.buildAgentTaskIndex(cfg).parentById;
    const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(parentById, taskId);

    this.completedReportsByTaskId.set(taskId, {
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      ancestorWorkspaceIds,
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

  private findProposePlanSuccessInParts(parts: readonly unknown[]): { planPath: string } | null {
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (!isDynamicToolPart(part)) continue;
      if (part.toolName !== "propose_plan") continue;
      if (part.state !== "output-available") continue;
      if (!isSuccessfulToolResult(part.output)) continue;

      const planPath =
        typeof part.output === "object" &&
        part.output !== null &&
        "planPath" in part.output &&
        typeof (part.output as { planPath?: unknown }).planPath === "string"
          ? (part.output as { planPath: string }).planPath.trim()
          : "";
      if (!planPath) continue;

      return { planPath };
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
      // Normalize null → undefined at the schema boundary so downstream
      // code that expects `title?: string` doesn't need to handle null.
      return { reportMarkdown: parsed.data.reportMarkdown, title: parsed.data.title ?? undefined };
    }
    return null;
  }

  private async deliverReportToParent(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    report: { reportMarkdown: string; title?: string }
  ): Promise<void> {
    assert(
      childWorkspaceId.length > 0,
      "deliverReportToParent: childWorkspaceId must be non-empty"
    );

    const agentType = childEntry?.workspace.agentType ?? "agent";

    const output = {
      status: "completed" as const,
      taskId: childWorkspaceId,
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
      `<task_id>${childWorkspaceId}</task_id>`,
      `<agent_type>${agentType}</agent_type>`,
      `<title>${titlePrefix}</title>`,
      "<report_markdown>",
      report.reportMarkdown,
      "</report_markdown>",
      "</mux_subagent_report>",
    ].join("\n");

    const messageId = createTaskReportMessageId();
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

    const partial = await this.historyService.readPartial(workspaceId);
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

    const writeResult = await this.historyService.writePartial(workspaceId, updated);
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

  private async canCleanupReportedTask(
    workspaceId: string
  ): Promise<{ ok: true; parentWorkspaceId: string } | { ok: false; reason: string }> {
    assert(workspaceId.length > 0, "canCleanupReportedTask: workspaceId must be non-empty");

    const config = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(config, workspaceId);
    if (!entry) {
      return { ok: false, reason: "workspace_not_found" };
    }

    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      return { ok: false, reason: "missing_parent_workspace" };
    }

    if (entry.workspace.taskStatus !== "reported") {
      return { ok: false, reason: "task_not_reported" };
    }

    if (this.aiService.isStreaming(workspaceId)) {
      log.debug("cleanupReportedLeafTask: deferring auto-delete; stream still active", {
        workspaceId,
        parentWorkspaceId,
      });
      return { ok: false, reason: "still_streaming" };
    }

    // Topology gate: a reported task can only be cleaned up when it is a structural leaf
    // (has no child agent tasks in config). This is status-agnostic — even reported children
    // block parent deletion, ensuring artifact rollup always targets an existing parent path.
    const index = this.buildAgentTaskIndex(config);
    if (this.hasChildAgentTasks(index, workspaceId)) {
      return { ok: false, reason: "has_child_tasks" };
    }

    const parentSessionDir = this.config.getSessionDir(parentWorkspaceId);
    const patchArtifact = await readSubagentGitPatchArtifact(parentSessionDir, workspaceId);
    if (patchArtifact?.status === "pending") {
      log.debug("cleanupReportedLeafTask: deferring auto-delete; patch artifact pending", {
        workspaceId,
        parentWorkspaceId,
      });
      return { ok: false, reason: "patch_pending" };
    }

    return { ok: true, parentWorkspaceId };
  }

  private async cleanupReportedLeafTask(workspaceId: string): Promise<void> {
    assert(workspaceId.length > 0, "cleanupReportedLeafTask: workspaceId must be non-empty");

    // Lineage reduction: each iteration removes exactly one leaf node, then re-evaluates
    // the parent on fresh config. The structural-leaf gate in canCleanupReportedTask ensures
    // parents are only removed after all children are gone.
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

      const cleanupEligibility = await this.canCleanupReportedTask(currentWorkspaceId);
      if (!cleanupEligibility.ok) {
        return;
      }

      const removeResult = await this.workspaceService.remove(currentWorkspaceId, true);
      if (!removeResult.success) {
        log.error("Failed to auto-delete reported task workspace", {
          workspaceId: currentWorkspaceId,
          error: removeResult.error,
        });
        return;
      }

      currentWorkspaceId = cleanupEligibility.parentWorkspaceId;
    }

    log.error("cleanupReportedLeafTask: exceeded max parent traversal depth", {
      workspaceId,
    });
  }
}
