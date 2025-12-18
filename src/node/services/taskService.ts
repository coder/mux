import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import { createMuxMessage, type MuxMessage, type MuxToolPart } from "@/common/types/message";
import assert from "@/common/utils/assert";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { Config } from "@/node/config";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { InitLogger } from "@/node/runtime/Runtime";
import type { AIService } from "@/node/services/aiService";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import { getAgentPreset } from "@/node/services/agentPresets";
import { log } from "@/node/services/log";
import type { Workspace } from "@/common/types/project";

export type AgentTaskStatus = "queued" | "running" | "awaiting_report" | "reported";

export interface CreateAgentTaskParams {
  parentWorkspaceId: string;
  toolCallId: string;
  agentType: string;
  prompt: string;
  model: string;
}

// Workspace config entries can be legacy (missing `id`), but agent tasks must always have a stable id.
type AgentTaskWorkspace = Workspace & { id: string; projectPath: string };
export interface AgentTaskReport {
  reportMarkdown: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createNoopInitLogger(): InitLogger {
  return {
    logStep: () => undefined,
    logStdout: () => undefined,
    logStderr: () => undefined,
    logComplete: () => undefined,
  };
}

function getDefaultResumeOptionsFromMessage(message: MuxMessage): {
  model: string;
  mode?: string;
  toolPolicy?: ToolPolicy;
} {
  const model = message.metadata?.model ?? DEFAULT_MODEL;
  return {
    model,
    mode: message.metadata?.mode ?? undefined,
    toolPolicy: message.metadata?.toolPolicy ?? undefined,
  };
}

export class TaskService {
  private readonly pendingReportByWorkspaceId = new Map<string, Deferred<AgentTaskReport>>();

  private schedulingPromise: Promise<void> | null = null;

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly partialService: PartialService,
    private readonly workspaceService: WorkspaceService,
    aiService: AIService
  ) {
    // Enforce reporting / cleanup when agent task streams end.
    aiService.on("stream-end", (event: unknown) => {
      if (!event || typeof event !== "object" || !("workspaceId" in event)) {
        return;
      }

      const workspaceId = (event as { workspaceId?: unknown }).workspaceId;
      if (typeof workspaceId !== "string") {
        return;
      }

      void this.onStreamEnd(workspaceId);
    });
  }

  async initialize(): Promise<void> {
    // Best-effort: resume any tasks marked as running (e.g. mux restarted mid-stream).
    const tasks = this.listAgentTaskWorkspaces();
    for (const task of tasks) {
      if (task.taskStatus === "running") {
        void this.resumeTaskWorkspace(task).catch((error: unknown) => {
          log.error("Failed to resume agent task workspace", { workspaceId: task.id, error });
          void this.handleTaskStartFailure(task.id, error);
        });
      }

      if (task.taskStatus === "awaiting_report") {
        void this.onStreamEnd(task.id).catch((error: unknown) => {
          log.error("Failed to enforce report for agent task workspace", {
            workspaceId: task.id,
            error,
          });
        });
      }
    }

    // Start any queued tasks within the configured parallelism limit.
    await this.queueScheduling();
  }

