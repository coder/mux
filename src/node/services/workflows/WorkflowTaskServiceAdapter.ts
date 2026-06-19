import type { ParsedThinkingInput } from "@/common/types/thinking";
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
  workspaceHeartbeats?: boolean;
  dynamicWorkflows?: boolean;
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
      workflowName?: string;
      outputSchema?: unknown;
    };
    experiments?: WorkflowTaskExperiments;
    modelString?: string;
    thinkingLevel?: ParsedThinkingInput;
  }): Promise<{ success: true; data: TaskCreateResult } | { success: false; error: string }>;
  createMany?(
    args: Array<{
      parentWorkspaceId: string;
      kind: "agent";
      agentId: string;
      prompt: string;
      title: string;
      workflowTask: {
        runId: string;
        stepId: string;
        workflowName?: string;
        outputSchema?: unknown;
      };
      experiments?: WorkflowTaskExperiments;
      modelString?: string;
      thinkingLevel?: ParsedThinkingInput;
    }>,
    options?: {
      onTaskReserved?: (index: number, result: TaskCreateResult) => Promise<void> | void;
    }
  ): Promise<{ success: true; data: TaskCreateResult[] } | { success: false; error: string }>;
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
  markWorkflowRunEnded?(workflowRunId: string): Promise<void>;
}

type WorkflowPatchArtifactApplier = (
  args: TaskApplyGitPatchArgs,
  options?: { abortSignal?: AbortSignal }
) => Promise<TaskApplyGitPatchResult>;

export interface WorkflowTaskServiceAdapterOptions {
  taskService: WorkflowTaskServiceLike;
  parentWorkspaceId: string;
  workflowRunId: string;
  /**
   * Human-readable workflow definition name, stamped onto spawned tasks so the
   * sidebar can label workflow run groups. Optional: interrupt-only adapters
   * and legacy call sites may not know the name.
   */
  workflowName?: string;
  defaultAgentId: string;
  experiments?: WorkflowTaskExperiments;
  modelString?: string;
  thinkingLevel?: ParsedThinkingInput;
  patchToolConfig?: TaskApplyGitPatchConfiguration;
  applyPatchArtifact?: WorkflowPatchArtifactApplier;
  getProjectTrusted?: () => boolean | Promise<boolean>;
}

export class WorkflowTaskServiceAdapter implements WorkflowTaskAdapter {
  private readonly taskService: WorkflowTaskServiceLike;
  private readonly parentWorkspaceId: string;
  private readonly workflowRunId: string;
  private readonly workflowName?: string;
  private readonly defaultAgentId: string;
  private readonly patchToolConfig?: TaskApplyGitPatchConfiguration;
  private readonly applyPatchArtifact?: WorkflowPatchArtifactApplier;
  private readonly getProjectTrusted?: () => boolean | Promise<boolean>;
  private readonly patchApplyMutex = new AsyncMutex();
  private readonly experiments?: WorkflowTaskExperiments;
  private readonly modelString?: string;
  private readonly thinkingLevel?: ParsedThinkingInput;

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
    this.workflowName = options.workflowName;
    this.defaultAgentId = options.defaultAgentId;
    this.patchToolConfig = options.patchToolConfig;
    this.applyPatchArtifact = options.applyPatchArtifact;
    this.getProjectTrusted = options.getProjectTrusted;
    this.experiments = options.experiments;
    this.modelString = options.modelString;
    this.thinkingLevel = options.thinkingLevel;
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

  async onRunEnded(): Promise<void> {
    await this.taskService.markWorkflowRunEnded?.(this.workflowRunId);
  }

