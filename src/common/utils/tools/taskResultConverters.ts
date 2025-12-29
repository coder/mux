// Shared helpers for coercing / converting tool results.
//
// These are primarily used by the mobile renderer, which needs to display tool calls
// that may have been produced by older Mux versions.

import type { BashToolResult, TaskToolResult } from "@/common/types/tools";

const BASH_TASK_ID_PREFIX = "bash:";

function fromBashTaskId(taskId: string): string | null {
  if (typeof taskId !== "string") {
    return null;
  }

  if (!taskId.startsWith(BASH_TASK_ID_PREFIX)) {
    return null;
  }

  const processId = taskId.slice(BASH_TASK_ID_PREFIX.length).trim();
  return processId.length > 0 ? processId : null;
}

export function coerceBashToolResult(value: unknown): BashToolResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (typeof (value as { success?: unknown }).success !== "boolean") {
    return null;
  }

  return value as BashToolResult;
}

export function convertTaskBashResult(
  taskResult: TaskToolResult | null,
  options?: { legacySuccessCheckInclErrorLine?: boolean }
): BashToolResult | null {
  if (!taskResult || typeof taskResult !== "object") {
    return null;
  }

  // Some historical `task(kind="bash")` tool calls stored the raw BashToolResult.
  const maybeDirect = coerceBashToolResult(taskResult);
  if (maybeDirect) {
    if (options?.legacySuccessCheckInclErrorLine && maybeDirect.success) {
      const lines = maybeDirect.output.split(/\r?\n/).map((line) => line.trim());
      const errorLine = lines.find((line) => /^error:/i.test(line));
      if (errorLine) {
        return {
          success: false,
          error: errorLine,
          exitCode: 1,
          wall_duration_ms: maybeDirect.wall_duration_ms,
          output: maybeDirect.output,
        };
      }
    }

    return maybeDirect;
  }

  // Task tool error shape: { success: false, error }
  if ((taskResult as { success?: unknown }).success === false) {
    const error = (taskResult as { error?: unknown }).error;
    return {
      success: false,
      error: typeof error === "string" ? error : "Task failed",
      exitCode: -1,
      wall_duration_ms: 0,
    };
  }

  // Task tool success shapes: { status: "queued"|"running"|"completed", ... }
  const status = (taskResult as { status?: unknown }).status;
  if (typeof status !== "string") {
    return null;
  }

  if (status === "queued" || status === "running") {
    const taskId = (taskResult as { taskId?: unknown }).taskId;
    if (typeof taskId !== "string") {
      return null;
    }

    const processId = fromBashTaskId(taskId);
    if (!processId) {
      return null;
    }

    return {
      success: true,
      output: `Background process started with ID: ${processId}`,
      exitCode: 0,
      wall_duration_ms: 0,
      taskId,
      backgroundProcessId: processId,
    };
  }

  if (status === "completed") {
    const reportMarkdown = (taskResult as { reportMarkdown?: unknown }).reportMarkdown;
    const title = (taskResult as { title?: unknown }).title;

    const output =
      typeof reportMarkdown === "string" && reportMarkdown.trim().length > 0
        ? reportMarkdown
        : typeof title === "string"
          ? title
          : "";

    return {
      success: true,
      output,
      exitCode: 0,
      wall_duration_ms: 0,
    };
  }

  return null;
}
