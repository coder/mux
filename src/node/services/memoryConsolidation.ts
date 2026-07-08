/**
 * Memory-consolidation runner — the "dream" agent (issue #3534).
 *
 * Deep module: given a model + scope context, runs a headless agent loop
 * (direct streamText, same seam as workspaceTitleGenerator — no StreamManager,
 * no chat history, no UI events) whose only tool is a guarded memory tool.
 *
 * Rails live HERE in code, not in the agent prompt:
 * - scope restriction: consolidates workspace + global, plus project when the
 *   run has a single stable project identity
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
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

import assert from "@/common/utils/assert";
import {
  MEMORY_CONSOLIDATION_MAX_STEPS,
  MEMORY_CONSOLIDATION_OP_BUDGET,
} from "@/common/constants/memory";
import type { MemoryToolResult } from "@/common/types/tools";
import type { MemoryConsolidationOp } from "@/common/orpc/schemas/memory";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";
import { accumulateStepsProviderMetadata } from "@/common/utils/tokens/usageHelpers";
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
    // Whitelist, not blacklist, so scopes added later stay out of bounds by default.
    // Project memory is available only when the workspace has one stable project identity.
    for (const virtualPath of [target.path, target.newPath]) {
      if (virtualPath == null) continue;
      const { scope } = parseMemoryPath(virtualPath);
      if (scope === "workspace" || scope === "global") continue;
      if (scope === "project" && ctx.projectPath !== "") continue;
      return `Consolidation may not modify ${virtualPath}: project memory is available only for single-project runs; this run can modify /memories/workspace/... and /memories/global/....`;
    }
    // Pin protection: pinned files are editable but never deleted/renamed.
    // Deletes/renames may target a directory (MemoryService removes
    // recursively), so reject when the path itself OR anything under it is
    // pinned — otherwise `delete dir/` would silently destroy dir/pinned.md.
    if (target.command === "delete" || target.command === "rename") {
      const { scope, relPath } = parseMemoryPath(target.path);
      assert(
        scope === "workspace" || scope === "project" || scope === "global",
        "guard scope check must run first"
      );
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
   * pass, so durable lessons must be moved to the narrowest available scope
   * before workspace memory is deleted (PRD #3534).
   */
  finalPass?: boolean;
  abortSignal?: AbortSignal;
  /**
   * Best-effort cost telemetry: headless consolidation bypasses the chat cost
   * pipeline, so the caller records the full stream usage (with cache-token
   * breakdown) into session-usage.json. Invoked only after a clean stream.
   * providerMetadata is step-accumulated — Anthropic reports billed
   * cache-write tokens only there, so dropping it would price cache writes
   * as ordinary input.
   */
  recordUsage?: (
    usage: LanguageModelV2Usage,
    providerMetadata?: Record<string, unknown>
  ) => Promise<void>;
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

  const finalPassPrompt =
    args.finalPass !== true
      ? ""
      : args.ctx.projectPath === ""
        ? " This is the FINAL pass for an archived workspace: preserve only cross-project user preferences or environment facts in /memories/global/... before workspace memory is deleted. Project memory is unavailable for this run; do not promote project-specific lessons to global memory."
        : " This is the FINAL pass for an archived workspace: promote durable workspace lessons before workspace memory is deleted. Move repo-specific lessons to /memories/project/... and only cross-project user preferences or environment facts to /memories/global/....";

  const stream = streamText({
    model: args.model,
    system: args.agentBody,
    prompt:
      "Run a memory-consolidation pass now. Survey the memory directories, then apply the highest-value cleanups within budget." +
      finalPassPrompt,
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
      await args.recordUsage?.(totalUsage, accumulateStepsProviderMetadata(await stream.steps));
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
