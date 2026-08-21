/**
 * Branch summarization on fork/truncate (rlm-mode experiment).
 *
 * When RLM mode is on and history branches — a workspace forked from an
 * earlier message, or history truncated by an edit-resend — the abandoned
 * tail would otherwise vanish silently. This module summarizes that tail via
 * a cheap side-channel model call (thinking-stripped transcript, bounded
 * output tokens) and appends the summary as a durable, clearly-labeled user
 * row on the new branch BEFORE any subsequent provider request is built, so
 * log purity holds by construction: the row is ordinary durable history and
 * requests never inject live state.
 *
 * Failure posture: strictly best-effort. Model/key unavailability, timeouts,
 * or append failures skip the summary silently (log.debug) and never fail or
 * outlast the user-facing fork/edit operation beyond the hard deadline.
 */

import { streamText } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { NAME_GEN_PREFERRED_MODELS } from "@/common/constants/nameGeneration";
import { buildCompactionPrompt } from "@/common/constants/ui";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import {
  BRANCH_SUMMARY_MAX_ACCUMULATED_CHARS,
  BRANCH_SUMMARY_MAX_OUTPUT_TOKENS,
  BRANCH_SUMMARY_MAX_TRANSCRIPT_CHARS,
  BRANCH_SUMMARY_MIN_SEGMENT_TOKENS,
  BRANCH_SUMMARY_TARGET_WORDS,
  BRANCH_SUMMARY_TIMEOUT_MS,
} from "@/constants/branchSummary";

import type { AIService } from "./aiService";
import type { HistoryService } from "./historyService";
import { runLanguageModelCleanup } from "./languageModelCleanup";
import { log } from "./log";
import { modelCostsIncluded } from "./providerModelFactory";
import type { SessionUsageService } from "./sessionUsageService";
import { createBranchSummaryMessageId } from "./utils/messageIds";

/** Human-readable marker prefixed to the durable summary row's text. */
export const BRANCH_SUMMARY_LABEL = "Summary of the abandoned branch:";

/**
 * Structural subset of AIService so tests can pass lightweight fakes.
 * Pinned-metadata creation (not plain createModel): usage recorded below must
 * carry the creation-time pricing identity, or a Coder catalog refresh
 * mid-generation could re-attribute the spend (same rationale as the status
 * generator and /refine).
 */
export type BranchSummaryAiService = Pick<
  AIService,
  "createModelWithPinnedMetadata" | "getWorkspaceMetadata"
>;

/** Send-option experiment flags relevant to RLM gating (subset of ExperimentsSchema). */
export interface RlmExperimentFlags {
  rlm?: boolean;
  programmaticToolCalling?: boolean;
  programmaticToolCallingExclusive?: boolean;
}

/**
 * True when RLM mode applies. RLM is a sub-experiment of Programmatic Tool
 * Calling: without a PTC parent flag it stays inert (matching the experiments
 * registry). Send-option experiments are AUTHORITATIVE when present — the
 * frontend always sends the full boolean set (useSendMessageOptions /
 * sendOptions.ts), so an explicit `rlm: false` must win over machine
 * overrides, never fall through to them. Only backend-initiated operations
 * without send options (fork IPC) fall back to the persisted machine
 * overrides the renderer syncs into Settings.
 */
export function isRlmModeEnabled(
  experiments: RlmExperimentFlags | undefined,
  isExperimentEnabled: ((experimentId: ExperimentId) => boolean) | undefined
): boolean {
  if (experiments !== undefined) {
    return (
      experiments.rlm === true &&
      (experiments.programmaticToolCalling === true ||
        experiments.programmaticToolCallingExclusive === true)
    );
  }
  // Guard for test mocks that may not implement isExperimentEnabled.
  if (typeof isExperimentEnabled !== "function") {
    return false;
  }
  return (
    isExperimentEnabled(EXPERIMENT_IDS.RLM) &&
    (isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING) ||
      isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE))
  );
}

function extractTextForTranscript(message: MuxMessage): string {
  return (message.parts ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
}

function summarizeToolMarker(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  const record = part as { type?: unknown; toolName?: unknown };
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) return null;
  const toolName =
    typeof record.toolName === "string"
      ? record.toolName
      : type.startsWith("tool-")
        ? type.slice(5)
        : null;
  return toolName ? `[tool ${toolName}]` : null;
}

