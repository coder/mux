/**
 * Side-question (/btw) service: a forked, single-turn, read-only side branch
 * of the current conversation.
 *
 * /btw lets a user ask a quick question against the current chat. Because
 * the answer is useful to keep visible across reloads (so the user can scroll
 * back and re-read it), we PERSIST both the user question and the assistant
 * answer to chat.jsonl, with metadata that marks them as side-question
 * artifacts. The renderer uses that metadata to style them distinctly, and
 * request builders filter the side branch out of future main-agent context.
 *
 * What still makes /btw "forked":
 *   - No tools — the model is told tools are unavailable AND the schema-side
 *     `tools` argument is omitted from the streamText call.
 *   - Single turn — we do not loop the agent; one streamText call, one
 *     committed assistant message.
 *   - No workspace busy state — we do not flip the workspace's "streaming"
 *     flag, so the user can still send normal messages, fire another /btw,
 *     or interrupt the main agent while a side question is answering.
 *
 * Streaming:
 *   - We emit `stream-start` / `stream-delta` / `stream-end` chat events
 *     directly via `session.emitChatEvent` (bypassing StreamManager). The
 *     frontend's existing StreamingMessageAggregator handles these events
 *     identically to a real agent stream, which means TypewriterMarkdown,
 *     smooth-text animation, and stream replay all work out of the box.
 */

import { streamText, type ModelMessage } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { modelCostsIncluded } from "./providerModelFactory";
import type { AIService } from "./aiService";
import type { HistoryService } from "./historyService";
import { log } from "./log";
import { mapModelCreationError, mapNameGenerationError } from "./workspaceTitleGenerator";
import { runLanguageModelCleanup } from "./languageModelCleanup";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { NameGenerationError } from "@/common/types/errors";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import {
  SIDE_QUESTION_ANSWER_METADATA_TYPE,
  SIDE_QUESTION_COMMAND,
  SIDE_QUESTION_METADATA_TYPE,
  filterSideQuestionMessages,
} from "@/common/utils/messages/sideQuestion";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { createUserMessageId, createAssistantMessageId } from "@/node/services/utils/messageIds";
import { NAME_GEN_PREFERRED_MODELS } from "@/common/constants/nameGeneration";

/** Max non-/btw messages from the active context window we keep in a /btw transcript. */
const SIDE_QUESTION_MAX_TRAILING_MESSAGES = 200;
/** Max characters per message we keep in the transcript (per role). */
const SIDE_QUESTION_MAX_MESSAGE_CHARS = 8_000;
/** Overall character budget for the transcript (defensive against runaway). */
const SIDE_QUESTION_MAX_TRANSCRIPT_CHARS = 120_000;
/**
 * Lower bound on the number of model-creation attempts. Even when the
 * workspace-preferred candidates fail or look stale, we walk far enough to
 * exercise at least one entry from `NAME_GEN_PREFERRED_MODELS` so /btw stays
 * usable. Three matches the historical behavior before this was named.
 */
const SIDE_QUESTION_MIN_FALLBACK_ATTEMPTS = 3;

/**
 * Narrow surface of `AIService` consumed by /btw. The full `AIService` includes
 * the entire streaming/billing pipeline; /btw only needs to mint a model and
 * peek at the live-stream registry. Stating the dependency precisely keeps
 * `askSideQuestion` testable without an `as unknown as AIService` cast.
 */
export type SideQuestionAIService = Pick<
  AIService,
  "createModel" | "getStreamInfo" | "resolveMetadataModel"
>;

export interface AskSideQuestionOptions {
  workspaceId: string;
  question: string;
  candidates: readonly string[];
  aiService: SideQuestionAIService;
  historyService: HistoryService;
  /** Optional pre-await snapshot captured by callers that must avoid async race windows. */
  liveStreamSnapshot?: ReturnType<AIService["getStreamInfo"]>;
  /**
   * Emit a chat event so the frontend's `onChat` subscription sees the new
   * message / stream lifecycle. Provided by WorkspaceService so this module
   * stays free of any direct dependency on AgentSession.
   */
  emitChatEvent: (workspaceId: string, message: WorkspaceChatMessage) => void;
  /**
   * Best-effort cost telemetry for the successful answer. /btw bypasses
   * StreamManager, so without this callback its token spend never reaches
   * session-usage.json. Provided by WorkspaceService (SessionUsageService).
   */
  recordUsage?: (
    modelString: string,
    usage: LanguageModelV2Usage,
    providerMetadata?: Record<string, unknown>
  ) => Promise<void>;
}

