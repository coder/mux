import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  COMPLETED_REPORT_REFETCH_NOTE,
  WorkflowRunToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
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
      });
      const startInput = {
        script,
        workspaceId,
        projectTrusted: config.trusted === true,
        args: args.args ?? {},
        onRunCreated: async (event: { runId: string; run: unknown }) => {
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
      const result =
        args.run_in_background === true
          ? await requireBackgroundWorkflowStart(workflowService)(startInput)
          : await requireForegroundWorkflowStart(workflowService)({
              ...startInput,
              ...(options.abortSignal != null ? { abortSignal: options.abortSignal } : {}),
            });

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