/**
 * Format one abandoned message for the summarizer. Thinking-stripped by
 * construction: only text parts and compact tool markers survive — reasoning
 * parts are transient signal that inflates side-channel cost without adding
 * durable context worth preserving.
 */
function formatMessageForBranchTranscript(message: MuxMessage): string {
  const role = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : null;
  if (!role) return "";

  const segments: string[] = [];
  const text = extractTextForTranscript(message);
  if (text) segments.push(text);
  for (const part of message.parts ?? []) {
    const marker = summarizeToolMarker(part);
    if (marker) segments.push(marker);
  }
  if (segments.length === 0) return "";
  return `${role}: ${segments.join("\n")}`;
}

/**
 * Build the thinking-stripped transcript of the abandoned segment, trimming
 * oldest messages first when over the input cap (the newest abandoned work
 * carries the most context worth preserving).
 */
export function buildAbandonedBranchTranscript(messages: MuxMessage[]): string {
  assert(Array.isArray(messages), "buildAbandonedBranchTranscript requires a message array");
  const formatted = messages.map(formatMessageForBranchTranscript).filter((s) => s.length > 0);

  let totalChars = formatted.reduce((sum, s) => sum + s.length, 0);
  let drop = 0;
  while (totalChars > BRANCH_SUMMARY_MAX_TRANSCRIPT_CHARS && drop < formatted.length - 1) {
    totalChars -= formatted[drop].length;
    drop += 1;
  }
  // A single oversized message can still exceed the cap after dropping all
  // older ones; hard-clamp from the end (newest content carries the most
  // context) so the transcript never blows a small side-channel model's window.
  return formatted.slice(drop).join("\n\n").slice(-BRANCH_SUMMARY_MAX_TRANSCRIPT_CHARS);
}

/**
 * Build the summarization prompt. Reuses the compaction prompt machinery
 * (include/exclude lists, word target) so summary style stays consistent with
 * epoch compaction, plus an abandoned-branch framing and explicit transcript
 * delimiters (prompt-injection guard: arbitrary chat history must not read as
 * instructions).
 */
export function buildAbandonedBranchSummaryPrompt(transcript: string): string {
  return [
    buildCompactionPrompt(BRANCH_SUMMARY_TARGET_WORDS),
    "",
    "Special case: the transcript below is an ABANDONED branch of the conversation — the user rewound to an earlier message, so these turns were removed from the active history. Summarize what was attempted, decided, and learned on that branch so the continuing assistant retains the context.",
    "",
    "<abandoned_branch>",
    transcript,
    "</abandoned_branch>",
  ].join("\n");
}

/**
 * Cheap side-channel model candidates: preferred small models first, then the
 * workspace's configured models as fallbacks (mirrors
 * WorkspaceService.getWorkspaceTitleModelCandidates, which is not reachable
 * from AgentSession).
 */
async function getSideChannelModelCandidates(
  aiService: BranchSummaryAiService,
  workspaceId: string
): Promise<string[]> {
  const candidates: string[] = [...NAME_GEN_PREFERRED_MODELS];
  const metadataResult = await aiService.getWorkspaceMetadata(workspaceId);
  if (!metadataResult.success) {
    return candidates;
  }
  const fallbackModels = [
    metadataResult.data.aiSettings?.model,
    ...Object.values(metadataResult.data.aiSettingsByAgent ?? {}).map((settings) => settings.model),
  ];
  for (const model of fallbackModels) {
    if (model && !candidates.includes(model)) {
      candidates.push(model);
    }
  }
  return candidates;
}

/**
 * Trim generated text to its last complete line or sentence. Salvages
 * deadline- or max_tokens-truncated output: a summary that ends mid-sentence
 * ("…The assistant") reads as corrupt, while cutting back to the last
 * sentence terminator (or newline, which protects list-style output) keeps
 * only whole statements. Returns "" when no boundary exists.
 */
export function trimSummaryToBoundary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  // Sentence terminators optionally followed by closing quotes/brackets.
  const sentenceEnd = /[.!?][)"'\]]*(?=\s|$)/g;
  let lastBoundary = -1;
  for (const match of trimmed.matchAll(sentenceEnd)) {
    lastBoundary = Math.max(lastBoundary, match.index + match[0].length);
  }
  lastBoundary = Math.max(lastBoundary, trimmed.lastIndexOf("\n"));
  if (lastBoundary <= 0) return "";
  return trimmed.slice(0, lastBoundary).trim();
}

