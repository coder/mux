import assert from "@/common/utils/assert";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { TaskCreateResult } from "@/node/services/taskService";
import type {
  WorkflowAgentResult,
  WorkflowAgentSpec,
  WorkflowAgentWaitOptions,
  WorkflowApplyPatchSpec,
  WorkflowTaskAdapter,
} from "./WorkflowRunner";
import {
  applyTaskGitPatchArtifact,
  type TaskApplyGitPatchArgs,
  type TaskApplyGitPatchConfiguration,
  type TaskApplyGitPatchResult,
} from "@/node/services/tools/task_apply_git_patch";

interface WorkflowTaskExperiments {
  programmaticToolCalling?: boolean;
  programmaticToolCallingExclusive?: boolean;
  advisorTool?: boolean;
  execSubagentHardRestart?: boolean;
  dynamicWorkflows?: boolean;
  subagentFileReports?: boolean;
}

interface WorkflowTaskServiceLike {
  create(args: {
    parentWorkspaceId: string;
    kind: "agent";
    agentId: string;
    prompt: string;
    title: string;
    workflowTask: {
      runId: string;
      stepId: string;
      outputSchema?: unknown;
    };
    experiments?: WorkflowTaskExperiments;
  }): Promise<{ success: true; data: TaskCreateResult } | { success: false; error: string }>;
  waitForAgentReport(
    taskId: string,
    options: WorkflowAgentWaitOptions & {
      requestingWorkspaceId: string;
      backgroundOnMessageQueued: boolean;
    }
  ): Promise<{ reportMarkdown: string; title?: string; structuredOutput?: unknown }>;
  terminateAllDescendantAgentTasks?(
    workspaceId: string,
    options?: { workflowRunId?: string }
  ): Promise<string[]>;
}

type WorkflowPatchArtifactApplier = (
  args: TaskApplyGitPatchArgs,
  options?: { abortSignal?: AbortSignal }
) => Promise<TaskApplyGitPatchResult>;

export interface WorkflowTaskServiceAdapterOptions {
  taskService: WorkflowTaskServiceLike;
  parentWorkspaceId: string;
  workflowRunId: string;
  defaultAgentId: string;
  experiments?: WorkflowTaskExperiments;
  patchToolConfig?: TaskApplyGitPatchConfiguration;
  applyPatchArtifact?: WorkflowPatchArtifactApplier;
  getProjectTrusted?: () => boolean | Promise<boolean>;
}

export class WorkflowTaskServiceAdapter implements WorkflowTaskAdapter {
  private readonly taskService: WorkflowTaskServiceLike;
  private readonly parentWorkspaceId: string;
  private readonly workflowRunId: string;
  private readonly defaultAgentId: string;
  private readonly patchToolConfig?: TaskApplyGitPatchConfiguration;
  private readonly applyPatchArtifact?: WorkflowPatchArtifactApplier;
  private readonly getProjectTrusted?: () => boolean | Promise<boolean>;
  private readonly patchApplyMutex = new AsyncMutex();
  private readonly experiments?: WorkflowTaskExperiments;

  constructor(options: WorkflowTaskServiceAdapterOptions) {
    assert(
      options.parentWorkspaceId.length > 0,
      "WorkflowTaskServiceAdapter: parentWorkspaceId is required"
    );
    assert(
      options.workflowRunId.length > 0,
      "WorkflowTaskServiceAdapter: workflowRunId is required"
    );
    assert(
      options.defaultAgentId.length > 0,
      "WorkflowTaskServiceAdapter: defaultAgentId is required"
    );
    this.taskService = options.taskService;
    this.parentWorkspaceId = options.parentWorkspaceId;
    this.workflowRunId = options.workflowRunId;
    this.defaultAgentId = options.defaultAgentId;
    this.patchToolConfig = options.patchToolConfig;
    this.applyPatchArtifact = options.applyPatchArtifact;
    this.getProjectTrusted = options.getProjectTrusted;
    this.experiments = options.experiments;
  }

