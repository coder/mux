import type { BashToolResult } from "@/common/types/tools";

interface TruncatedInfo {
  reason: string;
  totalLines: number;
}

const BASH_TASK_ID_PREFIX = "bash:";

export interface ConvertTaskBashResultOptions {
  /**
   * Legacy markdown parsing fallback: treat an `error:` line as failure even when exitCode===0.
   *
   * - Desktop historically used exitCode only.
   * - Mobile historically treated `error:` lines as authoritative.
   */
  legacySuccessCheckInclErrorLine?: boolean;
}

export function isBashToolResult(value: unknown): value is BashToolResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "success" in value &&
    typeof (value as { success?: unknown }).success === "boolean"
  );
}

export function coerceBashToolResult(value: unknown): BashToolResult | null {
  return isBashToolResult(value) ? value : null;
}

export function convertTaskBashResult(
  result: unknown,
  options?: ConvertTaskBashResultOptions
): BashToolResult | null {
  if (!result) return null;
  if (typeof result !== "object") return null;

  // Some tool failures may still return a { success: false, error } shape.
  if ("success" in result) {
    const success = (result as { success?: unknown }).success;
    if (success === false) {
      const error = (result as { error?: unknown }).error;
      return {
        success: false,
        error: typeof error === "string" ? error : "Task failed",
        exitCode: -1,
        wall_duration_ms: 0,
      };
    }
  }

  const status = (result as { status?: unknown }).status;
  if (typeof status !== "string") {
    return null;
  }

  // Newer task(kind="bash") results include the raw bash tool result directly.
  // Prefer that over parsing reportMarkdown.
  const structuredBashResult = coerceBashToolResult(
    (result as { bashResult?: unknown }).bashResult
  );
  if (structuredBashResult) {
    return structuredBashResult;
  }

  // Background bash tasks return early with status!=completed and taskId=bash:<processId>.
  if (status !== "completed") {
    const taskId = (result as { taskId?: unknown }).taskId;
    if (typeof taskId === "string" && taskId.startsWith(BASH_TASK_ID_PREFIX)) {
      const processId = taskId.slice(BASH_TASK_ID_PREFIX.length).trim() || taskId;
      return {
        success: true,
        output: "",
        exitCode: 0,
        wall_duration_ms: 0,
        backgroundProcessId: processId,
      };
    }
    return null;
  }

  // Legacy fallback for older sessions that only persisted reportMarkdown.
  const reportMarkdown =
    typeof (result as { reportMarkdown?: unknown }).reportMarkdown === "string"
      ? ((result as { reportMarkdown: string }).reportMarkdown ?? "")
      : "";

  const note =
    typeof (result as { note?: unknown }).note === "string"
      ? (result as { note: string }).note
      : undefined;
  const truncatedValue = (result as { truncated?: unknown }).truncated;
  const truncated =
    truncatedValue !== null && typeof truncatedValue === "object"
      ? (truncatedValue as TruncatedInfo)
      : undefined;

  const wallDurationMatch = /wall_duration_ms:\s*(\d+)/.exec(reportMarkdown);
  const parsedWallDuration = wallDurationMatch ? Number(wallDurationMatch[1]) : undefined;
  const wall_duration_ms = Number.isFinite(parsedWallDuration) ? parsedWallDuration! : 0;

  const textBlockMatch = /```text\n([\s\S]*?)\n```/.exec(reportMarkdown);
  const output = textBlockMatch ? textBlockMatch[1] : "";

  const errorLineMatch = /^error:\s*(.*)$/m.exec(reportMarkdown);
  const errorFromMarkdown = errorLineMatch?.[1];

  const rawExplicitExitCode = (result as { exitCode?: unknown }).exitCode;
  const explicitExitCode =
    typeof rawExplicitExitCode === "number" && Number.isFinite(rawExplicitExitCode)
      ? rawExplicitExitCode
      : undefined;

  const exitCodeLineMatch = /^exitCode:\s*(.*)$/m.exec(reportMarkdown);
  const rawExitCodeFromMarkdown = exitCodeLineMatch ? exitCodeLineMatch[1].trim() : undefined;

  let exitCode: number;
  if (explicitExitCode !== undefined) {
    exitCode = explicitExitCode;
  } else if (rawExitCodeFromMarkdown !== undefined) {
    if (!/^-?\d+$/.test(rawExitCodeFromMarkdown)) {
      return {
        success: false,
        output: output.length > 0 ? output : undefined,
        exitCode: -1,
        error:
          errorFromMarkdown ??
          `Failed to parse exitCode from legacy reportMarkdown: ${rawExitCodeFromMarkdown}`,
        wall_duration_ms,
        note,
        truncated,
      };
    }
    exitCode = Number(rawExitCodeFromMarkdown);
  } else {
    exitCode = 0;
  }

  const error = errorFromMarkdown ?? `Command exited with code ${exitCode}`;

  const legacyTreatErrorLineAsFailure = options?.legacySuccessCheckInclErrorLine ?? false;
  const isSuccess = legacyTreatErrorLineAsFailure
    ? exitCode === 0 && !errorLineMatch
    : exitCode === 0;

  if (isSuccess) {
    return {
      success: true,
      output,
      exitCode: 0,
      wall_duration_ms,
      note,
      truncated,
    };
  }

  return {
    success: false,
    output: output.length > 0 ? output : undefined,
    exitCode,
    error,
    wall_duration_ms,
    note,
    truncated,
  };
}