  private formatErrorForReport(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === "string") {
      return error;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private async handleTaskStartFailure(workspaceId: string, error: unknown): Promise<void> {
    const workspaceConfig = this.config.getWorkspaceConfig(workspaceId);
    if (!workspaceConfig) {
      log.error("Failed to handle agent task start failure: unknown workspace", {
        workspaceId,
        error,
      });
      return;
    }

    const agentType = workspaceConfig.workspace.agentType ?? "unknown";
    const model = workspaceConfig.workspace.taskModel ?? DEFAULT_MODEL;

    const reportMarkdown = [
      "Mux failed to start this agent task workspace.",
      "",
      `- Agent preset: \`${agentType}\``,
      `- Model: \`${model}\``,
      "",
      "Error:",
      "```",
      this.formatErrorForReport(error),
      "```",
      "",
      "Suggested next steps:",
      "- Verify the model string is supported by the selected provider.",
      "- Verify you have an API key set for that provider.",
    ].join("\n");

    // If this isn't a properly-parented task workspace, at least mark it complete so it doesn't
    // consume a scheduler slot indefinitely.
    if (!workspaceConfig.workspace.parentWorkspaceId) {
      await this.updateTaskWorkspace(workspaceId, { taskStatus: "reported" });
      await this.maybeCleanupReportedWorkspace(workspaceId);
      await this.queueScheduling();
      return;
    }

    try {
      await this.handleAgentReport(workspaceId, { reportMarkdown });
    } catch (reportError: unknown) {
      // Ensure a failed report doesn't leave the queue stuck.
      log.error("Failed to forward agent task start failure report", {
        workspaceId,
        error: reportError,
      });

      await this.updateTaskWorkspace(workspaceId, { taskStatus: "reported" });
      await this.maybeCleanupReportedWorkspace(workspaceId);
      await this.queueScheduling();
    }
  }

  private async finalizeAgentTaskWithoutReport(
    workspaceId: string,
    reportMarkdown: string
  ): Promise<void> {
    const workspaceConfig = this.config.getWorkspaceConfig(workspaceId);
    if (!workspaceConfig) {
      log.error("Failed to finalize agent task without report: unknown workspace", {
        workspaceId,
      });
      return;
    }

    // If this isn't a properly-parented task workspace, at least mark it complete so it doesn't
    // consume a scheduler slot indefinitely.
    if (!workspaceConfig.workspace.parentWorkspaceId) {
      await this.updateTaskWorkspace(workspaceId, { taskStatus: "reported" });
      await this.maybeCleanupReportedWorkspace(workspaceId);
      await this.queueScheduling();
      return;
    }

    try {
      await this.handleAgentReport(workspaceId, { reportMarkdown });
    } catch (error: unknown) {
      // Ensure a failed report doesn't leave the queue stuck.
      log.error("Failed to finalize agent task without agent_report", {
        workspaceId,
        error,
      });

      await this.updateTaskWorkspace(workspaceId, { taskStatus: "reported" });
      await this.maybeCleanupReportedWorkspace(workspaceId);
      await this.queueScheduling();
    }
  }

  async createAgentTask(params: CreateAgentTaskParams): Promise<{ childWorkspaceId: string }> {
    const preset = getAgentPreset(params.agentType);

    const existingWorkspaceId = this.findExistingTaskWorkspace(
      params.parentWorkspaceId,
      params.toolCallId
    );
    if (existingWorkspaceId) {
      await this.queueScheduling();
      return { childWorkspaceId: existingWorkspaceId };
    }
    if (!preset) {
      throw new Error(`Unknown agentType: ${params.agentType}`);
    }

    const nestingDepth = this.computeNestingDepth(params.parentWorkspaceId);
    const maxDepth = this.config.getTaskSettings().maxTaskNestingDepth;
    if (nestingDepth + 1 > maxDepth) {
      throw new Error(
        `Max task nesting depth exceeded (depth=${nestingDepth + 1}, max=${maxDepth}). ` +
          "Increase it in Settings → Tasks."
      );
    }

    const parentMetadata = await this.workspaceService.getInfo(params.parentWorkspaceId);
    if (!parentMetadata) {
      throw new Error(`Parent workspace not found: ${params.parentWorkspaceId}`);
    }

    const childWorkspaceId = this.config.generateStableId();
    const now = new Date().toISOString();

    const childName = `agent_${params.agentType}_${childWorkspaceId.slice(0, 8)}`;

    const initLogger = createNoopInitLogger();
    const runtime = createRuntime(parentMetadata.runtimeConfig, {
      projectPath: parentMetadata.projectPath,
    });

    // Prefer fork semantics when the runtime supports it.
    let workspacePath: string | undefined;
    const forkResult = await runtime.forkWorkspace({
      projectPath: parentMetadata.projectPath,
      sourceWorkspaceName: parentMetadata.name,
      newWorkspaceName: childName,
      initLogger,
    });
    if (forkResult.success) {
      workspacePath = forkResult.workspacePath;
    } else {
      const createResult = await runtime.createWorkspace({
        projectPath: parentMetadata.projectPath,
        branchName: childName,
        trunkBranch: parentMetadata.name,
        directoryName: childName,
        initLogger,
      });
      if (!createResult.success) {
        throw new Error(createResult.error);
      }
      workspacePath = createResult.workspacePath;
    }
    assert(workspacePath, "workspacePath must be defined");

    // Persist workspace + task metadata.
    await this.config.editConfig((config) => {
      const projectConfig = config.projects.get(parentMetadata.projectPath);
      if (!projectConfig) {
        throw new Error(`Project not found for task: ${parentMetadata.projectPath}`);
      }

      projectConfig.workspaces.push({
        id: childWorkspaceId,
        name: childName,
        path: workspacePath,
        createdAt: now,
        title: `${params.agentType}: ${params.prompt.split("\n")[0]?.slice(0, 60)}`,
        runtimeConfig: parentMetadata.runtimeConfig,
        parentWorkspaceId: params.parentWorkspaceId,
        agentType: params.agentType,
        taskStatus: "queued",
        taskParentToolCallId: params.toolCallId,
        taskPrompt: params.prompt,
        taskModel: params.model,
      });

      return config;
    });

    // Kick off init hook (best-effort).
    void runtime
      .initWorkspace({
        projectPath: parentMetadata.projectPath,
        branchName: childName,
        trunkBranch: parentMetadata.name,
        workspacePath,
        initLogger,
      })
      .then((result) => {
        if (!result.success) {
          log.error("Failed to init agent task workspace", {
            workspaceId: childWorkspaceId,
            error: result.error,
          });
        }
      })
      .catch((error: unknown) => {
        log.error("Failed to init agent task workspace", { workspaceId: childWorkspaceId, error });
      });

    await this.workspaceService.emitWorkspaceMetadata(childWorkspaceId);

    // Seed the child workspace history with the initial task prompt.
    const promptMessage = createMuxMessage(this.config.generateStableId(), "user", params.prompt);

    const promptAppendResult = await this.historyService.appendToHistory(
      childWorkspaceId,
      promptMessage
    );
    if (!promptAppendResult.success) {
      throw new Error(promptAppendResult.error);
    }

    this.workspaceService.emitChatEvent(childWorkspaceId, {
      ...promptMessage,
      type: "message",
    } satisfies WorkspaceChatMessage);

    // Schedule execution (may stay queued depending on parallelism).
    await this.queueScheduling();

    return { childWorkspaceId };
  }

  async awaitAgentReport(workspaceId: string, abortSignal?: AbortSignal): Promise<AgentTaskReport> {
    const existing = this.pendingReportByWorkspaceId.get(workspaceId);
    if (existing) {
      return existing.promise;
    }

    const deferred = createDeferred<AgentTaskReport>();
    this.pendingReportByWorkspaceId.set(workspaceId, deferred);

    if (abortSignal) {
      if (abortSignal.aborted) {
        this.pendingReportByWorkspaceId.delete(workspaceId);
        throw new Error("Task was aborted");
      }

      const onAbort = () => {
        deferred.reject(new Error("Task was aborted"));
        this.pendingReportByWorkspaceId.delete(workspaceId);
      };

      abortSignal.addEventListener("abort", onAbort, { once: true });

      return deferred.promise.finally(() => {
        abortSignal.removeEventListener("abort", onAbort);
      });
    }

    return deferred.promise;
  }

  async handleAgentReport(workspaceId: string, report: AgentTaskReport): Promise<void> {
    const workspaceConfig = this.config.getWorkspaceConfig(workspaceId);
    if (!workspaceConfig) {
      throw new Error(`Unknown workspace for agent_report: ${workspaceId}`);
    }

    const parentWorkspaceId = workspaceConfig.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      // Not an agent task workspace (or manually created) — nothing to forward.
      return;
    }

    // Resolve any in-flight tool call awaiters first so foreground `task` calls don't hang even if
    // persisting the report to parent history fails.
    const deferred = this.pendingReportByWorkspaceId.get(workspaceId);
    if (deferred) {
      deferred.resolve(report);
      this.pendingReportByWorkspaceId.delete(workspaceId);
    }

    const preset = workspaceConfig.workspace.agentType
      ? getAgentPreset(workspaceConfig.workspace.agentType)
      : undefined;

    const reportHeader = preset
      ? `### Subagent report (${preset.agentType})\n\n`
      : "### Subagent report\n\n";

    const reportMessage = createMuxMessage(
      this.config.generateStableId(),
      "assistant",
      `${reportHeader}${report.reportMarkdown}`
    );

    const appendResult = await this.historyService.appendToHistory(
      parentWorkspaceId,
      reportMessage
    );
    if (!appendResult.success) {
      log.error("Failed to append subagent report to parent history", {
        workspaceId,
        parentWorkspaceId,
        error: appendResult.error,
      });
    } else {
      this.workspaceService.emitChatEvent(parentWorkspaceId, {
        ...reportMessage,
        type: "message",
      } satisfies WorkspaceChatMessage);
    }

    // Mark reported after best-effort delivery to the parent.
    await this.updateTaskWorkspace(workspaceId, {
      taskStatus: "reported",
    });

    // Durable tool output + auto-resume for interrupted parent streams.
    const parentToolCallId = workspaceConfig.workspace.taskParentToolCallId;
    if (!deferred && parentToolCallId) {
      await this.tryResolveParentTaskToolCall({
        parentWorkspaceId,
        parentToolCallId,
        childWorkspaceId: workspaceId,
        report,
      });
    }

    // Cleanup + scheduling.
    await this.maybeCleanupReportedWorkspace(workspaceId);
    await this.queueScheduling();
  }

