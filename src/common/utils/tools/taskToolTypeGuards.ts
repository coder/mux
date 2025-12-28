import type { TaskToolArgs } from "@/common/types/tools";

export type TaskBashArgs = TaskToolArgs & {
  kind: "bash";
  script: string;
  timeout_secs: number;
  display_name?: string;
};

export function isTaskBashArgs(args: TaskToolArgs): args is TaskBashArgs {
  return (
    args.kind === "bash" && typeof args.script === "string" && typeof args.timeout_secs === "number"
  );
}

export function isTaskBashArgsFromUnknown(value: unknown): value is TaskBashArgs {
  return (
    Boolean(value && typeof value === "object") &&
    (value as { kind?: unknown }).kind === "bash" &&
    typeof (value as { script?: unknown }).script === "string" &&
    typeof (value as { timeout_secs?: unknown }).timeout_secs === "number"
  );
}
