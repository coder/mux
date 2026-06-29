import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  COMPLETED_REPORT_REFETCH_NOTE,
  WorkflowRunToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import { getErrorMessage } from "@/common/utils/errors";
import {
  emitWorkflowRunAttachedEvent,
  parseToolResult,
  recordBackgroundWorkflowRunReference,
  requireWorkspaceId,
} from "./toolUtils";
import { resolveWorkflowScript } from "@/node/services/workflows/workflowScriptResolver";

function requireWorkflowService(config: ToolConfiguration) {
  if (!config.workflowService) {
    throw new Error("workflow_run requires workflowService");
  }
  return config.workflowService;
}

function requireForegroundWorkflowStart(
  workflowService: NonNullable<ToolConfiguration["workflowService"]>
) {
  if (workflowService.startWorkflow == null) {
    throw new Error("workflow_run requires startWorkflow");
  }
  return workflowService.startWorkflow.bind(workflowService);
}

function requireBackgroundWorkflowStart(
  workflowService: NonNullable<ToolConfiguration["workflowService"]>
) {
  if (workflowService.startWorkflowInBackground == null) {
    throw new Error("workflow_run background mode requires startWorkflowInBackground");
  }
  return workflowService.startWorkflowInBackground.bind(workflowService);
}

function isBackgroundWorkflowResult(
  args: { run_in_background?: boolean | null },
  status: string
): boolean {
  return args.run_in_background === true || status === "backgrounded";
}

function isAwaitableRecoveredWorkflowStatus(status: WorkflowRunRecord["status"]): boolean {
  return status === "running" || status === "backgrounded";
}

function latestCompletedWorkflowResult(run: WorkflowRunRecord): unknown {
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const event = run.events[index];
    if (event?.type === "result") {
      return event.result;
    }
  }
  return null;
}

function workflowRunRecoveryNote(run: WorkflowRunRecord, error: unknown): string {
  const statusGuidance: Record<WorkflowRunRecord["status"], string> = {
    pending: "resume it with workflow_resume because no runner may be active yet",
    running: "await it with task_await",
    backgrounded: "await it with task_await",
    interrupted: "resume it with workflow_resume",
    failed: "use workflow_resume({ mode: 'retry_from_checkpoint' }) only if the run is eligible",
    completed: "inspect the returned durable result instead of rerunning",
  };
  return (
    `workflow_run errored after creating durable run \`${run.id}\`: ${getErrorMessage(error)}. ` +
    `The durable run is ${run.status}; ${statusGuidance[run.status]}. Do not start another copy.`
  );
}

export const createWorkflowRunTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.workflow_run.description,
    inputSchema: TOOL_DEFINITIONS.workflow_run.schema,
    execute: async (args, options): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "workflow_run");
      const workflowService = requireWorkflowService(config);
      const toolCallId = options.toolCallId;

      const script = await resolveWorkflowScript({
        scriptPath: args.script_path,
        runtime: config.runtime,
        workspacePath: config.cwd,
        projectTrusted: config.trusted === true,
        ...(config.agentSkillsRoots != null ? { roots: config.agentSkillsRoots } : {}),
      });
      const createdRun: { id: string | null } = { id: null };
      const startInput = {
        script,
        workspaceId,
        projectTrusted: config.trusted === true,
        args: args.args ?? {},
        onRunCreated: async (event: { runId: string; run: unknown }) => {
          createdRun.id = event.runId;
          await emitWorkflowRunAttachedEvent({
            config,
            workspaceId,
            toolCallId,
            runId: event.runId,
            run: event.run,
          });
        },
      };
      const invocationStartedAtMs = Date.now();
      let result: { runId: string; status: string; result: unknown };
      try {
        result =
          args.run_in_background === true
            ? await requireBackgroundWorkflowStart(workflowService)({
                ...startInput,
                // Background runs are non-blocking; terminal result is delivered by
                // AIService.onBackgroundRunTerminal rather than a forced task_await.
                attentionPolicy: "notify_on_terminal",
              })
            : await requireForegroundWorkflowStart(workflowService)({
                ...startInput,
                ...(options.abortSignal != null ? { abortSignal: options.abortSignal } : {}),
              });
      } catch (error: unknown) {
        const createdRunId = createdRun.id;
        if (createdRunId == null) {
          throw error;
        }
        if (workflowService.getRun == null) {
          throw new Error(
            `${getErrorMessage(error)} (workflow_run created durable run ${createdRunId} before failing)`
          );
        }

        const durableRun = await workflowService.getRun({ workspaceId, runId: createdRunId });
        const parsedRun = WorkflowRunRecordSchema.safeParse(durableRun);
        if (!parsedRun.success) {
          throw new Error(
            `${getErrorMessage(error)} (workflow_run created durable run ${createdRunId}, but the run could not be fetched or parsed)`
          );
        }

        const run = parsedRun.data;
        if (isAwaitableRecoveredWorkflowStatus(run.status)) {
          await recordBackgroundWorkflowRunReference(config, run.id, invocationStartedAtMs);
        }

        return parseToolResult(
          WorkflowRunToolResultSchema,
          {
            status: run.status,
            runId: run.id,
            result: run.status === "completed" ? latestCompletedWorkflowResult(run) : null,
            run,
            note: workflowRunRecoveryNote(run, error),
          },
          "workflow_run"
        );
      }

      if (isBackgroundWorkflowResult(args, result.status)) {
        await recordBackgroundWorkflowRunReference(config, result.runId, invocationStartedAtMs);
      }

      const run = await workflowService.getRun?.({ workspaceId, runId: result.runId });

      return parseToolResult(
        WorkflowRunToolResultSchema,
        {
          status: result.status,
          runId: result.runId,
          result: result.result,
          ...(run != null ? { run } : {}),
          ...(result.status === "completed" ? { note: COMPLETED_REPORT_REFETCH_NOTE } : {}),
        },
        "workflow_run"
      );
    },
  });
};
