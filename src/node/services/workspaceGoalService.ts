import * as fs from "fs/promises";
import * as path from "path";
import writeFileAtomic from "write-file-atomic";
import assert from "@/common/utils/assert";
import {
  toGoalSnapshot,
  toPendingGoalSnapshot,
  type GoalRecordV1,
  type GoalSetError,
  type GoalSnapshot,
  type GoalStatus,
} from "@/common/types/goal";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import type { Workspace } from "@/common/types/project";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { GoalRecordV1Schema } from "@/common/orpc/schemas/goal";
import { createMuxMessage, pickStartupRetrySendOptions } from "@/common/types/message";
import type { ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import { isWorkspaceArchived } from "@/common/utils/archive";
import {
  hasBudgetedResumableGoal,
  hasGoalBudgetLimit,
  modelHasPricingData,
  normalizeGoalBudgetCents,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
import type { SendMessageError } from "@/common/types/errors";
import type { Config } from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import {
  DEFAULT_GOAL_CONTINUATION_COOLDOWN_MS,
  GOAL_BUDGET_LIMIT_KIND,
  GOAL_CONTINUATION_IDLE_CONSUMER_NAME,
  GOAL_CONTINUATION_IDLE_CONSUMER_PRIORITY,
  GOAL_CONTINUATION_KIND,
  type GoalSyntheticMessageKind,
} from "@/constants/goals";
import { buildGoalBudgetLimitMessage, buildGoalContinuationMessage } from "@/constants/goalPrompts";
import type { IdleDispatcher, IdleDispatchPayload } from "./idleDispatcher";
import { log } from "./log";

const GOAL_FILE = "goal.json";
const PENDING_GOAL_EDIT_MESSAGE =
  "Goal is still being saved. Wait for the current stream to finish before editing it.";

const MICRO_CENTS_PER_CENT = 1_000_000;

function costUsdToMicroCents(costUsd: number | null | undefined): number {
  return Math.max(0, Math.round((costUsd ?? 0) * 100 * MICRO_CENTS_PER_CENT));
}

/**
 * Returns the goal's accumulated cost in micro-cents, falling back to the
 * coarser `costCents` field for goals persisted before micro-cent tracking
 * was added.
 */
function getGoalCostMicroCents(goal: GoalRecordV1): number {
  return goal.costMicroCents ?? goal.costCents * MICRO_CENTS_PER_CENT;
}

type GoalLifecycleEvent =
  | "goal_created"
  | "goal_replaced"
  | "goal_cleared"
  | "goal_paused"
  | "goal_resumed"
  | "goal_completed"
  | "goal_budget_changed"
  | "goal_budget_limited"
  | "goal_continuation_fired"
  | "goal_wrapup_fired"
  | "goal_crash_gate_set";

type GoalLifecycleProperties = Record<string, string | number | boolean | null>;
type GoalLifecycleInitiator = "user" | "model" | "auto";

export interface GoalLifecycleAnalyticsSink {
  recordGoalLifecycleEvent(event: GoalLifecycleEvent, properties: GoalLifecycleProperties): void;
}

export interface SetGoalInput {
  workspaceId: string;
  objective?: string | null;
  status?: GoalStatus | null;
  budgetCents?: number | null;
  turnCap?: number | null;
  completionSummary?: string | null;
  expectedGoalId?: string | null;
  requireUserAcknowledgmentSinceMs?: number | null;
  initiator?: GoalLifecycleInitiator;
}

export type GoalContinuationSkipReason =
  | "not_registered"
  | "no_pending_candidate"
  | "experiment_disabled"
  | "workspace_not_found"
  | "archived"
  | "transcript_only"
  | "initializing"
  | "incompatible_runtime"
  | "child_workspace"
  | "active_descendant_tasks"
  | "currently_streaming"
  | "queued_user_input"
  | "pending_follow_up"
  | "plan_mode"
  | "compact_mode"
  | "user_stop"
  | "goal_missing"
  | "goal_mismatch"
  | "goal_not_active"
  | "requires_ack"
  | "budget_wrapup_already_fired"
  | "budget_wrapup_suppressed"
  | "cooldown";

export interface GoalContinuationRuntimeState {
  isInitializing?: boolean;
  isRuntimeCompatible?: boolean;
  isBusy?: boolean;
  hasQueuedMessages?: boolean;
  hasPendingFollowUp?: boolean;
}

export interface GoalContinuationRuntimeBridge {
  isGoalExperimentEnabled(): boolean;
  hasActiveDescendantTasks(workspaceId: string): boolean;
  getRuntimeState(workspaceId: string): GoalContinuationRuntimeState;
  executeGoalContinuation(input: {
    workspaceId: string;
    message: string;
    options: SendMessageOptions;
    kind?: GoalSyntheticMessageKind;
  }): Promise<boolean>;
  /**
   * Build default SendMessageOptions for a kickoff continuation that is armed
   * outside of a stream-end (e.g. when the user resumes a paused goal on an
   * idle workspace). Returns null when defaults can't be derived.
   */
  getKickoffSendOptions?(workspaceId: string): SendMessageOptions | null;
}

interface PendingGoalContinuationCandidate {
  goalId: string;
  requestedAtMs: number;
  streamEndedAtMs: number;
  sendOptions: SendMessageOptions;
}

interface GoalContinuationEligibilityResult {
  eligible: boolean;
  reason?: GoalContinuationSkipReason;
  goal?: GoalRecordV1;
  candidate?: PendingGoalContinuationCandidate;
  lastStreamStamp?: GoalStreamStamp;
  deferUntilMs?: number;
}

interface PendingGoalMutation {
  objective: string;
  budgetCents?: number | null;
  turnCap?: number | null;
  status?: GoalStatus | null;
  completionSummary?: string | null;
  expectedGoalId?: string | null;
  initiator?: GoalLifecycleInitiator;
}

export type GoalStreamOriginKind = "goal_continuation" | "goal_budget_limit" | "user" | "other";

interface GoalStreamStamp {
  originKind: GoalStreamOriginKind;
  sequence: number;
  goalId: string | null;
}

interface StreamAccountingInput {
  workspaceId: string;
  /** Total cost attributable to this stream from start (cumulative for previews, final for records). */
  costUsd?: number | null;
  isCompaction?: boolean;
  streamStartedAtMs?: number | null;
  streamOriginKind?: GoalStreamOriginKind;
}

export interface ChildReportAttributionInput {
  parentWorkspaceId: string;
  childWorkspaceId: string;
  childCostCents: number;
}

export interface ChildReportAttributionResult {
  goalBefore: GoalRecordV1;
  goalAfter: GoalRecordV1;
  attributed: boolean;
  causedBudgetLimit: boolean;
}

function skippedChildAttribution(goal: GoalRecordV1): ChildReportAttributionResult {
  return {
    goalBefore: goal,
    goalAfter: goal,
    attributed: false,
    causedBudgetLimit: false,
  };
}

export class WorkspaceGoalChildWorkspaceError extends Error {
  readonly code = "GOAL_CHILD_WORKSPACE";

  constructor(workspaceId: string) {
    super(
      `Workspace ${workspaceId} is a child task workspace. Goals can only be set on parent workspaces.`
    );
    this.name = "WorkspaceGoalChildWorkspaceError";
  }
}

export class WorkspaceGoalTransitionError extends Error {
  readonly code = "GOAL_INVALID_TRANSITION";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGoalTransitionError";
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function lengthBucket(length: number): string {
  if (length < 10) return "0-9";
  if (length < 50) return "10-49";
  if (length < 100) return "50-99";
  return "100+";
}

function centsBucket(cents: number): string {
  if (cents === 0) return "0";
  if (cents < 100) return "1-99";
  if (cents < 1_000) return "100-999";
  return "1000+";
}

function countBucket(count: number): string {
  if (count === 0) return "0";
  if (count < 10) return "1-9";
  if (count < 100) return "10-99";
  return "100+";
}

/**
 * Local helper kept bare-decimal because the only call site (clear summary)
 * embeds it in a template literal that already supplies the `$` prefix.
 * Distinct from the shared `formatGoalCents` in `budgetPricing.ts` (which is
 * dollar-prefixed); callers that want the prefixed form must import from
 * there rather than defining a local copy.
 */
function formatCentsBare(cents: number): string {
  return (cents / 100).toFixed(2);
}

function actionForStatus(status: GoalStatus): "pause" | "resume" | "complete" {
  if (status === "active") {
    return "resume";
  }
  if (status === "complete") {
    return "complete";
  }
  return "pause";
}

function completionSummaryPatch(
  status: GoalStatus | null | undefined,
  completionSummary: string | null
): Pick<GoalRecordV1, "completionSummary"> | Record<string, never> {
  if (status === "complete" && completionSummary != null) {
    return { completionSummary };
  }
  if (status != null && status !== "complete") {
    return { completionSummary: undefined };
  }
  return {};
}

/**
 * Whitelist the model/agent configuration carried into synthetic continuations.
 *
 * The prior turn's full `SendMessageOptions` may carry payload-adjacent fields
 * (e.g. attachments at the IPC boundary, edit/correlation ids, mux metadata)
 * that should never be re-sent on auto-continuations:
 *  - re-sending attachments inflates cost and can hit per-request limits.
 *  - replaying `editMessageId` / `acpPromptId` / `muxMetadata` retargets the
 *    synthetic message at the wrong turn or breaks ACP correlation.
 *
 * `pickStartupRetrySendOptions` already encodes the canonical whitelist used
 * for crash-recovery retries, so reuse it here.
 */
function continuationSendOptions(sendOptions: SendMessageOptions): SendMessageOptions {
  return pickStartupRetrySendOptions(sendOptions) as SendMessageOptions;
}

export class WorkspaceGoalService {
  private readonly fileLocks = workspaceFileLocks;
  private readonly pendingGoalMutations = new Map<string, PendingGoalMutation>();
  private readonly pendingGoalSnapshots = new Map<string, GoalSnapshot>();

  private pendingContinuationCandidates = new Map<string, PendingGoalContinuationCandidate>();
  private continuationReRequestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastUserStopAtMsByWorkspace = new Map<string, number>();
  private recordedStreamStartedAtMsByWorkspace = new Map<string, number>();
  private lastGoalStreamStamps = new Map<string, GoalStreamStamp>();
  private nextGoalStreamStampSequence = 1;
  private goalContinuationBridge: GoalContinuationRuntimeBridge | null = null;
  private goalContinuationDispatcher: IdleDispatcher | null = null;
  private goalContinuationConsumerDisposer: (() => void) | null = null;

  private onActivityChange?: (workspaceId: string, snapshot: WorkspaceActivitySnapshot) => void;

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly extensionMetadata: ExtensionMetadataService,
    private readonly analytics?: GoalLifecycleAnalyticsSink
  ) {}

  setOnActivityChange(
    listener: (workspaceId: string, snapshot: WorkspaceActivitySnapshot) => void
  ): void {
    this.onActivityChange = listener;
  }

  private getFilePath(workspaceId: string): string {
    assert(workspaceId.trim().length > 0, "WorkspaceGoalService requires non-empty workspaceId");
    return path.join(this.config.getSessionDir(workspaceId), GOAL_FILE);
  }

  private createGoal(input: {
    objective: string;
    budgetCents: number | null;
    turnCap: number | null;
    status?: GoalStatus | null;
    completionSummary?: string | null;
  }): GoalRecordV1 {
    const now = Date.now();
    const status = input.status ?? "active";
    const goal = GoalRecordV1Schema.parse({
      version: 1,
      goalId: crypto.randomUUID(),
      objective: input.objective,
      status,
      budgetCents: normalizeGoalBudgetCents(input.budgetCents),
      turnCap: input.turnCap,
      costCents: 0,
      costMicroCents: 0,
      turnsUsed: 0,
      attributedChildren: [],
      budgetLimitInjectedForGoalId: null,
      requireUserAcknowledgmentSinceMs: null,
      lastContinuationFiredAtMs: null,
      ...(input.completionSummary != null
        ? { completionSummary: input.completionSummary.trim() }
        : {}),
      createdAtMs: now,
      updatedAtMs: now,
    });
    return status === "active" ? this.applyBudgetDrivenStatus(goal) : goal;
  }

  private async writeGoal(workspaceId: string, goal: GoalRecordV1): Promise<void> {
    const filePath = this.getFilePath(workspaceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, `${JSON.stringify(goal, null, 2)}\n`, "utf-8");
  }

  private async renameCorruptGoal(
    workspaceId: string,
    filePath: string,
    error: unknown
  ): Promise<void> {
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      await fs.rename(filePath, corruptPath);
    } catch (renameError) {
      if (!isNotFound(renameError)) {
        log.warn("Failed to rename corrupt goal.json", { workspaceId, error: renameError });
      }
    }
    log.warn("Ignoring corrupt goal.json", { workspaceId, corruptPath, error });
    await this.pushSnapshot(workspaceId, null);
  }

  private async readGoalFile(workspaceId: string): Promise<GoalRecordV1 | null> {
    const filePath = this.getFilePath(workspaceId);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }

    try {
      return GoalRecordV1Schema.parse(JSON.parse(raw));
    } catch (error) {
      await this.renameCorruptGoal(workspaceId, filePath, error);
      return null;
    }
  }

  private async pushSnapshot(
    workspaceId: string,
    goal: GoalRecordV1 | null
  ): Promise<GoalSnapshot | null> {
    const snapshot = goal ? toGoalSnapshot(goal) : null;
    const activity = await this.extensionMetadata.setGoal(workspaceId, snapshot);
    this.onActivityChange?.(workspaceId, activity);
    return snapshot;
  }

  private async pushTransientGoalSnapshot(
    workspaceId: string,
    snapshot: GoalSnapshot
  ): Promise<void> {
    const activity = await this.extensionMetadata.getSnapshot(workspaceId);
    if (activity) {
      this.onActivityChange?.(workspaceId, {
        ...activity,
        goal: snapshot,
        transientGoalOnly: true,
      });
    }
  }

  private async publishPendingGoalSnapshot(workspaceId: string, goal: GoalRecordV1): Promise<void> {
    const snapshot = toPendingGoalSnapshot(goal);
    this.pendingGoalSnapshots.set(workspaceId, snapshot);
    await this.pushTransientGoalSnapshot(workspaceId, snapshot);
  }

  private async pushGoalReadSnapshot(
    workspaceId: string,
    goal: GoalRecordV1 | null
  ): Promise<GoalSnapshot | null> {
    const pendingSnapshot = this.pendingGoalSnapshots.get(workspaceId);
    if (pendingSnapshot) {
      // Goal reads keep activity snapshots warm, but mid-stream queued goals
      // must keep showing the transient replacement until stream-end persistence.
      await this.pushTransientGoalSnapshot(workspaceId, pendingSnapshot);
      return pendingSnapshot;
    }
    return this.pushSnapshot(workspaceId, goal);
  }

  private async restorePersistedGoalSnapshot(workspaceId: string): Promise<void> {
    try {
      await this.fileLocks.withLock(workspaceId, async () => {
        const current = await this.readGoalFile(workspaceId);
        await this.pushSnapshot(workspaceId, current);
      });
    } catch (error) {
      log.warn("Failed to restore persisted goal snapshot", { workspaceId, error });
    }
  }

  private assertParentWorkspace(workspaceId: string): void {
    const workspace = this.config.findWorkspace(workspaceId);
    if (workspace?.parentWorkspaceId != null) {
      throw new WorkspaceGoalChildWorkspaceError(workspaceId);
    }
  }

  private emitLifecycle(event: GoalLifecycleEvent, properties: GoalLifecycleProperties): void {
    try {
      this.analytics?.recordGoalLifecycleEvent(event, properties);
    } catch (error) {
      log.warn("Failed to record goal lifecycle event", { event, error });
    }
  }

  private async isWorkspaceStreaming(workspaceId: string): Promise<boolean> {
    const snapshot = await this.extensionMetadata.getSnapshot(workspaceId);
    return snapshot?.streaming === true;
  }

  /**
   * Returns true when the GOALS experiment is enabled at the bridge layer.
   * Used as a hot-path short-circuit so users with the experiment off do
   * not pay disk I/O cost (goal.json read + extensionMetadata write) on
   * every stream-end (Coder-agents-review P3 DEREM-19).
   *
   * Returns false when no bridge is registered yet (e.g. headless tests
   * that never wire continuations); callers should default-deny in that
   * case to keep the off-experiment runtime cost truly identical to main.
   */
  isExperimentEnabled(): boolean {
    return this.goalContinuationBridge?.isGoalExperimentEnabled() ?? false;
  }

  registerGoalContinuationConsumer(
    idleDispatcher: IdleDispatcher,
    bridge: GoalContinuationRuntimeBridge
  ): () => void {
    assert(idleDispatcher, "registerGoalContinuationConsumer requires an idle dispatcher");
    assert(bridge, "registerGoalContinuationConsumer requires a runtime bridge");
    assert(
      this.goalContinuationConsumerDisposer == null,
      "goal continuation idle consumer is already registered"
    );

    this.goalContinuationBridge = bridge;
    this.goalContinuationDispatcher = idleDispatcher;
    this.goalContinuationConsumerDisposer = idleDispatcher.registerConsumer({
      name: GOAL_CONTINUATION_IDLE_CONSUMER_NAME,
      priority: GOAL_CONTINUATION_IDLE_CONSUMER_PRIORITY,
      buildPayload: (workspaceId) => this.buildGoalContinuationPayload(workspaceId),
    });

    return () => {
      this.goalContinuationConsumerDisposer?.();
      this.goalContinuationConsumerDisposer = null;
      this.goalContinuationBridge = null;
      this.goalContinuationDispatcher = null;
      for (const timer of this.continuationReRequestTimers.values()) {
        clearTimeout(timer);
      }
      this.continuationReRequestTimers.clear();
    };
  }

  private getPricedContinuationSendOptions(
    workspaceId: string,
    goal: GoalRecordV1,
    sendOptions: SendMessageOptions
  ): SendMessageOptions | null {
    const normalized = continuationSendOptions(sendOptions);
    if (!hasBudgetedResumableGoal(goal)) {
      return normalized;
    }
    const providersConfig = this.getProvidersConfigForPricing();
    if (modelHasPricingData(normalized.model, providersConfig)) {
      return normalized;
    }
    const kickoff = this.goalContinuationBridge?.getKickoffSendOptions?.(workspaceId);
    if (!kickoff || kickoff.agentId === "plan" || kickoff.agentId === "compact") {
      return null;
    }
    const fallback = continuationSendOptions(kickoff);
    return modelHasPricingData(fallback.model, providersConfig) ? fallback : null;
  }

  async requestContinuationAfterStreamEnd(input: {
    workspaceId: string;
    sendOptions: SendMessageOptions;
    streamEndedAtMs?: number;
  }): Promise<void> {
    assert(
      input.workspaceId.trim().length > 0,
      "requestContinuationAfterStreamEnd requires workspaceId"
    );
    if (this.goalContinuationDispatcher == null) {
      return;
    }
    // Hot-path experiment gate (Coder-agents-review P3 DEREM-37, sibling to
    // DEREM-19). Without this, every non-compaction stream-end pays the
    // disk cost of `getGoal` (goal.json read + extensionMetadata write)
    // even for users with the GOALS experiment off, breaking the
    // off-experiment runtime invariant. The bridge is the source of truth
    // for whether the experiment is on; default-deny when unset.
    if (!this.isExperimentEnabled()) {
      return;
    }

    const goal = await this.getGoal(input.workspaceId);
    if (goal?.status !== "active" && goal?.status !== "budget_limited") {
      this.pendingContinuationCandidates.delete(input.workspaceId);
      return;
    }

    const sendOptions = this.getPricedContinuationSendOptions(
      input.workspaceId,
      goal,
      input.sendOptions
    );
    if (!sendOptions) {
      this.pendingContinuationCandidates.delete(input.workspaceId);
      return;
    }

    const streamEndedAtMs = input.streamEndedAtMs ?? Date.now();
    this.pendingContinuationCandidates.set(input.workspaceId, {
      goalId: goal.goalId,
      requestedAtMs: Date.now(),
      streamEndedAtMs,
      sendOptions,
    });
    await this.goalContinuationDispatcher.requestDispatch(
      input.workspaceId,
      GOAL_CONTINUATION_IDLE_CONSUMER_NAME
    );
  }

  async recordUserStoppedStream(workspaceId: string, stoppedAtMs = Date.now()): Promise<void> {
    assert(workspaceId.trim().length > 0, "recordUserStoppedStream requires workspaceId");
    assert(Number.isFinite(stoppedAtMs) && stoppedAtMs >= 0, "user stop timestamp must be valid");
    this.lastUserStopAtMsByWorkspace.set(workspaceId, stoppedAtMs);
    this.pendingContinuationCandidates.delete(workspaceId);
    this.pendingGoalSnapshots.delete(workspaceId);
    // Drop queued goal mutations too (Coder-agents-review P2 DEREM-18). If a
    // user sets a goal mid-stream then stops the stream, the mutation would
    // otherwise stay queued and apply on the NEXT stream's stream-end via
    // applyPendingAfterStreamEnd, writing goal.json with createdAtMs > the
    // userStopAtMs gate — auto-continuation would then fire in a context the
    // user did not intend (the stop was meant to discard the goal change).
    const hadPendingGoalMutation = this.pendingGoalMutations.delete(workspaceId);

    await this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (current?.status !== "active" && current?.status !== "budget_limited") {
        // Mid-stream /goal now publishes an optimistic activity snapshot so the
        // Goal panel opens immediately. If the user aborts that stream, revert
        // the panel to the persisted goal file (or null) along with dropping the
        // queued mutation.
        if (hadPendingGoalMutation) {
          await this.pushSnapshot(workspaceId, current);
        }
        return;
      }
      const next = GoalRecordV1Schema.parse({
        ...current,
        requireUserAcknowledgmentSinceMs: Math.floor(stoppedAtMs),
        updatedAtMs: Date.now(),
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
    });
  }

  async buildGoalContinuationPayload(workspaceId: string): Promise<IdleDispatchPayload | null> {
    const eligibility = await this.checkGoalContinuationEligibility(workspaceId, Date.now());
    if (!eligibility.eligible) {
      log.info("WorkspaceGoalService: skipped goal continuation", {
        workspaceId,
        reason: eligibility.reason,
      });
      if (eligibility.deferUntilMs != null) {
        this.scheduleContinuationReRequest(workspaceId, eligibility.deferUntilMs);
        return null;
      }
      return null;
    }

    const { goal, candidate } = eligibility;
    assert(goal != null, "eligible goal continuation requires a goal");
    assert(candidate != null, "eligible goal continuation requires a pending candidate");

    if (goal.status === "budget_limited") {
      const lastStreamStamp = eligibility.lastStreamStamp;
      assert(lastStreamStamp != null, "eligible budget wrap-up requires a stream stamp");
      const message = buildGoalBudgetLimitMessage(goal);
      return {
        dispatch: async () => {
          // Send first, mark only on accept. If sendMessage rejects transiently
          // (e.g. requireIdle fails because a new turn started), we want a future
          // dispatch to retry — we must not permanently flip
          // budgetLimitInjectedForGoalId or the goal gets stuck in budget_limited
          // with no wrap-up. Mirrors the active-continuation path below.
          const accepted = await this.goalContinuationBridge?.executeGoalContinuation({
            workspaceId,
            message,
            options: candidate.sendOptions,
            kind: GOAL_BUDGET_LIMIT_KIND,
          });
          if (accepted !== true) {
            this.scheduleContinuationReRequest(workspaceId, Date.now() + 1_000);
            return;
          }
          const reserved = await this.tryMarkBudgetLimitInjected(
            workspaceId,
            goal.goalId,
            lastStreamStamp
          );
          if (reserved) {
            this.emitBudgetWrapupFired(reserved, Date.now());
          }
          this.deletePendingCandidateIfStillSame(workspaceId, candidate);
        },
      };
    }

    assert(goal.status === "active", "goal idle payload requires active or budget-limited goal");
    const message = buildGoalContinuationMessage(goal);
    return {
      dispatch: async () => {
        const accepted = await this.goalContinuationBridge?.executeGoalContinuation({
          workspaceId,
          message,
          options: candidate.sendOptions,
          kind: GOAL_CONTINUATION_KIND,
        });
        if (accepted !== true) {
          this.scheduleContinuationReRequest(workspaceId, Date.now() + 1_000);
          return;
        }
        await this.recordContinuationFired(workspaceId, goal.goalId, Date.now());
        this.deletePendingCandidateIfStillSame(workspaceId, candidate);
      },
    };
  }

  /**
   * Delete the pending continuation candidate for a workspace ONLY if the map
   * entry still references the same candidate this dispatch closure captured.
   *
   * Between executeGoalContinuation returning true and the cleanup
   * delete, two file-lock awaits yield the event loop
   * (tryMarkBudgetLimitInjected / recordContinuationFired). If the
   * continuation stream fails immediately and the stream-end handler writes a
   * NEW candidate during the yield, an unconditional delete-by-key would drop
   * that fresh candidate — the next dispatch cycle would then find no
   * candidate and skip silently (Coder-agents-review P2 DEREM-17).
   *
   * Reference equality is the simplest correct guard: each pending candidate
   * is a distinct object, so identity checks against the captured closure
   * variable cannot collide with a concurrently-written replacement.
   */
  private deletePendingCandidateIfStillSame(
    workspaceId: string,
    candidate: PendingGoalContinuationCandidate
  ): void {
    if (this.pendingContinuationCandidates.get(workspaceId) === candidate) {
      this.pendingContinuationCandidates.delete(workspaceId);
    }
  }

  async checkGoalContinuationEligibility(
    workspaceId: string,
    nowMs: number
  ): Promise<GoalContinuationEligibilityResult> {
    assert(workspaceId.trim().length > 0, "checkGoalContinuationEligibility requires workspaceId");
    assert(Number.isFinite(nowMs) && nowMs >= 0, "checkGoalContinuationEligibility requires nowMs");

    const candidate = this.pendingContinuationCandidates.get(workspaceId);
    if (!candidate) {
      return { eligible: false, reason: "no_pending_candidate" };
    }
    const bridge = this.goalContinuationBridge;
    if (!bridge) {
      return { eligible: false, reason: "not_registered" };
    }
    if (!bridge.isGoalExperimentEnabled()) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "experiment_disabled" };
    }

    const workspace = this.findWorkspaceConfigEntry(workspaceId);
    if (!workspace) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "workspace_not_found" };
    }
    if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "archived" };
    }
    if (!workspace.path) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "transcript_only" };
    }
    if (workspace.parentWorkspaceId != null) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "child_workspace" };
    }
    if (bridge.hasActiveDescendantTasks(workspaceId)) {
      return { eligible: false, reason: "active_descendant_tasks" };
    }

    const runtimeState = bridge.getRuntimeState(workspaceId);
    if (runtimeState.isInitializing === true) {
      return { eligible: false, reason: "initializing", deferUntilMs: nowMs + 1_000 };
    }
    if (runtimeState.isRuntimeCompatible === false) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "incompatible_runtime" };
    }
    if (runtimeState.isBusy === true || (await this.isWorkspaceStreaming(workspaceId))) {
      return { eligible: false, reason: "currently_streaming", deferUntilMs: nowMs + 1_000 };
    }
    if (runtimeState.hasQueuedMessages === true) {
      return { eligible: false, reason: "queued_user_input" };
    }
    if (runtimeState.hasPendingFollowUp === true) {
      return { eligible: false, reason: "pending_follow_up" };
    }
    if (candidate.sendOptions.agentId === "plan" || candidate.sendOptions.mode === "plan") {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "plan_mode" };
    }
    if (candidate.sendOptions.agentId === "compact" || candidate.sendOptions.mode === "compact") {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "compact_mode" };
    }

    const userStopAtMs = this.lastUserStopAtMsByWorkspace.get(workspaceId);
    if (userStopAtMs != null) {
      const goalForStopCheck = await this.readGoalFile(workspaceId);
      if (!goalForStopCheck) {
        this.pendingContinuationCandidates.delete(workspaceId);
        return { eligible: false, reason: "goal_missing" };
      }
      if (userStopAtMs >= goalForStopCheck.createdAtMs) {
        this.pendingContinuationCandidates.delete(workspaceId);
        return { eligible: false, reason: "user_stop" };
      }
    }

    const goal = await this.normalizeGoalLimits(workspaceId);
    if (!goal) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "goal_missing" };
    }
    if (goal.goalId !== candidate.goalId) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "goal_mismatch" };
    }
    if (goal.status !== "active" && goal.status !== "budget_limited") {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "goal_not_active" };
    }
    if (goal.requireUserAcknowledgmentSinceMs != null) {
      return { eligible: false, reason: "requires_ack" };
    }

    if (goal.status === "budget_limited") {
      const lastStreamStamp = this.lastGoalStreamStamps.get(workspaceId);
      if (goal.budgetLimitInjectedForGoalId === goal.goalId) {
        this.pendingContinuationCandidates.delete(workspaceId);
        return { eligible: false, reason: "budget_wrapup_already_fired" };
      }
      if (
        lastStreamStamp?.goalId !== goal.goalId ||
        !this.isBudgetWrapupEligibleOrigin(lastStreamStamp.originKind)
      ) {
        this.pendingContinuationCandidates.delete(workspaceId);
        return { eligible: false, reason: "budget_wrapup_suppressed" };
      }
      return { eligible: true, goal, candidate, lastStreamStamp };
    }

    const lastContinuationFiredAtMs = goal.lastContinuationFiredAtMs ?? null;
    if (
      lastContinuationFiredAtMs != null &&
      nowMs - lastContinuationFiredAtMs < DEFAULT_GOAL_CONTINUATION_COOLDOWN_MS
    ) {
      return {
        eligible: false,
        reason: "cooldown",
        deferUntilMs: lastContinuationFiredAtMs + DEFAULT_GOAL_CONTINUATION_COOLDOWN_MS,
      };
    }

    return { eligible: true, goal, candidate };
  }

  private scheduleContinuationReRequest(workspaceId: string, dueAtMs: number): void {
    if (this.goalContinuationDispatcher == null) {
      return;
    }
    const delayMs = Math.max(0, dueAtMs - Date.now());
    const existing = this.continuationReRequestTimers.get(workspaceId);
    if (existing != null) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.continuationReRequestTimers.delete(workspaceId);
      if (!this.pendingContinuationCandidates.has(workspaceId)) {
        return;
      }
      this.goalContinuationDispatcher
        ?.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME)
        .catch((error: unknown) => {
          log.warn("Failed to re-request goal continuation dispatch", { workspaceId, error });
        });
    }, delayMs);
    this.continuationReRequestTimers.set(workspaceId, timer);
  }

  private findWorkspaceConfigEntry(workspaceId: string): Workspace | null {
    const config = this.config.loadConfigOrDefault();
    for (const [, projectConfig] of config.projects) {
      const workspace = projectConfig.workspaces.find((candidate) => candidate.id === workspaceId);
      if (workspace) {
        return workspace;
      }
    }
    return null;
  }

  private async normalizeGoalLimits(workspaceId: string): Promise<GoalRecordV1 | null> {
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (!current) {
        await this.pushGoalReadSnapshot(workspaceId, null);
        return null;
      }
      const next = this.applyBudgetDrivenStatus(current);
      if (next !== current) {
        await this.writeGoal(workspaceId, next);
        await this.pushGoalReadSnapshot(workspaceId, next);
        this.emitBudgetLimited(next, current.status);
        return next;
      }
      await this.pushGoalReadSnapshot(workspaceId, current);
      return current;
    });
  }

  private async recordContinuationFired(
    workspaceId: string,
    expectedGoalId: string,
    firedAtMs: number
  ): Promise<void> {
    await this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (current?.goalId !== expectedGoalId || current.status !== "active") {
        return;
      }
      const next = GoalRecordV1Schema.parse({
        ...current,
        lastContinuationFiredAtMs: firedAtMs,
        updatedAtMs: firedAtMs,
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      this.emitContinuationFired(next, firedAtMs);
    });
  }

  private emitContinuationFired(goal: GoalRecordV1, firedAtMs: number): void {
    const budgetRemaining =
      goal.budgetCents == null ? null : Math.max(0, goal.budgetCents - goal.costCents);
    this.emitLifecycle("goal_continuation_fired", {
      turns_used: goal.turnsUsed,
      cost_cents_bucket: centsBucket(goal.costCents),
      budget_remaining_cents_bucket:
        budgetRemaining == null ? "unlimited" : centsBucket(budgetRemaining),
      elapsed_minutes_bucket: countBucket(
        Math.floor(Math.max(0, firedAtMs - goal.createdAtMs) / 60_000)
      ),
      turn_cap_present: goal.turnCap != null,
      source: "stream_end_idle_dispatch",
    });
  }

  private isBudgetWrapupEligibleOrigin(originKind: GoalStreamOriginKind): boolean {
    return originKind !== "user";
  }

  private async tryMarkBudgetLimitInjected(
    workspaceId: string,
    expectedGoalId: string,
    expectedLastStreamStamp: GoalStreamStamp
  ): Promise<GoalRecordV1 | null> {
    assert(expectedGoalId.trim().length > 0, "budget wrap-up reservation requires a goal id");
    assert(
      this.isBudgetWrapupEligibleOrigin(expectedLastStreamStamp.originKind),
      "budget wrap-up reservation requires a goal-attributable stream"
    );

    return this.fileLocks.withLock(workspaceId, async () => {
      const currentStamp = this.lastGoalStreamStamps.get(workspaceId);
      if (
        currentStamp?.goalId !== expectedGoalId ||
        !this.isBudgetWrapupEligibleOrigin(currentStamp.originKind)
      ) {
        return null;
      }

      const current = await this.readGoalFile(workspaceId);
      if (
        current?.goalId !== expectedGoalId ||
        current.status !== "budget_limited" ||
        current.budgetLimitInjectedForGoalId === expectedGoalId
      ) {
        return null;
      }

      const next = GoalRecordV1Schema.parse({
        ...current,
        budgetLimitInjectedForGoalId: expectedGoalId,
        updatedAtMs: Date.now(),
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      return next;
    });
  }

  private emitBudgetWrapupFired(goal: GoalRecordV1, firedAtMs: number): void {
    this.emitLifecycle("goal_wrapup_fired", {
      turns_used: goal.turnsUsed,
      cost_cents_bucket: centsBucket(goal.costCents),
      "cost-overshoot": centsBucket(
        Math.max(0, goal.costCents - (goal.budgetCents ?? goal.costCents))
      ),
      elapsed_minutes_bucket: countBucket(
        Math.floor(Math.max(0, firedAtMs - goal.createdAtMs) / 60_000)
      ),
      source: "stream_end_idle_dispatch",
    });
  }

  private validateStatusTransition(
    current: GoalRecordV1 | null,
    nextStatus: GoalStatus,
    completionSummary: string | null
  ): void {
    if (!current) {
      throw new WorkspaceGoalTransitionError(
        `Cannot ${actionForStatus(nextStatus)} a goal because no goal is set.`
      );
    }

    if (current.status === "complete" && nextStatus !== "complete") {
      throw new WorkspaceGoalTransitionError(
        `Cannot ${actionForStatus(nextStatus)} a completed goal. Clear it before starting another.`
      );
    }

    if (nextStatus === "paused" && current.status !== "active") {
      throw new WorkspaceGoalTransitionError("Cannot pause a goal that is not active.");
    }

    if (nextStatus === "active" && current.status !== "paused") {
      throw new WorkspaceGoalTransitionError("Cannot resume a goal that is not paused.");
    }

    if (nextStatus === "complete") {
      if (completionSummary == null || completionSummary.length === 0) {
        throw new WorkspaceGoalTransitionError("Completion summary is required.");
      }
      if (current.status !== "active" && current.status !== "budget_limited") {
        throw new WorkspaceGoalTransitionError(
          "Cannot complete a goal that is not active or budget-limited."
        );
      }
    }
  }

  private conflictForExpectedGoalId(
    current: GoalRecordV1 | null,
    expectedGoalId: string | null | undefined
  ): GoalSetError | null {
    if (expectedGoalId === undefined) {
      return null;
    }
    const actualGoalId = current?.goalId ?? null;
    if (actualGoalId === expectedGoalId) {
      return null;
    }
    return { type: "goal_conflict", expectedGoalId, actualGoalId };
  }

  private applyMutableFields(goal: GoalRecordV1, input: SetGoalInput): GoalRecordV1 {
    const completionSummary = input.completionSummary?.trim() ?? null;
    if (input.status != null) {
      this.validateStatusTransition(goal, input.status, completionSummary);
    }

    const next: GoalRecordV1 = GoalRecordV1Schema.parse({
      ...goal,
      ...(input.status != null ? { status: input.status } : {}),
      ...(Object.hasOwn(input, "budgetCents")
        ? { budgetCents: normalizeGoalBudgetCents(input.budgetCents) }
        : {}),
      ...(Object.hasOwn(input, "turnCap") ? { turnCap: input.turnCap ?? null } : {}),
      ...(Object.hasOwn(input, "requireUserAcknowledgmentSinceMs")
        ? { requireUserAcknowledgmentSinceMs: input.requireUserAcknowledgmentSinceMs ?? null }
        : {}),
      ...completionSummaryPatch(input.status, completionSummary),
      updatedAtMs: Date.now(),
    });
    return this.applyBudgetDrivenStatus(next);
  }

  private hasReachedBudgetLimit(goal: GoalRecordV1): boolean {
    const { budgetCents } = goal;
    if (budgetCents == null || !hasGoalBudgetLimit(budgetCents)) {
      return false;
    }
    return getGoalCostMicroCents(goal) >= budgetCents * MICRO_CENTS_PER_CENT;
  }

  private hasReachedTurnLimit(goal: GoalRecordV1): boolean {
    return goal.turnCap != null && goal.turnsUsed >= goal.turnCap;
  }

  private hasReachedAnyLimit(goal: GoalRecordV1): boolean {
    return this.hasReachedBudgetLimit(goal) || this.hasReachedTurnLimit(goal);
  }

  private applyCostAccounting(
    goal: GoalRecordV1,
    costMicroCentsThisStream: number
  ): Pick<GoalRecordV1, "costCents" | "costMicroCents"> {
    const costMicroCents = getGoalCostMicroCents(goal) + costMicroCentsThisStream;
    return {
      costCents: Math.round(costMicroCents / MICRO_CENTS_PER_CENT),
      costMicroCents,
    };
  }

  private applyBudgetDrivenStatus(
    next: GoalRecordV1,
    options?: { originKind?: GoalStreamOriginKind }
  ): GoalRecordV1 {
    const normalizedBudgetCents = normalizeGoalBudgetCents(next.budgetCents);
    const normalized =
      normalizedBudgetCents === next.budgetCents
        ? next
        : GoalRecordV1Schema.parse({
            ...next,
            budgetCents: normalizedBudgetCents,
            updatedAtMs: Date.now(),
          });
    const reachedLimit = this.hasReachedAnyLimit(normalized);
    const shouldLimitActiveGoal = normalized.status === "active" && reachedLimit;
    const shouldRearmBudgetLimitedGoal = normalized.status === "budget_limited" && !reachedLimit;
    if (!shouldLimitActiveGoal && !shouldRearmBudgetLimitedGoal) {
      return normalized;
    }

    return GoalRecordV1Schema.parse({
      ...normalized,
      status: shouldLimitActiveGoal ? "budget_limited" : "active",
      // Raising/removing limits re-arms the one-shot budget wrap-up.
      budgetLimitInjectedForGoalId: shouldRearmBudgetLimitedGoal
        ? null
        : normalized.budgetLimitInjectedForGoalId,
      // Persist the origin kind on the active→budget_limited transition so
      // `recoverPendingDispatchAfterRestart` can decide whether to arm a
      // wrap-up after restart (Coder-agents-review P3 DEREM-54). When
      // re-arming back to `active` (budget raised / removed), clear it.
      budgetLimitOriginKind: shouldLimitActiveGoal
        ? (options?.originKind ?? null)
        : shouldRearmBudgetLimitedGoal
          ? null
          : normalized.budgetLimitOriginKind,
      updatedAtMs: Date.now(),
    });
  }

  private emitBudgetLimited(
    goal: GoalRecordV1,
    previousStatus: GoalStatus,
    properties?: GoalLifecycleProperties
  ): void {
    if (previousStatus === "budget_limited" || goal.status !== "budget_limited") {
      return;
    }

    this.emitLifecycle("goal_budget_limited", {
      hasBudget: goal.budgetCents != null,
      hasTurnCap: goal.turnCap != null,
      "cost-overshoot": this.hasReachedBudgetLimit(goal)
        ? centsBucket(Math.max(0, goal.costCents - (goal.budgetCents ?? 0)))
        : null,
      "turn-overshoot": this.hasReachedTurnLimit(goal)
        ? countBucket(Math.max(0, goal.turnsUsed - (goal.turnCap ?? 0)))
        : null,
      ...(properties ?? {}),
    });
  }

  private budgetDeltaProperties(
    field: "budget" | "turn-cap",
    previous: number | null,
    next: number | null
  ): GoalLifecycleProperties {
    const previousValue = previous ?? 0;
    const nextValue = next ?? 0;
    const delta = nextValue - previousValue;
    let deltaSign = "zero";
    let raisedVsLowered = "unchanged";
    if (delta > 0) {
      deltaSign = "positive";
      raisedVsLowered = "raised";
    } else if (delta < 0) {
      deltaSign = "negative";
      raisedVsLowered = "lowered";
    }
    return {
      [`${field}-delta-sign`]: deltaSign,
      [`${field}-raised-vs-lowered`]: raisedVsLowered,
      [`${field}-delta-cents`]: field === "budget" ? delta : null,
      [`${field}-delta-turns`]: field === "turn-cap" ? delta : null,
    };
  }

  private emitBudgetChanged(
    current: GoalRecordV1 | null,
    next: GoalRecordV1,
    input: SetGoalInput
  ): void {
    const budgetTouched = Object.hasOwn(input, "budgetCents");
    const turnCapTouched = Object.hasOwn(input, "turnCap");
    if (!budgetTouched && !turnCapTouched) {
      return;
    }

    this.emitLifecycle("goal_budget_changed", {
      hasBudget: next.budgetCents != null,
      hasTurnCap: next.turnCap != null,
      ...(budgetTouched
        ? this.budgetDeltaProperties("budget", current?.budgetCents ?? null, next.budgetCents)
        : {}),
      ...(turnCapTouched
        ? this.budgetDeltaProperties("turn-cap", current?.turnCap ?? null, next.turnCap)
        : {}),
    });
  }

  private emitStatusLifecycle(
    goal: GoalRecordV1,
    previousStatus: GoalStatus,
    initiator: GoalLifecycleInitiator
  ): void {
    if (goal.status === previousStatus) {
      return;
    }

    if (goal.status === "paused") {
      this.emitLifecycle("goal_paused", { initiator });
    } else if (goal.status === "active" && previousStatus === "paused") {
      // BudgetLimited → Active is a budget-driven re-arm, not a user resume;
      // it is reported via goal_budget_changed only.
      this.emitLifecycle("goal_resumed", { initiator });
    } else if (goal.status === "complete") {
      this.emitLifecycle("goal_completed", {
        initiator,
        summaryLengthBucket: lengthBucket(goal.completionSummary?.length ?? 0),
      });
    }
  }

  private getProvidersConfigForPricing(): ProvidersConfigMap | null {
    const maybeConfig = this.config as Config & {
      loadProvidersConfig?: () => ProvidersConfigMap | null;
    };
    if (typeof maybeConfig.loadProvidersConfig !== "function") {
      return null;
    }
    return maybeConfig.loadProvidersConfig() as unknown as ProvidersConfigMap | null;
  }

  async getGoal(workspaceId: string): Promise<GoalRecordV1 | null> {
    return this.normalizeGoalLimits(workspaceId);
  }

  /**
   * Reject sends/resumes that would run a non-terminal budgeted goal on an
   * unpriced model. Without this gate, the turn streams happily, accounting
   * records 0 cost (no pricing data → `getTotalCost(...) ?? 0`), and budget
   * enforcement is silently bypassed for real work. Persistence-only blocks
   * are not enough: the actual stream is what burns the budget.
   *
   * Owned by WorkspaceGoalService so every dispatch path can share one gate
   * implementation:
   *  - `WorkspaceService.sendMessage` / `resumeStream` (initial calls) — to
   *    avoid persisting an unpriced model into workspace AI settings before
   *    the rejection.
   *  - `AgentSession.sendMessage` (every internal/queued/auto dispatch) — to
   *    catch races where the goal becomes budgeted while a queued message
   *    waits, or where a server-internal caller picks an unpriced model.
   *
   * Intentionally does NOT honour `options.skipAiSettingsPersistence`: that
   * field is part of the public `SendMessageOptionsSchema` and forwarded
   * verbatim by the router, so trusting it would let any oRPC caller flip a
   * single bool to disarm the gate. Internal compaction / heartbeat callers
   * always pick a priced model via `getPreferredCompactionModel` /
   * heartbeat builders, so they hit the early `modelHasPricingData` exit
   * below without touching `goal.json`.
   */
  async assertPricedModelForBudgetedGoal(
    workspaceId: string,
    model: string | undefined
  ): Promise<Result<void, SendMessageError>> {
    // Hot-path gate: every sendMessage / resumeStream lands here, so an
    // experiment-off short-circuit avoids paying `getGoal`'s disk cost on
    // workspaces that never used the GOALS feature (sibling to DEREM-19 /
    // DEREM-37 / DEREM-40 — Coder-agents-review P3 DEREM-52). Defaults to
    // false when no bridge is registered (matches the existing
    // `isExperimentEnabled` contract for headless tests).
    if (!this.isExperimentEnabled()) {
      return Ok(undefined);
    }
    if (!model || modelHasPricingData(model, this.getProvidersConfigForPricing())) {
      return Ok(undefined);
    }
    const goal = await this.getGoal(workspaceId);
    if (!hasBudgetedResumableGoal(goal)) {
      return Ok(undefined);
    }
    return Err({ type: "unknown", raw: UNPRICED_TARGET_MODEL_GOAL_MESSAGE });
  }

  async inheritFromFork(
    parentWorkspaceId: string,
    forkWorkspaceId: string
  ): Promise<GoalRecordV1 | null> {
    assert(
      parentWorkspaceId.trim().length > 0,
      "inheritFromFork requires non-empty parentWorkspaceId"
    );
    assert(forkWorkspaceId.trim().length > 0, "inheritFromFork requires non-empty forkWorkspaceId");
    assert(
      parentWorkspaceId !== forkWorkspaceId,
      "inheritFromFork requires distinct parent and fork workspaces"
    );

    const parentGoal = await this.fileLocks.withLock(parentWorkspaceId, () =>
      this.readGoalFile(parentWorkspaceId)
    );
    if (!parentGoal) {
      return null;
    }

    const inherited = this.createGoal({
      objective: parentGoal.objective,
      budgetCents: parentGoal.budgetCents,
      turnCap: parentGoal.turnCap,
      status: "paused",
    });

    return this.fileLocks.withLock(forkWorkspaceId, async () => {
      const existingForkGoal = await this.readGoalFile(forkWorkspaceId);
      assert(existingForkGoal == null, "inheritFromFork expects a fresh fork workspace goal file");
      await this.writeGoal(forkWorkspaceId, inherited);
      await this.pushSnapshot(forkWorkspaceId, inherited);
      this.emitLifecycle("goal_created", {
        viaFork: true,
        sourceStatus: parentGoal.status,
        objectiveLengthBucket: lengthBucket(inherited.objective.length),
        hasBudget: inherited.budgetCents != null,
        hasTurnCap: inherited.turnCap != null,
      });
      return inherited;
    });
  }

  async setGoal(input: SetGoalInput): Promise<Result<GoalRecordV1, GoalSetError>> {
    // Catch the two known throw paths (`assertParentWorkspace` and
    // `applyMutableFields`/`validateStatusTransition`) and surface them as
    // typed Result errors so the oRPC `setGoal` handler does not leak them as
    // unhandled 500s (Coder-agents-review P3 DEREM-36).
    try {
      return await this.setGoalInternal(input);
    } catch (error) {
      if (error instanceof WorkspaceGoalChildWorkspaceError) {
        return Err({ type: "child_workspace", message: error.message });
      }
      if (error instanceof WorkspaceGoalTransitionError) {
        return Err({ type: "invalid_transition", message: error.message });
      }
      throw error;
    }
  }

  private async setGoalInternal(input: SetGoalInput): Promise<Result<GoalRecordV1, GoalSetError>> {
    const objective = input.objective?.trim();
    this.assertParentWorkspace(input.workspaceId);

    if (!objective && this.pendingGoalSnapshots.has(input.workspaceId)) {
      // Until stream-end persists the queued objective, status/budget-only edits
      // would target the old durable goal (or no goal) while the panel displays
      // the optimistic replacement. Reject them instead of mutating the wrong record.
      return Err({ type: "invalid_transition", message: PENDING_GOAL_EDIT_MESSAGE });
    }

    // -----------------------------------------------------------------------
    // Mid-stream branch: setGoal during an active stream defers the actual
    // disk write until applyPendingAfterStreamEnd. The returned `Ok(projected)`
    // is a synthetic record for immediate UI rendering; it has NOT been
    // persisted yet.
    //
    // ⚠️ DO NOT use `projected.goalId` as `expectedGoalId` on a follow-up
    // mutation — the eventual persisted record gets a fresh `goalId` from
    // `setGoalImmediately`/`createGoal` on stream-end, so the projected id is
    // throwaway. Re-fetch via `getGoal` after the stream ends before issuing
    // any optimistic-concurrency mutation. The `goalId` mismatch is a known
    // footgun (Coder-agents-review P3 DEREM-23) — current callers all
    // re-fetch first so no bug manifests today, but new callers must respect
    // this contract.
    // -----------------------------------------------------------------------
    if (objective && (await this.isWorkspaceStreaming(input.workspaceId))) {
      return this.fileLocks.withLock(input.workspaceId, async () => {
        const current = await this.readGoalFile(input.workspaceId);
        const conflict = this.conflictForExpectedGoalId(current, input.expectedGoalId);
        if (conflict) {
          return Err(conflict);
        }
        const projected = this.createGoal({
          objective,
          budgetCents: input.budgetCents ?? null,
          turnCap: input.turnCap ?? null,
          status: input.status,
          completionSummary: input.completionSummary,
        });
        if (
          (projected.status === "active" || projected.status === "budget_limited") &&
          !this.canRunBudgetedGoalOnKickoffModel(input.workspaceId, projected)
        ) {
          return Err({
            type: "invalid_transition" as const,
            message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
          });
        }
        this.pendingGoalMutations.set(input.workspaceId, {
          objective,
          ...(Object.hasOwn(input, "budgetCents")
            ? { budgetCents: input.budgetCents ?? null }
            : {}),
          ...(Object.hasOwn(input, "turnCap") ? { turnCap: input.turnCap ?? null } : {}),
          ...(input.status != null ? { status: input.status } : {}),
          ...(input.completionSummary != null
            ? { completionSummary: input.completionSummary }
            : {}),
          ...(Object.hasOwn(input, "expectedGoalId")
            ? { expectedGoalId: input.expectedGoalId ?? null }
            : {}),
          ...(input.initiator != null ? { initiator: input.initiator } : {}),
        });
        // A user can run /goal while the first turn is still streaming. The
        // durable goal write must wait for stream accounting, but the Goal panel
        // reads activity snapshots, so publish the projected goal immediately
        // without persisting this crash-unsafe optimistic state.
        await this.publishPendingGoalSnapshot(input.workspaceId, projected);
        return Ok(projected);
      });
    }

    return this.setGoalImmediately({ ...input, objective });
  }

  private canRunBudgetedGoalOnKickoffModel(workspaceId: string, goal: GoalRecordV1): boolean {
    if (!this.isExperimentEnabled() || !hasBudgetedResumableGoal(goal)) {
      return true;
    }
    const model = this.goalContinuationBridge?.getKickoffSendOptions?.(workspaceId)?.model;
    if (!model) {
      return true;
    }
    return modelHasPricingData(model, this.getProvidersConfigForPricing());
  }

  private async setGoalImmediately(
    input: SetGoalInput & { objective?: string }
  ): Promise<Result<GoalRecordV1, GoalSetError>> {
    const result = await this.fileLocks.withLock(input.workspaceId, async () => {
      const current = await this.readGoalFile(input.workspaceId);
      const conflict = this.conflictForExpectedGoalId(current, input.expectedGoalId);
      if (conflict) {
        return Err(conflict);
      }
      const trimmedObjective = input.objective?.trim();
      const objective =
        trimmedObjective && trimmedObjective.length > 0 ? trimmedObjective : current?.objective;
      if (!objective) {
        // No objective + status mutation + no current goal will fall into
        // `validateStatusTransition(null, ...)` below, which throws a typed
        // `WorkspaceGoalTransitionError`. That throw is caught by the outer
        // `setGoal` wrapper and surfaced as a typed `invalid_transition`
        // Result error (Coder-agents-review P3 DEREM-35 / DEREM-36) — no
        // unhandled 500 reaches the oRPC layer.
        if (input.status != null) {
          this.validateStatusTransition(
            null,
            input.status,
            input.completionSummary?.trim() ?? null
          );
        }
        // No-objective + no-status path (e.g. RightSidebar "Update budget"
        // race where another window cleared the goal concurrently): use the
        // typed transition error so the outer `setGoal` wrapper surfaces it
        // as a typed `invalid_transition` Result instead of letting a plain
        // Error escape as an unhandled 500 (Coder-agents-review P2 DEREM-43).
        throw new WorkspaceGoalTransitionError(
          "Goal objective is required because no goal currently exists for this workspace."
        );
      }

      if (current?.objective === objective) {
        const hasMutableChange =
          input.status != null ||
          input.completionSummary != null ||
          Object.hasOwn(input, "budgetCents") ||
          Object.hasOwn(input, "turnCap") ||
          Object.hasOwn(input, "requireUserAcknowledgmentSinceMs");
        const previousStatus = current.status;
        let updated = hasMutableChange ? this.applyMutableFields(current, input) : current;
        if (hasMutableChange) {
          if (
            (updated.status === "active" || updated.status === "budget_limited") &&
            !this.canRunBudgetedGoalOnKickoffModel(input.workspaceId, updated)
          ) {
            return Err({
              type: "invalid_transition" as const,
              message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
            });
          }

          // User resume is an explicit opt-in after a stop/crash gate; clear
          // both the in-memory stop marker and persisted acknowledgment gate.
          if (
            previousStatus === "paused" &&
            updated.status === "active" &&
            (input.initiator ?? "user") === "user"
          ) {
            this.lastUserStopAtMsByWorkspace.delete(input.workspaceId);
            updated = GoalRecordV1Schema.parse({
              ...updated,
              requireUserAcknowledgmentSinceMs: null,
              updatedAtMs: Date.now(),
            });
          }
          await this.writeGoal(input.workspaceId, updated);
          await this.pushSnapshot(input.workspaceId, updated);
          this.emitBudgetChanged(current, updated, input);
          this.emitBudgetLimited(updated, previousStatus);
          this.emitStatusLifecycle(updated, previousStatus, input.initiator ?? "user");
        }
        if (input.objective != null) {
          this.emitLifecycle("goal_replaced", {
            sameObjective: true,
            objectiveLengthBucket: lengthBucket(objective.length),
            hasBudget: updated.budgetCents != null,
            hasTurnCap: updated.turnCap != null,
          });
        }
        return Ok(updated);
      }

      const next = this.createGoal({
        objective,
        budgetCents: input.budgetCents ?? null,
        turnCap: input.turnCap ?? null,
        status: input.status,
        completionSummary: input.completionSummary,
      });
      if (
        (next.status === "active" || next.status === "budget_limited") &&
        !this.canRunBudgetedGoalOnKickoffModel(input.workspaceId, next)
      ) {
        return Err({
          type: "invalid_transition" as const,
          message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
        });
      }
      await this.writeGoal(input.workspaceId, next);
      await this.pushSnapshot(input.workspaceId, next);
      this.emitBudgetChanged(current, next, input);
      this.emitLifecycle(current ? "goal_replaced" : "goal_created", {
        sameObjective: false,
        objectiveLengthBucket: lengthBucket(objective.length),
        hasBudget: next.budgetCents != null,
        hasTurnCap: next.turnCap != null,
      });
      return Ok(next);
    });

    if (result.success) {
      if (result.data.status === "active") {
        this.armKickoffContinuationIfIdle(input.workspaceId, result.data);
      } else if (result.data.status === "budget_limited") {
        this.armBudgetWrapupForBudgetLimitedGoal(input.workspaceId, result.data);
      }
    }
    return result;
  }

  private armKickoffContinuationIfIdle(workspaceId: string, goal: GoalRecordV1): void {
    if (goal.status !== "active") {
      return;
    }
    if (this.goalContinuationDispatcher == null || this.goalContinuationBridge == null) {
      return;
    }
    const existingCandidate = this.pendingContinuationCandidates.get(workspaceId);
    if (existingCandidate?.goalId === goal.goalId) {
      // A real stream-end already armed this goal; re-request dispatch in case
      // the previous request was consumed while an acknowledgment gate was set.
      this.goalContinuationDispatcher
        .requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME)
        .catch((error: unknown) => {
          log.warn("Failed to re-request kickoff goal continuation dispatch", {
            workspaceId,
            error,
          });
        });
      return;
    }
    const sendOptions = this.goalContinuationBridge.getKickoffSendOptions?.(workspaceId);
    if (!sendOptions) {
      return;
    }
    if (sendOptions.agentId === "plan" || sendOptions.agentId === "compact") {
      return;
    }

    const nowMs = Date.now();
    this.pendingContinuationCandidates.set(workspaceId, {
      goalId: goal.goalId,
      requestedAtMs: nowMs,
      streamEndedAtMs: nowMs,
      sendOptions: continuationSendOptions(sendOptions),
    });
    this.goalContinuationDispatcher
      .requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME)
      .catch((error: unknown) => {
        log.warn("Failed to request kickoff goal continuation dispatch", { workspaceId, error });
      });
  }

  /**
   * Re-arm pending continuation / budget-wrap-up dispatches after a process
   * restart. `pendingContinuationCandidates` and `lastGoalStreamStamps` are
   * in-memory and are wiped on restart; the goal record on disk is the
   * persisted source of truth, so we re-derive whatever dispatch state is
   * owed by the persisted status (Coder-agents-review P2 DEREM-16).
   *
   * Without this, a `budget_limited` goal with `budgetLimitInjectedForGoalId
   * === null` (i.e. the budget was hit but the wrap-up message had not yet
   * fired before the crash) is permanently stranded:
   *   - eligibility lookup finds no in-memory stamp and returns
   *     `budget_wrapup_suppressed`, deleting the candidate.
   *   - `armKickoffContinuationIfIdle` only fires for `status === "active"`.
   *
   * The user would need to manually clear the goal or raise the budget to
   * recover. Instead we synthesize the stamp + candidate so the wrap-up can
   * fire on the next idle moment.
   *
   * Called from `AgentSession.runStartupRecovery` per workspace.
   */
  async recoverPendingDispatchAfterRestart(workspaceId: string): Promise<void> {
    assert(
      workspaceId.trim().length > 0,
      "recoverPendingDispatchAfterRestart requires workspaceId"
    );
    const goal = await this.normalizeGoalLimits(workspaceId);
    if (!goal) {
      return;
    }
    if (goal.status === "active") {
      this.armKickoffContinuationIfIdle(workspaceId, goal);
      return;
    }
    if (goal.status === "budget_limited" && goal.budgetLimitInjectedForGoalId === null) {
      // DEREM-54: only synthesize a wrap-up if the stream that hit the
      // budget was goal-attributable. A user-origin stream that exhausted
      // the budget was correctly suppressed pre-restart
      // (`checkGoalContinuationEligibility` rejects it as
      // `budget_wrapup_suppressed`); after restart we'd otherwise lose that
      // suppression because in-memory `lastGoalStreamStamps` is empty and
      // this function would synthesize a `GOAL_CONTINUATION_KIND` stamp.
      // Legacy goal records with `budgetLimitOriginKind` undefined arm by
      // default — the field is new and most existing budget_limited goals
      // would otherwise be permanently stranded.
      const originKind = goal.budgetLimitOriginKind ?? null;
      if (originKind === "user") {
        return;
      }
      this.armBudgetWrapupForBudgetLimitedGoal(workspaceId, goal);
    }
  }

  /**
   * Synthesize a `GOAL_CONTINUATION_KIND` stream stamp + arm a continuation
   * candidate so the budget-wrap-up eligibility check passes its identity
   * guards (`lastStreamStamp.goalId === goal.goalId` && a non-user origin).
   *
   * Called from two paths:
   *   1. `recoverPendingDispatchAfterRestart` — in-memory dispatch state was
   *      wiped on restart and the persisted goal is `budget_limited` with no
   *      wrap-up injected (Coder-agents-review P2 DEREM-16).
   *   2. `attributeChildReport` — a child task's cost rolled the goal into
   *      `budget_limited`. Without this the wrap-up never fires because the
   *      attribution path does not produce a continuation-origin stream
   *      (Coder-agents-review P2 DEREM-33).
   */
  private armBudgetWrapupForBudgetLimitedGoal(workspaceId: string, goal: GoalRecordV1): void {
    if (this.goalContinuationDispatcher == null || this.goalContinuationBridge == null) {
      return;
    }
    if (this.pendingContinuationCandidates.has(workspaceId)) {
      return;
    }
    const sendOptions = this.goalContinuationBridge.getKickoffSendOptions?.(workspaceId);
    if (!sendOptions || sendOptions.agentId === "plan" || sendOptions.agentId === "compact") {
      return;
    }

    this.recordLastGoalStream(workspaceId, GOAL_CONTINUATION_KIND, goal.goalId);
    const nowMs = Date.now();
    this.pendingContinuationCandidates.set(workspaceId, {
      goalId: goal.goalId,
      requestedAtMs: nowMs,
      streamEndedAtMs: nowMs,
      sendOptions: continuationSendOptions(sendOptions),
    });
    this.goalContinuationDispatcher
      .requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME)
      .catch((error: unknown) => {
        log.warn("Failed to request budget-wrap-up dispatch", {
          workspaceId,
          error,
        });
      });
  }

  async requireUserAcknowledgment(
    workspaceId: string,
    sinceMs = Date.now()
  ): Promise<GoalRecordV1 | null> {
    assert(
      Number.isInteger(sinceMs) && sinceMs >= 0,
      "requireUserAcknowledgment requires a non-negative integer timestamp"
    );
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (!current) {
        await this.pushSnapshot(workspaceId, null);
        return null;
      }
      const next = this.applyMutableFields(current, {
        workspaceId,
        requireUserAcknowledgmentSinceMs: sinceMs,
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      return next;
    });
  }

  async acknowledgeUser(workspaceId: string): Promise<GoalRecordV1 | null> {
    assert(workspaceId.trim().length > 0, "acknowledgeUser requires workspaceId");
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (!current) {
        await this.pushSnapshot(workspaceId, null);
        return null;
      }
      if (current.requireUserAcknowledgmentSinceMs == null) {
        await this.pushSnapshot(workspaceId, current);
        return current;
      }

      const next = this.applyMutableFields(current, {
        workspaceId,
        requireUserAcknowledgmentSinceMs: null,
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      return next;
    });
  }

  async requireUserAcknowledgmentForCrashRecovery(
    workspaceId: string,
    sinceMs = Date.now()
  ): Promise<GoalRecordV1 | null> {
    assert(
      Number.isInteger(sinceMs) && sinceMs >= 0,
      "requireUserAcknowledgmentForCrashRecovery requires a non-negative integer timestamp"
    );
    const next = await this.requireUserAcknowledgment(workspaceId, sinceMs);
    if (next) {
      this.emitLifecycle("goal_crash_gate_set", {
        workspaceIdLengthBucket: lengthBucket(workspaceId.length),
      });
    }
    return next;
  }

  private recordLastGoalStream(
    workspaceId: string,
    originKind: GoalStreamOriginKind,
    goalId: string | null
  ): GoalStreamStamp {
    const stamp = {
      originKind,
      sequence: this.nextGoalStreamStampSequence,
      goalId,
    };
    this.nextGoalStreamStampSequence += 1;
    this.lastGoalStreamStamps.set(workspaceId, stamp);
    return stamp;
  }

  /**
   * Push a live cost preview to the activity snapshot without persisting to
   * goal.json. The cost is the cumulative current-stream cost on top of the
   * durable base; `recordStreamAccounting` performs final accounting at stream end.
   */
  async previewStreamAccounting(input: StreamAccountingInput): Promise<GoalSnapshot | null> {
    assert(input.workspaceId.trim().length > 0, "previewStreamAccounting requires workspaceId");
    if (input.isCompaction === true) {
      return null;
    }

    const pendingSnapshot = this.pendingGoalSnapshots.get(input.workspaceId);
    if (pendingSnapshot) {
      return pendingSnapshot;
    }

    const costMicroCentsThisStream = costUsdToMicroCents(input.costUsd);
    return this.fileLocks.withLock(input.workspaceId, async () => {
      const current = await this.readGoalFile(input.workspaceId);
      if (!current) {
        return null;
      }

      if (input.streamStartedAtMs != null && current.createdAtMs > input.streamStartedAtMs) {
        return null;
      }
      if (
        input.streamStartedAtMs != null &&
        this.recordedStreamStartedAtMsByWorkspace.get(input.workspaceId) === input.streamStartedAtMs
      ) {
        return null;
      }

      if (current.status === "paused" || current.status === "complete") {
        return toGoalSnapshot(current);
      }

      const preview = GoalRecordV1Schema.parse({
        ...current,
        ...this.applyCostAccounting(current, costMicroCentsThisStream),
        updatedAtMs: Date.now(),
      });
      return this.pushSnapshot(input.workspaceId, preview);
    });
  }

  async recordStreamAccounting(input: StreamAccountingInput): Promise<GoalRecordV1 | null> {
    assert(input.workspaceId.trim().length > 0, "recordStreamAccounting requires workspaceId");
    const originKind = input.streamOriginKind ?? (input.isCompaction === true ? "other" : "user");

    if (input.isCompaction === true) {
      this.recordLastGoalStream(input.workspaceId, originKind, null);
      return null;
    }

    const costMicroCentsThisStream = costUsdToMicroCents(input.costUsd);
    return this.fileLocks.withLock(input.workspaceId, async () => {
      const current = await this.readGoalFile(input.workspaceId);
      if (!current) {
        this.recordLastGoalStream(input.workspaceId, originKind, null);
        await this.pushSnapshot(input.workspaceId, null);
        return null;
      }

      if (input.streamStartedAtMs != null && current.createdAtMs > input.streamStartedAtMs) {
        this.recordLastGoalStream(input.workspaceId, originKind, current.goalId);
        await this.pushSnapshot(input.workspaceId, current);
        return null;
      }

      if ((current.status === "paused" || current.status === "complete") && originKind === "user") {
        this.recordLastGoalStream(input.workspaceId, originKind, current.goalId);
        await this.pushSnapshot(input.workspaceId, current);
        return current;
      }

      // Only count goal-attributable turns. A rare `user`-origin stream that
      // reaches here while still active must not consume a turn against the cap
      // (Coder-agents-review P3 DEREM-24).
      const turnsDelta = originKind === "user" ? 0 : 1;
      const accounted = GoalRecordV1Schema.parse({
        ...current,
        ...this.applyCostAccounting(current, costMicroCentsThisStream),
        turnsUsed: current.turnsUsed + turnsDelta,
        updatedAtMs: Date.now(),
      });
      const next = this.applyBudgetDrivenStatus(accounted, { originKind });
      if (input.streamStartedAtMs != null) {
        this.recordedStreamStartedAtMsByWorkspace.set(input.workspaceId, input.streamStartedAtMs);
      }
      await this.writeGoal(input.workspaceId, next);
      await this.pushSnapshot(input.workspaceId, next);
      this.recordLastGoalStream(input.workspaceId, originKind, next.goalId);
      this.emitBudgetLimited(next, current.status);
      return next;
    });
  }

  async attributeChildReport(
    input: ChildReportAttributionInput
  ): Promise<ChildReportAttributionResult | null> {
    assert(
      input.parentWorkspaceId.trim().length > 0,
      "attributeChildReport requires parentWorkspaceId"
    );
    assert(
      input.childWorkspaceId.trim().length > 0,
      "attributeChildReport requires childWorkspaceId"
    );
    assert(
      input.parentWorkspaceId !== input.childWorkspaceId,
      "attributeChildReport requires distinct parent and child workspaces"
    );
    assert(
      Number.isInteger(input.childCostCents) && input.childCostCents >= 0,
      "attributeChildReport requires a non-negative integer childCostCents"
    );

    return this.fileLocks.withLock(input.parentWorkspaceId, async () => {
      const current = await this.readGoalFile(input.parentWorkspaceId);
      if (!current) {
        await this.pushSnapshot(input.parentWorkspaceId, null);
        return null;
      }

      if (current.status === "paused" || current.status === "complete") {
        await this.pushSnapshot(input.parentWorkspaceId, current);
        return skippedChildAttribution(current);
      }

      if (current.attributedChildren.includes(input.childWorkspaceId)) {
        await this.pushSnapshot(input.parentWorkspaceId, current);
        return skippedChildAttribution(current);
      }

      const accounted = GoalRecordV1Schema.parse({
        ...current,
        ...this.applyCostAccounting(current, input.childCostCents * MICRO_CENTS_PER_CENT),
        turnsUsed: current.turnsUsed + 1,
        attributedChildren: [...current.attributedChildren, input.childWorkspaceId],
        updatedAtMs: Date.now(),
      });
      // Tag the budget-limit transition so post-restart recovery knows the
      // wrap-up is owed (DEREM-54). `goal_continuation` is the right tag here
      // because the wrap-up MUST fire — child attribution is goal-attributable
      // work. The recovery path checks for `!= "user"`.
      const next = this.applyBudgetDrivenStatus(accounted, { originKind: "goal_continuation" });
      const causedLimit = current.status === "active" && next.status === "budget_limited";

      await this.writeGoal(input.parentWorkspaceId, next);
      await this.pushSnapshot(input.parentWorkspaceId, next);
      this.emitBudgetLimited(next, current.status, { "caused-by-child": true });
      // Coder-agents-review P2 DEREM-33: when child attribution drives the
      // goal into budget_limited, arm the same wrap-up stamp + candidate the
      // restart-recovery path uses. Without this the goal sits stuck in
      // budget_limited with no mechanism to fire the wrap-up because the
      // attribution path never produces a normal stream-end candidate/stamp.
      if (causedLimit) {
        this.armBudgetWrapupForBudgetLimitedGoal(input.parentWorkspaceId, next);
      } else if (next.status === "active") {
        this.armKickoffContinuationIfIdle(input.parentWorkspaceId, next);
      }
      return {
        goalBefore: current,
        goalAfter: next,
        attributed: true,
        causedBudgetLimit: causedLimit,
      };
    });
  }

  async clearGoal(workspaceId: string): Promise<GoalRecordV1 | null> {
    const cleared = await this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      this.pendingGoalMutations.delete(workspaceId);
      this.pendingGoalSnapshots.delete(workspaceId);
      this.pendingContinuationCandidates.delete(workspaceId);
      this.recordedStreamStartedAtMsByWorkspace.delete(workspaceId);
      this.lastGoalStreamStamps.delete(workspaceId);
      const timer = this.continuationReRequestTimers.get(workspaceId);
      if (timer != null) {
        clearTimeout(timer);
        this.continuationReRequestTimers.delete(workspaceId);
      }
      if (!current) {
        await this.pushSnapshot(workspaceId, null);
        return null;
      }

      await fs.rm(this.getFilePath(workspaceId), { force: true });
      await this.pushSnapshot(workspaceId, null);
      this.emitLifecycle("goal_cleared", {
        finalStatus: current.status,
        costCentsBucket: centsBucket(current.costCents),
        turnsUsed: current.turnsUsed,
      });
      return current;
    });

    if (cleared) {
      await this.appendClearSummary(workspaceId, cleared);
    }

    return cleared;
  }

  private async appendClearSummary(workspaceId: string, goal: GoalRecordV1): Promise<void> {
    // Keep the persisted summary self-describing for model context; the renderer hides the redundant label.
    const summary = `Goal cleared: "${goal.objective}" — spent $${formatCentsBare(goal.costCents)} over ${goal.turnsUsed} turns (status: ${goal.status})`;
    const message = createMuxMessage(
      `goal-cleared-${Date.now()}-${crypto.randomUUID()}`,
      "assistant",
      summary,
      {
        synthetic: true,
        uiVisible: true,
        muxMetadata: { type: "goal-cleared-summary" },
      }
    );
    const result = await this.historyService.appendToHistory(workspaceId, message);
    if (!result.success) {
      log.warn("Failed to append goal cleared summary", { workspaceId, error: result.error });
    }
  }

  async applyPendingAfterStreamEnd(workspaceId: string): Promise<GoalRecordV1 | null> {
    const pending = this.pendingGoalMutations.get(workspaceId);
    if (!pending) {
      return null;
    }

    this.pendingGoalMutations.delete(workspaceId);
    this.pendingGoalSnapshots.delete(workspaceId);
    // Mirror the `setGoal` wrapper (DEREM-36) here: `setGoalImmediately`
    // rethrows `WorkspaceGoalTransitionError` / `WorkspaceGoalChildWorkspaceError`
    // for invalid transitions (e.g. a queued `/goal pause` against an
    // already-paused goal). Two of three call sites invoke this method via
    // `void` so an uncaught rejection would surface as an unhandled-rejection
    // process crash under `--unhandled-rejections=throw` (Coder-agents-review
    // P2 DEREM-47). Log + swallow so the stream-end pipeline stays alive;
    // the caller already treats null as "no apply happened".
    try {
      const result = await this.setGoalImmediately({ workspaceId, ...pending });
      return result.success ? result.data : null;
    } catch (error) {
      log.warn("applyPendingAfterStreamEnd: dropped invalid queued goal mutation", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      // Always re-read the durable record: queued snapshots are optimistic, and
      // drains can succeed as persistence no-ops, reject, or throw.
      await this.restorePersistedGoalSnapshot(workspaceId);
    }
  }
}