export interface AskSideQuestionSuccess {
  /** Final answer text (also persisted to history). */
  answer: string;
  /** Model that successfully produced the answer. */
  modelUsed: string;
  /** ID of the assistant message appended to history. */
  assistantMessageId: string;
}

/**
 * Build the model messages for a side question. Exported for testability —
 * the wording of the reminder is the load-bearing part of the "no tools,
 * conversation-grounded" contract.
 */
export function buildSideQuestionMessages(
  question: string,
  transcript: string
): { system: string; messages: ModelMessage[] } {
  const trimmedQuestion = question.trim();
  const renderedTranscript = transcript.trim().length > 0 ? transcript : "(empty transcript)";

  const system = [
    "You are answering a quick side question about an ongoing AI coding chat.",
    "This is a forked, single-turn branch. Your answer will be appended to the",
    "chat as a clearly-marked side answer so the user can re-read it later,",
    "but no follow-up turn is possible on this branch.",
    "",
    "Rules:",
    "- Answer directly from the conversation context provided below.",
    "- No tools are available on this turn. Do not pretend to call tools,",
    "  do not emit tool-call JSON, and do not promise future actions.",
    "- If the conversation does not contain enough information to answer,",
    "  say so plainly instead of guessing or fabricating details.",
    "- Keep the answer concise and use markdown when it improves clarity.",
  ].join("\n");

  const userPrompt = [
    "Current conversation (oldest first, newest last):",
    "<conversation>",
    renderedTranscript,
    "</conversation>",
    "",
    "<system-reminder>",
    "The user just asked a side question (/btw). Answer directly using the",
    "conversation above. No tools are available. This is a one-shot response;",
    "no follow-up turn will reach you.",
    "</system-reminder>",
    "",
    `Side question: ${trimmedQuestion}`,
  ].join("\n");

  return {
    system,
    messages: [{ role: "user", content: userPrompt }],
  };
}

/**
 * Run a /btw side question. Persists the user question, streams the answer,
 * and persists the final assistant message. The orpc caller only needs to
 * know success/failure — actual content flows to the renderer through the
 * existing `onChat` subscription.
 */
export function snapshotSideQuestionLiveStream(
  liveStream: ReturnType<AIService["getStreamInfo"]>
): ReturnType<AIService["getStreamInfo"]> {
  return liveStream
    ? {
        ...liveStream,
        // Freeze the visible-at-/btw part list before any awaited I/O.
        // StreamManager mutates this array as new main-agent chunks arrive;
        // the side-question prompt must line up with the interruption offset
        // captured at this exact moment.
        parts: liveStream.parts.map((part) => ({ ...part })),
      }
    : undefined;
}

