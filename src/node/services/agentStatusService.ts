import { createHash } from "crypto";
import assert from "@/common/utils/assert";
import {
  AGENT_STATUS_ACTIVE_FOCUSED_INTERVAL_MS,
  AGENT_STATUS_ACTIVE_UNFOCUSED_INTERVAL_MS,
  AGENT_STATUS_IDLE_FOCUSED_INTERVAL_MS,
  AGENT_STATUS_IDLE_UNFOCUSED_INTERVAL_MS,
  AGENT_STATUS_MAX_CONCURRENT,
  AGENT_STATUS_MAX_MESSAGE_CHARS,
  AGENT_STATUS_MAX_TRAILING_MESSAGES,
  AGENT_STATUS_MAX_TRANSCRIPT_TOKENS,
  AGENT_STATUS_TICK_INTERVAL_MS,
} from "@/constants/agentStatus";
import type { Config } from "@/node/config";
import type { MuxMessage } from "@/common/types/message";
import { isWorkspaceArchived } from "@/common/utils/archive";
import type { AIService } from "./aiService";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import type { TokenizerService } from "./tokenizerService";
import type { WindowService } from "./windowService";
import type { WorkspaceService } from "./workspaceService";
import { generateWorkspaceStatus } from "./workspaceStatusGenerator";
import { log } from "./log";

const FALLBACK_TOKENIZER_MODEL = "anthropic:claude-haiku-4-5";

export interface AgentStatusServiceOptions {
  /** Override for test injection. Defaults to `Date.now`. */
  clock?: () => number;
  /** Override scheduler tick interval. Defaults to AGENT_STATUS_TICK_INTERVAL_MS. */
  tickIntervalMs?: number;
}

interface State {
  /** Last time we ran (or skipped via dedup). 0 if we never ran. */
  lastRanAt: number;
  /**
   * Hash of the input we last "settled" on — i.e. an outcome that depends
   * on the *transcript* and shouldn't be retried until the transcript
   * changes. That covers:
   *   - successful persists (Ok result, status written),
   *   - post-generation placeholder rejection,
   *   - generation failures that reached the provider (model refused tool,
   *     rate limit, persistent provider error, etc.).
   *
   * Pre-provider failures (no API key, OAuth not connected, provider
   * disabled, model not available, policy denied — anything that fails
   * inside createModel before we cross the wire) intentionally do NOT
   * advance this hash. Those are properties of the user's *config*, and
   * caching them by transcript would freeze a workspace out of AI status
   * until a new chat message arrived, even after the user fixed
   * credentials. See the `result.error.reachedProvider` branch in
   * `runForWorkspace`.
   *
   * null if we have never settled on a transcript for this workspace.
   */
  lastInputHash: string | null;
  /**
   * Hash of the transcript the scheduler last examined, even if that input
   * did not settle into a sidebar status (for example, a pre-provider config
   * failure). Used to avoid consuming a recency bump while history is still
   * catching up to the user message that caused it.
   */
  lastSeenInputHash: string | null;
  /**
   * Recency timestamp observed the last time the scheduler considered this
   * workspace. User messages update recency, so an increased value is a
   * strong signal that the old sidebar status may now be stale even if the
   * normal idle/active cadence has not elapsed yet.
   */
  lastObservedRecency: number | null;
  /** Whether a generation is currently in flight. */
  inFlight: boolean;
}

/**
 * Periodic backend job that produces the sidebar's AI-generated agent status
 * using the same "small model" path as workspace title generation.
 *
 * Cadence: streaming workspaces refresh fast so the user can follow along;
 * idle workspaces back off. Both back off further when the desktop window
 * is blurred. See ACTIVE_/IDLE_ intervals in @/constants/agentStatus.
 *
 * Dedup: each generation hashes its trailing-transcript window. Identical
 * hash to the last settled run skips regeneration (idle/frozen chats).
 *
 * Concurrency: bounded by AGENT_STATUS_MAX_CONCURRENT so a multi-workspace
 * sweep never spikes provider load.
 */
