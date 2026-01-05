// Shared type guards for tool argument shapes.
//
// NOTE: The `task` tool is agent-only today, but older chat histories may contain
// legacy `task(kind="bash")` calls. Keep these helpers in `src/common` so both the
// desktop and mobile renderers can detect those shapes without importing node-only code.

export interface TaskBashArgs {
  kind: "bash";
  script: string;
  timeout_secs: number;
  run_in_background?: boolean;
  display_name?: string;
}

export function isTaskBashArgsFromUnknown(value: unknown): value is TaskBashArgs {
  if (!value || typeof value !== "object") {
    return false;
  }

  const args = value as Partial<TaskBashArgs>;

  if (args.kind !== "bash") {
    return false;
  }

  if (typeof args.script !== "string" || args.script.trim().length === 0) {
    return false;
  }

  if (typeof args.timeout_secs !== "number" || !Number.isFinite(args.timeout_secs)) {
    return false;
  }

  if (args.run_in_background !== undefined && typeof args.run_in_background !== "boolean") {
    return false;
  }

  if (args.display_name !== undefined && typeof args.display_name !== "string") {
    return false;
  }

  return true;
}

export function isTaskBashArgs(value: unknown): value is TaskBashArgs {
  return isTaskBashArgsFromUnknown(value);
}