  async applyPatch(
    spec: WorkflowApplyPatchSpec,
    options?: { abortSignal?: AbortSignal }
  ): Promise<TaskApplyGitPatchResult> {
    assert(spec.id.length > 0, "WorkflowTaskServiceAdapter.applyPatch: spec.id is required");
    assert(
      spec.sourceTaskId.length > 0,
      "WorkflowTaskServiceAdapter.applyPatch: sourceTaskId is required"
    );
    if ((await this.getProjectTrusted?.()) !== true) {
      throw new Error("applyPatch requires Project Trust");
    }

    // Applying one patch mutates HEAD, so complete each dry-run + real apply pair before
    // checking the next patch. This preserves the old Orchestrator conflict model.
    await using _lock = await this.patchApplyMutex.acquire();
    const applyPatchArtifact = this.resolvePatchArtifactApplier();
    const baseArgs: TaskApplyGitPatchArgs = {
      task_id: spec.sourceTaskId,
      ...(spec.projectPath != null ? { project_path: spec.projectPath } : {}),
      ...(spec.expectedHeadSha != null ? { expected_head_sha: spec.expectedHeadSha } : {}),
      three_way: spec.threeWay,
      force: spec.force,
    };

    const dryRun = await applyPatchArtifact(
      {
        ...baseArgs,
        dry_run: true,
      },
      options
    );
    if (!dryRun.success) {
      return dryRun;
    }

    return await applyPatchArtifact(
      {
        ...baseArgs,
        dry_run: false,
      },
      options
    );
  }

  private resolvePatchArtifactApplier(): WorkflowPatchArtifactApplier {
    if (this.applyPatchArtifact != null) {
      return this.applyPatchArtifact;
    }
    const patchToolConfig = this.patchToolConfig;
    if (patchToolConfig == null) {
      throw new Error("WorkflowTaskServiceAdapter.applyPatch requires patch tool configuration");
    }
    return async (args, options) =>
      await applyTaskGitPatchArtifact(
        {
          ...patchToolConfig,
          trusted: true,
        },
        args,
        { abortSignal: options?.abortSignal, allowAlreadyApplied: true }
      );
  }

  async interruptRun(): Promise<void> {
    await this.taskService.terminateAllDescendantAgentTasks?.(this.parentWorkspaceId, {
      workflowRunId: this.workflowRunId,
    });
  }

  async runAgent(
    spec: WorkflowAgentSpec,
    lifecycle?: { onTaskCreated?: (taskId: string) => Promise<void> | void },
    waitOptions?: WorkflowAgentWaitOptions
  ): Promise<WorkflowAgentResult> {
    assert(spec.id.length > 0, "WorkflowTaskServiceAdapter.runAgent: spec.id is required");
    assert(spec.prompt.length > 0, "WorkflowTaskServiceAdapter.runAgent: spec.prompt is required");

    const workflowTask: { runId: string; stepId: string; outputSchema?: unknown } = {
      runId: this.workflowRunId,
      stepId: spec.id,
    };
    if (spec.outputSchema !== undefined) {
      workflowTask.outputSchema = spec.outputSchema;
    }

    const agentId = spec.agentId ?? this.defaultAgentId;
    const experiments = this.getExperimentsForAgent(agentId);
    const createResult = await this.taskService.create({
      parentWorkspaceId: this.parentWorkspaceId,
      kind: "agent",
      agentId,
      prompt: spec.prompt,
      title: spec.title ?? spec.id,
      workflowTask,
      ...(experiments !== undefined ? { experiments } : {}),
    });
    if (!createResult.success) {
      throw new Error(createResult.error);
    }

    await lifecycle?.onTaskCreated?.(createResult.data.taskId);

    return await this.waitForAgentTask(createResult.data.taskId, spec, waitOptions);
  }

  private getExperimentsForAgent(agentId: string): WorkflowTaskExperiments | undefined {
    const experiments = this.experiments;
    if (experiments == null) {
      return undefined;
    }

    if (agentId.trim().toLowerCase() !== "explore" || experiments.subagentFileReports !== true) {
      return experiments;
    }

    // Explore is intentionally read-only and cannot create report.md/structured-output.json.
    // Keep workflow Explore steps compatible when file-backed reporting is enabled globally.
    return { ...experiments, subagentFileReports: false };
  }

  async waitForAgentTask(
    taskId: string,
    _spec: WorkflowAgentSpec,
    waitOptions?: WorkflowAgentWaitOptions
  ): Promise<WorkflowAgentResult> {
    const report = await this.taskService.waitForAgentReport(taskId, {
      ...(waitOptions?.abortSignal != null ? { abortSignal: waitOptions.abortSignal } : {}),
      ...(waitOptions?.timeoutMs != null ? { timeoutMs: waitOptions.timeoutMs } : {}),
      requestingWorkspaceId: this.parentWorkspaceId,
      backgroundOnMessageQueued: waitOptions?.backgroundOnMessageQueued ?? true,
    });

    return {
      taskId,
      reportMarkdown: report.reportMarkdown,
      ...(report.title != null ? { title: report.title } : {}),
      ...(report.structuredOutput !== undefined
        ? { structuredOutput: report.structuredOutput }
        : {}),
    };
  }
}