  private async onStreamEnd(workspaceId: string): Promise<void> {
    const config = this.config.getWorkspaceConfig(workspaceId);
    if (!config) {
      return;
    }

    const agentType = config.workspace.agentType;
    const taskStatus = config.workspace.taskStatus as AgentTaskStatus | undefined;
    if (!agentType || taskStatus === "reported") {
      return;
    }

    if (taskStatus !== "awaiting_report") {
      // First time we noticed the stream ended without reporting.
      await this.updateTaskWorkspace(workspaceId, { taskStatus: "awaiting_report" });

      const preset = getAgentPreset(agentType);
      if (preset) {
        // Force a report-only follow-up.
        const requirePolicy: ToolPolicy = [{ action: "require", regex_match: "^agent_report$" }];

        const nudgeMessage = createMuxMessage(
          this.config.generateStableId(),
          "user",
          "You must now call agent_report with your final reportMarkdown. Do not do anything else.",
          { synthetic: true }
        );

        const appendResult = await this.historyService.appendToHistory(workspaceId, nudgeMessage);
        if (!appendResult.success) {
          log.error("Failed to append agent_report enforcement message", {
            workspaceId,
            error: appendResult.error,
          });
        } else {
          this.workspaceService.emitChatEvent(workspaceId, {
            ...nudgeMessage,
            type: "message",
          } satisfies WorkspaceChatMessage);
        }

        const model = config.workspace.taskModel ?? DEFAULT_MODEL;
        const resumeResult = await this.workspaceService.resumeStream(workspaceId, {
          model,
          mode: "agent",
          additionalSystemInstructions: preset.systemPrompt,
          toolPolicy: requirePolicy,
        });
        if (resumeResult.success) {
          return;
        }

        log.error("Failed to resume agent task for report enforcement", {
          workspaceId,
          error: resumeResult.error,
        });

        const fallbackReport = await this.buildFallbackReportFromHistory(workspaceId);
        const reportMarkdown = [
          "Mux was unable to resume this agent task to collect a final agent_report.",
          "",
          "Resume error:",
          "```",
          this.formatErrorForReport(resumeResult.error),
          "```",
          ...(fallbackReport
            ? ["", "Best-effort output extracted from the task history:", "", fallbackReport]
            : [
                "",
                "Mux could not extract any assistant text from the task history (best-effort fallback).",
              ]),
        ].join("\n");

        await this.finalizeAgentTaskWithoutReport(workspaceId, reportMarkdown);
        return;
      }

      log.error("Agent task ended without agent_report, but no preset exists for enforcement", {
        workspaceId,
        agentType,
      });
      // Fall through to best-effort extraction.
    }

    // Second failure: fall back to best-effort report extraction.
    const fallbackReport = await this.buildFallbackReportFromHistory(workspaceId);
    const reportMarkdown =
      fallbackReport ??
      "Mux did not receive an agent_report for this task and could not extract any assistant text from the task history.";

    await this.finalizeAgentTaskWithoutReport(workspaceId, reportMarkdown);
  }

