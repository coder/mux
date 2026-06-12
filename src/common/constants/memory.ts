/**
 * Agent Memory constants (experiment: "memory").
 *
 * Models only ever see virtual paths under the virtual root (e.g.
 * /memories/global/preferences.md). The MemoryService maps each scope to a
 * physical root:
 * - global    -> <muxHome>/memory/ (host-local, permanent, shared across projects)
 * - project   -> <workspace checkout>/.mux/memory/ (via Runtime, git-tracked)
 * - workspace -> <sessionDir>/memory/ (host-local, deleted with the workspace)
 */

/** Virtual root prefix all memory paths are expressed under. */
export const MEMORY_VIRTUAL_ROOT = "/memories";

export const MEMORY_SCOPES = ["global", "project", "workspace"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export type MemoryAccessLevel = "read" | "readwrite";

/**
 * Per-scope write policy for the memory tool, derived from the agent class:
 * - Exec-like (editing-capable): all scopes read-write.
 * - Plan-like: project scope read-only (project memories are git-tracked files
 *   in the checkout; plan agents must not mutate the repo).
 * - Explore/read-only: all scopes read-only (view only).
 */
export type MemoryScopeAccess = Record<MemoryScope, MemoryAccessLevel>;

/** Maximum size of a single memory file (bytes). */
export const MEMORY_MAX_FILE_BYTES = 100 * 1024;

/** Maximum number of files per scope. */
export const MEMORY_MAX_FILES_PER_SCOPE = 1000;

/**
 * Maximum length of a memory file's one-line description in the injected
 * memory index (frontmatter `description`, truncated for prompt budget and
 * index hardening).
 */
export const MEMORY_INDEX_DESCRIPTION_MAX_CHARS = 200;

/**
 * Bytes read from the head of each file when building the memory index.
 * Committed project memories bypass MemoryService write caps, so index builds
 * must never fully read arbitrarily large files; the frontmatter description
 * must start within this prefix or it degrades to "" (file stays listed).
 */
export const MEMORY_INDEX_DESCRIPTION_PREFIX_BYTES = 4 * 1024;

/** Directory listing depth for `view` on a directory (per Anthropic memory-tool semantics). */
export const MEMORY_VIEW_MAX_DEPTH = 2;

/**
 * Hot-set budgets: user-pinned + frequently-used memory files are preloaded
 * into context (the second tier between the always-present index and
 * tool-call cold reads). The hot set is recomputed only at session start and
 * compaction boundaries so its bytes stay prompt-cache-stable within a
 * session segment.
 */
/** Maximum bytes of a single preloaded memory file (longer files are truncated). */
export const MEMORY_HOT_SET_MAX_ITEM_BYTES = 16 * 1024;
/** Maximum total bytes of preloaded memory content per session segment. */
export const MEMORY_HOT_SET_MAX_TOTAL_BYTES = 48 * 1024;
/** Half-life of the recency decay applied to access counts when ranking auto-hot files. */
export const MEMORY_HOT_SET_DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