export async function askSideQuestion(
  opts: AskSideQuestionOptions
): Promise<Result<AskSideQuestionSuccess, NameGenerationError>> {
  const { workspaceId, question, candidates, aiService, historyService, emitChatEvent } = opts;

  const trimmedQuestion = question.trim();
  if (trimmedQuestion.length === 0) {
    return Err({ type: "unknown", raw: "Side question is empty" });
  }

  if (candidates.length === 0) {
    return Err({ type: "unknown", raw: "No model candidates available for side question" });
  }

  // ---------------------------------------------------------------------
  // 0. Snapshot any in-flight MAIN-AGENT stream so the renderer can later
  //    split the interrupted message into pre-aside + post-aside halves
  //    around this /btw pair.
  //
  // Two structural guarantees make this safe to read synchronously:
  //  - `aiService.getStreamInfo` is a sync getter over an in-memory map
  //    (StreamManager.workspaceStreams), so no race with disk I/O.
  //  - The /btw pipeline bypasses StreamManager entirely (no
  //    `streamManager.startStream` call), so `getStreamInfo` can ONLY
  //    return a main-agent stream — never a concurrent /btw. The
  //    "side question must not interrupt itself" filter is therefore
  //    structural rather than a runtime check.
  //
  // MUST run before the first `await` below: any awaited work between
  // this read and the user-message append widens the racy window where
  // the main agent could finish streaming (StreamingMessageAggregator
  // would then no longer have the interruption anchor we promise).
  // ---------------------------------------------------------------------
  const liveStreamSnapshot =
    opts.liveStreamSnapshot ?? snapshotSideQuestionLiveStream(aiService.getStreamInfo(workspaceId));
  const interruption = liveStreamSnapshot
    ? {
        interruptedMessageId: liveStreamSnapshot.messageId,
        // Text length anchors the split across text parts; part index keeps
        // non-text parts (reasoning/tool/file) that were already visible at
        // the same text offset on the pre-aside side after reload.
        interruptedTextLength: liveStreamSnapshot.parts.reduce(
          (sum, p) => (p.type === "text" ? sum + p.text.length : sum),
          0
        ),
        interruptedPartIndex: liveStreamSnapshot.parts.length,
        interruptedHistorySequence: liveStreamSnapshot.historySequence,
      }
    : undefined;

  // ---------------------------------------------------------------------
  // 1. Persist + emit the user's /btw message FIRST so the question shows
  //    up in the chat immediately. Even if the model call fails, the user
  //    can see what they asked.
  // ---------------------------------------------------------------------
  const rawCommand = `${SIDE_QUESTION_COMMAND} ${trimmedQuestion}`;
  const userMessage: MuxMessage = createMuxMessage(createUserMessageId(), "user", trimmedQuestion, {
    timestamp: Date.now(),
    muxMetadata: {
      type: SIDE_QUESTION_METADATA_TYPE,
      rawCommand,
      // `commandPrefix` is rendered as a small badge before the message
      // body — reuses the existing `/compact` / `/{skillName}` mechanism.
      commandPrefix: SIDE_QUESTION_COMMAND,
      // Spread the interruption snapshot only when a main-agent stream
      // was actually in flight — otherwise leave the fields off so the
      // renderer treats this as a "normal" side branch at the end of the
      // transcript.
      ...interruption,
    },
  });

  const appendUserResult = await historyService.appendToHistory(workspaceId, userMessage);
  if (!appendUserResult.success) {
    return Err({ type: "unknown", raw: appendUserResult.error });
  }
  emitChatEvent(workspaceId, { ...userMessage, type: "message" });

  // Persist first so the UI shows the side branch immediately, but do not
  // read the current /btw row back into model context: the transcript helper
  // filters side-question rows and buildSideQuestionMessages adds the current
  // question explicitly below the transcript.
  const transcript = await buildSideQuestionTranscript(
    workspaceId,
    historyService,
    liveStreamSnapshot
  );
  const { system, messages } = buildSideQuestionMessages(trimmedQuestion, transcript);

  const fallbackModels = new Set<string>(NAME_GEN_PREFERRED_MODELS);
  const firstFallbackCandidateIndex = candidates.findIndex((candidate) =>
    fallbackModels.has(candidate)
  );
  // Try the first few workspace-preferred candidates, but keep going far enough
  // to exercise at least one known fallback. This keeps /btw usable when stale
  // live/chat/agent model IDs sit ahead of the fallback list.
  const maxAttempts = Math.min(
    candidates.length,
    Math.max(
      SIDE_QUESTION_MIN_FALLBACK_ATTEMPTS,
      firstFallbackCandidateIndex >= 0 ? firstFallbackCandidateIndex + 1 : 0
    )
  );
  let lastError: NameGenerationError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const modelString = candidates[attempt];

    const modelResult = await aiService.createModel(modelString, undefined, {
      agentInitiated: false,
    });
    if (!modelResult.success) {
      lastError = mapModelCreationError(modelResult.error, modelString);
      log.debug(`Side question: skipping ${modelString} (${modelResult.error.type})`);
      continue;
    }

    // Each attempt uses a fresh assistant message id so a retried candidate
    // never reuses a partially-streamed stale id.
    const assistantMessageId = createAssistantMessageId();
    const streamStartedAt = Date.now();
    let accumulatedText = "";

    // Append a placeholder assistant row FIRST so historyService allocates
    // a historySequence we can attach to stream-start. The frontend's
    // StreamingMessageAggregator keys streams by both messageId and
    // historySequence, so this number needs to be real and stable.
    const placeholderAssistant: MuxMessage = {
      id: assistantMessageId,
      role: "assistant",
      metadata: {
        timestamp: streamStartedAt,
        model: modelString,
        muxMetadata: {
          type: SIDE_QUESTION_ANSWER_METADATA_TYPE,
          questionMessageId: userMessage.id,
        },
      },
      parts: [],
    };
    const placeholderResult = await historyService.appendToHistory(
      workspaceId,
      placeholderAssistant
    );
    if (!placeholderResult.success) {
      lastError = { type: "unknown", raw: placeholderResult.error };
      log.warn("Side question: failed to append assistant placeholder", {
        workspaceId,
        error: placeholderResult.error,
      });
      runLanguageModelCleanup(modelResult.data);
      continue;
    }
    const assistantHistorySequence = placeholderAssistant.metadata?.historySequence;
    if (typeof assistantHistorySequence !== "number") {
      lastError = {
        type: "unknown",
        raw: "appendToHistory did not assign a historySequence to the side-question placeholder",
      };
      runLanguageModelCleanup(modelResult.data);
      continue;
    }

    // Surface the placeholder to the live chat stream so the frontend
    // aggregator sees the side-question-answer's muxMetadata BEFORE
    // stream-start fires. Without this, the aggregator's handleStreamStart
    // would create a fresh assistant message from the stream-start event
    // payload (which doesn't carry muxMetadata) and the marker that drives
    // side-answer styling plus the aggregator's side-answer-aware lifecycle
    // guards (skipping main-agent model switch, onResponseComplete, queued
    // follow-up handling, and the WorkspaceStore stream-end pinned-todo
    // collapse) would be lost for the entire streaming window. On
    // reconnect/replay the placeholder is re-emitted from chat.jsonl, so
    // the marker survives there too.
    emitChatEvent(workspaceId, { ...placeholderAssistant, type: "message" });

    // -------------------------------------------------------------------
    // 2. Open the streaming envelope so the frontend can render the
    //    assistant slot immediately and animate text as it arrives.
    // -------------------------------------------------------------------
    emitChatEvent(workspaceId, {
      type: "stream-start",
      workspaceId,
      messageId: assistantMessageId,
      model: modelString,
      historySequence: assistantHistorySequence,
      startTime: streamStartedAt,
    });

    let usage: LanguageModelV2Usage | undefined;
    let usageProviderMetadata: Record<string, unknown> | undefined;
    try {
      try {
        // streamText (not generateText): we want token-by-token UX.
        // No `tools` key: tools are denied client-side AND prompt-side per the
        // /btw spec.
        const stream = streamText({
          model: modelResult.data,
          system,
          messages,
        });

        for await (const chunk of stream.textStream) {
          if (chunk.length === 0) continue;
          accumulatedText += chunk;
          emitChatEvent(workspaceId, {
            type: "stream-delta",
            workspaceId,
            messageId: assistantMessageId,
            delta: chunk,
            // Token count is best-effort — we don't tokenize per chunk here
            // because /btw isn't billed against the main agent's token budget
            // UI. The frontend uses this only for its live "tokens/sec" stat,
            // which is non-critical for an ephemeral side question.
            tokens: 0,
            timestamp: Date.now(),
          });
        }

        // Cost telemetry: the side question sends the full conversation
        // context, so the provider bills real spend. Capture usage after a
        // clean stream (short race — a slow-settling SDK promise must not
        // stall the answer) so it can be persisted on the answer row and
        // recorded in session-usage.json below.
        const withTimeout = <T>(promise: PromiseLike<T>): Promise<T | undefined> =>
          Promise.race([
            promise,
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
          ]).catch(() => undefined);
        usage = await withTimeout(stream.totalUsage);
        usageProviderMetadata = await withTimeout(stream.providerMetadata);
        // Subscription-covered routing (Codex OAuth) must price at $0. The
        // StreamManager path stamps this via markProviderMetadataCostsIncluded;
        // /btw bypasses it, so stamp here — the persisted answer row (analytics
        // ETL) and the recordUsage callback both read this metadata.
        if (usage !== undefined && modelCostsIncluded(modelResult.data)) {
          const existingMux = usageProviderMetadata?.mux;
          usageProviderMetadata = {
            ...(usageProviderMetadata ?? {}),
            mux: {
              ...(typeof existingMux === "object" && existingMux !== null ? existingMux : {}),
              costsIncluded: true,
            },
          };
        }
      } catch (error) {
        lastError = mapNameGenerationError(error, modelString);
        log.warn("Side question failed; trying next candidate", {
          modelString,
          workspaceId,
          error: lastError,
        });
        // Tear down the failed candidate's partial output so the retry on the
        // next candidate doesn't leave the failed turn's accumulated text
        // sitting in the chat next to the successful answer.
        //
        // Live aggregator: stream-end does NOT replace already-accumulated
        // delta text with `data.parts` (it only merges metadata + compacts).
        // So an empty stream-end here would still leave the partial failed
        // text visible until a reload. A `delete` event keyed off the
        // placeholder's historySequence removes the row entirely, which is
        // what users actually want when the answer they were watching
        // collapsed mid-stream.
        //
        // History: the placeholder row is deleted to match; without this,
        // reloading would resurrect the partial text from chat.jsonl. The
        // empty stream-end is emitted before delete so WorkspaceStore can
        // identify the terminal side-answer event while the placeholder still
        // carries side-answer metadata.
        await deleteSideQuestionPlaceholder({
          workspaceId,
          assistantMessageId,
          assistantHistorySequence,
          modelString,
          historyService,
          emitChatEvent,
        });
        continue;
      }

      const trimmedAnswer = accumulatedText.trim();
      if (trimmedAnswer.length === 0) {
        lastError = { type: "unknown", raw: "Model produced an empty response" };
        log.warn("Side question: empty response", { modelString, workspaceId });
        // Same rationale as the catch above: an empty-response retry must
        // remove the placeholder so the next candidate's answer doesn't
        // render alongside a stale blank row.
        await deleteSideQuestionPlaceholder({
          workspaceId,
          assistantMessageId,
          assistantHistorySequence,
          modelString,
          historyService,
          emitChatEvent,
        });
        continue;
      }

      // -------------------------------------------------------------------
      // 3. Fill in the placeholder with the final answer and close the
      //    stream. updateHistory (not appendToHistory) because the row is
      //    already there from the placeholder step.
      // -------------------------------------------------------------------
      const duration = Date.now() - streamStartedAt;
      // Narrow to a single text part. The stream-end event schema only allows
      // reasoning/text/tool parts (no MuxFilePart) — using a concrete tuple
      // keeps both the history write and the chat-event emit type-checked
      // without needing a cast.
      const finalParts = [{ type: "text" as const, text: accumulatedText }];
      const assistantMessage: MuxMessage = {
        id: assistantMessageId,
        role: "assistant",
        metadata: {
          historySequence: assistantHistorySequence,
          timestamp: streamStartedAt,
          duration,
          model: modelString,
          // Resolved mappedToModel alias target (mirrors StreamManager rows):
          // without it the ETL prices custom provider models against the raw
          // custom ID (unknown → $0).
          metadataModel: aiService.resolveMetadataModel(modelString),
          // Persist usage on the answer row so analytics prices the /btw turn
          // (the ETL reads metadata.usage from chat.jsonl rows).
          ...(usage !== undefined ? { usage } : {}),
          ...(usageProviderMetadata !== undefined
            ? { providerMetadata: usageProviderMetadata }
            : {}),
          muxMetadata: {
            type: SIDE_QUESTION_ANSWER_METADATA_TYPE,
            questionMessageId: userMessage.id,
          },
        },
        parts: finalParts,
      };

      // Mirror the persisted usage into session-usage.json (live per-workspace
      // cost display). Best-effort: the recorder never throws.
      if (usage !== undefined && opts.recordUsage) {
        await opts.recordUsage(modelString, usage, usageProviderMetadata);
      }

      const updateResult = await historyService.updateHistory(workspaceId, assistantMessage);
      if (!updateResult.success) {
        // History write failed but the model produced an answer. Emit
        // stream-end first so the live UI still shows what the user saw, then
        // return Err so callers can toast that the durable /btw answer was not
        // persisted and would be lost on reload.
        log.warn("Side question: failed to update placeholder with final answer", {
          workspaceId,
          error: updateResult.error,
        });
      }

      // INVARIANT: this stream-end must NOT carry metadata.usage. The live
      // Costs cache already receives this turn's spend via the
      // session-usage-delta emitted by the recordUsage callback above;
      // WorkspaceStore also accumulates stream-end usage, so including it
      // here would double-count until a reload. Usage lives only on the
      // persisted answer row (for the analytics ETL).
      emitChatEvent(workspaceId, {
        type: "stream-end",
        workspaceId,
        messageId: assistantMessageId,
        metadata: {
          model: modelString,
          duration,
          timestamp: streamStartedAt,
          historySequence: assistantHistorySequence,
          muxMetadata: {
            type: SIDE_QUESTION_ANSWER_METADATA_TYPE,
            questionMessageId: userMessage.id,
          },
        },
        parts: finalParts,
      });

      if (!updateResult.success) {
        return Err({ type: "unknown", raw: updateResult.error });
      }

      return Ok({
        answer: trimmedAnswer,
        modelUsed: modelString,
        assistantMessageId,
      });
    } finally {
      runLanguageModelCleanup(modelResult.data);
    }
  }

  return Err(
    lastError ?? {
      type: "configuration",
      raw: "No working model candidates were available for side question.",
    }
  );
}

