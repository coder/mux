export const CODER_ARCHIVE_BEHAVIORS = ["keep", "stop", "delete"] as const;

export type CoderWorkspaceArchiveBehavior = (typeof CODER_ARCHIVE_BEHAVIORS)[number];

export const DEFAULT_CODER_ARCHIVE_BEHAVIOR: CoderWorkspaceArchiveBehavior = "stop";

export function isCoderWorkspaceArchiveBehavior(
  value: unknown
): value is CoderWorkspaceArchiveBehavior {
  return (
    typeof value === "string" &&
    CODER_ARCHIVE_BEHAVIORS.includes(value as CoderWorkspaceArchiveBehavior)
  );
}