  private async tryResolveParentTaskToolCall(params: {
    parentWorkspaceId: string;
    parentToolCallId: string;
    childWorkspaceId: string;
    report: AgentTaskReport;
  }): Promise<void> {
    let finalized: { updated: MuxMessage; output: unknown } | null = null;
    let shouldAutoResumeParent = false;

    // 1) Prefer partial.json (most common after restart while waiting).
    const parentPartial = await this.partialService.readPartial(params.parentWorkspaceId);
    if (parentPartial) {
      const hasPendingToolCall = parentPartial.parts.some(
        (part) =>
          part.type === "dynamic-tool" &&
          part.toolCallId === params.parentToolCallId &&
          part.state === "input-available"
      );

      finalized = this.updateTaskToolPartOutput(
        parentPartial,
        params.parentToolCallId,
        params.childWorkspaceId,
        params.report
      );

      if (finalized) {
        if (hasPendingToolCall) {
          shouldAutoResumeParent = true;
        }

        const writeResult = await this.partialService.writePartial(
          params.parentWorkspaceId,
          finalized.updated
        );
        if (!writeResult.success) {
          log.error("Failed to write parent partial with task tool output", {
            workspaceId: params.parentWorkspaceId,
            error: writeResult.error,
          });
          return;
        }

        this.workspaceService.emitChatEvent(params.parentWorkspaceId, {
          type: "tool-call-end",
          workspaceId: params.parentWorkspaceId,
          messageId: finalized.updated.id,
          toolCallId: params.parentToolCallId,
          toolName: "task",
          result: finalized.output,
          timestamp: Date.now(),
        } satisfies WorkspaceChatMessage);
      }
    }

    if (!finalized) {
      // 2) Fall back to chat history (partial may have already been committed).
      const historyResult = await this.historyService.getHistory(params.parentWorkspaceId);
      if (!historyResult.success) {
        log.error("Failed to read parent history for task tool resolution", {
          workspaceId: params.parentWorkspaceId,
          error: historyResult.error,
        });
        return;
      }

      // Find the newest message containing this tool call.
      let best: MuxMessage | null = null;
      let bestSeq = -Infinity;
      for (const msg of historyResult.data) {
        const seq = msg.metadata?.historySequence;
        if (seq === undefined) continue;

        const hasTool = msg.parts.some(
          (p) => p.type === "dynamic-tool" && p.toolCallId === params.parentToolCallId
        );
        if (hasTool && seq > bestSeq) {
          best = msg;
          bestSeq = seq;
        }
      }

      if (!best) {
        return;
      }

      const hasPendingToolCall = best.parts.some(
        (part) =>
          part.type === "dynamic-tool" &&
          part.toolCallId === params.parentToolCallId &&
          part.state === "input-available"
      );

      const maxSeq = Math.max(
        ...historyResult.data
          .map((m) => m.metadata?.historySequence)
          .filter((n): n is number => typeof n === "number")
      );
      const wasLatestOrSecondLatest = bestSeq === maxSeq || bestSeq === maxSeq - 1;

      finalized = this.updateTaskToolPartOutput(
        best,
        params.parentToolCallId,
        params.childWorkspaceId,
        params.report
      );
      if (!finalized) {
        return;
      }

      if (hasPendingToolCall && wasLatestOrSecondLatest) {
        shouldAutoResumeParent = true;
      }

      const updateResult = await this.historyService.updateHistory(
        params.parentWorkspaceId,
        finalized.updated
      );
      if (!updateResult.success) {
        log.error("Failed to update parent history with task tool output", {
          workspaceId: params.parentWorkspaceId,
          error: updateResult.error,
        });
        return;
      }

      this.workspaceService.emitChatEvent(params.parentWorkspaceId, {
        type: "tool-call-end",
        workspaceId: params.parentWorkspaceId,
        messageId: finalized.updated.id,
        toolCallId: params.parentToolCallId,
        toolName: "task",
        result: finalized.output,
        timestamp: Date.now(),
      } satisfies WorkspaceChatMessage);
    }

    if (!finalized || !shouldAutoResumeParent) {
      return;
    }

    // Only auto-resume once all descendant tasks are finished.
    if (this.hasActiveDescendantTasks(params.parentWorkspaceId)) {
      return;
    }

    const resumeOptions = getDefaultResumeOptionsFromMessage(finalized.updated);
    const resumeResult = await this.workspaceService.resumeStream(
      params.parentWorkspaceId,
      resumeOptions
    );
    if (!resumeResult.success) {
      log.error("Failed to auto-resume parent after agent task report", {
        workspaceId: params.parentWorkspaceId,
        error: resumeResult.error,
      });
    }
  }

