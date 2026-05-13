export const CONTEXT_BOUNDARY_KINDS = {
  COMPACTION: "compaction",
  RESET: "reset",
} as const;

export type ContextBoundaryKind =
  (typeof CONTEXT_BOUNDARY_KINDS)[keyof typeof CONTEXT_BOUNDARY_KINDS];

export type PersistedContextBoundaryKind = typeof CONTEXT_BOUNDARY_KINDS.RESET;