export class AgentStatusService {
  private readonly tracked = new Map<string, State>();
  private readonly inFlightPromises = new Set<Promise<void>>();
  private readonly clock: () => number;
  private readonly tickIntervalMs: number;

  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private tickInFlight = false;

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly tokenizerService: TokenizerService,
    private readonly extensionMetadata: ExtensionMetadataService,
    private readonly workspaceService: WorkspaceService,
    private readonly windowService: WindowService,
    private readonly aiService: AIService,
    options: AgentStatusServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => Date.now());
    this.tickIntervalMs = options.tickIntervalMs ?? AGENT_STATUS_TICK_INTERVAL_MS;
  }

  start(): void {
    assert(this.checkInterval === null, "AgentStatusService.start() called while already running");
    this.stopped = false;
    // No startup delay: AGENT_STATUS_MAX_CONCURRENT=1 already serializes
    // generation across workspaces, so an immediate first tick won't create a
    // thundering herd at launch.
    this.checkInterval = setInterval(() => void this.runTick(), this.tickIntervalMs);
    void this.runTick();
    log.info("AgentStatusService started", { tickIntervalMs: this.tickIntervalMs });
  }

  stop(): void {
    this.stopped = true;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.tracked.clear();
    this.inFlightPromises.clear();
    this.tickInFlight = false;
    log.info("AgentStatusService stopped");
  }

  private async runTick(): Promise<void> {
    if (this.stopped || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      // Anchor lastRanAt below to tick start time. With tick=10s and
      // active-focused interval=10s, that makes the eligibility math exact:
      // tick[k+1] - tick[k] === interval, so the workspace runs every tick.
      // Otherwise sub-ms timer drift can degrade actual cadence to 2× the
      // configured interval.
      const tickStartedAt = this.clock();
      await this.dispatch(tickStartedAt);
      // Awaited so production callers and tests observe completion.
      await Promise.allSettled([...this.inFlightPromises]);
    } catch (error) {
      log.error("AgentStatusService tick failed", { error });
    } finally {
      this.tickInFlight = false;
    }
  }

  private async dispatch(tickStartedAt: number): Promise<void> {
    const focused = this.windowService.isFocused();
    // One disk read per tick for streaming state across all workspaces.
    // Cheap, and avoids N reads inside the inner loop.
    const snapshots = await this.extensionMetadata.getAllSnapshots();

    // Sort eligible workspaces by lastRanAt ascending. With MAX_CONCURRENT=1,
    // a fixed iteration order would let the first workspace starve the rest;
    // least-recently-run gives fair round-robin without an explicit queue.
    const eligible: Array<{
      id: string;
      lastRanAt: number;
      recency: number | null;
      recencyAdvanced: boolean;
    }> = [];
    for (const [, projectConfig] of this.config.loadConfigOrDefault().projects) {
      for (const ws of projectConfig.workspaces) {
        const id = ws.id ?? ws.name;
        if (typeof id !== "string" || id.length === 0) continue;
        if (isWorkspaceArchived(ws.archivedAt, ws.unarchivedAt)) continue;
        const state = this.tracked.get(id);
        if (state?.inFlight) continue;
        const snapshot = snapshots.get(id);
        const recency = typeof snapshot?.recency === "number" ? snapshot.recency : null;
        const recencyAdvanced = hasRecencyAdvanced(state, recency);
        const interval = pickInterval(snapshot?.streaming === true, focused);
        if (state && !recencyAdvanced && tickStartedAt - state.lastRanAt < interval) continue;
        eligible.push({ id, lastRanAt: state?.lastRanAt ?? 0, recency, recencyAdvanced });
      }
    }
    eligible.sort((a, b) => {
      if (a.recencyAdvanced !== b.recencyAdvanced) {
        // A user message is usually a task pivot. Put those workspaces ahead
        // of ordinary cadence refreshes so stale pre-pivot statuses don't
        // linger behind background idle work.
        return a.recencyAdvanced ? -1 : 1;
      }
      return a.lastRanAt - b.lastRanAt;
    });

    for (const { id, recency } of eligible) {
      if (this.stopped || this.inFlightPromises.size >= AGENT_STATUS_MAX_CONCURRENT) return;
      const state = this.ensureState(id);
      state.inFlight = true;
      // Set lastRanAt at dispatch time (not after the async transcript
      // build) so cadence is anchored to tick boundaries — see runTick.
      state.lastRanAt = tickStartedAt;
      const promise = this.runForWorkspace(id, recency).finally(() => {
        state.inFlight = false;
        this.inFlightPromises.delete(promise);
      });
      this.inFlightPromises.add(promise);
    }
  }

  private async runForWorkspace(
    workspaceId: string,
    observedRecency: number | null = null
  ): Promise<void> {
    try {
      const transcript = await this.buildTrailingTranscript(workspaceId);
      const inputHash = computeInputHash(transcript);
      // dispatch() set lastRanAt to the tick start time before kicking us
      // off, so the scheduler won't reconsider this workspace until the next
      // interval boundary unless a newer user-recency timestamp indicates the
      // chat pivoted again.
      const state = this.ensureState(workspaceId);

      const markRecencyObserved = () => {
        if (observedRecency !== null) {
          state.lastObservedRecency = observedRecency;
        }
      };

      if (
        isRecentRecencyAheadOfHistory(
          state,
          inputHash,
          observedRecency,
          this.clock(),
          AGENT_STATUS_TICK_INTERVAL_MS
        )
      ) {
        state.lastSeenInputHash = inputHash;
        // We may be seeing WorkspaceService's recency update before the
        // corresponding user message is appended to history. If the transcript
        // is unchanged from the last one we examined (or we have no baseline
        // immediately after startup), generating now could persist a stale
        // pre-pivot status and consume the only recency signal. Wait one
        // scheduler interval so the history write can catch up.
        log.debug("AgentStatusService: waiting for recent recency bump to reach history", {
          workspaceId,
          observedRecency,
        });
        return;
      }
      state.lastSeenInputHash = inputHash;

      // Empty workspace: nothing to summarize. Don't blank an existing
      // todoStatus — that would clobber a status produced before compaction.
      // Still consume non-racy recency so an empty workspace doesn't sort as
      // "recency advanced" forever and starve other workspaces under the
      // single-concurrency scheduler.
      if (transcript.trim().length === 0) {
        markRecencyObserved();
        return;
      }
      // Idle/frozen: identical trailing window since last settled run. The
      // recent race path above already handles recency that may be ahead of
      // history, so any recency reaching this dedup branch is stale/non-racy:
      // consume it to avoid permanent recency-advanced priority.
      if (state.lastInputHash === inputHash) {
        markRecencyObserved();
        return;
      }

      const candidates = await this.workspaceService.getWorkspaceTitleModelCandidates(workspaceId);
      if (candidates.length === 0) return;

      // Skip the expensive provider call if stop() fired during any of the
      // earlier awaits (transcript build, candidates fetch). The generator
      // can take seconds to a minute, so kicking it off after shutdown
      // would leak background LLM work past our lifecycle.
      if (this.stopped) return;
      const result = await generateWorkspaceStatus(transcript, candidates, this.aiService);
      // Re-check after the generator returns: the same hazard at a later
      // await boundary.
      if (this.stopped) return;
      if (!result.success) {
        // Only advance the dedup hash when at least one candidate actually
        // reached the provider. If every candidate failed during model
        // construction (no API key, OAuth not connected, provider disabled,
        // model not available, policy denied, etc.), the failure is about
        // the user's *config* rather than the transcript — caching it would
        // permanently skip this workspace until they happen to send another
        // message, even after they fix credentials. Post-provider failures
        // (model refused tool, rate limit, persistent provider error) are
        // properties of the transcript and should defer until the chat
        // changes.
        if (result.error.reachedProvider) {
          log.debug(
            "AgentStatusService: status generation failed at provider; deferring until transcript changes",
            { workspaceId, error: result.error.error }
          );
          markRecencyObserved();
          state.lastInputHash = inputHash;
        } else {
          log.debug(
            "AgentStatusService: status generation failed before reaching provider; will retry on cadence",
            { workspaceId, error: result.error.error }
          );
          // Consume recency without advancing lastInputHash: credential/config
          // fixes should still retry the same transcript, but a misconfigured
          // workspace must not retain permanent recency-advanced priority and
          // starve other workspaces under max concurrency 1.
          markRecencyObserved();
        }
        return;
      }

      // Defense in depth: even with a tuned prompt, small models can
      // occasionally produce a generic placeholder ("Awaiting next task",
      // "Doing work", etc.) that conveys no information. Reject those
      // outputs before they reach the sidebar. Advance lastInputHash so we
      // don't burn provider budget retrying the same transcript on every
      // tick — the next genuine transcript change will trigger a fresh
      // attempt.
      if (isPlaceholderStatus(result.data.status.message)) {
        log.debug("AgentStatusService: model produced placeholder status; skipping persist", {
          workspaceId,
          message: result.data.status.message,
        });
        markRecencyObserved();
        state.lastInputHash = inputHash;
        return;
      }

      // Persist BEFORE updating the in-memory dedup hash. If the disk write
      // fails we want the next tick to retry against the same transcript
      // instead of dedup'ing against a hash we never committed.
      try {
        const snapshot = await this.extensionMetadata.setSidebarStatus(
          workspaceId,
          result.data.status,
          { skipIfRecencyAdvancedSince: observedRecency }
        );
        if (this.stopped) return;
        if (!snapshot) {
          // The recency check happens inside ExtensionMetadataService's
          // serialized mutation queue, immediately before the status write.
          // That makes it atomic with fire-and-forget user-recency writes:
          // a slow provider response cannot resurrect a pre-pivot status
          // after a newer user turn has queued or committed its recency bump.
          log.debug("AgentStatusService: dropping generated status after newer recency", {
            workspaceId,
            observedRecency,
          });
          return;
        }
        markRecencyObserved();
        state.lastInputHash = inputHash;
        this.workspaceService.emitWorkspaceActivity(workspaceId, snapshot);
      } catch (error) {
        log.error("AgentStatusService: failed to persist generated status", {
          workspaceId,
          error,
        });
      }
    } catch (error) {
      log.error("AgentStatusService: unexpected error during status generation", {
        workspaceId,
        error,
      });
    }
  }

  private ensureState(id: string): State {
    let state = this.tracked.get(id);
    if (!state) {
      state = {
        lastRanAt: 0,
        lastInputHash: null,
        lastSeenInputHash: null,
        lastObservedRecency: null,
        inFlight: false,
      };
      this.tracked.set(id, state);
    }
    return state;
  }

  /**
   * Build the trailing chat transcript, capped by message count and
   * AGENT_STATUS_MAX_TRANSCRIPT_TOKENS. Includes the in-flight partial
   * assistant message (HistoryService.readPartial) so the hash refreshes
   * mid-stream — exactly when "what is the agent doing now" matters most.
   */
  private async buildTrailingTranscript(workspaceId: string): Promise<string> {
    const result = await this.historyService.getLastMessages(
      workspaceId,
      AGENT_STATUS_MAX_TRAILING_MESSAGES
    );
    if (!result.success) return "";

    const messages: MuxMessage[] = [...result.data];
    const partial = await this.historyService.readPartial(workspaceId);
    if (partial) messages.push(partial);

    const formatted = messages.map(formatMessageForTranscript).filter((s) => s.length > 0);
    if (formatted.length === 0) return "";

    // Trim from the front (oldest) until we fit the token budget. Trailing
    // messages carry the most signal for "what is the agent doing right now",
    // so we never drop them. The tokenizer service falls back to a known
    // family for unknown models, so the fallback constant is safe regardless
    // of which model actually generates this workspace's status.
    const tokenCounts = await this.tokenizerService.countTokensBatch(
      FALLBACK_TOKENIZER_MODEL,
      formatted
    );

    let totalTokens = tokenCounts.reduce((sum, n) => sum + n, 0);
    let drop = 0;
    while (totalTokens > AGENT_STATUS_MAX_TRANSCRIPT_TOKENS && drop < formatted.length - 1) {
      totalTokens -= tokenCounts[drop];
      drop += 1;
    }
    return formatted.slice(drop).join("\n\n");
  }
}

