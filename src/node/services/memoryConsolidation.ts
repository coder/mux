/**
 * Memory-consolidation runner — the "dream" agent (issue #3534).
 *
 * Deep module: given a model + scope context, runs a headless agent loop
 * (direct streamText, same seam as workspaceTitleGenerator — no StreamManager,
 * no chat history, no UI events) whose only tool is a guarded memory tool.
 *
 * Rails live HERE in code, not in the agent prompt:
 * - scope restriction: v1 consolidates workspace + global only (host-local,
 *   runtime-independent); project-scope mutations are rejected
 * - pin protection: pinned files may be edited, never deleted or renamed —
 *   including via a delete/rename of an ancestor directory (subtree check)
 * - op budget: at most MEMORY_CONSOLIDATION_OP_BUDGET mutating commands per
 *   run (reads unlimited). Budget is consumed by accepted mutations only
 *   (applied, dry-run, and dispatch failures); guard rejections do not
 *   consume it — runaway retries are bounded by the step ceiling instead.
 * - dry-run: mutations are journaled as proposed but not applied
 *
 * Every mutating command is journaled ({command, path, applied, rejected})
 * for the audit trail that feeds the Memory tab's "last consolidated" line.
 * Global-scope writes are intentionally permitted (merging into global files
 * is core consolidation work); they remain auditable in the journal via the
 * /memories/global/ path prefix.
 *
 * TODO(#3534, phase 2): net-shrink enforcement needs a byte-size API on
 * MemoryService; until then the journal is the only post-run signal.
 */
import { tool, streamText, stepCountIs, type LanguageModel, type Tool } from "ai";

import assert from "@/common/utils/assert";
import {
  MEMORY_CONSOLIDATION_MAX_STEPS,
  MEMORY_CONSOLIDATION_OP_BUDGET,
} from "@/common/constants/memory";
import type { MemoryToolResult } from "@/common/types/tools";
import type { MemoryConsolidationOp } from "@/common/orpc/schemas/memory";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";
import { memoryLogicalKey, type MemoryMetaService } from "@/node/services/memoryMeta";
import { parseMemoryPath, type MemoryScopeContext } from "@/node/services/memoryService";
import type { MemoryService } from "@/node/services/memoryService";
import { executeMemoryCommand, type MemoryCommandInput } from "@/node/services/tools/memory";

// Re-exported for journal consumers; defined next to the oRPC schema so the
// wire shape and the node shape can never drift (z.infer single source).
export type { MemoryConsolidationOp };

export interface MemoryConsolidationResult {
  ops: MemoryConsolidationOp[];
  /** The model's one-line closing summary (best-effort). */
  summary: string;
  budgetExhausted: boolean;
  /** Token cost of the run; undefined when the provider reported none. */
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * Fatal stream error (provider failure or abort/timeout). When set, the
   * pass did NOT complete — callers must not treat the memory state as
   * consolidated (no journal record, no debounce anchor).
   */
  streamError?: string;
}

interface MutationTarget {
  command: MemoryConsolidationOp["command"];
  path: string;
  newPath?: string;
}

/** Classify a memory command: mutation target paths, or null for reads. */
function classifyMutation(input: MemoryCommandInput): MutationTarget | null {
  switch (input.command) {
    case "view":
      return null;
    case "rename": {
      const oldPath = input.old_path ?? input.path;
      // Missing args fall through to executeMemoryCommand's validation errors.
      if (oldPath == null || input.new_path == null) return null;
      return { command: "rename", path: oldPath, newPath: input.new_path };
    }
    default:
      if (input.path == null) return null;
      return { command: input.command, path: input.path };
  }
}

/**
 * Build the guarded memory tool for one consolidation run. Exported separately
 * from runMemoryConsolidation so the rails are testable without a model.
 */