async function generateAbandonedBranchSummaryText(input: {
  aiService: BranchSummaryAiService;
  candidates: string[];
  prompt: string;
  timeoutMs: number;
  cancellationSignal?: AbortSignal;
  /**
   * Cost telemetry for the side-channel call (mirrors the status generator's
   * hook): invoked after a cleanly finished stream so this spend reaches
   * session usage instead of staying invisible.
   */
  recordUsage?: (
    modelString: string,
    usage: LanguageModelV2Usage,
    options: {
      costsIncluded: boolean;
      providerMetadata?: Record<string, unknown>;
      metadataModel: string;
    }
  ) => Promise<void>;
}): Promise<string | null> {
  // One shared deadline across all candidates: callers may block on this, so
  // the total wait must stay bounded regardless of how many models fail over.
  // Caller cancellation (workspace removal) is folded into the same signal so
  // invalidation ends generation promptly instead of waiting out the deadline.
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
  const abortSignal = input.cancellationSignal
    ? AbortSignal.any([timeoutSignal, input.cancellationSignal])
    : timeoutSignal;
  // Defensive double-bound: abortSignal cancels well-behaved providers, but a
  // provider that ignores abort must not hold the fork/edit operation hostage,
  // so the consume loop below also races against this deadline promise.
  const deadline = new Promise<null>((resolve) => {
    if (abortSignal.aborted) {
      resolve(null);
      return;
    }
    abortSignal.addEventListener("abort", () => resolve(null), { once: true });
  });
  const maxAttempts = Math.min(input.candidates.length, 3);

  for (let i = 0; i < maxAttempts; i++) {
    if (abortSignal.aborted) break;
    const modelString = input.candidates[i];
    const modelResult = await input.aiService.createModelWithPinnedMetadata(modelString, {
      agentInitiated: true,
    });
    if (!modelResult.success) {
      log.debug("Branch summary: skipping model candidate", {
        modelString,
        error: modelResult.error.type,
      });
      continue;
    }
    try {
      // streamText (not generateText): Codex OAuth endpoints require
      // stream:true in the request body (same rationale as workspaceTitleGenerator).
      // No thinking provider options are passed, so the call itself stays
      // thinking-free on top of the thinking-stripped transcript.
      const stream = streamText({
        model: modelResult.data.model,
        prompt: input.prompt,
        maxOutputTokens: BRANCH_SUMMARY_MAX_OUTPUT_TOKENS,
        abortSignal,
      });
      // Consume deltas incrementally (not stream.text) so a deadline that
      // fires mid-stream can salvage the text streamed so far instead of
      // turning the whole bounded wait into pure waste. The consumer never
      // rejects: abort/stream errors set streamFailed and end the loop.
      let accumulated = "";
      let streamFailed = false;
      let cappedAtLimit = false;
      // Explicit reader instead of for-await: the deadline path below must be
      // able to cancel the consumer from OUTSIDE. A provider that ignores
      // abortSignal would otherwise keep this loop alive after the race
      // returns — pinned in read() forever, or growing `accumulated` without
      // bound — while the finally cleans up the model underneath it.
      const reader = stream.textStream.getReader();
      const consume = (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // Deadline already won the race: the salvage snapshot was taken,
            // so stop appending and tear the stream down.
            if (abortSignal.aborted) break;
            // Defensive memory bound: a pathological provider can ignore
            // max_tokens too; never buffer beyond the hard cap. Sliced to
            // the remaining allowance BEFORE appending (r21): one giant
            // delta appended in full retained O(delta) memory, and the trim
            // below kept nearly all of it via a late sentence boundary —
            // the retained buffer and the persisted row must both stay
            // <= the cap regardless of delta sizing.
            const remaining = BRANCH_SUMMARY_MAX_ACCUMULATED_CHARS - accumulated.length;
            if (value.length >= remaining) {
              accumulated += value.slice(0, remaining);
              cappedAtLimit = true;
              break;
            }
            accumulated += value;
          }
        } catch (error) {
          streamFailed = true;
          log.debug("Branch summary stream ended with error", {
            modelString,
            error: getErrorMessage(error),
          });
        } finally {
          // Cancel (not just release) on ANY exit: an early break above must
          // stop the underlying stream, not leave it producing into a locked
          // reader. No-op when the stream already closed; rejects when it
          // errored, hence the swallow.
          void reader.cancel().catch(() => undefined);
        }
      })();
      await Promise.race([consume, deadline]);

      if (abortSignal.aborted) {
        // Actively cancel the losing consumer: a wedged provider leaves it
        // pinned in read() (the loop's aborted check only runs when a delta
        // arrives), and cancel resolves that pending read so the reader is
        // released promptly instead of leaking with the raced-away task.
        void reader.cancel().catch(() => undefined);
        // Deadline hit. Salvage whole sentences already streamed — a missed
        // deadline should still buy a (shorter) summary when tokens flowed.
        const salvaged = trimSummaryToBoundary(accumulated);
        if (salvaged.length > 0) {
          log.debug("Branch summary: deadline reached, salvaging partial text", {
            modelString,
            chars: salvaged.length,
          });
          return salvaged;
        }
        log.debug("Branch summary: generation deadline reached with no text", { modelString });
        break;
      }
      if (!streamFailed) {
        // A "length" stop means max_tokens cut the model off mid-sentence, so
        // trim back to a whole-statement boundary; a natural stop is complete
        // by definition and kept verbatim. Raced against the deadline
        // defensively (a stream that closes without a finish part must not
        // hang us); an unknown reason is treated as truncated. A cap-break
        // must NOT touch finishReason at all: awaiting it makes the SDK keep
        // draining the runaway stream internally until the deadline, exactly
        // the unbounded consumption the cap exists to stop.
        const finishReason = cappedAtLimit
          ? null
          : await Promise.race([stream.finishReason, deadline]);
        // Usage is recorded ONLY when a real finish part arrived (non-null
        // finishReason): the stream fully drained, so the SDK's settled usage
        // promise is safe to read. Capped or deadline-hit paths (including
        // salvaged partial summaries) must NOT touch stream.usage — like
        // finishReason above, awaiting it resumes the SDK's internal drain of
        // a runaway/wedged stream, so that spend stays unrecorded by design.
        // Recorded even when the text ends up unusable: the tokens were spent.
        if (finishReason !== null && input.recordUsage) {
          try {
            // Timeout guard mirrors the status generator: a slow-settling SDK
            // promise must not block the fork/edit path behind the deadline.
            const settled = await Promise.race([
              Promise.all([stream.usage, stream.providerMetadata]),
              new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
            ]);
            if (settled !== undefined) {
              const [usage, providerMetadata] = settled;
              await input.recordUsage(modelString, usage, {
                costsIncluded: modelCostsIncluded(modelResult.data.model),
                ...(providerMetadata !== undefined ? { providerMetadata } : {}),
                metadataModel: modelResult.data.metadataModel,
              });
            }
          } catch {
            // Usage promise rejection must not fail an otherwise good summary.
          }
        }
        const text =
          finishReason === "length" || finishReason === null
            ? trimSummaryToBoundary(accumulated)
            : accumulated.trim();
        if (text.length > 0) {
          return text;
        }
        log.debug("Branch summary: model produced empty summary", { modelString });
      }
      // streamFailed without abort => try the next candidate.
    } catch (error) {
      log.debug("Branch summary generation failed", {
        modelString,
        error: getErrorMessage(error),
      });
    } finally {
      runLanguageModelCleanup(modelResult.data.model);
    }
  }
  return null;
}

