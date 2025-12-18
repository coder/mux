/**
 * TaskService - Orchestrates subagent task workspaces.
 *
 * Responsibilities:
 * - Create agent task workspaces with proper limits enforcement
 * - Queue tasks when parallel limit is reached
 * - Handle agent_report delivery to parent workspace
 * - Auto-cleanup completed task workspaces
 * - Rehydrate tasks on restart
 */

import { EventEmitter } from "events";
import type { Config } from "@/node/config";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { AIService } from "@/node/services/aiService";
import type { AgentType, TaskState, TaskToolResult } from "@/common/types/task";
import { getAgentPreset } from "@/common/constants/agentPresets";
import { log } from "@/node/services/log";
import {
  createMuxMessage,
  type MuxMessage,
  type MuxFrontendMetadata,
} from "@/common/types/message";
import { isDynamicToolPart } from "@/common/types/toolParts";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { detectDefaultTrunkBranch, getCurrentBranch, listLocalBranches } from "@/node/git";
import * as crypto from "crypto";
import assert from "@/common/utils/assert";

export interface CreateTaskOptions {
  parentWorkspaceId: string;
  agentType: AgentType;
  prompt: string;
  description?: string;
  parentToolCallId?: string;
  runInBackground: boolean;
}

export interface CreateTaskResult {
  taskId: string;
  status: "queued" | "running" | "completed";
  reportMarkdown?: string;
  reportTitle?: string;
}

interface PendingCompletion {
  resolve: (result: CreateTaskResult) => void;
  reject: (error: Error) => void;
}

