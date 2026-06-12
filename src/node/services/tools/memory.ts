import { tool } from "ai";
import assert from "@/common/utils/assert";
import type { MemoryToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";
import { type MemoryScope, type MemoryScopeAccess } from "@/common/constants/memory";
import type { z } from "zod";
import {
  formatMemoryIndexForToolDescription,
  parseMemoryPath,
  type MemoryScopeContext,
  type MemoryService,
} from "@/node/services/memoryService";

/** Safe default: without an explicit policy, every scope is read-only. */
const READ_ONLY_ACCESS: MemoryScopeAccess = {
  global: "read",
  project: "read",
  "project-local": "read",
  workspace: "read",
};

/**
 * Map an agent class onto the per-scope memory write matrix
 * (see MemoryScopeAccess in src/common/constants/memory.ts):
 * - Plan-like agents must not mutate the repo checkout, so project is read-only.
 *   project-local stays writable: it lives under muxHome, not the checkout.
 * - Editing-capable (exec-like) agents get read-write everywhere.
 * - Everything else (explore/read-only agents) is view-only.
 */
export function resolveMemoryAccessPolicy(options: {
  planLike: boolean;
  editingCapable: boolean;
}): MemoryScopeAccess {
  if (options.planLike) {
    return {
      global: "readwrite",
      project: "read",
      "project-local": "readwrite",
      workspace: "readwrite",
    };
  }
  if (options.editingCapable) {
    return {
      global: "readwrite",
      project: "readwrite",
      "project-local": "readwrite",
      workspace: "readwrite",
    };
  }
  return READ_ONLY_ACCESS;
}

/**
 * Build the dynamic memory tool description: the base description plus the
 * session-segment memory index (same disclosure mechanic as skills — index
 * advertised next to the tool schema, contents fetched on demand). Falls back
 * to the base description when no snapshot was resolved.
 */
function buildMemoryDescription(config: ToolConfiguration): string {
  const baseDescription = TOOL_DEFINITIONS.memory.description;
  if (config.memoryIndexEntries == null) {
    return baseDescription;
  }
  return `${baseDescription}\n\n${formatMemoryIndexForToolDescription(config.memoryIndexEntries)}`;
}

/**
 * Memory tool factory: dispatches the six Anthropic-style memory commands
 * (view, create, str_replace, insert, delete, rename) to the MemoryService.
 * Write policy is enforced per command + scope via config.memoryAccess.
 */
export const createMemoryTool: ToolFactory = (config: ToolConfiguration) => {
  const memoryService = config.memoryService;
  assert(memoryService != null, "memory tool requires config.memoryService");
  const access = config.memoryAccess ?? READ_ONLY_ACCESS;

  const ctx: MemoryScopeContext = {
    runtime: config.runtime,
    // Prefer the checkout root: on sub-project workspaces config.cwd includes
    // the sub-project segment, which would split agent project memories from
    // the UI/index/hot-set (they resolve the checkout root). null = project
    // scope disabled ("" sentinel; recoverable error in MemoryService).
    checkoutCwd:
      config.workspaceCheckoutRootPath === null
        ? ""
        : (config.workspaceCheckoutRootPath ?? config.cwd),
    workspaceId: config.workspaceId ?? "",
    // Stable project identity for sidecar logical keys (never the checkout
    // cwd). Multi-project workspaces have no single identity — their
    // workspaceProjectPath is the FIRST project's path, which must not become
    // the project-local store key — so "" disables the project-keyed scopes
    // (same resolution as resolveMemoryProjectIdentity; config.projects
    // mirrors metadata.projects via getProjects).
    projectPath: (config.projects?.length ?? 0) > 1 ? "" : (config.workspaceProjectPath ?? ""),
  };

  /**
   * Returns a recoverable error result when the (parsed) scope is read-only
   * for this agent; null when the mutation may proceed. Invalid paths fall
   * through (null) so the service produces its canonical validation error.
   */
  function checkWriteAccess(virtualPath: string): MemoryToolResult | null {
    let scope: MemoryScope | null;
    try {
      scope = parseMemoryPath(virtualPath).scope;
    } catch {
      return null;
    }
    if (scope !== null && access[scope] !== "readwrite") {
      return {
        success: false,
        error: `The ${scope} memory scope is read-only for this agent; only 'view' is allowed.`,
      };
    }
    return null;
  }

  return tool({
    description: buildMemoryDescription(config),
    inputSchema: TOOL_DEFINITIONS.memory.schema,
    execute: (input): Promise<MemoryToolResult> =>
      executeMemoryCommand(memoryService, ctx, input, checkWriteAccess),
  });
};

/** Parsed memory tool input (post-schema; shared by the tool and the consolidation runner). */
export type MemoryCommandInput = z.infer<(typeof TOOL_DEFINITIONS.memory)["schema"]>;

/**
 * Dispatch one validated memory command to the MemoryService.
 *
 * Shared by the agent memory tool (above) and the memory-consolidation
 * runner, which supplies its own `checkWriteAccess` guard (pin protection,
 * scope restriction, op budget, dry-run interception). The guard runs for
 * every mutating command with the path(s) it would touch; returning a result
 * short-circuits the dispatch.
 */
export async function executeMemoryCommand(
  memoryService: MemoryService,
  ctx: MemoryScopeContext,
  input: MemoryCommandInput,
  checkWriteAccess: (virtualPath: string) => MemoryToolResult | null
): Promise<MemoryToolResult> {
  try {
    switch (input.command) {
      case "view": {
        if (input.path == null) {
          return { success: false, error: "view requires 'path'" };
        }
        return await memoryService.view(ctx, input.path, {
          offset: input.offset ?? undefined,
          limit: input.limit ?? undefined,
        });
      }
      case "create": {
        if (input.path == null || input.file_text == null) {
          return { success: false, error: "create requires 'path' and 'file_text'" };
        }
        return (
          checkWriteAccess(input.path) ??
          (await memoryService.create(ctx, input.path, input.file_text, "agent"))
        );
      }
      case "str_replace": {
        if (input.path == null || input.old_str == null) {
          return { success: false, error: "str_replace requires 'path' and 'old_str'" };
        }
        return (
          checkWriteAccess(input.path) ??
          (await memoryService.strReplace(
            ctx,
            input.path,
            input.old_str,
            input.new_str ?? "",
            "agent"
          ))
        );
      }
      case "insert": {
        if (input.path == null || input.insert_line == null || input.insert_text == null) {
          return {
            success: false,
            error: "insert requires 'path', 'insert_line' and 'insert_text'",
          };
        }
        return (
          checkWriteAccess(input.path) ??
          (await memoryService.insert(
            ctx,
            input.path,
            input.insert_line,
            input.insert_text,
            "agent"
          ))
        );
      }
      case "delete": {
        if (input.path == null) {
          return { success: false, error: "delete requires 'path'" };
        }
        return (
          checkWriteAccess(input.path) ?? (await memoryService.deletePath(ctx, input.path, "agent"))
        );
      }
      case "rename": {
        // Accept `path` as the source for models that emit it instead of old_path.
        const oldPath = input.old_path ?? input.path;
        if (oldPath == null || input.new_path == null) {
          return { success: false, error: "rename requires 'old_path' and 'new_path'" };
        }
        return (
          checkWriteAccess(oldPath) ??
          checkWriteAccess(input.new_path) ??
          (await memoryService.rename(ctx, oldPath, input.new_path, "agent"))
        );
      }
    }
  } catch (error) {
    return { success: false, error: `Memory operation failed: ${getErrorMessage(error)}` };
  }
}
