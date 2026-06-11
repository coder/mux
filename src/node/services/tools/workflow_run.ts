import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  COMPLETED_REPORT_REFETCH_NOTE,
  WorkflowRunToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import {
  parseToolResult,
  recordBackgroundWorkflowRunReference,
  requireWorkspaceId,
} from "./toolUtils";

function requireWorkflowService(config: ToolConfiguration) {
  if (!config.workflowService) {
    throw new Error("workflow_run requires workflowService");
  }
  return config.workflowService;
}

function requireBackgroundWorkflowStart(
  workflowService: NonNullable<ToolConfiguration["workflowService"]>
) {
  if (workflowService.startNamedWorkflowInBackground == null) {
    throw new Error("workflow_run background mode requires startNamedWorkflowInBackground");
  }
  return workflowService.startNamedWorkflowInBackground.bind(workflowService);
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

      const startInput = {
        name: args.name,
        workspaceId,
        projectTrusted: config.trusted === true,
        args: args.args ?? {},
      };
      const invocationStartedAtMs = Date.now();
      const result =
        args.run_in_background === true
          ? await requireBackgroundWorkflowStart(workflowService)(startInput)
          : await workflowService.startNamedWorkflow({
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