/** Build the durable labeled summary row appended to the new branch. */
export function createBranchSummaryMessage(summaryText: string): MuxMessage {
  assert(summaryText.trim().length > 0, "branch summary text must be non-empty");
  return createMuxMessage(
    createBranchSummaryMessageId(),
    // SECURITY: assistant role, never user. The text is MODEL OUTPUT over an
    // attacker-influenceable transcript (the abandoned branch); storing it as
    // a user row would grant prompt-injected summarizer output user-priority
    // trust in every later tool-capable request, surviving the very rewind
    // the user performed. As an assistant row the provider reads it as prior
    // generated context, not user instructions — same posture as compaction
    // summary rows, the other synthetic assistant precedent. Provenance is
    // durable via synthetic + muxMetadata; no turn envelope/usage marks it as
    // a streamed turn.
    "assistant",
    `${BRANCH_SUMMARY_LABEL}\n\n${summaryText.trim()}`,
    {
      timestamp: Date.now(),
      synthetic: true,
      uiVisible: true,
      muxMetadata: { type: "branch-summary" },
    }
  );
}

/** Everything maybeAppendAbandonedBranchSummary needs; shared by the background starter. */
export interface AbandonedBranchSummaryInput {
  historyService: Pick<HistoryService, "appendToHistory" | "appendToHistoryIfTailMatches">;
  aiService: BranchSummaryAiService;
  /** The NEW branch: fork target workspace, or the edited workspace post-truncation. */
  workspaceId: string;
  /** The removed tail, as returned by HistoryService.truncateAfterMessage. */
  abandonedMessages: MuxMessage[];
  /** Send-option experiments when available (edit path); omit for IPC ops without send options (fork). */
  experiments?: RlmExperimentFlags;
  /** Machine-override fallback (ExperimentsService/AIService.isExperimentEnabled). */
  isExperimentEnabled?: (experimentId: ExperimentId) => boolean;
  /**
   * Cost telemetry sink: the side-channel call bills real tokens, and without
   * this the spend never reaches session usage or the cost UI. Recorded
   * against the workspace receiving the summary row (fork target / edited
   * workspace), same attribution recordHeadlessUsage gives /refine.
   */
  sessionUsageService?: Pick<SessionUsageService, "recordHeadlessUsage">;
  /**
   * When set, the summary row is appended only if this message is still the
   * branch's tail at append time (compare-and-append under the history lock).
   * Required for callers that do not block on generation (fork): the row must
   * never land after unrelated rows, so losing the race drops it silently.
   */
  guardTailMessageId?: string;
  timeoutMs?: number;
  /**
   * Invalidation signal for background writers: workspace removal aborts it
   * (clearPendingBranchSummary). Generation stops promptly and the append
   * step must not run once aborted — a late append could recreate the
   * just-deleted session directory.
   */
  cancellationSignal?: AbortSignal;
}

