/**
 * /refine orchestration (RLM track, phase r11): user-invokable trajectory
 * distillation with a paper trail.
 *
 * Owns everything around the runner (refineRunner.ts): RLM experiment gating
 * (backend refuses when off), one-run-at-a-time-per-workspace locking
 * (concurrent invocations are REJECTED, not queued — an explicit /refine has
 * nothing to gain from running twice over the same trajectory), trajectory
 * assembly (recent chat.jsonl + timeline events when the Timeline experiment
 * is on), model resolution, journal-row correlation, and the completion chat
 * message.
 *
 * v1 tradeoff (intentional, no proposal/approval UI): edits are auto-applied
 * and the summary row points at the r6 rollback paths ("bun run debug
 * refinements" / the refinement_rollback tool). Approval UX would double the
 * surface of an experimental feature whose every edit is already journaled
 * with a byte-exact inverse — cheap rollback is the safety mechanism.
 *
 * Failure posture: best-effort everywhere below the run result. Summary-row
 * append or emission failures log and continue (self-healing doctrine); a
 * stream failure returns an error so the user knows the pass did not finish.
 */
import * as os from "node:os";
import type { LanguageModel, Tool } from "ai";

import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import type { RefineAppliedEditPayload, RefineRecordPayload } from "@/common/orpc/schemas/api";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  MemoryRefinementActionSchema,
  RefinementEvidenceSchema,
  SkillRefinementActionSchema,
} from "@/common/types/refinement";
import { Err, Ok, type Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import {
  REFINE_APPLY_CROSS_PROCESS_LOCK_TIMEOUT_MS,
  REFINE_MAX_MESSAGES,
  REFINE_OP_BUDGET,
  REFINE_SUMMARY_LABEL,
  REFINE_TIMELINE_EVENT_LIMIT,
  REFINE_TIMEOUT_MS,
} from "@/constants/refine";
import * as path from "node:path";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  buildAbandonedBranchTranscript,
  isRlmModeEnabled,
  type RlmExperimentFlags,
} from "@/node/services/branchSummary";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import type { HistoryService } from "@/node/services/historyService";
import { runLanguageModelCleanup } from "@/node/services/languageModelCleanup";
import { log } from "@/node/services/log";
import {
  createConsolidationMemoryTool,
  createMutationBudget,
} from "@/node/services/memoryConsolidation";
import {
  resolveConsolidationProjectPath,
  resolveDreamModelString,
} from "@/node/services/memoryConsolidationService";
import type { MemoryMetaService } from "@/node/services/memoryMeta";
import type { MemoryScopeContext, MemoryService } from "@/node/services/memoryService";
import { modelCostsIncluded } from "@/node/services/providerModelFactory";
import {
  listRefinements,
  type RefinementEvent,
} from "@/node/services/refinement/refinementRollback";
import {
  clearStagedRefineSet,
  hashStagedRefineSet,
  loadStagedRefineSet,
  saveStagedRefineSet,
  type StagedRefineEdit,
} from "@/node/services/refinement/refineStaging";
import { runRefinePass } from "@/node/services/refinement/refineRunner";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { TimelineService } from "@/node/services/timelineService";
import { createAgentSkillWriteTool } from "@/node/services/tools/agent_skill_write";
import { sharedDurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { createRefineSummaryMessageId } from "@/node/services/utils/messageIds";

// Types derive from the oRPC schemas (z.infer single source) so node-side
// fields can never silently be stripped by output validation.
export type RefineAppliedEdit = RefineAppliedEditPayload;
export type RefineRecord = RefineRecordPayload;

interface ExperimentsCheck {
  isExperimentEnabled(experimentId: ExperimentId): boolean;
}

/**
 * Structural AIService subset (model creation + runtime metadata), mirroring
 * the dream service's ModelFactoryLike so tests can pass lightweight fakes.
 */
export interface RefineAiService {
  createModelWithPinnedMetadata(
    modelString: string,
    opts?: { agentInitiated?: boolean; workspaceId?: string }
  ): Promise<Result<{ model: LanguageModel; metadataModel: string }, { type: string }>>;
  getWorkspaceMetadata(workspaceId: string): Promise<Result<WorkspaceMetadata>>;
}

interface RefineServiceOptions {
  timelineService?: Pick<TimelineService, "list">;
  /** Narrowed to the one member used so tests can pass lightweight fakes. */
  sessionUsageService?: Pick<SessionUsageService, "recordHeadlessUsage">;
  /** Live-session emission hook so the appended summary row renders immediately. */
  emitChatMessage?: (workspaceId: string, message: MuxMessage) => void;
  /** Test seam: overrides REFINE_TIMEOUT_MS as the pass deadline. */
  timeoutMs?: number;
  /** Test seam: overrides the cross-process apply-lock acquisition timeout. */
  applyLockTimeoutMs?: number;
  /**
   * Test seam: invoked after each staged edit's apply-progress journal write
   * settles. Crash-recovery tests throw from here to simulate process death
   * between edits (the mutation + its journal entry are durable; nothing
   * after runs).
   */
  onStagedEditAttempted?: (toolCallId: string) => void;
}

/** Human-readable action line for a refinement journal row. */
export function describeRefinementRow(row: RefinementEvent): string {
  if (row.data.kind === "memory") {
    const action = MemoryRefinementActionSchema.safeParse(row.data.action);
    if (action.success) {
      const rename = action.data.newPath !== undefined ? ` -> ${action.data.newPath}` : "";
      return `memory ${action.data.op} ${action.data.path}${rename}`;
    }
  }
  if (row.data.kind === "skill") {
    const action = SkillRefinementActionSchema.safeParse(row.data.action);
    if (action.success) {
      const file = action.data.filePath !== undefined ? `/${action.data.filePath}` : "";
      return `skill ${action.data.op} ${action.data.skillName}${file}`;
    }
  }
  return `${row.data.kind} edit`;
}

/**
 * Build the durable, clearly-labeled summary row for a refine pass. "staged"
 * mode announces the proposal — rendering the EXACT staged payloads so
 * approval is informed — and how to approve it; "applied" mode reports the
 * executed edits with their rollback addresses.
 */
export function createRefineSummaryMessage(
  record: RefineRecord,
  mode:
    | { mode: "applied" }
    | {
        mode: "staged";
        /** The exact staged edits; their full inputs are rendered below. */
        edits: StagedRefineEdit[];
        /** Canonical hash binding /refine apply to the rendered bytes. */
        stagedSetHash: string;
      }
): MuxMessage {
  const lines = [REFINE_SUMMARY_LABEL, ""];
  if (mode.mode === "staged") {
    // SECURITY: render the exact staged inputs (full file_text / skill
    // content), never just the model's one-line descriptions — a
    // prompt-injected refine model could otherwise present a benign
    // rationale while apply persists different content. Sizes are bounded
    // by the per-run mutation budget and the tools' own input caps, so full
    // rendering stays feasible; approval is bound to these bytes via
    // stagedSetHash.
    for (const [index, edit] of mode.edits.entries()) {
      const payload = JSON.stringify(edit.input, null, 2);
      // SECURITY: a backtick run in the payload could close a fixed ```
      // fence early (lenient renderers accept closers JSON quoting would not
      // stop), letting a prompt-influenced payload render part of itself as
      // Markdown — counterfeit headings or "nothing applied" prose — outside
      // the code block that the explicit-review boundary depends on. Use a
      // fence strictly longer than the longest backtick run anywhere in the
      // payload so it can never terminate early.
      const longestBacktickRun = (payload.match(/`+/gu) ?? []).reduce(
        (max, run) => Math.max(max, run.length),
        0
      );
      const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
      lines.push(
        `- [staged ${index + 1}/${mode.edits.length}] ${edit.description}`,
        "",
        `${fence}json`,
        payload,
        fence,
        ""
      );
    }
  } else {
    lines.push(
      ...record.applied.map((edit) => `- ${edit.description} (refinement ${edit.refinementId})`)
    );
    if (record.untrackedApplied !== undefined && record.untrackedApplied > 0) {
      // Real edits with no journal row: the user must learn about them even
      // though the r6 rollback path cannot address them.
      lines.push(
        `- ${record.untrackedApplied} applied edit(s) could not be journaled; rollback is unavailable for them.`
      );
    }
    if (record.failed !== undefined && record.failed.length > 0) {
      // Approved edits that failed to apply: the audit row must say so — a
      // no-op-shaped summary would silently drop approved work.
      lines.push(...record.failed.map((edit) => `- FAILED: ${edit.description} — ${edit.reason}`));
    }
  }
  if (record.summary.length > 0) {
    lines.push("", record.summary);
  }
  if (mode.mode === "staged") {
    // SECURITY: nothing has been written yet — the approval affordance is
    // this instruction (see refineStaging.ts for the rationale).
    lines.push(
      "",
      "Nothing has been applied yet. Apply with /refine apply, or run /refine again to replace the proposal."
    );
  } else if (record.applied.length > 0) {
    // The rollback pointer only applies to journaled rows.
    lines.push(
      "",
      // Only real affordances: the debug CLI and the refinement_rollback
      // tool ("/debug refinements" is not a registered slash command).
      "Rollback with: bun run debug refinements <workspace-id> --rollback <id>, or the refinement_rollback tool."
    );
  }
  // SECURITY: assistant role, never user. The summary embeds the refine
  // model's verbatim closing output over an attacker-influenceable
  // trajectory; a user row would grant prompt-injected text user-priority
  // trust in every later tool-capable request (and startup auto-retry can
  // resume it after a restart). As an assistant row the provider reads it as
  // prior generated context — same posture as branch summaries and
  // compaction summary rows; transformModelMessages merges consecutive
  // text-only assistant rows for Anthropic's alternation constraint.
  return createMuxMessage(createRefineSummaryMessageId(), "assistant", lines.join("\n"), {
    timestamp: Date.now(),
    // Synthetic system-style row: provider-visible durable history (never
    // request-time injection), uiVisible so users see what was self-applied.
    synthetic: true,
    uiVisible: true,
    muxMetadata: {
      type: "refine-summary",
      ...(mode.mode === "staged" ? { stagedSetHash: mode.stagedSetHash } : {}),
    },
  });
}

interface InFlightRefinePass {
  promise: Promise<Result<RefineRecord, string>>;
  /** Invalidates the running pass (see cancelInFlightRefinePass). */
  controller: AbortController;
}

export class RefineService {
  /**
   * Per-workspace run lock. Reserved SYNCHRONOUSLY in run() before any await
   * so two near-simultaneous invocations can never both start; the loser is
   * rejected outright (see module doc). Entries carry a cancellation handle
   * so workspace removal can abort and drain a running pass before deleting
   * the session directory (same posture as pendingBranchSummaries).
   */
  private readonly inFlight = new Map<string, InFlightRefinePass>();

  constructor(
    private readonly config: Config,
    private readonly memoryService: MemoryService,
    private readonly metaService: MemoryMetaService,
    private readonly historyService: HistoryService,
    private readonly aiService: RefineAiService,
    private readonly experiments: ExperimentsCheck,
    private readonly options: RefineServiceOptions = {}
  ) {}

  private enabled(experiments?: RlmExperimentFlags): boolean {
    // RLM is a sub-experiment of Programmatic Tool Calling; both machine
    // overrides must be on. Explicit renderer flags ride the request with the
    // same authority as send options.experiments (r32): persisting overrides
    // to the backend is asynchronous/best-effort, so a backend-only predicate
    // could refuse /refine while the same workspace is already running with
    // the RLM kernel the renderer sees.
    return isRlmModeEnabled(experiments, (id) => this.experiments.isExperimentEnabled(id));
  }

  async run(
    workspaceId: string,
    experiments?: RlmExperimentFlags
  ): Promise<Result<RefineRecord, string>> {
    if (!this.enabled(experiments)) {
      return Err("rlm-mode experiment is disabled (enable Programmatic Tool Calling + RLM Mode)");
    }
    if (this.inFlight.has(workspaceId)) {
      return Err("a refine pass is already running for this workspace");
    }
    // runLocked executes synchronously up to its first await, so the map is
    // populated before any other caller can observe it.
    const controller = new AbortController();
    const run = this.runLocked(workspaceId, controller.signal);
    const entry: InFlightRefinePass = { promise: run, controller };
    this.inFlight.set(workspaceId, entry);
    try {
      return await run;
    } finally {
      // Identity-guarded: a cancel + immediate re-run must not sweep the
      // newer registration.
      if (this.inFlight.get(workspaceId) === entry) {
        this.inFlight.delete(workspaceId);
      }
    }
  }

  /**
   * Abort and drain any running /refine pass for a removed workspace. Removal
   * MUST await this before deleting the session directory: the abort stops
   * the pass's stream (ending tool-driven memory/skill writes) and gates the
   * summary-row append, and awaiting the settle serializes removal behind
   * writes already in flight — otherwise a late write could recreate session
   * state for a workspace that no longer exists. Never rejects.
   */
  async cancelInFlightRefinePass(workspaceId: string): Promise<void> {
    const entry = this.inFlight.get(workspaceId);
    if (!entry) {
      return;
    }
    entry.controller.abort();
    // runLocked can throw on unexpected failures; removal must proceed anyway.
    await entry.promise.catch(() => undefined);
  }

  /**
   * Apply the staged edits from the last /refine run. This is the explicit
   * approval step of the staging contract (see refineStaging.ts): the staged
   * inputs replay through the SAME journaled tool paths a live agent uses —
   * the consolidation memory tool (scope guard + pin protection re-checked)
   * and the standard agent_skill_write tool (containment re-checked) — so
   * every applied edit lands as an invertible r2 refinement row and r6
   * rollback keeps working. Shares the per-workspace lock with run().
   */
  async apply(
    workspaceId: string,
    experiments?: RlmExperimentFlags
  ): Promise<Result<RefineRecord, string>> {
    if (!this.enabled(experiments)) {
      return Err("rlm-mode experiment is disabled (enable Programmatic Tool Calling + RLM Mode)");
    }
    if (this.inFlight.has(workspaceId)) {
      return Err("a refine pass is already running for this workspace");
    }
    const controller = new AbortController();
    const run = this.applyLocked(workspaceId, controller.signal);
    const entry: InFlightRefinePass = { promise: run, controller };
    this.inFlight.set(workspaceId, entry);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(workspaceId) === entry) {
        this.inFlight.delete(workspaceId);
      }
    }
  }

  private async applyLocked(
    workspaceId: string,
    cancellationSignal: AbortSignal
  ): Promise<Result<RefineRecord, string>> {
    const workspace = this.config.findWorkspace(workspaceId);
    if (!workspace) return Err(`workspace not found: ${workspaceId}`);
    const sessionDir = this.config.getSessionDir(workspaceId);
    // r32: the in-process inFlight map cannot see a second backend over the
    // same root (XUM_ALLOW_MULTIPLE_INSTANCES=1). Hold a cross-process lock
    // across staged-state load, recovery, execution, and progress persistence
    // — per-target mutation locks only serialize the individual writes, so
    // two processes could both capture an empty attempted set and double-
    // apply a non-idempotent edit. Short acquisition timeout: a held lock
    // means another apply is running, mirror the in-process rejection.
    let applyLock: Awaited<ReturnType<typeof acquireProcessFileLock>>;
    try {
      applyLock = await acquireProcessFileLock({
        lockPath: path.join(sessionDir, "refine-apply.lock"),
        timeoutMs: this.options.applyLockTimeoutMs ?? REFINE_APPLY_CROSS_PROCESS_LOCK_TIMEOUT_MS,
        label: "refine apply lock",
      });
    } catch (error) {
      return Err(
        `a refine apply appears to be running in another process: ${getErrorMessage(error)}`
      );
    }
    await using _applyLock = applyLock;
    const staged = await loadStagedRefineSet(sessionDir);
    if (staged === null) {
      return Err("no staged refine edits (run /refine first)");
    }

    // SECURITY: bind approval to the rendered bytes. The staged proposal row
    // displayed the exact edit payloads and recorded their canonical hash;
    // apply refuses unless refine-staged.json still hashes to the NEWEST
    // proposal the user could have audited in chat. This catches a tampered
    // staged file and a file/row desync — approving unseen content is never
    // possible. Fail closed when no hashed proposal row is found (e.g.
    // pre-hash proposals from an older binary): rerun /refine to restage.
    const approvedHash = await this.findNewestStagedProposalHash(workspaceId);
    if (approvedHash === null) {
      return Err(
        "no staged refine proposal found in chat to verify against; run /refine again to restage"
      );
    }
    const actualHash = hashStagedRefineSet(staged.edits);
    if (actualHash !== approvedHash) {
      return Err(
        "staged refine edits no longer match the proposal shown in chat (the staged file changed after it was displayed); run /refine again and re-approve"
      );
    }

    // Baseline BEFORE applying: rows appended by this apply have seq >
    // baseline. Correlation additionally requires the row's
    // evidence.toolCallId to be one of the staged tool calls, so concurrent
    // main-agent self-edits in the same journal can never be misattributed.
    // A crash-resumed apply reuses the ORIGINAL run's persisted baseline so
    // the audit row also covers edits applied before the crash.
    const baselineSeq = staged.applyBaselineSeq ?? (await this.readMaxJournalSeq(sessionDir));

    const projectPath = resolveConsolidationProjectPath(workspace);
    const ctx: MemoryScopeContext = {
      runtime: null,
      checkoutCwd: "",
      workspaceId,
      projectPath,
    };
    const { tool: memoryTool } = createConsolidationMemoryTool({
      memoryService: this.memoryService,
      metaService: this.metaService,
      ctx,
      dryRun: false,
      journal: [],
      budget: createMutationBudget(REFINE_OP_BUDGET),
    });
    const skillWriteTool = await this.buildSkillWriteTool(workspaceId, sessionDir);

    // Cancellation is honored ONLY before the first mutation. Once admitted,
    // the apply runs to completion: aborting between edits left a partially
    // applied global/project mutation while removal deleted the session
    // journal holding its rollback IDs — surviving with no audit or rollback
    // path. Applies are local journaled file mutations with no model calls,
    // so removal (which awaits this promise via cancelInFlightRefinePass
    // before deleting the session directory) waits out the full run instead;
    // the audit row below is persisted before session teardown.
    if (cancellationSignal.aborted) {
      return Err("refine apply cancelled (workspace removed)");
    }

    // CRASH SAFETY (consume-before-mutate): transition the staged file into
    // its applying state — persisted baseline + attempted list — BEFORE the
    // first mutation, and mark each edit attempted (atomic rewrite) right
    // after its execution settles. A crash mid-apply then cannot replay
    // non-idempotent edits on the next /refine apply: recovery skips
    // attempted IDs and resumes the remainder, and a fully-attempted set
    // applies nothing new while still producing the correct audit row (via
    // the persisted baseline) instead of replaying everything.
    const attempted = new Set(staged.attemptedToolCallIds ?? []);
    if (staged.applyBaselineSeq === undefined) {
      await saveStagedRefineSet(sessionDir, {
        ...staged,
        applyBaselineSeq: baselineSeq,
        attemptedToolCallIds: [...attempted],
      });
    } else {
      // CRASH RECOVERY (journal-first): the attempted-progress rewrite lands
      // only AFTER a tool execution settles, so a crash in that window leaves
      // a completed edit missing from attemptedToolCallIds while its
      // refinement journal row (appended by the tool itself) survives. Union
      // journaled IDs past the persisted baseline into the attempted set
      // before invoking any tool again — replaying a non-idempotent memory
      // insert would duplicate it. The residual window (mutation done,
      // journal append failed) is accepted: journal appends are best-effort
      // by design, so such an edit can still replay once.
      const journaled = await this.listStagedRefinementRows(
        sessionDir,
        workspaceId,
        baselineSeq,
        staged.edits.map((edit) => edit.toolCallId)
      );
      for (const { toolCallId } of journaled) attempted.add(toolCallId);
    }

    // Success outcomes are PERSISTED per edit (succeededToolCallIds), not
    // just counted: a crash-resumed apply skips attempted edits, so a prior
    // unjournaled success would otherwise be unreconstructable and the
    // resume would misreport a real mutation as a no-op (see the schema doc).
    const succeededIds = new Set(staged.succeededToolCallIds ?? []);
    // Failed approved edits are REPORTED, never folded into a successful
    // no-op: "nothing was applied" must not stand in for "everything failed"
    // (the staged set would be consumed with no record that approved edits
    // were dropped).
    const failed: Array<{ description: string; reason: string }> = [];
    // Never-executed skips (tool unavailable / schema-rejected input) have no
    // side effects, so they stay OUT of the attempted set and the staged set
    // is retained below: a later /refine apply may retry them safely once the
    // cause is fixed. Executed edits are marked attempted and never replay.
    let retryableSkips = 0;
    for (const edit of staged.edits) {
      // Applied (or at least attempted) before a crash: never replay.
      if (attempted.has(edit.toolCallId)) continue;
      const tool = edit.tool === "memory" ? memoryTool : skillWriteTool;
      if (tool === undefined || typeof tool.execute !== "function") {
        log.warn("[Refine] staged edit skipped: tool unavailable at apply time", {
          workspaceId,
          tool: edit.tool,
        });
        failed.push({ description: edit.description, reason: "tool unavailable at apply time" });
        retryableSkips += 1;
        continue;
      }
      // The staged file is on-disk state: validate the input against the
      // tool's own schema before executing (defense against tampering and
      // schema drift across upgrades).
      const schema =
        edit.tool === "memory"
          ? TOOL_DEFINITIONS.memory.schema
          : TOOL_DEFINITIONS.agent_skill_write.schema;
      const parsedInput = schema.safeParse(edit.input);
      if (!parsedInput.success) {
        log.warn("[Refine] staged edit skipped: input failed schema validation", {
          workspaceId,
          tool: edit.tool,
          error: parsedInput.error.message,
        });
        failed.push({
          description: edit.description,
          // Zod messages can run long; the audit row needs the gist only.
          reason: `input failed schema validation: ${parsedInput.error.message.slice(0, 200)}`,
        });
        retryableSkips += 1;
        continue;
      }
      try {
        const result: unknown = await tool.execute(parsedInput.data, {
          toolCallId: edit.toolCallId,
          messages: [],
          // Neither tool declares a context schema; undefined matches the
          // unknown-context Tool shape.
          context: undefined,
        });
        if (
          typeof result === "object" &&
          result !== null &&
          (result as { success?: unknown }).success === true
        ) {
          succeededIds.add(edit.toolCallId);
        } else {
          const toolError =
            typeof result === "object" && result !== null
              ? (result as { error?: unknown }).error
              : undefined;
          failed.push({
            description: edit.description,
            reason:
              typeof toolError === "string" && toolError.length > 0
                ? toolError.slice(0, 200)
                : "tool reported failure",
          });
        }
      } catch (error) {
        log.warn("[Refine] staged edit failed to apply", {
          workspaceId,
          tool: edit.tool,
          error: getErrorMessage(error),
        });
        failed.push({
          description: edit.description,
          reason: getErrorMessage(error).slice(0, 200),
        });
      } finally {
        // Durable per-edit journal entry AFTER the execution settled
        // (success or clean failure — a failed edit must not replay either,
        // since its handler may have partially observable effects). Best
        // effort: a journal-write failure must not fail the admitted apply,
        // it only weakens crash recovery for this edit.
        attempted.add(edit.toolCallId);
        try {
          await saveStagedRefineSet(sessionDir, {
            ...staged,
            applyBaselineSeq: baselineSeq,
            attemptedToolCallIds: [...attempted],
            succeededToolCallIds: [...succeededIds],
          });
        } catch (error) {
          log.warn("[Refine] failed to persist apply progress", {
            workspaceId,
            error: getErrorMessage(error),
          });
        }
        this.options.onStagedEditAttempted?.(edit.toolCallId);
      }
    }
    const journaledRows = await this.listStagedRefinementRows(
      sessionDir,
      workspaceId,
      baselineSeq,
      staged.edits.map((edit) => edit.toolCallId)
    );
    const applied: RefineAppliedEdit[] = journaledRows.map(({ row }) => ({
      refinementId: row.id,
      description: describeRefinementRow(row),
    }));
    // Journal acknowledgement can fail while the mutation itself succeeded
    // (appendRefinementEvent swallows journal/blob failures by design so
    // user-facing writes stay self-healing). Those edits are real — files
    // changed with no rollback id — so they must be reported, never
    // classified as a no-op. The tools' own PERSISTED success outcomes are
    // the ground truth: successes without a journaled row are untracked.
    // Set difference (not a counter minus applied.length) so a crash-resumed
    // apply — whose in-pass counter would be zero — still reconstructs
    // untracked successes recorded by the pre-crash pass.
    const journaledIds = new Set(journaledRows.map(({ toolCallId }) => toolCallId));
    const untrackedApplied = [...succeededIds].filter((id) => !journaledIds.has(id)).length;
    const record: RefineRecord = {
      applied,
      summary: staged.summary,
      // Failures keep the apply out of no-op classification: approved edits
      // that failed must reach the audit row and the invoking UI.
      noOp: applied.length === 0 && untrackedApplied === 0 && failed.length === 0,
      ...(untrackedApplied > 0 ? { untrackedApplied } : {}),
      ...(failed.length > 0 ? { failed } : {}),
    };

    log.debug("[Refine] apply complete", {
      workspaceId,
      staged: staged.edits.length,
      applied: applied.length,
      untrackedApplied,
      failed: failed.length,
    });

    // No cancellation gate here (unlike runLocked): an admitted apply's
    // audit row — the only durable record of the rollback IDs — must persist
    // even when removal is racing. Removal awaits this promise before
    // deleting the session directory, so the append still precedes teardown.
    if (!record.noOp) {
      const auditDurable = await this.appendSummaryMessage(workspaceId, record, {
        mode: "applied",
      });
      // The staged set is the only state that can regenerate the audit row
      // (persisted baseline + attempted IDs reproduce it with zero
      // re-mutation). A swallowed append failure here would consume that
      // state below and report success with the rollback IDs lost — same loss
      // as the crash window, so it must fail the apply, not just log.
      if (!auditDurable) {
        return Err(
          "refine apply finished, but the audit summary row (the durable record of the " +
            "rollback IDs) could not be appended to chat; the staged set is retained — run " +
            "/refine apply again to retry the audit record (attempted edits are never re-applied)"
        );
      }
    }
    // Consume the staged set only AFTER the audit summary append succeeded:
    // clearing first opened a crash window where every mutation + journal row
    // was durable but the resumable staged state was gone — the next apply
    // refused ("no staged refine edits") and the audit row holding the
    // rollback IDs could never be reconstructed. A crash after the append
    // but before this clear instead resumes as a fully-attempted set: zero
    // re-mutation (attempted IDs + journal-first recovery above), at worst a
    // duplicate audit row — a far better failure than lost rollback
    // addresses. Re-runs still can never double-apply (per-edit attempted
    // progress is persisted before this point).
    if (retryableSkips > 0) {
      // Some edits never executed (no side effects, not in the attempted
      // set): keep the staged set so /refine apply can retry them once the
      // cause is fixed. The proposal row stays the newest hashed refine-
      // summary row (the audit row above carries no stagedSetHash), so the
      // retry still verifies approval against the same rendered bytes.
      return Ok(record);
    }
    await clearStagedRefineSet(sessionDir);
    return Ok(record);
  }

  /**
   * Newest staged-proposal hash from the chat transcript (see applyLocked).
   * Searches recent history for the latest refine-summary row carrying a
   * stagedSetHash; returns null when none exists in the window.
   */
  private async findNewestStagedProposalHash(workspaceId: string): Promise<string | null> {
    const messagesResult = await this.historyService.getLastMessages(
      workspaceId,
      REFINE_MAX_MESSAGES
    );
    if (!messagesResult.success) {
      return null;
    }
    for (let i = messagesResult.data.length - 1; i >= 0; i--) {
      const muxMetadata = messagesResult.data[i].metadata?.muxMetadata;
      if (
        muxMetadata?.type === "refine-summary" &&
        typeof muxMetadata.stagedSetHash === "string" &&
        muxMetadata.stagedSetHash.length > 0
      ) {
        return muxMetadata.stagedSetHash;
      }
    }
    return null;
  }

  private async runLocked(
    workspaceId: string,
    cancellationSignal: AbortSignal
  ): Promise<Result<RefineRecord, string>> {
    const workspace = this.config.findWorkspace(workspaceId);
    if (!workspace) return Err(`workspace not found: ${workspaceId}`);

    const messagesResult = await this.historyService.getLastMessages(
      workspaceId,
      REFINE_MAX_MESSAGES
    );
    if (!messagesResult.success) {
      return Err(`could not read workspace history: ${messagesResult.error}`);
    }
    // Reuse the branch-summary transcript builder: role-labeled,
    // thinking-stripped, char-bounded — exactly the evidence shape a
    // distillation pass needs.
    const transcript = buildAbandonedBranchTranscript(messagesResult.data);
    if (transcript.length === 0) {
      // Empty trajectory: a clean first-class no-op without spending a model call.
      return Ok({ applied: [], summary: "Nothing worth distilling.", noOp: true });
    }

    const timelineText = await this.buildTimelineText(workspaceId);

    // Model: reuse the dream-agent inherit cascade — refine is the same class
    // of background self-maintenance agent, so a per-workspace dream override
    // intentionally covers both.
    const modelString = resolveDreamModelString(this.config, workspaceId);
    const modelResult = await this.aiService.createModelWithPinnedMetadata(modelString, {
      agentInitiated: true,
      workspaceId,
    });
    if (!modelResult.success) {
      return Err(`could not create model ${modelString}: ${modelResult.error.type}`);
    }
    // From here on the model is live: every exit (success, stream failure,
    // throw) must release it in the finally below.
    try {
      const projectPath = resolveConsolidationProjectPath(workspace);
      const ctx: MemoryScopeContext = {
        runtime: null,
        checkoutCwd: "",
        workspaceId,
        projectPath,
      };

      const sessionDir = this.config.getSessionDir(workspaceId);
      // The pass only STAGES edits (see refineStaging.ts) — journal-baseline
      // bookkeeping happens at apply time. Skill-tool availability is still
      // resolved here so the model only sees agent_skill_write when a later
      // apply could actually execute it.
      const skillWriteAvailable =
        (await this.buildSkillWriteTool(workspaceId, sessionDir)) !== undefined;

      const result = await runRefinePass({
        model: modelResult.data.model,
        memoryService: this.memoryService,
        metaService: this.metaService,
        ctx,
        transcript,
        timelineText,
        skillWriteAvailable,
        // Hard timeout: a wedged provider stream must not hold the run lock
        // forever. Workspace-removal cancellation is folded into the same
        // signal so it stops the stream (and its tool-driven writes) promptly.
        abortSignal: AbortSignal.any([
          AbortSignal.timeout(this.options.timeoutMs ?? REFINE_TIMEOUT_MS),
          cancellationSignal,
        ]),
        recordUsage: async (usage, providerMetadata) => {
          await this.options.sessionUsageService?.recordHeadlessUsage(
            workspaceId,
            modelString,
            usage,
            providerMetadata,
            {
              costsIncluded: modelCostsIncluded(modelResult.data.model),
              analyticsSource: "refine",
              metadataModel: modelResult.data.metadataModel,
            }
          );
        },
      });
      if (result.streamError !== undefined) {
        // Nothing was applied (the pass only stages); a previous staged set,
        // if any, stays intact for a later apply.
        return Err(`refine stream failed: ${result.streamError}`);
      }

      const summary = result.summary.length > 0 ? result.summary : "Nothing worth distilling.";
      const record: RefineRecord = {
        applied: [],
        summary,
        noOp: result.stagedEdits.length === 0,
        ...(result.stagedEdits.length > 0
          ? { staged: result.stagedEdits.map((edit) => ({ description: edit.description })) }
          : {}),
        usage: result.usage,
      };

      log.debug("[Refine] staging pass complete", {
        workspaceId,
        staged: result.stagedEdits.length,
        budgetExhausted: result.budgetExhausted,
        usage: result.usage,
      });

      // Cancellation gate before the disk/chat writes: removal aborts and
      // drains in-flight passes before deleting the session directory, and a
      // write past this point would recreate it. (A stream that drained
      // cleanly just before the abort still reaches here, so the mid-stream
      // abort alone is not enough.)
      if (cancellationSignal.aborted) {
        return Err("refine pass cancelled (workspace removed)");
      }

      // Every completed pass REPLACES the staged set (one per workspace):
      // stale proposals from an older trajectory must not linger behind a
      // newer no-op result.
      if (result.stagedEdits.length > 0) {
        await saveStagedRefineSet(sessionDir, {
          version: 1,
          workspaceId,
          createdAt: Date.now(),
          summary,
          edits: result.stagedEdits,
        });
      } else {
        await clearStagedRefineSet(sessionDir);
      }

      // Completion UX: post the labeled proposal row ONLY when edits were
      // staged — a no-op stays out of chat (the invoking toast reports it).
      // The row renders the exact staged payloads and carries their hash so
      // apply can bind approval to these bytes.
      if (!record.noOp) {
        const proposalDurable = await this.appendSummaryMessage(workspaceId, record, {
          mode: "staged",
          edits: result.stagedEdits,
          stagedSetHash: hashStagedRefineSet(result.stagedEdits),
        });
        // Approval is hash-bound to this rendered row; without it apply fails
        // closed ("no staged refine proposal found"). Reporting staged
        // success here would leave the user a dead end.
        if (!proposalDurable) {
          return Err(
            "edits were staged, but the proposal row could not be recorded in chat for " +
              "approval; run /refine again to restage"
          );
        }
      }
      return Ok(record);
    } finally {
      // Providers can attach cleanup hooks (e.g. an OpenAI Responses
      // WebSocket transport); without this, repeated /refine runs accumulate
      // live transports. Same posture as the other headless model consumers
      // (branchSummary, workspaceTitleGenerator).
      runLanguageModelCleanup(modelResult.data.model);
    }
  }

  /** Newest journal seq, or -1 for a fresh/absent journal. */
  private async readMaxJournalSeq(sessionDir: string): Promise<number> {
    const events = await sharedDurableEventJournal(sessionDir).read();
    return events.reduce((max, event) => Math.max(max, event.seq), -1);
  }

  /**
   * Journal refinement rows appended after baselineSeq whose evidence
   * correlates to one of the given staged tool calls (see applyLocked's
   * baseline comment for why both filters are required).
   */
  private async listStagedRefinementRows(
    sessionDir: string,
    workspaceId: string,
    baselineSeq: number,
    toolCallIds: string[]
  ): Promise<Array<{ row: RefinementEvent; toolCallId: string }>> {
    if (toolCallIds.length === 0) return [];
    const callIds = new Set(toolCallIds);
    const rows = await listRefinements(sessionDir);
    const matched: Array<{ row: RefinementEvent; toolCallId: string }> = [];
    for (const row of rows) {
      if (row.seq <= baselineSeq || row.workspaceId !== workspaceId) continue;
      const evidence = RefinementEvidenceSchema.safeParse(row.data.evidence);
      if (!evidence.success) continue;
      if (evidence.data.toolCallId === undefined || !callIds.has(evidence.data.toolCallId)) {
        continue;
      }
      matched.push({ row, toolCallId: evidence.data.toolCallId });
    }
    return matched;
  }

  /**
   * Standard agent_skill_write tool confined to the workspace checkout's
   * .xum/skills (project scope). Only for host-local single-project
   * workspaces: remote runtimes would need a live runtime connection and
   * multi-project workspaces have no single skills root. Memory scopes remain
   * available either way. Returns undefined (memory-only pass) on any
   * resolution failure — never fails the run.
   */
  private async buildSkillWriteTool(
    workspaceId: string,
    sessionDir: string
  ): Promise<Tool | undefined> {
    try {
      const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) return undefined;
      const metadata = metadataResult.data;
      const runtimeType = metadata.runtimeConfig.type;
      if (runtimeType === "ssh" || runtimeType === "docker") return undefined;
      if ((metadata.projects?.length ?? 0) > 1) return undefined;
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) return undefined;
      const projectRoot = workspace.workspacePath;

      // Minimal host-local ToolConfiguration: the project-local skill path
      // only touches fs/promises under xumScope roots; workspaceSessionDir +
      // workspaceId make the tool's r2 refinement journaling land in this
      // session's durable journal.
      const toolConfig: ToolConfiguration = {
        cwd: projectRoot,
        runtime: new LocalRuntime(projectRoot),
        runtimeTempDir: os.tmpdir(),
        workspaceSessionDir: sessionDir,
        workspaceId,
        xumScope: {
          type: "project",
          xumHome: this.config.rootDir,
          projectRoot,
          projectStorageAuthority: "host-local",
        },
      };
      return createAgentSkillWriteTool(toolConfig);
    } catch (error) {
      log.debug("[Refine] skill tool unavailable; running memory-only", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return undefined;
    }
  }

  /** Timeline digest when the Timeline experiment is on; undefined otherwise. */
  private async buildTimelineText(workspaceId: string): Promise<string | undefined> {
    if (!this.experiments.isExperimentEnabled(EXPERIMENT_IDS.TIMELINE)) return undefined;
    if (this.options.timelineService === undefined) return undefined;
    try {
      const page = await this.options.timelineService.list(workspaceId, {
        limit: REFINE_TIMELINE_EVENT_LIMIT,
      });
      if (page.events.length === 0) return undefined;
      // list() returns newest-first; present oldest-first for the model.
      return [...page.events]
        .reverse()
        .map((event) => {
          const description = event.data?.description ?? event.data?.digest ?? "";
          return `${new Date(event.ts).toISOString()} ${event.kind}${
            description.length > 0 ? `: ${description}` : ""
          }`;
        })
        .join("\n");
    } catch (error) {
      log.debug("[Refine] timeline read failed; continuing without it", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return undefined;
    }
  }

  /**
   * Append + emit the summary row. Returns true only when the row is durably
   * appended (renderer emission stays best-effort): both callers depend on
   * the row's existence — the applied-mode audit row is the sole durable
   * record of the rollback IDs, and the staged-mode proposal row is the
   * hash-bound approval affordance apply verifies against — so a swallowed
   * append failure must be distinguishable from success.
   */
  private async appendSummaryMessage(
    workspaceId: string,
    record: RefineRecord,
    mode: Parameters<typeof createRefineSummaryMessage>[1]
  ): Promise<boolean> {
    try {
      const message = createRefineSummaryMessage(record, mode);
      const appendResult = await this.historyService.appendToHistory(workspaceId, message);
      if (!appendResult.success) {
        log.warn("[Refine] failed to append summary row", {
          workspaceId,
          error: appendResult.error,
        });
        return false;
      }
      try {
        this.options.emitChatMessage?.(workspaceId, message);
      } catch (error) {
        // The row is durable; a renderer-emission failure only delays its
        // visibility until reload and must not fail the operation.
        log.warn("[Refine] summary emission failed", {
          workspaceId,
          error: getErrorMessage(error),
        });
      }
      return true;
    } catch (error) {
      log.warn("[Refine] summary emission failed", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }
}