  async createAgentTasks(
    specs: WorkflowAgentSpec[],
    lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
  ): Promise<Array<{ taskId: string; status: "queued" | "starting" | "running" }>> {
    assert(specs.length > 0, "WorkflowTaskServiceAdapter.createAgentTasks: specs are required");
    if (this.taskService.createMany == null) {
      const created: Array<{ taskId: string; status: "queued" | "starting" | "running" }> = [];
      for (const [index, spec] of specs.entries()) {
        const createResult = await this.taskService.create(this.buildCreateArgs(spec));
        if (!createResult.success) {
          throw new Error(createResult.error);
        }
        assert(createResult.data.taskId.length > 0, "createAgentTasks: taskId is required");
        await lifecycle?.onTaskCreated?.(index, createResult.data.taskId);
        created.push({ taskId: createResult.data.taskId, status: createResult.data.status });
      }
      return created;
    }

    const createResult = await this.taskService.createMany(
      specs.map((spec) => this.buildCreateArgs(spec)),
      {
        onTaskReserved: async (index, result) => {
          assert(result.taskId.length > 0, "createAgentTasks: taskId is required");
          await lifecycle?.onTaskCreated?.(index, result.taskId);
        },
      }
    );
    if (!createResult.success) {
      throw new Error(createResult.error);
    }
    if (createResult.data.length !== specs.length) {
      throw new Error("WorkflowTaskServiceAdapter.createAgentTasks: result length mismatch");
    }

    const created: Array<{ taskId: string; status: "queued" | "starting" | "running" }> = [];
    for (const result of createResult.data) {
      assert(result.taskId.length > 0, "createAgentTasks: taskId is required");
      created.push({ taskId: result.taskId, status: result.status });
    }
    return created;
  }

  private buildCreateArgs(
    spec: WorkflowAgentSpec
  ): Parameters<WorkflowTaskServiceLike["create"]>[0] {
    assert(spec.id.length > 0, "WorkflowTaskServiceAdapter: spec.id is required");
    assert(spec.prompt.length > 0, "WorkflowTaskServiceAdapter: spec.prompt is required");

    const workflowTask: {
      runId: string;
      stepId: string;
      workflowName?: string;
      outputSchema?: unknown;
    } = {
      runId: this.workflowRunId,
      stepId: spec.id,
    };
    if (this.workflowName !== undefined) {
      workflowTask.workflowName = this.workflowName;
    }
    if (spec.outputSchema !== undefined) {
      workflowTask.outputSchema = spec.outputSchema;
    }

    const agentId = spec.agentId ?? this.defaultAgentId;
    return {
      parentWorkspaceId: this.parentWorkspaceId,
      kind: "agent",
      agentId,
      prompt: spec.prompt,
      title: spec.title ?? spec.id,
      workflowTask,
      ...(this.experiments !== undefined ? { experiments: this.experiments } : {}),
      ...(this.modelString !== undefined ? { modelString: this.modelString } : {}),
      ...(this.thinkingLevel !== undefined ? { thinkingLevel: this.thinkingLevel } : {}),
      // Refusal policy must survive both the single-step and parallel
      // (createAgentTasks) paths: a verifier step marked onRefusal: "fail"
      // must fail honestly instead of silently continuing on a fallback model.
      ...(spec.onRefusal !== undefined ? { onRefusal: spec.onRefusal } : {}),
    };
  }

  async runAgent(
    spec: WorkflowAgentSpec,
    lifecycle?: { onTaskCreated?: (taskId: string) => Promise<void> | void },
    waitOptions?: WorkflowAgentWaitOptions
  ): Promise<WorkflowAgentResult> {
    assert(spec.id.length > 0, "WorkflowTaskServiceAdapter.runAgent: spec.id is required");
    assert(spec.prompt.length > 0, "WorkflowTaskServiceAdapter.runAgent: spec.prompt is required");

    const createResult = await this.taskService.create(this.buildCreateArgs(spec));
    if (!createResult.success) {
      throw new Error(createResult.error);
    }

    await lifecycle?.onTaskCreated?.(createResult.data.taskId);

    return await this.waitForAgentTask(createResult.data.taskId, spec, waitOptions);
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
