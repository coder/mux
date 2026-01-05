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

  const success = (value as { success?: unknown }).success;
  if (typeof success !== "boolean") {
    return null;
  }

  if (success) {
    const output = (value as { output?: unknown }).output;
    const exitCode = (value as { exitCode?: unknown }).exitCode;
    const wallDurationMs = (value as { wall_duration_ms?: unknown }).wall_duration_ms;

    if (typeof output !== "string") {
      return null;
    }

    if (exitCode !== 0) {
      return null;
    }

    if (typeof wallDurationMs !== "number" || !Number.isFinite(wallDurationMs)) {
      return null;
    }

    // Background spawn success includes taskId/backgroundProcessId.
    // Older histories sometimes stored only one of these fields, so we derive the
    // other when possible.
    const taskIdRaw = (value as { taskId?: unknown }).taskId;
    const backgroundProcessIdRaw = (value as { backgroundProcessId?: unknown }).backgroundProcessId;

    if (taskIdRaw === undefined && backgroundProcessIdRaw === undefined) {
      return value as BashToolResult;
    }

    if (typeof taskIdRaw === "string" && typeof backgroundProcessIdRaw === "string") {
      return value as BashToolResult;
    }

    if (typeof backgroundProcessIdRaw === "string" && taskIdRaw === undefined) {
      const processId = backgroundProcessIdRaw.trim();
      if (processId.length === 0) {
        return null;
      }

      const derived: BashToolResult = {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: wallDurationMs,
        taskId: `${BASH_TASK_ID_PREFIX}${processId}`,
        backgroundProcessId: processId,
      };

      return derived;
    }

    if (typeof taskIdRaw === "string" && backgroundProcessIdRaw === undefined) {
      const processId = fromBashTaskId(taskIdRaw);
      if (!processId) {
        return null;
      }

      const derived: BashToolResult = {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: wallDurationMs,
        taskId: taskIdRaw,
        backgroundProcessId: processId,
      };

      return derived;
    }

    return null;
  }

  const error = (value as { error?: unknown }).error;
  const exitCode = (value as { exitCode?: unknown }).exitCode;
  const wallDurationMs = (value as { wall_duration_ms?: unknown }).wall_duration_ms;
  const output = (value as { output?: unknown }).output;

  if (typeof error !== "string") {
    return null;
  }

  if (typeof exitCode !== "number" || !Number.isFinite(exitCode)) {
    return null;
  }

  if (typeof wallDurationMs !== "number" || !Number.isFinite(wallDurationMs)) {
    return null;
  }

  if (output !== undefined && typeof output !== "string") {
    return null;
  }

  return value as BashToolResult;
}

function maybeApplyLegacySuccessCheck(
  bashResult: BashToolResult,
  options?: { legacySuccessCheckInclErrorLine?: boolean }
): BashToolResult {
  if (!options?.legacySuccessCheckInclErrorLine) {
    return bashResult;
  }

  if (!bashResult.success) {
    return bashResult;
  }

  // Don't drop background task identifiers.
  if ("taskId" in bashResult) {
    return bashResult;
  }

  const lines = bashResult.output.split(/\r?\n/).map((line) => line.trim());
  const errorLine = lines.find((line) => /^error:/i.test(line));
  if (!errorLine) {
    return bashResult;
  }

  return {
    success: false,
    error: errorLine,
    exitCode: 1,
    wall_duration_ms: bashResult.wall_duration_ms,
    output: bashResult.output,
    truncated: "truncated" in bashResult ? bashResult.truncated : undefined,
    note: "note" in bashResult ? bashResult.note : undefined,
  };
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
    return maybeApplyLegacySuccessCheck(maybeDirect, options);
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
    // Legacy `task(kind="bash")` results sometimes store a nested bash result or explicit
    // exit/error fields. Preserve them so old histories don't render failures as successes.
    const nestedRaw =
      (taskResult as { result?: unknown; bashResult?: unknown }).result ??
      (taskResult as { bashResult?: unknown }).bashResult;

    const nested = coerceBashToolResult(nestedRaw);
    if (nested) {
      return maybeApplyLegacySuccessCheck(nested, options);
    }

    const exitCodeRaw = (taskResult as { exitCode?: unknown }).exitCode;
    const exitCode =
      typeof exitCodeRaw === "number" && Number.isFinite(exitCodeRaw) ? exitCodeRaw : undefined;

    const errorRaw = (taskResult as { error?: unknown }).error;
    const error = typeof errorRaw === "string" ? errorRaw : undefined;

    const wallDurationRaw = (taskResult as { wall_duration_ms?: unknown }).wall_duration_ms;
    const wall_duration_ms =
      typeof wallDurationRaw === "number" && Number.isFinite(wallDurationRaw) ? wallDurationRaw : 0;

    const outputRaw = (taskResult as { output?: unknown }).output;
    const reportMarkdown = (taskResult as { reportMarkdown?: unknown }).reportMarkdown;
    const title = (taskResult as { title?: unknown }).title;

    const output =
      typeof outputRaw === "string"
        ? outputRaw
        : typeof reportMarkdown === "string" && reportMarkdown.trim().length > 0
          ? reportMarkdown
          : typeof title === "string"
            ? title
            : "";

    if (exitCode !== undefined && exitCode !== 0) {
      return {
        success: false,
        error: error?.trim().length ? error : `Command failed with exit code ${exitCode}`,
        exitCode,
        wall_duration_ms,
        output: output.trim().length ? output : undefined,
      };
    }

    if (error?.trim().length) {
      return {
        success: false,
        error,
        exitCode: exitCode ?? 1,
        wall_duration_ms,
        output: output.trim().length ? output : undefined,
      };
    }

    return maybeApplyLegacySuccessCheck(
      {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms,
      },
      options
    );
  }

  return null;
}