export function createConsolidationMemoryTool(args: {
  memoryService: MemoryService;
  metaService: MemoryMetaService;
  ctx: MemoryScopeContext;
  dryRun: boolean;
  /** Run-scoped journal; the tool appends every mutating command to it. */
  journal: MemoryConsolidationOp[];
}): { tool: Tool; getMutationCount: () => number } {
  const { memoryService, metaService, ctx, dryRun, journal } = args;
  let mutationCount = 0;

  const guard = async (target: MutationTarget): Promise<string | null> => {
    // v1 scope restriction — whitelist, not blacklist, so scopes added later
    // (e.g. project-local from #3533) stay out of bounds by default. Project
    // memories are git-tracked and need a live checkout + diff-visibility
    // story; project-local is project-private state this background pass has
    // no business rewriting. Defer both to phase 1.1 (PRD #3534).
    for (const virtualPath of [target.path, target.newPath]) {
      if (virtualPath == null) continue;
      const { scope } = parseMemoryPath(virtualPath);
      if (scope !== "workspace" && scope !== "global") {
        return `Consolidation may not modify ${virtualPath}: only /memories/workspace/... and /memories/global/... are in scope for this run.`;
      }
    }
    // Pin protection: pinned files are editable but never deleted/renamed.
    // Deletes/renames may target a directory (MemoryService removes
    // recursively), so reject when the path itself OR anything under it is
    // pinned — otherwise `delete dir/` would silently destroy dir/pinned.md.
    if (target.command === "delete" || target.command === "rename") {
      const { scope, relPath } = parseMemoryPath(target.path);
      assert(scope === "workspace" || scope === "global", "guard scope check must run first");
      const entries = await metaService.getEntries();
      const key = memoryLogicalKey(scope, relPath, {
        projectPath: ctx.projectPath,
        workspaceId: ctx.workspaceId,
      });
      const subtreePrefix = `${key}/`;
      for (const [entryKey, entry] of entries) {
        if (entry.pinned !== true) continue;
        if (entryKey === key || entryKey.startsWith(subtreePrefix)) {
          return `${target.path} is pinned by the user (directly or via a pinned file inside it); pinned files may be edited but never deleted or renamed.`;
        }
      }
    }
    return null;
  };

  const memoryTool = tool({
    description:
      "Manage the persistent memory directory you are consolidating. " +
      TOOL_DEFINITIONS.memory.description,
    inputSchema: TOOL_DEFINITIONS.memory.schema,
    execute: async (input): Promise<MemoryToolResult> => {
      const target = classifyMutation(input);
      if (target === null) {
        // Reads (and malformed inputs, which fail validation inside) pass through.
        return executeMemoryCommand(memoryService, ctx, input, () => null);
      }

      let rejection: string | null;
      try {
        rejection = await guard(target);
      } catch (error) {
        // parseMemoryPath throws on invalid paths; surface as a tool error.
        return { success: false, error: getErrorMessage(error) };
      }
      if (rejection !== null) {
        journal.push({ ...target, applied: false, note: rejection });
        return { success: false, error: rejection };
      }

      // Budget check + reservation in ONE synchronous block: the AI SDK runs
      // parallel tool calls concurrently, so an await between check and
      // increment would let two calls at budget-1 both pass. Budget is
      // consumed by every accepted mutation — including dry-run and dispatch
      // failures — so dry-run mirrors a real run.
      if (mutationCount >= MEMORY_CONSOLIDATION_OP_BUDGET) {
        const note = `Mutation budget exhausted (${MEMORY_CONSOLIDATION_OP_BUDGET} per run); stop and summarize.`;
        journal.push({ ...target, applied: false, note });
        return { success: false, error: note };
      }
      mutationCount++;

      if (dryRun) {
        journal.push({ ...target, applied: false, note: "dry-run" });
        return { success: true, output: `[dry-run] recorded ${target.command} ${target.path}` };
      }

      const result = await executeMemoryCommand(memoryService, ctx, input, () => null);
      journal.push({
        ...target,
        applied: result.success,
        note: result.success ? undefined : result.error,
      });
      return result;
    },
  });
  return { tool: memoryTool, getMutationCount: () => mutationCount };
}

/**
 * Run one headless consolidation pass. The caller resolves the model and the
 * dream agent body (CLI: built-in definition; app: standard agent resolution)
 * so this module stays independent of agent-resolution plumbing.
 */
export async function runMemoryConsolidation(args: {
  model: LanguageModel;
  /** Resolved dream agent system prompt body. */
  agentBody: string;
  memoryService: MemoryService;
  metaService: MemoryMetaService;
  ctx: MemoryScopeContext;
  dryRun: boolean;
  /**
   * Archive trigger: instructs the agent that this is the workspace's final
   * pass, unlocking workspace→global promotion of durable lessons (PRD #3534).
   */
  finalPass?: boolean;
  abortSignal?: AbortSignal;
}): Promise<MemoryConsolidationResult> {
  assert(args.agentBody.trim().length > 0, "dream agent body must not be empty");
  const journal: MemoryConsolidationOp[] = [];
  const { tool: memoryTool, getMutationCount } = createConsolidationMemoryTool({
    memoryService: args.memoryService,
    metaService: args.metaService,
    ctx: args.ctx,
    dryRun: args.dryRun,
    journal,
  });

  const stream = streamText({
    model: args.model,
    system: args.agentBody,
    prompt:
      "Run a memory-consolidation pass now. Survey the memory directories, then apply the highest-value cleanups within budget." +
      (args.finalPass === true
        ? " This is the FINAL pass for an archived workspace: promote durable lessons from /memories/workspace/... to /memories/global/... before they are lost."
        : ""),
    tools: { memory: memoryTool },
    stopWhen: stepCountIs(MEMORY_CONSOLIDATION_MAX_STEPS),
    abortSignal: args.abortSignal,
  });

  // Drain the stream; tool executions happen as the loop runs. consumeStream
  // (vs. awaiting .text directly) surfaces mid-stream errors via onError
  // below instead of throwing per-part. Array (not a string flag) because TS
  // cannot track assignments inside the callback for narrowing.
  const streamErrors: string[] = [];
  await stream.consumeStream({
    onError: (error) => {
      streamErrors.push(getErrorMessage(error));
    },
  });
  const summary =
    streamErrors.length === 0 ? (await stream.text).trim() : `stream error: ${streamErrors[0]}`;

  // Cost telemetry: headless runs bypass the chat cost pipeline, so the
  // journal record is the only place token usage is visible. Only awaited on
  // clean streams — after a mid-flight error, totalUsage can stay pending
  // forever (streamManager guards the same promise with withTimeout).
  let usage: MemoryConsolidationResult["usage"];
  if (streamErrors.length === 0) {
    try {
      const totalUsage = await stream.totalUsage;
      usage = {
        inputTokens: totalUsage.inputTokens ?? 0,
        outputTokens: totalUsage.outputTokens ?? 0,
      };
    } catch {
      usage = undefined;
    }
  }

  return {
    ops: journal,
    summary,
    // Derived from accepted mutations, not journal length: journaled guard
    // rejections must not report a budget the run never spent (MEM-RPT-01).
    budgetExhausted: getMutationCount() >= MEMORY_CONSOLIDATION_OP_BUDGET,
    usage,
    streamError: streamErrors[0],
  };
}