/**
 * Summarize an abandoned history segment and append the labeled row to the
 * new branch's chat.jsonl. Returns the appended row (so live sessions can
 * emit it to the renderer) or null when no summary was produced.
 *
 * The edit-resend path awaits this SYNCHRONOUSLY (bounded by timeoutMs):
 * the acceptance contract requires the summary row to precede the re-sent
 * user message, which is appended immediately after, so there is no later
 * point where the row could still land in order. The fork path instead runs
 * this in the background (startAbandonedBranchSummaryInBackground) because
 * the fork's next request is not built until the user's first send, which
 * awaits the pending summary; the tail guard makes the late append
 * provably race-free.
 *
 * Never throws; every failure path degrades to "no summary row".
 */
export async function maybeAppendAbandonedBranchSummary(
  input: AbandonedBranchSummaryInput
): Promise<MuxMessage | null> {
  try {
    // RLM off => byte-identical behavior to today: no model call, no row.
    if (!isRlmModeEnabled(input.experiments, input.isExperimentEnabled)) {
      return null;
    }
    if (input.abandonedMessages.length === 0) {
      return null;
    }

    // Compaction artifacts must not reach the summarizer. Forking from a
    // message that moved into the sealed archive removes BOTH the archived
    // original turns and their rlmPreservedTailCopy duplicates from the
    // active epoch, so the copies would displace unique abandoned work under
    // the transcript's char cap; compaction summary rows likewise condense
    // history that is already represented (kept prefix or removed originals).
    // Filtered here — NOT in buildAbandonedBranchTranscript, which /refine
    // also uses on the active epoch where the preserved copies are the tail's
    // only representation.
    const abandonedMessages = input.abandonedMessages.filter(
      (message) =>
        message.metadata?.rlmPreservedTailCopy !== true &&
        (message.metadata?.compacted === undefined || message.metadata.compacted === false)
    );

    // Tiny abandoned segments are not worth a model call.
    const estimatedTokens = abandonedMessages.reduce(
      (sum, message) => sum + estimateMuxMessageTokens(message),
      0
    );
    if (estimatedTokens < BRANCH_SUMMARY_MIN_SEGMENT_TOKENS) {
      return null;
    }

    const transcript = buildAbandonedBranchTranscript(abandonedMessages);
    if (transcript.length === 0) {
      return null;
    }

    const candidates = await getSideChannelModelCandidates(input.aiService, input.workspaceId);
    if (candidates.length === 0) {
      return null;
    }

    const sessionUsageService = input.sessionUsageService;
    const summaryText = await generateAbandonedBranchSummaryText({
      aiService: input.aiService,
      candidates,
      prompt: buildAbandonedBranchSummaryPrompt(transcript),
      timeoutMs: input.timeoutMs ?? BRANCH_SUMMARY_TIMEOUT_MS,
      cancellationSignal: input.cancellationSignal,
      ...(sessionUsageService
        ? {
            recordUsage: async (
              modelString: string,
              usage: LanguageModelV2Usage,
              options: {
                costsIncluded: boolean;
                providerMetadata?: Record<string, unknown>;
                metadataModel: string;
              }
            ) => {
              // recordHeadlessUsage never throws (cost telemetry must not
              // fail the feature that spent the tokens). The analytics
              // sidecar entry matters because this spend produces no
              // assistant chat row the ETL could otherwise ingest.
              await sessionUsageService.recordHeadlessUsage(
                input.workspaceId,
                modelString,
                usage,
                options.providerMetadata,
                {
                  costsIncluded: options.costsIncluded,
                  analyticsSource: "branch_summary",
                  metadataModel: options.metadataModel,
                }
              );
            },
          }
        : {}),
    });
    if (summaryText === null) {
      return null;
    }

    // Invalidation gate before the write: workspace removal may have started
    // while we were generating, and an append past this point could recreate
    // the session directory after removal deletes it. clearPendingBranchSummary
    // aborts first and then awaits this promise, so either the abort is
    // visible here (no append) or removal waits for the append to finish.
    if (input.cancellationSignal?.aborted) {
      log.debug("Branch summary: cancelled before append", { workspaceId: input.workspaceId });
      return null;
    }

    const summaryMessage = createBranchSummaryMessage(summaryText);
    if (input.guardTailMessageId !== undefined) {
      const guardedResult = await input.historyService.appendToHistoryIfTailMatches(
        input.workspaceId,
        summaryMessage,
        input.guardTailMessageId
      );
      if (!guardedResult.success) {
        log.debug("Branch summary: failed to append summary row", {
          workspaceId: input.workspaceId,
          error: guardedResult.error,
        });
        return null;
      }
      if (guardedResult.data === "tail-mismatch") {
        // History moved past the branch point while we were generating (the
        // user's first turn won the race, or the branch was rewritten).
        // Appending now would put the row out of order — drop it instead.
        log.debug("Branch summary: history advanced past branch point, dropping summary", {
          workspaceId: input.workspaceId,
          guardTailMessageId: input.guardTailMessageId,
        });
        return null;
      }
      return summaryMessage;
    }
    const appendResult = await input.historyService.appendToHistory(
      input.workspaceId,
      summaryMessage
    );
    if (!appendResult.success) {
      log.debug("Branch summary: failed to append summary row", {
        workspaceId: input.workspaceId,
        error: appendResult.error,
      });
      return null;
    }
    return summaryMessage;
  } catch (error) {
    // Self-healing doctrine: the summary is best-effort and must never fail
    // the fork/edit operation that triggered it.
    log.debug("Branch summary: unexpected failure", {
      workspaceId: input.workspaceId,
      error: getErrorMessage(error),
    });
    return null;
  }
}