  private updateTaskToolPartOutput(
    message: MuxMessage,
    toolCallId: string,
    childWorkspaceId: string,
    report: AgentTaskReport
  ): { updated: MuxMessage; output: unknown } | null {
    const outputForTool = {
      status: "completed",
      childWorkspaceId,
      reportMarkdown: report.reportMarkdown,
    };

    let output: unknown = null;
    let hasOutput = false;
    let changed = false;

    const nextParts = message.parts.map((part) => {
      if (part.type !== "dynamic-tool" || part.toolCallId !== toolCallId) {
        return part;
      }

      if (part.state === "output-available") {
        const existing = part.output;
        const alreadyCompleted =
          typeof existing === "object" &&
          existing !== null &&
          "status" in existing &&
          (existing as { status?: unknown }).status === "completed" &&
          "childWorkspaceId" in existing &&
          (existing as { childWorkspaceId?: unknown }).childWorkspaceId === childWorkspaceId &&
          "reportMarkdown" in existing &&
          (existing as { reportMarkdown?: unknown }).reportMarkdown === report.reportMarkdown;

        if (alreadyCompleted) {
          return part;
        }

        output = outputForTool;
        hasOutput = true;
        changed = true;

        const nextToolPart: MuxToolPart = {
          ...part,
          output: outputForTool,
        };

        return nextToolPart;
      }

      output = outputForTool;
      hasOutput = true;
      changed = true;

      const nextToolPart: MuxToolPart = {
        ...part,
        state: "output-available",
        output: outputForTool,
      };

      return nextToolPart;
    });

    if (!changed || !hasOutput) {
      return null;
    }

    return { updated: { ...message, parts: nextParts }, output };
  }