export interface TaskServiceEvents {
  "task-created": (event: { taskId: string; parentWorkspaceId: string }) => void;
  "task-completed": (event: {
    taskId: string;
    parentWorkspaceId: string;
    reportMarkdown: string;
    reportTitle?: string;
  }) => void;
  "task-failed": (event: { taskId: string; parentWorkspaceId: string; error: string }) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface TaskService {
  on<U extends keyof TaskServiceEvents>(event: U, listener: TaskServiceEvents[U]): this;
  emit<U extends keyof TaskServiceEvents>(
    event: U,
    ...args: Parameters<TaskServiceEvents[U]>
  ): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class TaskService extends EventEmitter {
  /** Queue of tasks waiting for a slot (FIFO) */
  private readonly taskQueue: Array<{
    taskId: string;
    options: CreateTaskOptions;
  }> = [];

  /** Pending completions waiting for agent_report */
  private readonly pendingCompletions = new Map<string, PendingCompletion>();

  /** Disposed flag */
  private disposed = false;

  constructor(
    private readonly config: Config,
    private readonly workspaceService: WorkspaceService,
    private readonly historyService: HistoryService,
    private readonly partialService: PartialService,
    private readonly aiService: AIService
  ) {
    super();
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Listen for tool-call-end events to detect agent_report calls
    this.aiService.on("tool-call-end", (data: unknown) => {
      if (this.disposed) return;
      const event = data as {
        workspaceId: string;
        toolName: string;
        args: unknown;
      };
      if (event.toolName === "agent_report") {
        void this.handleAgentReport(
          event.workspaceId,
          event.args as {
            reportMarkdown: string;
            title?: string;
          }
        );
      }
    });

    // Listen for stream-end to detect missing agent_report
    this.aiService.on("stream-end", (data: unknown) => {
      if (this.disposed) return;
      const event = data as { workspaceId: string };
      void this.handleStreamEnd(event.workspaceId);
    });
  }

  /**
   * Create a new agent task.
   * Returns immediately if runInBackground=true, otherwise waits for completion.
   */
  async createTask(options: CreateTaskOptions): Promise<CreateTaskResult> {
    const { parentWorkspaceId, agentType, prompt, description, parentToolCallId, runInBackground } =
      options;

    // Validate parent exists
    const parentInfo = this.config.findWorkspace(parentWorkspaceId);
    if (!parentInfo) {
      throw new Error(`Parent workspace ${parentWorkspaceId} not found`);
    }

    // Guardrail: disallow spawning new tasks from a workspace that already reported completion.
    const parentTaskState = this.config.getWorkspaceTaskState(parentWorkspaceId);
    if (parentTaskState?.taskStatus === "reported") {
      throw new Error(
        `Cannot spawn subagent task from workspace ${parentWorkspaceId} after agent_report was called`
      );
    }

    // Check nesting depth limit
    const settings = this.config.getTaskSettings();
    const parentDepth = this.config.getWorkspaceNestingDepth(parentWorkspaceId);
    if (parentDepth >= settings.maxTaskNestingDepth) {
      throw new Error(
        `Maximum task nesting depth (${settings.maxTaskNestingDepth}) reached. ` +
          `Cannot spawn subagent from workspace at depth ${parentDepth}.`
      );
    }

    // Check parallel limit
    const runningCount = this.config.countRunningAgentTasks();
    const shouldQueue = runningCount >= settings.maxParallelAgentTasks;

    // Generate workspace name
    const preset = getAgentPreset(agentType);
    const suffix = Math.random().toString(36).substring(2, 6);
    const workspaceName = `agent_${agentType}_${suffix}`;
    const workspaceTitle = description ?? `${preset.name} Task`;

    // Get parent's runtime config for the new workspace
    const parentMetadata = await this.getWorkspaceMetadata(parentWorkspaceId);
    if (!parentMetadata) {
      throw new Error(`Parent workspace ${parentWorkspaceId} metadata not found`);
    }

    // Inherit runtime from parent - agent tasks run in same environment as parent
    // For SSH workspaces, this means agent tasks run on the same remote host
    // For local workspaces, this has no change in behavior
    const parentRuntime = parentMetadata.runtimeConfig;

    // Detect trunk branch for worktree/SSH runtimes
    // Local runtime doesn't need a trunk branch
    let trunkBranch: string | undefined = undefined;
    const isLocalRuntime = parentRuntime.type === "local";
    if (!isLocalRuntime) {
      try {
        // Prefer forking from the parent's current branch for worktree runtimes.
        // This keeps the child task aligned with the parent's working branch.
        if (parentRuntime.type === "worktree") {
          trunkBranch = (await getCurrentBranch(parentMetadata.namedWorkspacePath)) ?? undefined;
        }

        if (!trunkBranch) {
          const branches = await listLocalBranches(parentInfo.projectPath);
          trunkBranch = await detectDefaultTrunkBranch(parentInfo.projectPath, branches);
        }
      } catch (error) {
        log.warn(`Failed to detect base branch for agent task, using 'main':`, error);
        trunkBranch = "main";
      }
    }

    // Create workspace via WorkspaceService
    const createResult = await this.workspaceService.create(
      parentInfo.projectPath,
      workspaceName,
      trunkBranch,
      workspaceTitle,
      parentRuntime // Inherit runtime from parent workspace
    );

    if (!createResult.success) {
      throw new Error(`Failed to create task workspace: ${createResult.error}`);
    }

    const taskId = createResult.data.metadata.id;

    // Set task state
    const taskState: TaskState = {
      taskStatus: shouldQueue ? "queued" : "running",
      agentType,
      parentWorkspaceId,
      prompt,
      description,
      parentToolCallId,
      queuedAt: new Date().toISOString(),
      startedAt: shouldQueue ? undefined : new Date().toISOString(),
    };

    await this.config.setWorkspaceTaskState(taskId, taskState);

    log.debug(`Created task workspace ${taskId} for parent ${parentWorkspaceId}`, {
      agentType,
      status: taskState.taskStatus,
    });

    this.emit("task-created", { taskId, parentWorkspaceId });

    if (shouldQueue) {
      // Add to queue
      this.taskQueue.push({ taskId, options });
      log.debug(
        `Task ${taskId} queued (${runningCount}/${settings.maxParallelAgentTasks} running)`
      );
    } else {
      // Start immediately
      await this.startTask(taskId, options);
    }

    if (runInBackground) {
      return {
        taskId,
        status: shouldQueue ? "queued" : "running",
      };
    }

    // Wait for completion
    return new Promise<CreateTaskResult>((resolve, reject) => {
      this.pendingCompletions.set(taskId, { resolve, reject });
    });
  }

  /**
   * Start a task that was previously created (either new or from queue).
   */
  private async startTask(taskId: string, options: CreateTaskOptions): Promise<void> {
    const { prompt } = options;

    // Update task state to running
    const currentState = this.config.getWorkspaceTaskState(taskId);
    if (currentState) {
      await this.config.setWorkspaceTaskState(taskId, {
        ...currentState,
        taskStatus: "running",
        startedAt: new Date().toISOString(),
      });
    }

    try {
      const result = await this.workspaceService.sendMessage(taskId, prompt, {
        model: "anthropic:claude-sonnet-4-20250514", // Default model for agents
        thinkingLevel: "medium",
        mode: "exec", // Agent tasks are always in exec mode
      });

      if (!result.success) {
        const errMsg =
          result.error?.type === "unknown"
            ? result.error.raw
            : (result.error?.type ?? "Unknown error");
        throw new Error(errMsg);
      }
    } catch (error) {
      log.error(`Failed to start task ${taskId}:`, error);
      await this.handleTaskFailure(taskId, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Handle agent_report tool call from a task workspace.
   */
  private async handleAgentReport(
    workspaceId: string,
    args: { reportMarkdown: string; title?: string }
  ): Promise<void> {
    const taskState = this.config.getWorkspaceTaskState(workspaceId);
    if (!taskState) {
      // Not a task workspace, ignore
      return;
    }

    if (taskState.taskStatus === "reported") {
      log.debug(`Ignoring duplicate agent_report for task ${workspaceId}`);
      return;
    }
    if (taskState.taskStatus === "failed") {
      log.warn(`Ignoring agent_report for failed task ${workspaceId}`);
      return;
    }

    assert(
      typeof args.reportMarkdown === "string" && args.reportMarkdown.trim().length > 0,
      "agent_report reportMarkdown must be a non-empty string"
    );

    log.debug(`Task ${workspaceId} reported`, { title: args.title });

    // Update task state
    const reportedState: TaskState = {
      ...taskState,
      taskStatus: "reported",
      reportedAt: new Date().toISOString(),
      reportMarkdown: args.reportMarkdown,
      reportTitle: args.title,
    };

    await this.config.setWorkspaceTaskState(workspaceId, reportedState);

    // Emit event for external listeners
    this.emit("task-completed", {
      taskId: workspaceId,
      parentWorkspaceId: taskState.parentWorkspaceId,
      reportMarkdown: args.reportMarkdown,
      reportTitle: args.title,
    });

    // Resolve pending completion if any
    const pending = this.pendingCompletions.get(workspaceId);
    if (pending) {
      this.pendingCompletions.delete(workspaceId);
      pending.resolve({
        taskId: workspaceId,
        status: "completed",
        reportMarkdown: args.reportMarkdown,
        reportTitle: args.title,
      });
    }

    // Always append the report to the parent workspace history for user visibility.
    await this.postReportToParent(workspaceId, reportedState, args);

    // If this was a foreground task, also inject the tool output into the parent's pending tool call.
    // This enables restart recovery: if pendingCompletions was lost, the parent will still have output
    // persisted in partial.json or chat.jsonl.
    if (reportedState.parentToolCallId) {
      const toolOutput: TaskToolResult = {
        status: "completed",
        taskId: workspaceId,
        reportMarkdown: args.reportMarkdown,
        reportTitle: args.title,
      };
      const injected = await this.injectToolOutputToParent(
        reportedState.parentWorkspaceId,
        reportedState.parentToolCallId,
        toolOutput
      );
      if (injected) {
        await this.maybeResumeParentStream(reportedState.parentWorkspaceId);
      }
    }

    // Process queue (a slot freed up)
    await this.processQueue();

    // Schedule cleanup (delay slightly to ensure all events propagate).
    setTimeout(() => {
      void this.cleanupTaskSubtree(workspaceId);
    }, 1000);
  }

  /**
   * Post the report as a message to the parent workspace.
   */
  private async postReportToParent(
    taskId: string,
    taskState: TaskState,
    report: { reportMarkdown: string; title?: string }
  ): Promise<void> {
    try {
      const preset = getAgentPreset(taskState.agentType);
      const title = report.title ?? `${preset.name} Report`;

      // Append an assistant message to the parent history so the user can read the report.
      const reportMessage: MuxMessage = createMuxMessage(
        crypto.randomBytes(8).toString("hex"), // Generate unique ID
        "assistant",
        `## 📋 ${title}\n\n${report.reportMarkdown}`,
        {
          timestamp: Date.now(),
          // Store task metadata in muxMetadata (frontend-defined, backend treats as black-box)
          muxMetadata: {
            type: "task-report" as const,
            taskId,
            agentType: taskState.agentType,
          } as unknown as MuxFrontendMetadata,
        }
      );

      const appendResult = await this.workspaceService.appendToHistoryAndEmit(
        taskState.parentWorkspaceId,
        reportMessage
      );
      if (!appendResult.success) {
        throw new Error(appendResult.error);
      }

      log.debug(`Posted task report to parent ${taskState.parentWorkspaceId}`, { taskId, title });
    } catch (error) {
      log.error(`Failed to post report to parent ${taskState.parentWorkspaceId}:`, error);
    }
  }

  private async postFailureToParent(taskId: string, taskState: TaskState, error: string): Promise<void> {
    try {
      const preset = getAgentPreset(taskState.agentType);
      const title = `${preset.name} Task Failed`;

      const failureMessage: MuxMessage = createMuxMessage(
        crypto.randomBytes(8).toString("hex"),
        "assistant",
        `## ❌ ${title}\n\n${error}`,
        {
          timestamp: Date.now(),
          muxMetadata: {
            type: "task-failed" as const,
            taskId,
            agentType: taskState.agentType,
            error,
          } as unknown as MuxFrontendMetadata,
        }
      );

      const appendResult = await this.workspaceService.appendToHistoryAndEmit(
        taskState.parentWorkspaceId,
        failureMessage
      );
      if (!appendResult.success) {
        throw new Error(appendResult.error);
      }
    } catch (postError) {
      log.error(`Failed to post task failure to parent ${taskState.parentWorkspaceId}:`, postError);
    }
  }

  /**
   * Inject task tool output into the parent workspace's pending tool call.
   * Persists the output into partial.json or chat.jsonl and emits a synthetic
   * tool-call-end event so the UI updates immediately after restart recovery.
   */
  private async injectToolOutputToParent(
    parentWorkspaceId: string,
    parentToolCallId: string,
    toolOutput: TaskToolResult
  ): Promise<boolean> {
    try {
      // Try to update partial.json first (most likely location for in-flight tool call)
      const partial = await this.partialService.readPartial(parentWorkspaceId);
      if (partial) {
        const finalized = this.tryFinalizeTaskToolCall(partial, parentToolCallId, toolOutput);
        if (finalized) {
          const writeResult = await this.partialService.writePartial(parentWorkspaceId, finalized.updated);
          if (!writeResult.success) {
            throw new Error(writeResult.error);
          }
          this.emitSyntheticToolCallEnd(
            parentWorkspaceId,
            finalized.updated.id,
            parentToolCallId,
            finalized.input,
            toolOutput
          );
          log.debug(`Injected task result into parent partial`, {
            parentWorkspaceId,
            parentToolCallId,
          });
          return true;
        }
      }

      // Fall back to chat history
      const historyResult = await this.historyService.getHistory(parentWorkspaceId);
      if (historyResult.success) {
        // Find the message with this tool call (search from newest to oldest)
        for (let i = historyResult.data.length - 1; i >= 0; i--) {
          const msg = historyResult.data[i];
          const finalized = this.tryFinalizeTaskToolCall(msg, parentToolCallId, toolOutput);
          if (finalized) {
            const updateResult = await this.historyService.updateHistory(
              parentWorkspaceId,
              finalized.updated
            );
            if (!updateResult.success) {
              throw new Error(updateResult.error);
            }
            this.emitSyntheticToolCallEnd(
              parentWorkspaceId,
              finalized.updated.id,
              parentToolCallId,
              finalized.input,
              toolOutput
            );
            log.debug(`Injected task result into parent history`, {
              parentWorkspaceId,
              parentToolCallId,
            });
            return true;
          }
        }
      }

      log.warn(`Could not find parent task tool call ${parentToolCallId} to inject output`, {
        parentWorkspaceId,
      });
      return false;
    } catch (error) {
      log.error(`Failed to inject tool output to parent ${parentWorkspaceId}:`, error);
      return false;
    }
  }

  /**
   * Update the output for a `task` tool call in a message.
   * Returns null if tool call not found or invalid.
   */
  private tryFinalizeTaskToolCall(
    msg: MuxMessage,
    toolCallId: string,
    output: TaskToolResult
  ): { updated: MuxMessage; input: unknown } | null {
    let foundToolCall = false;
    let input: unknown = null;
    let errorMessage: string | null = null;

    const updatedParts = msg.parts.map((part) => {
      if (!isDynamicToolPart(part) || part.toolCallId !== toolCallId) {
        return part;
      }

      foundToolCall = true;

      if (part.toolName !== "task") {
        errorMessage = `toolCallId=${toolCallId} is toolName=${part.toolName}, expected task`;
        return part;
      }

      // Capture tool input for synthetic tool-call-end event.
      input = part.input;

      // Idempotent: already has output.
      if (part.state === "output-available") {
        return part;
      }

      return {
        ...part,
        state: "output-available" as const,
        output,
      };
    });

    if (errorMessage) {
      log.warn(errorMessage);
      return null;
    }
    if (!foundToolCall) {
      return null;
    }

    return { updated: { ...msg, parts: updatedParts }, input };
  }

  private emitSyntheticToolCallEnd(
    workspaceId: string,
    messageId: string,
    toolCallId: string,
    args: unknown,
    result: unknown
  ): void {
    this.aiService.emit("tool-call-end", {
      type: "tool-call-end",
      workspaceId,
      messageId,
      toolCallId,
      toolName: "task",
      args,
      result,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle stream end - check if agent_report was called.
   */
  private async handleStreamEnd(workspaceId: string): Promise<void> {
    const taskState = this.config.getWorkspaceTaskState(workspaceId);
    if (!taskState) {
      return;
    }

    if (taskState.taskStatus !== "running" && taskState.taskStatus !== "awaiting_report") {
      return;
    }

    // Give a short delay for the tool-call-end event to arrive
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Re-check state
    const updatedState = this.config.getWorkspaceTaskState(workspaceId);
    if (!updatedState || updatedState.taskStatus === "reported" || updatedState.taskStatus === "failed") {
      return;
    }

    if (updatedState.taskStatus === "running") {
      // Agent didn't call agent_report - send reminder
      log.warn(`Task ${workspaceId} stream ended without agent_report, sending reminder`);

      await this.config.setWorkspaceTaskState(workspaceId, {
        ...updatedState,
        taskStatus: "awaiting_report",
      });

      // Send reminder message
      try {
        const result = await this.workspaceService.sendMessage(
          workspaceId,
          "Your task is complete but you haven't called agent_report yet. " +
            "Please call agent_report now with your findings.",
          {
            model: "anthropic:claude-sonnet-4-20250514",
            thinkingLevel: "low",
            // Require only agent_report
            toolPolicy: [{ regex_match: "agent_report", action: "require" }],
            mode: "exec",
          }
        );

        if (!result.success) {
          const errMsg =
            result.error?.type === "unknown"
              ? result.error.raw
              : (result.error?.type ?? "Unknown error");
          throw new Error(errMsg);
        }
      } catch (error) {
        log.error(`Failed to send reminder to task ${workspaceId}, using fallback report:`, error);
        const fallback = await this.synthesizeFallbackReportMarkdown(workspaceId);
        await this.handleAgentReport(workspaceId, {
          reportMarkdown: fallback,
          title: "Fallback Report (agent_report missing)",
        });
      }

      return;
    }

    if (updatedState.taskStatus === "awaiting_report") {
      // Reminder stream ended and agent_report still wasn't called. Fall back to best-effort report.
      log.warn(`Task ${workspaceId} still missing agent_report after reminder, using fallback report`);
      const fallback = await this.synthesizeFallbackReportMarkdown(workspaceId);
      await this.handleAgentReport(workspaceId, {
        reportMarkdown: fallback,
        title: "Fallback Report (agent_report missing)",
      });
      return;
    }
  }

  private async synthesizeFallbackReportMarkdown(workspaceId: string): Promise<string> {
    try {
      const lastAssistantText = await this.getLastAssistantTextFromWorkspace(workspaceId);
      if (lastAssistantText.trim().length > 0) {
        return (
          "⚠️ `agent_report` was not called. Using the last assistant output from the task workspace as a fallback.\n\n" +
          lastAssistantText
        );
      }
      return "⚠️ `agent_report` was not called, and no assistant text was captured from the task workspace.";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `⚠️ \`agent_report\` was not called, and fallback extraction failed: ${message}`;
    }
  }

  private async getLastAssistantTextFromWorkspace(workspaceId: string): Promise<string> {
    const extractText = (msg: MuxMessage): string => {
      return msg.parts
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("");
    };

    const partial = await this.partialService.readPartial(workspaceId);
    if (partial && partial.role === "assistant") {
      const text = extractText(partial).trim();
      if (text.length > 0) {
        return text;
      }
    }

    const historyResult = await this.historyService.getHistory(workspaceId);
    if (!historyResult.success) {
      return "";
    }

    for (let i = historyResult.data.length - 1; i >= 0; i--) {
      const msg = historyResult.data[i];
      if (msg.role !== "assistant") continue;
      const text = extractText(msg).trim();
      if (text.length > 0) {
        return text;
      }
    }

    return "";
  }

  /**
   * Handle task failure.
   */
  private async handleTaskFailure(taskId: string, error: string): Promise<void> {
    const taskState = this.config.getWorkspaceTaskState(taskId);
    if (!taskState) return;

    if (taskState.taskStatus === "failed") {
      log.debug(`Ignoring duplicate failure for task ${taskId}`);
      return;
    }
    if (taskState.taskStatus === "reported") {
      log.warn(`Ignoring task failure after report for task ${taskId}`, { error });
      return;
    }

    const failedState: TaskState = {
      ...taskState,
      taskStatus: "failed",
    };

    await this.config.setWorkspaceTaskState(taskId, failedState);

    this.emit("task-failed", {
      taskId,
      parentWorkspaceId: taskState.parentWorkspaceId,
      error,
    });

    // Reject pending completion
    const pending = this.pendingCompletions.get(taskId);
    if (pending) {
      this.pendingCompletions.delete(taskId);
      pending.reject(new Error(error));
    }

    // Always append a failure message to the parent workspace history for user visibility.
    await this.postFailureToParent(taskId, failedState, error);

    // If this was a foreground task, inject a failed tool output so the parent stream can resume safely.
    if (failedState.parentToolCallId) {
      const toolOutput: TaskToolResult = {
        status: "failed",
        taskId,
        error,
      };
      const injected = await this.injectToolOutputToParent(
        failedState.parentWorkspaceId,
        failedState.parentToolCallId,
        toolOutput
      );
      if (injected) {
        await this.maybeResumeParentStream(failedState.parentWorkspaceId);
      }
    }

    // Process queue
    await this.processQueue();

    // Cleanup
    setTimeout(() => {
      void this.cleanupTaskSubtree(taskId);
    }, 1000);
  }

  /**
   * Process the task queue - start next task if slot available.
   * Re-checks running count after each task start to enforce parallel limits.
   */
  private async processQueue(): Promise<void> {
    const settings = this.config.getTaskSettings();

    // Re-check running count each iteration to enforce parallel limits correctly
    while (this.taskQueue.length > 0) {
      const runningCount = this.config.countRunningAgentTasks();
      if (runningCount >= settings.maxParallelAgentTasks) {
        log.debug(
          `Task queue has ${this.taskQueue.length} waiting, but at parallel limit (${runningCount}/${settings.maxParallelAgentTasks})`
        );
        break;
      }

      const next = this.taskQueue.shift();
      if (next) {
        log.debug(`Starting queued task ${next.taskId}`);
        await this.startTask(next.taskId, next.options);
      }
    }
  }

  /**
   * Cleanup a completed/failed task workspace, but only once its subtree is gone.
   * This prevents orphaned child tasks from disappearing in the UI.
   */
  private async cleanupTaskSubtree(taskId: string, seen = new Set<string>()): Promise<void> {
    if (seen.has(taskId)) {
      return;
    }
    seen.add(taskId);

    try {
      const taskState = this.config.getWorkspaceTaskState(taskId);
      if (!taskState) {
        return;
      }

      if (taskState.taskStatus !== "reported" && taskState.taskStatus !== "failed") {
        return;
      }

      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const hasChildren = allMetadata.some((m) => m.parentWorkspaceId === taskId);
      if (hasChildren) {
        log.debug(`Skipping cleanup for task ${taskId} - has child workspaces`);
        return;
      }

      log.debug(`Cleaning up task workspace ${taskId}`);
      const removeResult = await this.workspaceService.remove(taskId);
      if (!removeResult.success) {
        throw new Error(removeResult.error);
      }

      // If the parent is also a completed task workspace, it might now be eligible for cleanup.
      const parentTaskState = this.config.getWorkspaceTaskState(taskState.parentWorkspaceId);
      if (parentTaskState && (parentTaskState.taskStatus === "reported" || parentTaskState.taskStatus === "failed")) {
        await this.cleanupTaskSubtree(taskState.parentWorkspaceId, seen);
      }
    } catch (error) {
      log.error(`Failed to cleanup task workspace ${taskId}:`, error);
    }
  }

  /**
   * Rehydrate tasks on startup (called from main process initialization).
   */
  async rehydrateTasks(): Promise<void> {
    const activeTasks = this.config.getActiveAgentTaskWorkspaces();

    for (const { workspaceId, taskState } of activeTasks) {
      log.debug(`Rehydrating task ${workspaceId} with status ${taskState.taskStatus}`);

      if (taskState.taskStatus === "queued") {
        // Re-add to queue
        this.taskQueue.push({
          taskId: workspaceId,
          options: {
            parentWorkspaceId: taskState.parentWorkspaceId,
            agentType: taskState.agentType,
            prompt: taskState.prompt,
            description: taskState.description,
            parentToolCallId: taskState.parentToolCallId,
            runInBackground: true, // Don't block on restart
          },
        });
      } else if (taskState.taskStatus === "running") {
        // Send continuation message for running tasks
        try {
          const result = await this.workspaceService.sendMessage(
            workspaceId,
            "Mux was restarted. Please continue your task and call agent_report when done.",
            {
              model: "anthropic:claude-sonnet-4-20250514",
              thinkingLevel: "medium",
              mode: "exec",
            }
          );

          if (!result.success) {
            log.error(`Failed to resume task ${workspaceId}:`, result.error);
          }
        } catch (error) {
          log.error(`Failed to resume task ${workspaceId}:`, error);
        }
      } else if (taskState.taskStatus === "awaiting_report") {
        // Send reminder message for tasks that finished without reporting
        try {
          const result = await this.workspaceService.sendMessage(
            workspaceId,
            "Mux was restarted. Your task appears to have finished but agent_report was not called. " +
              "Please call agent_report now with your findings.",
            {
              model: "anthropic:claude-sonnet-4-20250514",
              thinkingLevel: "low",
              // Require only agent_report
              toolPolicy: [{ regex_match: "agent_report", action: "require" }],
              mode: "exec",
            }
          );

          if (!result.success) {
            log.error(`Failed to send reminder to task ${workspaceId}:`, result.error);
          }
        } catch (error) {
          log.error(`Failed to send reminder to task ${workspaceId}:`, error);
        }
      }
    }

    // Process queue after rehydration
    await this.processQueue();

    // Best-effort cleanup of completed task workspaces left over from a previous run.
    await this.cleanupCompletedTaskWorkspaces();
  }

  private async cleanupCompletedTaskWorkspaces(): Promise<void> {
    try {
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const completedTaskIds = allMetadata
        .filter(
          (m) => m.taskState && (m.taskState.taskStatus === "reported" || m.taskState.taskStatus === "failed")
        )
        .map((m) => m.id);

      for (const taskId of completedTaskIds) {
        await this.cleanupTaskSubtree(taskId);
      }
    } catch (error) {
      log.error("Failed to cleanup completed task workspaces on startup:", error);
    }
  }

  private async maybeResumeParentStream(parentWorkspaceId: string): Promise<void> {
    try {
      if (this.aiService.isStreaming(parentWorkspaceId)) {
        return;
      }

      const partial = await this.partialService.readPartial(parentWorkspaceId);
      if (!partial) {
        return;
      }

      const hasPendingTaskToolCalls = partial.parts.some(
        (part) =>
          isDynamicToolPart(part) && part.toolName === "task" && part.state !== "output-available"
      );
      if (hasPendingTaskToolCalls) {
        return;
      }

      // Only resume once the parent has no remaining active descendant tasks.
      if (await this.hasActiveDescendantTasks(parentWorkspaceId)) {
        return;
      }

      // Prefer resuming with the model used for the interrupted assistant message.
      const modelFromPartial = typeof partial.metadata?.model === "string" ? partial.metadata.model : "";

      const metadataResult = await this.aiService.getWorkspaceMetadata(parentWorkspaceId);
      const aiSettings = metadataResult.success ? metadataResult.data.aiSettings : undefined;
      const fallbackModel = aiSettings?.model ?? "anthropic:claude-sonnet-4-20250514";
      const model = modelFromPartial.trim().length > 0 ? modelFromPartial : fallbackModel;

      const thinkingLevel = aiSettings?.thinkingLevel;
      const mode = partial.metadata?.mode;
      const normalizedMode = mode === "plan" || mode === "exec" ? mode : undefined;

      const resumeResult = await this.workspaceService.resumeStream(parentWorkspaceId, {
        model,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(normalizedMode ? { mode: normalizedMode } : {}),
      });
      if (!resumeResult.success) {
        log.error(`Failed to auto-resume parent workspace ${parentWorkspaceId}:`, resumeResult.error);
      }
    } catch (error) {
      log.error(`Failed to auto-resume parent workspace ${parentWorkspaceId}:`, error);
    }
  }

  private async hasActiveDescendantTasks(parentWorkspaceId: string): Promise<boolean> {
    const activeTasks = this.config.getActiveAgentTaskWorkspaces();
    if (activeTasks.length === 0) {
      return false;
    }

    const allMetadata = await this.config.getAllWorkspaceMetadata();
    const parentMap = new Map<string, string | undefined>();
    for (const meta of allMetadata) {
      parentMap.set(meta.id, meta.parentWorkspaceId);
    }

    for (const { workspaceId } of activeTasks) {
      let current: string | undefined = workspaceId;
      while (current) {
        const parent = parentMap.get(current);
        if (!parent) break;
        if (parent === parentWorkspaceId) {
          return true;
        }
        current = parent;
      }
    }

    return false;
  }

  /**
   * Get workspace metadata by ID.
   */
  private async getWorkspaceMetadata(
    workspaceId: string
  ): Promise<FrontendWorkspaceMetadata | null> {
    const allMetadata = await this.config.getAllWorkspaceMetadata();
    return allMetadata.find((m) => m.id === workspaceId) ?? null;
  }

  /**
   * Dispose of the service.
   */
  dispose(): void {
    this.disposed = true;
    this.removeAllListeners();

    // Reject all pending completions
    for (const [taskId, pending] of this.pendingCompletions) {
      pending.reject(new Error(`TaskService disposed while waiting for task ${taskId}`));
    }
    this.pendingCompletions.clear();
  }
}
