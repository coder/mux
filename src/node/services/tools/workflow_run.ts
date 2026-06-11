import { tool } from "ai";

import { getErrorMessage } from "@/common/utils/errors";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { log } from "@/node/services/log";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import {
  COMPLETED_REPORT_REFETCH_NOTE,
  WorkflowRunToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import { parseToolResult, requireWorkspaceId } from "./toolUtils";

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

async function recordBackgroundWorkflowRun(
  config: ToolConfiguration,
  runId: string,
  createdAtMs: number
): Promise<void> {
  const workspaceSessionDir = config.workspaceSessionDir;
  if (workspaceSessionDir == null || workspaceSessionDir.length === 0) {
    log.warn("Skipping agent workflow run reference without workspace session dir", { runId });
    return;
  }

  try {
    await recordAgentWorkflowRunReference({ workspaceSessionDir, runId, createdAtMs });
  } catch (error: unknown) {
    // History scanning is still a best-effort fallback for the current context epoch; failing the
    // tool here would strand a workflow that already started successfully.
    log.warn("Failed to record agent workflow run reference", {
      runId,
      error: getErrorMessage(error),
    });
  }
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
        await recordBackgroundWorkflowRun(config, result.runId, invocationStartedAtMs);
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