/**
 * Tear down a /btw placeholder whose stream failed or produced empty text
 * before the next candidate is tried.
 *
 * Closes the stream with an empty `stream-end` first so side-question
 * terminal-event bookkeeping (including the aggregator/store side-answer
 * terminal guards) unwinds while the placeholder still carries side-answer
 * metadata. Then removes the placeholder from chat.jsonl and emits a `delete`
 * chat event so the live aggregator drops any partial failed text.
 *
 * History deletion is best-effort: if the disk write fails we still emit
 * stream-end + delete so the live UI matches user expectations (the failed
 * text vanishes); next reload may then re-show the placeholder from
 * chat.jsonl, which is the same outcome we used to ship anyway.
 */
async function deleteSideQuestionPlaceholder(opts: {
  workspaceId: string;
  assistantMessageId: string;
  assistantHistorySequence: number;
  modelString: string;
  historyService: HistoryService;
  emitChatEvent: (workspaceId: string, message: WorkspaceChatMessage) => void;
}): Promise<void> {
  const {
    workspaceId,
    assistantMessageId,
    assistantHistorySequence,
    modelString,
    historyService,
    emitChatEvent,
  } = opts;

  // Close the stream slot while the side-answer placeholder still exists.
  // The aggregator and WorkspaceStore look up this message by id to check
  // its muxMetadata before dispatching their side-answer-aware branches
  // (e.g. WorkspaceStore.bufferedEventHandlers["stream-end"] skips
  // collapsePinnedTodoOnStreamStop iff the terminal stream belongs to a
  // side answer; the aggregator's handleStreamEnd skips main-agent
  // onResponseComplete / lastCompletedStreamStats updates). Deleting the
  // placeholder first would make those lookups fail, and the terminal
  // event would fall through to the main-agent code paths — clobbering
  // pinned-todo state and producing stale completion stats for a stream
  // that should be invisible to main-agent lifecycle.
  emitChatEvent(workspaceId, {
    type: "stream-end",
    workspaceId,
    messageId: assistantMessageId,
    metadata: { model: modelString, historySequence: assistantHistorySequence },
    parts: [],
  });

  const deleteResult = await historyService.deleteMessage(workspaceId, assistantMessageId);
  if (!deleteResult.success) {
    log.warn("Side question: failed to delete placeholder for retry", {
      workspaceId,
      assistantMessageId,
      error: deleteResult.error,
    });
  }

  emitChatEvent(workspaceId, {
    type: "delete",
    historySequences: [assistantHistorySequence],
  });
}