/**
 * Pending background summaries by workspace id. Fork registers here so the
 * new workspace's first send can await the row before building its request
 * (keeping the "summary lands before the next request" contract) without the
 * fork operation itself stalling on generation.
 *
 * A registration that produced a row is retained even after it settles: the
 * renderer may have loaded history before the background append landed, so
 * the first send must still be able to consume the row and emit it (deleting
 * at settle time left the row invisible until a reload). Cleanup happens on
 * consumption (awaitPendingBranchSummary) or workspace removal
 * (clearPendingBranchSummary), so retained results cannot accumulate.
 */
interface PendingBranchSummary {
  promise: Promise<MuxMessage | null>;
  /** Invalidates the background writer (see clearPendingBranchSummary). */
  controller: AbortController;
  /**
   * Exactly-once consumption marker. The entry must STAY in the map while the
   * first send awaits an unsettled promise — deleting it up front left a
   * concurrent workspace removal with nothing to abort/drain, so the writer
   * (or the resumed send) could append after removal deleted the session
   * directory. Set synchronously, so two concurrent sends cannot both consume.
   */
  consumed: boolean;
}
const pendingBranchSummaries = new Map<string, PendingBranchSummary>();

/**
 * Start abandoned-branch summarization WITHOUT blocking the caller. Used by
 * fork: awaiting generation synchronously stalls the user-facing fork for
 * seconds even when it ultimately produces nothing. Instead the promise is
 * registered so the fork's first send awaits it (see
 * awaitPendingBranchSummary), and the tail guard guarantees a late append can
 * never land after unrelated rows. maybeAppendAbandonedBranchSummary never
 * rejects, so this deliberate not-awaited call cannot leave an unhandled
 * rejection behind.
 */
