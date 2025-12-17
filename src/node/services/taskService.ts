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
import type { AIService } from "@/node/services/aiService";
import type { AgentType, TaskState } from "@/common/types/task";
import { getAgentPreset } from "@/common/constants/agentPresets";
import { log } from "@/node/services/log";
import {
  createMuxMessage,
  type MuxMessage,
  type MuxFrontendMetadata,
} from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import * as crypto from "crypto";

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

    // Create workspace via WorkspaceService
    // Using empty trunk branch because agent workspaces use local runtime (no git isolation needed)
    const createResult = await this.workspaceService.create(
      parentInfo.projectPath,
      workspaceName,
      "", // No trunk branch for local runtime
      workspaceTitle,
      { type: "local" } // Agent workspaces use local runtime for simplicity
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
    const { agentType, prompt } = options;
    const preset = getAgentPreset(agentType);

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
      // Send message with preset's tool policy and system prompt
      const result = await this.workspaceService.sendMessage(taskId, prompt, {
        model: "anthropic:claude-sonnet-4-20250514", // Default model for agents
        thinkingLevel: "medium",
        toolPolicy: preset.toolPolicy,
        mode: "exec", // Agent tasks are always in exec mode
        // System prompt override happens in AIService based on agentType
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

    log.debug(`Task ${workspaceId} reported`, { title: args.title });

    // Update task state
    await this.config.setWorkspaceTaskState(workspaceId, {
      ...taskState,
      taskStatus: "reported",
      reportedAt: new Date().toISOString(),
      reportMarkdown: args.reportMarkdown,
      reportTitle: args.title,
    });

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

    // Post report to parent workspace history
    await this.postReportToParent(workspaceId, taskState, args);

    // Process queue (a slot freed up)
    await this.processQueue();

    // Schedule cleanup (delay slightly to ensure all events propagate)
    setTimeout(() => {
      void this.cleanupTask(workspaceId);
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

      // Create a system message with the report content
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

      // Append to parent history
      await this.historyService.appendToHistory(taskState.parentWorkspaceId, reportMessage);

      log.debug(`Posted task report to parent ${taskState.parentWorkspaceId}`, { taskId, title });
    } catch (error) {
      log.error(`Failed to post report to parent ${taskState.parentWorkspaceId}:`, error);
    }
  }

  /**
   * Handle stream end - check if agent_report was called.
   */
  private async handleStreamEnd(workspaceId: string): Promise<void> {
    const taskState = this.config.getWorkspaceTaskState(workspaceId);
    if (taskState?.taskStatus !== "running") {
      return;
    }

    // Give a short delay for the tool-call-end event to arrive
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Re-check state
    const updatedState = this.config.getWorkspaceTaskState(workspaceId);
    if (!updatedState || updatedState.taskStatus === "reported") {
      return;
    }

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
      log.error(`Failed to send reminder to task ${workspaceId}:`, error);
      // Fall back to posting whatever we have
      await this.handleTaskFailure(workspaceId, "Task did not call agent_report after reminder");
    }
  }

  /**
   * Handle task failure.
   */
  private async handleTaskFailure(taskId: string, error: string): Promise<void> {
    const taskState = this.config.getWorkspaceTaskState(taskId);
    if (!taskState) return;

    await this.config.setWorkspaceTaskState(taskId, {
      ...taskState,
      taskStatus: "failed",
    });

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

    // Process queue
    await this.processQueue();

    // Cleanup
    setTimeout(() => {
      void this.cleanupTask(taskId);
    }, 1000);
  }

  /**
   * Process the task queue - start next task if slot available.
   */
  private async processQueue(): Promise<void> {
    const settings = this.config.getTaskSettings();
    const runningCount = this.config.countRunningAgentTasks();

    while (runningCount < settings.maxParallelAgentTasks && this.taskQueue.length > 0) {
      const next = this.taskQueue.shift();
      if (next) {
        log.debug(`Starting queued task ${next.taskId}`);
        await this.startTask(next.taskId, next.options);
      }
    }
  }

  /**
   * Cleanup a completed/failed task workspace.
   */
  private async cleanupTask(taskId: string): Promise<void> {
    try {
      log.debug(`Cleaning up task workspace ${taskId}`);
      await this.workspaceService.remove(taskId);
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
      } else if (taskState.taskStatus === "running" || taskState.taskStatus === "awaiting_report") {
        // Send continuation message
        try {
          const result = await this.workspaceService.sendMessage(
            workspaceId,
            "Mux was restarted. Please continue your task and call agent_report when done.",
            {
              model: "anthropic:claude-sonnet-4-20250514",
              thinkingLevel: "medium",
              toolPolicy: getAgentPreset(taskState.agentType).toolPolicy,
              mode: "exec",
            }
          );

          if (!result.success) {
            log.error(`Failed to resume task ${workspaceId}:`, result.error);
          }
        } catch (error) {
          log.error(`Failed to resume task ${workspaceId}:`, error);
        }
      }
    }

    // Process queue after rehydration
    await this.processQueue();
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