async function buildSideQuestionTranscript(
  workspaceId: string,
  historyService: HistoryService,
  liveStream: ReturnType<AIService["getStreamInfo"]>
): Promise<string> {
  // Read the active history window before applying the /btw cap. Prior side
  // questions are filtered below; capping the raw tail first would let many
  // side-question rows crowd out recent main-chat context.
  const result = await historyService.getHistoryFromLatestBoundary(workspaceId);
  if (!result.success) return "";

  const messages: MuxMessage[] = [...result.data];
  const partial = await historyService.readPartial(workspaceId);
  if (partial) messages.push(partial);

  // Partial files are throttled; merge the synchronous StreamManager snapshot
  // so /btw sees the main-agent text already visible in the UI.
  if (liveStream) {
    const liveMessage: MuxMessage = {
      id: liveStream.messageId,
      role: "assistant",
      metadata: {
        historySequence: liveStream.historySequence,
        model: liveStream.model,
      },
      parts: liveStream.parts,
    };
    const isLiveStreamMessage = (message: MuxMessage): boolean =>
      message.id === liveStream.messageId ||
      message.metadata?.historySequence === liveStream.historySequence;
    const existingIndex = messages.findIndex(isLiveStreamMessage);
    if (existingIndex === -1) {
      messages.push(liveMessage);
    } else {
      const existing = messages[existingIndex];
      messages[existingIndex] = {
        ...existing,
        metadata: {
          ...existing.metadata,
          historySequence: liveStream.historySequence,
          model: existing.metadata?.model ?? liveStream.model,
        },
        parts: liveStream.parts,
      };
      // Drop older partial.json copies for the same active stream; the live
      // snapshot above is the single source of truth for visible streamed text.
      for (let i = messages.length - 1; i >= 0; i--) {
        if (i !== existingIndex && isLiveStreamMessage(messages[i])) {
          messages.splice(i, 1);
        }
      }
    }
  }

  // Exclude PRIOR side-question exchanges from the transcript so /btw answers
  // don't pollute the context the model uses to answer the current side
  // question. Each /btw is independent — chained /btw turns would otherwise
  // amplify their own (potentially-wrong) prior answers. Then honor the same
  // durable context-boundary window as normal provider requests (e.g. soft
  // clears) so /btw does not resurrect content the user removed from context.
  const filtered = sliceMessagesForProviderFromLatestContextBoundary(
    filterSideQuestionMessages(messages)
  ).slice(-SIDE_QUESTION_MAX_TRAILING_MESSAGES);

  const formatted = filtered.map(formatMessageForSideQuestion).filter((s) => s.length > 0);
  if (formatted.length === 0) return "";

  // Trim from the front (oldest) until we fit the char budget.
  let drop = 0;
  let totalChars = formatted.reduce((sum, s) => sum + s.length, 0);
  while (totalChars > SIDE_QUESTION_MAX_TRANSCRIPT_CHARS && drop < formatted.length - 1) {
    totalChars -= formatted[drop].length;
    drop += 1;
  }
  return formatted.slice(drop).join("\n\n");
}