export function startAbandonedBranchSummaryInBackground(
  input: AbandonedBranchSummaryInput & { guardTailMessageId: string }
): void {
  const controller = new AbortController();
  const promise = maybeAppendAbandonedBranchSummary({
    ...input,
    cancellationSignal: controller.signal,
  });
  const entry: PendingBranchSummary = { promise, controller, consumed: false };
  pendingBranchSummaries.set(input.workspaceId, entry);
  void promise.then((appended) => {
    // A null result has nothing left for the first send to consume, so drop
    // the registration eagerly. A produced row must STAY registered: deleting
    // it here would make a summary that settles before the first send return
    // null from awaitPendingBranchSummary, leaving the appended row invisible
    // in the open chat until a reload. Only clear our own registration (a
    // re-fork of the same workspace id cannot happen, but stay defensive
    // about overwrites).
    if (appended === null && pendingBranchSummaries.get(input.workspaceId) === entry) {
      pendingBranchSummaries.delete(input.workspaceId);
    }
  });
}

/**
 * Await a pending background branch summary for this workspace, if any.
 * Bounded: the underlying generation enforces BRANCH_SUMMARY_TIMEOUT_MS.
 * Returns the appended row (for renderer emission) or null. Callers that
 * append user messages / build requests must call this first so the summary
 * row keeps its before-the-next-request ordering.
 */
export async function awaitPendingBranchSummary(workspaceId: string): Promise<MuxMessage | null> {
  const entry = pendingBranchSummaries.get(workspaceId);
  if (!entry) {
    return null;
  }
  if (entry.consumed) {
    // Consumption is gated, WAITING is not: a concurrent second send must
    // still block until the writer settles, or it could append its user
    // message first — advancing the guarded tail so the summary drops as a
    // mismatch and NEITHER request gets the abandoned-branch context. It
    // returns null (never rejects), so only the consumer emits the row.
    await entry.promise.catch(() => undefined);
    return null;
  }
  // Check-and-set is synchronous, so exactly one send observes (and emits)
  // the row; concurrent sends wait above without consuming. The entry itself
  // is NOT removed until the promise settles: workspace removal racing this
  // await must still find the cancellation handle to abort/drain the writer
  // (a cancelled writer resolves null here, so nothing is emitted after
  // removal).
  entry.consumed = true;
  try {
    return await entry.promise;
  } finally {
    // Identity-guarded: clearPendingBranchSummary may have already deleted
    // (and a re-registration under the same id must not be swept).
    if (pendingBranchSummaries.get(workspaceId) === entry) {
      pendingBranchSummaries.delete(workspaceId);
    }
  }
}

/**
 * Invalidate and drain any pending/retained registration for a removed
 * workspace. Settled results are kept consumable until the first send (see
 * the map doc above), so a fork that never sends must be cleaned up here or
 * its registration would leak forever.
 *
 * Removal MUST await this before deleting the session directory: the abort
 * stops generation and blocks the append step, and awaiting the (never
 * rejecting) promise serializes removal behind a writer whose append is
 * already in flight — otherwise that late append could recreate the session
 * directory after deletion, leaving an orphan.
 */
export async function clearPendingBranchSummary(workspaceId: string): Promise<void> {
  const entry = pendingBranchSummaries.get(workspaceId);
  pendingBranchSummaries.delete(workspaceId);
  if (!entry) {
    return;
  }
  entry.controller.abort();
  await entry.promise;
}
