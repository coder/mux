import { z } from "zod";
import { MEMORY_SCOPES } from "@/common/constants/memory";

/**
 * Schemas for the Memory tab oRPC surface (experiment: "memory").
 * Paths are always virtual (/memories/<scope>/...); the backend MemoryService
 * owns the physical mapping and the security envelope.
 */

export const MemoryScopeSchema = z.enum(MEMORY_SCOPES);

export const MemoryActorSchema = z.enum(["agent", "user"]);

/** One memory file in the bulk list (all scopes, one IPC call). */
export const MemoryFileInfoSchema = z.object({
  /** Virtual path (e.g. /memories/global/prefs.md). */
  path: z.string(),
  scope: MemoryScopeSchema,
  /** Sanitized single-line frontmatter description (may be empty). */
  description: z.string(),
  /** User pin state from the host-local sidecar (never stored in the file). */
  pinned: z.boolean(),
  /** Recorded uses (reads, writes, pins) from the host-local sidecar. */
  accessCount: z.number(),
  /** Timestamp of the most recent use; null when never used. */
  lastAccessedAt: z.number().nullable(),
});
export type MemoryFileInfo = z.infer<typeof MemoryFileInfoSchema>;

/** Change event emitted by the MemoryService (agent tool + UI writes). */
export const MemoryChangeEventSchema = z.object({
  scope: MemoryScopeSchema,
  /** Virtual path of the changed file or directory. */
  path: z.string(),
  actor: MemoryActorSchema,
  /** Workspace whose scope context performed the change. */
  workspaceId: z.string(),
  /** Stable project identity of the emitting scope context. */
  projectPath: z.string(),
});

/**
 * Save failures distinguish conflicts (sha precondition failed; the UI shows
 * a conflict banner and offers reload) from plain errors.
 */
export const MemorySaveErrorSchema = z.object({
  kind: z.enum(["conflict", "error"]),
  message: z.string(),
});
export type MemorySaveError = z.infer<typeof MemorySaveErrorSchema>;
