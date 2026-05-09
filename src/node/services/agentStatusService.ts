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
   * Hash of the input we last *attempted* to generate for — covers
   * successful persists, post-generation placeholder rejection, and
   * (intentionally) candidate failures that reached the provider.
   *
   * Why "attempted" rather than "successful": if all candidates fail
   * (e.g., a configured model repeatedly refuses to call propose_status,
   * or a persistent provider error), leaving this unset would let the
   * scheduler resend the same trailing transcript every focused/idle
   * interval, burning tokens on a workspace that is stuck. Advancing the
   * hash on failure means the next genuine transcript change is the
   * natural retry trigger, while idle/frozen workspaces stay quiet.
   *
   * null if we have never attempted on this workspace.
   */
  lastInputHash: string | null;
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
 * hash to the last successful run skips regeneration (idle/frozen chats).
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
    // generation across workspaces, so the first tick can fire immediately
    // without risking a thundering herd at launch.
    this.checkInterval = setInterval(() => void this.runTick(), this.tickIntervalMs);
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
    const eligible: Array<{ id: string; lastRanAt: number }> = [];
    for (const [, projectConfig] of this.config.loadConfigOrDefault().projects) {
      for (const ws of projectConfig.workspaces) {
        const id = ws.id ?? ws.name;
        if (typeof id !== "string" || id.length === 0) continue;
        if (isWorkspaceArchived(ws.archivedAt, ws.unarchivedAt)) continue;
        const state = this.tracked.get(id);
        if (state?.inFlight) continue;
        const interval = pickInterval(snapshots.get(id)?.streaming === true, focused);
        if (state && tickStartedAt - state.lastRanAt < interval) continue;
        eligible.push({ id, lastRanAt: state?.lastRanAt ?? 0 });
      }
    }
    eligible.sort((a, b) => a.lastRanAt - b.lastRanAt);

    for (const { id } of eligible) {
      if (this.stopped || this.inFlightPromises.size >= AGENT_STATUS_MAX_CONCURRENT) return;
      const state = this.ensureState(id);
      state.inFlight = true;
      // Set lastRanAt at dispatch time (not after the async transcript
      // build) so cadence is anchored to tick boundaries — see runTick.
      state.lastRanAt = tickStartedAt;
      const promise = this.runForWorkspace(id).finally(() => {
        state.inFlight = false;
        this.inFlightPromises.delete(promise);
      });
      this.inFlightPromises.add(promise);
    }
  }

  private async runForWorkspace(workspaceId: string): Promise<void> {
    try {
      const transcript = await this.buildTrailingTranscript(workspaceId);
      const inputHash = computeInputHash(transcript);
      // dispatch() set lastRanAt to the tick start time before kicking us
      // off, so the scheduler already won't reconsider this workspace until
      // the next interval boundary regardless of which branch we take below.
      const state = this.ensureState(workspaceId);

      // Empty workspace: nothing to summarize. Don't blank an existing
      // todoStatus — that would clobber a status produced before compaction.
      if (transcript.trim().length === 0) return;
      // Idle/frozen: identical trailing window since last successful run.
      if (state.lastInputHash === inputHash) return;

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
        // Advance the dedup hash so we don't resend the same frozen
        // transcript every tick when a workspace is stuck on a model that
        // consistently fails (refuses propose_status, persistent provider
        // error, etc.). The next genuine transcript change will trigger a
        // fresh attempt.
        log.debug(
          "AgentStatusService: status generation failed; deferring until transcript changes",
          {
            workspaceId,
            error: result.error,
          }
        );
        state.lastInputHash = inputHash;
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
        state.lastInputHash = inputHash;
        return;
      }

      // Persist BEFORE updating the in-memory dedup hash. If the disk write
      // fails we want the next tick to retry against the same transcript
      // instead of dedup'ing against a hash we never committed.
      try {
        const snapshot = await this.extensionMetadata.setSidebarStatus(
          workspaceId,
          result.data.status
        );
        if (this.stopped) return;
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
      state = { lastRanAt: 0, lastInputHash: null, inFlight: false };
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

function pickInterval(streaming: boolean, focused: boolean): number {
  if (streaming) {
    return focused
      ? AGENT_STATUS_ACTIVE_FOCUSED_INTERVAL_MS
      : AGENT_STATUS_ACTIVE_UNFOCUSED_INTERVAL_MS;
  }
  return focused ? AGENT_STATUS_IDLE_FOCUSED_INTERVAL_MS : AGENT_STATUS_IDLE_UNFOCUSED_INTERVAL_MS;
}