function extractMessageText(message: MuxMessage): string {
  return (message.parts ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
}

function summarizeToolPart(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  const record = part as { type?: unknown; toolName?: unknown };
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) return null;
  // Tool calls have type "tool-<name>" or "dynamic-tool" with a toolName.
  const toolName =
    typeof record.toolName === "string"
      ? record.toolName
      : type.startsWith("tool-")
        ? type.slice(5)
        : null;
  return toolName ? `[tool ${toolName}]` : null;
}

function formatMessageForTranscript(message: MuxMessage): string {
  const role = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : null;
  if (!role) return "";

  const segments: string[] = [];
  const text = extractMessageText(message).slice(0, AGENT_STATUS_MAX_MESSAGE_CHARS);
  if (text) segments.push(text);

  // Tool-call summaries let the model see what the agent is doing even when
  // the assistant has not emitted natural-language text yet. Args/output are
  // intentionally omitted to keep cost predictable.
  const tools = (message.parts ?? []).map(summarizeToolPart).filter((s): s is string => s !== null);
  if (tools.length > 0) segments.push(tools.join(" "));

  return segments.length === 0 ? "" : `${role}: ${segments.join("\n")}`;
}

function computeInputHash(transcript: string): string {
  return createHash("sha256").update(transcript).digest("hex");
}

