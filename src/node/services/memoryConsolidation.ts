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
 * - pin protection: pinned files may be edited, never deleted or renamed
 * - op budget: at most MEMORY_CONSOLIDATION_OP_BUDGET mutating commands per
 *   run (reads unlimited); rejected/failed commands consume budget so a
 *   misbehaving model cannot retry forever
 * - dry-run: mutations are journaled as proposed but not applied
 *
 * Every mutating command is journaled ({command, path, applied, rejected})
 * for the audit trail that feeds the Memory tab's "last consolidated" line.
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
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";
import { memoryLogicalKey, type MemoryMetaService } from "@/node/services/memoryMeta";
import { parseMemoryPath, type MemoryScopeContext } from "@/node/services/memoryService";
import type { MemoryService } from "@/node/services/memoryService";
import { executeMemoryCommand, type MemoryCommandInput } from "@/node/services/tools/memory";

/** One journaled mutating command (reads are not journaled). */
export interface MemoryConsolidationOp {
  command: "create" | "str_replace" | "insert" | "delete" | "rename";
  /** Primary virtual path (the source path for rename). */
  path: string;
  /** Rename target. */
  newPath?: string;
  /** True when the command was executed against disk and succeeded. */
  applied: boolean;
  /** Rejection/failure reason (guard rail, dry-run, or dispatch error). */
  note?: string;
}

export interface MemoryConsolidationResult {
  ops: MemoryConsolidationOp[];
  /** The model's one-line closing summary (best-effort). */
  summary: string;
  budgetExhausted: boolean;
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
}): Tool {
  const { memoryService, metaService, ctx, dryRun, journal } = args;
  let mutationCount = 0;

  const guard = async (target: MutationTarget): Promise<string | null> => {
    // v1 scope restriction: project memories are git-tracked and need a live
    // checkout + diff-visibility story; defer to phase 1.1 (PRD #3534).
    for (const virtualPath of [target.path, target.newPath]) {
      if (virtualPath == null) continue;
      const { scope } = parseMemoryPath(virtualPath);
      if (scope === null || scope === "project") {
        return `Consolidation may not modify ${virtualPath}: only /memories/workspace/... and /memories/global/... are in scope for this run.`;
      }
    }
    // Pin protection: pinned files are editable but never deleted/renamed.
    if (target.command === "delete" || target.command === "rename") {
      const { scope, relPath } = parseMemoryPath(target.path);
      assert(scope !== null && scope !== "project", "guard scope check must run first");
      const entries = await metaService.getEntries();
      const key = memoryLogicalKey(scope, relPath, {
        projectPath: ctx.projectPath,
        workspaceId: ctx.workspaceId,
      });
      if (entries.get(key)?.pinned === true) {
        return `${target.path} is pinned by the user; pinned files may be edited but never deleted or renamed.`;
      }
    }
    if (mutationCount >= MEMORY_CONSOLIDATION_OP_BUDGET) {
      return `Mutation budget exhausted (${MEMORY_CONSOLIDATION_OP_BUDGET} per run); stop and summarize.`;
    }
    return null;
  };

  return tool({
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

      // Budget is consumed by every accepted mutation — including dry-run and
      // dispatch failures — so dry-run mirrors a real run and a failing
      // command cannot be retried indefinitely.
      mutationCount++;
      assert(
        mutationCount <= MEMORY_CONSOLIDATION_OP_BUDGET,
        "mutation count must never exceed the budget"
      );

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
  abortSignal?: AbortSignal;
}): Promise<MemoryConsolidationResult> {
  assert(args.agentBody.trim().length > 0, "dream agent body must not be empty");
  const journal: MemoryConsolidationOp[] = [];
  const memoryTool = createConsolidationMemoryTool({
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
      "Run a memory-consolidation pass now. Survey the memory directories, then apply the highest-value cleanups within budget.",
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

  return {
    ops: journal,
    summary,
    budgetExhausted: journal.length >= MEMORY_CONSOLIDATION_OP_BUDGET,
  };
}