function extractMessageText(message: MuxMessage): string {
  return (message.parts ?? [])
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
    )
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Extract a short `[tool foo]` tag for inclusion in the /btw transcript.
 * Returns null for non-tool parts (text/reasoning/file are handled by
 * `extractMessageText`). This accepts `unknown` deliberately: history loading
 * JSON-parses persisted rows and casts them to `MuxMessage`, so older or
 * malformed chat.jsonl parts can still reach transcript construction. Skip
 * unrecognized shapes instead of letting one bad part break /btw.
 */
function summarizeToolPart(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  const record = part as { type?: unknown; toolName?: unknown };
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) return null;
  const toolName =
    typeof record.toolName === "string"
      ? record.toolName
      : type.startsWith("tool-")
        ? type.slice("tool-".length)
        : null;
  return toolName ? `[tool ${toolName}]` : null;
}

function formatMessageForSideQuestion(message: MuxMessage): string {
  const role = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : null;
  if (!role) return "";

  const segments: string[] = [];
  const text = extractMessageText(message).slice(0, SIDE_QUESTION_MAX_MESSAGE_CHARS);
  if (text) segments.push(text);

  const tools = (message.parts ?? []).map(summarizeToolPart).filter((s): s is string => s !== null);
  if (tools.length > 0) segments.push(tools.join(" "));

  return segments.length === 0 ? "" : `${role}: ${segments.join("\n")}`;
}