/**
 * Generic non-informative status messages. Even with the prompt steering
 * the model away from these, providers occasionally emit them (especially
 * when the transcript is short or paused). We reject them post-generation
 * rather than letting them reach the sidebar.
 *
 * Match is exact + case-insensitive on the trimmed message; we don't
 * substring-match because legitimate phrases like "Awaiting user reply"
 * contain "Awaiting" and shouldn't be filtered.
 */
const PLACEHOLDER_STATUS_MESSAGES: ReadonlySet<string> = new Set([
  "awaiting next task",
  "awaiting input",
  "doing work",
  "idle",
  "working",
  "no recent activity",
]);

function isPlaceholderStatus(message: string): boolean {
  return PLACEHOLDER_STATUS_MESSAGES.has(message.trim().toLowerCase());
}

function isRecentRecencyAheadOfHistory(
  state: State,
  inputHash: string,
  observedRecency: number | null,
  now: number,
  historyCatchupWindowMs: number
): boolean {
  return (
    hasRecencyAdvanced(state, observedRecency) &&
    (state.lastSeenInputHash === null || state.lastSeenInputHash === inputHash) &&
    observedRecency !== null &&
    now - observedRecency < historyCatchupWindowMs
  );
}

function hasRecencyAdvanced(state: State | undefined, recency: number | null): boolean {
  return (
    state !== undefined &&
    recency !== null &&
    (state.lastObservedRecency === null || recency > state.lastObservedRecency)
  );
}

function pickInterval(streaming: boolean, focused: boolean): number {
  if (streaming) {
    return focused
      ? AGENT_STATUS_ACTIVE_FOCUSED_INTERVAL_MS
      : AGENT_STATUS_ACTIVE_UNFOCUSED_INTERVAL_MS;
  }
  return focused ? AGENT_STATUS_IDLE_FOCUSED_INTERVAL_MS : AGENT_STATUS_IDLE_UNFOCUSED_INTERVAL_MS;
}