  private findExistingTaskWorkspace(parentWorkspaceId: string, toolCallId: string): string | null {
    const match = this.config
      .listWorkspaceConfigs()
      .map(({ workspace }) => workspace)
      .find(
        (workspace) =>
          workspace.parentWorkspaceId === parentWorkspaceId &&
          workspace.taskParentToolCallId === toolCallId &&
          workspace.taskStatus !== "reported"
      );

    return match?.id ?? null;
  }
  private listAgentTaskWorkspaces(): AgentTaskWorkspace[] {
    const result: AgentTaskWorkspace[] = [];

    for (const entry of this.config.listWorkspaceConfigs()) {
      const workspace = entry.workspace;
      if (!workspace.agentType) {
        continue;
      }

      if (!workspace.id) {
        log.error("Agent task workspace is missing id; skipping", {
          projectPath: entry.projectPath,
          workspacePath: workspace.path,
        });
        continue;
      }

      result.push({ ...workspace, id: workspace.id, projectPath: entry.projectPath });
    }

    return result;
  }

  private computeNestingDepth(workspaceId: string): number {
    let depth = 0;
    let currentId: string | undefined = workspaceId;

    while (currentId) {
      const current = this.config.getWorkspaceConfig(currentId);
      if (!current) {
        break;
      }
      const parent = current.workspace.parentWorkspaceId;
      if (!parent) {
        break;
      }
      depth += 1;
      currentId = parent;

      // Safety valve against cycles.
      if (depth > 100) {
        throw new Error("Workspace parent chain appears to contain a cycle");
      }
    }

    return depth;
  }

  private hasActiveDescendantTasks(rootWorkspaceId: string): boolean {
    const all = this.listAgentTaskWorkspaces();
    const childrenByParent = new Map<string, AgentTaskWorkspace[]>();
    for (const workspace of all) {
      const parentId = workspace.parentWorkspaceId;
      if (!parentId) {
        continue;
      }
      const list = childrenByParent.get(parentId) ?? [];
      list.push(workspace);
      childrenByParent.set(parentId, list);
    }

    const stack = childrenByParent.get(rootWorkspaceId)?.slice() ?? [];
    while (stack.length > 0) {
      const child = stack.pop();
      if (!child) {
        continue;
      }

      const status = child.taskStatus as AgentTaskStatus | undefined;
      if (status && status !== "reported") {
        return true;
      }

      const grandchildren = childrenByParent.get(child.id);
      if (grandchildren) {
        stack.push(...grandchildren);
      }
    }

    return false;
  }

  private async maybeCleanupReportedWorkspace(workspaceId: string): Promise<void> {
    const config = this.config.getWorkspaceConfig(workspaceId);
    if (!config) {
      return;
    }

    const status = config.workspace.taskStatus as AgentTaskStatus | undefined;
    if (status !== "reported") {
      return;
    }

    // Only delete once the subtree is fully completed.
    if (this.hasActiveDescendantTasks(workspaceId)) {
      return;
    }

    const removeResult = await this.workspaceService.remove(workspaceId, true);
    if (!removeResult.success) {
      log.error("Failed to remove reported agent task workspace", {
        workspaceId,
        error: removeResult.error,
      });
      return;
    }

    // workspaceService.remove emits metadata=null for us.
  }

