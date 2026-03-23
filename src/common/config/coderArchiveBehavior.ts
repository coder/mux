export const CODER_ARCHIVE_BEHAVIORS = ["keep", "stop", "delete"] as const;

export type CoderWorkspaceArchiveBehavior = (typeof CODER_ARCHIVE_BEHAVIORS)[number];

export const DEFAULT_CODER_ARCHIVE_BEHAVIOR: CoderWorkspaceArchiveBehavior = "stop";
