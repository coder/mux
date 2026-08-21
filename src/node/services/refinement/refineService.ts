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
  REFINE_MAX_MESSAGES,
  REFINE_OP_BUDGET,
  REFINE_SUMMARY_LABEL,
  REFINE_TIMELINE_EVENT_LIMIT,
  REFINE_TIMEOUT_MS,
} from "@/constants/refine";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { buildAbandonedBranchTranscript, isRlmModeEnabled } from "@/node/services/branchSummary";
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
      lines.push(
        `- [staged ${index + 1}/${mode.edits.length}] ${edit.description}`,
        "",
        "```json",
        JSON.stringify(edit.input, null, 2),
        "```",
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

  private enabled(): boolean {
    // RLM is a sub-experiment of Programmatic Tool Calling; both machine
    // overrides must be on (same fallback path as backend-initiated branch
    // summaries — /refine has no send options to ride on).
    return isRlmModeEnabled(undefined, (id) => this.experiments.isExperimentEnabled(id));
  }

  async run(workspaceId: string): Promise<Result<RefineRecord, string>> {
    if (!this.enabled()) {
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
  async apply(workspaceId: string): Promise<Result<RefineRecord, string>> {
    if (!this.enabled()) {
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
    }

    let succeeded = 0;
    for (const edit of staged.edits) {
      // Applied (or at least attempted) before a crash: never replay.
      if (attempted.has(edit.toolCallId)) continue;
      try {
        const tool = edit.tool === "memory" ? memoryTool : skillWriteTool;
        if (tool === undefined || typeof tool.execute !== "function") {
          log.warn("[Refine] staged edit skipped: tool unavailable at apply time", {
            workspaceId,
            tool: edit.tool,
          });
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
          continue;
        }
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
          succeeded += 1;
        }
      } catch (error) {
        log.warn("[Refine] staged edit failed to apply", {
          workspaceId,
          tool: edit.tool,
          error: getErrorMessage(error),
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
    // Consume the staged set regardless of per-edit outcomes so a re-run of
    // apply can never double-apply; failures were reported above and a fresh
    // /refine can restage.
    await clearStagedRefineSet(sessionDir);

    const applied = await this.collectAppliedEdits(
      sessionDir,
      workspaceId,
      baselineSeq,
      staged.edits.map((edit) => edit.toolCallId)
    );
    // Journal acknowledgement can fail while the mutation itself succeeded
    // (appendRefinementEvent swallows journal/blob failures by design so
    // user-facing writes stay self-healing). Those edits are real — files
    // changed with no rollback id — so they must be reported, never
    // classified as a no-op. The tools' own success results are the ground
    // truth; anything applied beyond the journaled rows is untracked.
    const untrackedApplied = Math.max(0, succeeded - applied.length);
    const record: RefineRecord = {
      applied,
      summary: staged.summary,
      noOp: applied.length === 0 && untrackedApplied === 0,
      ...(untrackedApplied > 0 ? { untrackedApplied } : {}),
    };

    log.debug("[Refine] apply complete", {
      workspaceId,
      staged: staged.edits.length,
      applied: applied.length,
      untrackedApplied,
    });

    // No cancellation gate here (unlike runLocked): an admitted apply's
    // audit row — the only durable record of the rollback IDs — must persist
    // even when removal is racing. Removal awaits this promise before
    // deleting the session directory, so the append still precedes teardown.
    if (!record.noOp) {
      await this.appendSummaryMessage(workspaceId, record, { mode: "applied" });
    }
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
        await this.appendSummaryMessage(workspaceId, record, {
          mode: "staged",
          edits: result.stagedEdits,
          stagedSetHash: hashStagedRefineSet(result.stagedEdits),
        });
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

  private async collectAppliedEdits(
    sessionDir: string,
    workspaceId: string,
    baselineSeq: number,
    toolCallIds: string[]
  ): Promise<RefineAppliedEdit[]> {
    if (toolCallIds.length === 0) return [];
    const callIds = new Set(toolCallIds);
    const rows = await listRefinements(sessionDir);
    const applied: RefineAppliedEdit[] = [];
    for (const row of rows) {
      if (row.seq <= baselineSeq || row.workspaceId !== workspaceId) continue;
      const evidence = RefinementEvidenceSchema.safeParse(row.data.evidence);
      if (!evidence.success) continue;
      if (evidence.data.toolCallId === undefined || !callIds.has(evidence.data.toolCallId)) {
        continue;
      }
      applied.push({ refinementId: row.id, description: describeRefinementRow(row) });
    }
    return applied;
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

  /** Best-effort: append + emit the summary row; failures log and continue. */
  private async appendSummaryMessage(
    workspaceId: string,
    record: RefineRecord,
    mode: Parameters<typeof createRefineSummaryMessage>[1]
  ): Promise<void> {
    try {
      const message = createRefineSummaryMessage(record, mode);
      const appendResult = await this.historyService.appendToHistory(workspaceId, message);
      if (!appendResult.success) {
        log.warn("[Refine] failed to append summary row", {
          workspaceId,
          error: appendResult.error,
        });
        return;
      }
      this.options.emitChatMessage?.(workspaceId, message);
    } catch (error) {
      log.warn("[Refine] summary emission failed", {
        workspaceId,
        error: getErrorMessage(error),
      });
    }
  }
}