  private async ensureTaskPromptSeeded(workspace: AgentTaskWorkspace): Promise<void> {
    const prompt = workspace.taskPrompt;
    if (!prompt) {
      return;
    }

    const historyResult = await this.historyService.getHistory(workspace.id);
    if (!historyResult.success) {
      log.error("Failed to read agent task history", {
        workspaceId: workspace.id,
        error: historyResult.error,
      });
      return;
    }

    // Prompt already exists (or some other history was written).
    if (historyResult.data.length > 0) {
      return;
    }

    const promptMessage = createMuxMessage(this.config.generateStableId(), "user", prompt);
    const appendResult = await this.historyService.appendToHistory(workspace.id, promptMessage);
    if (!appendResult.success) {
      log.error("Failed to append agent task prompt", {
        workspaceId: workspace.id,
        error: appendResult.error,
      });
      return;
    }

    this.workspaceService.emitChatEvent(workspace.id, {
      ...promptMessage,
      type: "message",
    } satisfies WorkspaceChatMessage);
  }

  private async resumeTaskWorkspace(workspace: AgentTaskWorkspace): Promise<void> {
    assert(workspace.agentType, "resumeTaskWorkspace requires agentType");

    const preset = getAgentPreset(workspace.agentType);
    if (!preset) {
      throw new Error(`Unknown agent preset: ${workspace.agentType}`);
    }

    await this.ensureTaskPromptSeeded(workspace);

    const model = workspace.taskModel ?? DEFAULT_MODEL;
    const resumeResult = await this.workspaceService.resumeStream(workspace.id, {
      model,
      mode: "agent",
      additionalSystemInstructions: preset.systemPrompt,
      toolPolicy: preset.toolPolicy,
    });

    if (!resumeResult.success) {
      const error = resumeResult.error;
      const errorMessage = (() => {
        switch (error.type) {
          case "unknown":
            return error.raw;
          case "invalid_model_string":
          case "incompatible_workspace":
            return error.message;
          case "api_key_not_found":
          case "provider_not_supported":
            return `${error.type}: ${error.provider}`;
        }
      })();

      throw new Error(errorMessage);
    }
  }

  private queueScheduling(): Promise<void> {
    if (this.schedulingPromise) {
      return this.schedulingPromise;
    }

    this.schedulingPromise = this.scheduleQueuedTasks().finally(() => {
      this.schedulingPromise = null;
    });
    return this.schedulingPromise;
  }

  private async scheduleQueuedTasks(): Promise<void> {
    const settings = this.config.getTaskSettings();
    const all = this.listAgentTaskWorkspaces();

    const activeCount = all.filter((w) => {
      const status = w.taskStatus as AgentTaskStatus | undefined;
      return status === "running" || status === "awaiting_report";
    }).length;

    const availableSlots = settings.maxParallelAgentTasks - activeCount;
    if (availableSlots <= 0) {
      return;
    }

    const queued = all
      .filter((w) => (w.taskStatus as AgentTaskStatus | undefined) === "queued")
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
      .slice(0, availableSlots);

    for (const workspace of queued) {
      await this.updateTaskWorkspace(workspace.id, { taskStatus: "running" });

      void this.resumeTaskWorkspace(workspace).catch((error: unknown) => {
        log.error("Failed to start queued agent task", { workspaceId: workspace.id, error });
        void this.handleTaskStartFailure(workspace.id, error);
      });
    }
  }

  private async updateTaskWorkspace(
    workspaceId: string,
    updates: Partial<Pick<Workspace, "taskStatus">>
  ): Promise<void> {
    await this.config.editConfig((config) => {
      for (const projectConfig of config.projects.values()) {
        const workspace = projectConfig.workspaces.find((w) => w.id === workspaceId);
        if (!workspace) {
          continue;
        }

        Object.assign(workspace, updates);
        return config;
      }
      return config;
    });

    await this.workspaceService.emitWorkspaceMetadata(workspaceId);
  }

  private async buildFallbackReportFromHistory(workspaceId: string): Promise<string | null> {
    const historyResult = await this.historyService.getHistory(workspaceId);
    if (!historyResult.success) {
      return null;
    }

    const assistantTextParts = historyResult.data
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text")
      .map((p) => p.text.trim())
      .filter(Boolean);

    if (assistantTextParts.length === 0) {
      return null;
    }

    return assistantTextParts.join("\n\n");
  }
}
