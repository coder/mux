import type {
  CompactionRequestData,
  DisplayedMessage,
  InlineSkillSnapshotMap,
  MuxFilePart,
  MuxMessage,
  SideQuestionDisplayBranch,
} from "@/common/types/message";
import { getCompactionFollowUpContent } from "@/common/types/message";
import type { StreamErrorType } from "@/common/types/errors";
import { GOAL_BUDGET_LIMIT_KIND, GOAL_CONTINUATION_KIND } from "@/constants/goals";
import { getFollowUpContentText } from "@/browser/utils/compaction/format";
import { getGoalClearedSummaryDisplayText } from "@/common/utils/goalClearedSummaryDisplay";
import { assert } from "@/common/utils/assert";
import {
  CONTEXT_BOUNDARY_KINDS,
  getContextBoundaryKind,
} from "@/common/utils/messages/compactionBoundary";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";
import {
  isSideQuestionAnswerMessage,
  isSideQuestionUserMessage,
} from "@/common/utils/messages/sideQuestion";

/**
 * Check if a tool result indicates success (for tools that return { success: boolean })
 */
export function hasSuccessResult(result: unknown): boolean {
  return (
    typeof result === "object" && result !== null && "success" in result && result.success === true
  );
}

/**
 * Check if a tool result indicates failure.
 * Handles both explicit failure ({ success: false }) and implicit failure ({ error: "..." })
 */
export function hasFailureResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  // Explicit failure
  if ("success" in result && result.success === false) return true;
  // Implicit failure - error field present
  if ("error" in result && result.error) return true;
  return false;
}

export function resolveRouteProvider(
  routeProvider: string | undefined,
  routedThroughGateway: boolean | undefined
): string | undefined {
  return routeProvider ?? (routedThroughGateway === true ? "mux-gateway" : undefined);
}

function getStandaloneSideQuestionBranch(
  message: MuxMessage
): SideQuestionDisplayBranch | undefined {
  const muxMeta = message.metadata?.muxMetadata;
  if (muxMeta?.type === "side-question") {
    return {
      branchId: message.id,
      placement: "standalone",
    };
  }

  if (muxMeta?.type === "side-question-answer") {
    return {
      branchId: muxMeta.questionMessageId ?? message.id,
      placement: "standalone",
    };
  }

  return undefined;
}

export function normalizeMessageRouteProvider(message: MuxMessage): MuxMessage {
  const routeProvider = resolveRouteProvider(
    message.metadata?.routeProvider,
    message.metadata?.routedThroughGateway
  );

  if (!message.metadata || routeProvider === message.metadata.routeProvider) {
    return message;
  }

  return {
    ...message,
    metadata: {
      ...message.metadata,
      routeProvider,
    },
  };
}

/**
 * Merge adjacent text/reasoning parts using array accumulation + join().
 * Avoids O(n²) string allocations from repeated concatenation.
 * Tool parts are preserved as-is between merged text/reasoning runs.
 */
export function mergeAdjacentParts(parts: MuxMessage["parts"]): MuxMessage["parts"] {
  if (parts.length <= 1) return parts;

  const merged: MuxMessage["parts"] = [];
  let pendingTexts: string[] = [];
  let pendingTextTimestamp: number | undefined;
  let pendingReasonings: string[] = [];
  let pendingReasoningTimestamp: number | undefined;

  const flushText = () => {
    if (pendingTexts.length > 0) {
      merged.push({
        type: "text",
        text: pendingTexts.join(""),
        timestamp: pendingTextTimestamp,
      });
      pendingTexts = [];
      pendingTextTimestamp = undefined;
    }
  };

  const flushReasoning = () => {
    if (pendingReasonings.length > 0) {
      merged.push({
        type: "reasoning",
        text: pendingReasonings.join(""),
        timestamp: pendingReasoningTimestamp,
      });
      pendingReasonings = [];
      pendingReasoningTimestamp = undefined;
    }
  };

  for (const part of parts) {
    if (part.type === "text") {
      flushReasoning();
      pendingTexts.push(part.text);
      pendingTextTimestamp ??= part.timestamp;
    } else if (part.type === "reasoning") {
      flushText();
      pendingReasonings.push(part.text);
      pendingReasoningTimestamp ??= part.timestamp;
    } else {
      // Tool part - flush and keep as-is
      flushText();
      flushReasoning();
      merged.push(part);
    }
  }
  flushText();
  flushReasoning();

  return merged;
}

export function getTextPartContent(parts: ReadonlyArray<MuxMessage["parts"][number]>): string {
  const content: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      content.push(part.text);
    }
  }
  return content.join("");
}

function createCompactionBoundaryRow(
  message: MuxMessage,
  historySequence: number
): Extract<DisplayedMessage, { type: "compaction-boundary" }> {
  assert(message.role === "assistant", "compaction boundaries must belong to assistant summaries");

  const rawCompactionEpoch = message.metadata?.compactionEpoch;
  const compactionEpoch =
    typeof rawCompactionEpoch === "number" &&
    Number.isInteger(rawCompactionEpoch) &&
    rawCompactionEpoch > 0
      ? rawCompactionEpoch
      : undefined;

  // Self-healing read path: malformed persisted compactionEpoch should not crash transcript rendering.
  return {
    type: "compaction-boundary",
    id: `${message.id}-compaction-boundary`,
    historySequence,
    boundaryKind: getContextBoundaryKind(message) ?? CONTEXT_BOUNDARY_KINDS.COMPACTION,
    position: "start",
    compactionEpoch,
  };
}

export interface BuildDisplayedMessagesForMessageOptions {
  message: MuxMessage;
  agentSkillSnapshot?: { frontmatterYaml?: string; body?: string };
  inlineSkillSnapshots?: InlineSkillSnapshotMap;
  hasActiveStream: boolean;
  streamIsReplay?: boolean;
  isContextBoundaryMessage: (message: MuxMessage) => boolean;
}

type ToolDisplayStatus = Extract<DisplayedMessage, { type: "tool" }>["status"];
type NestedToolCalls = NonNullable<DynamicToolPart["nestedCalls"]>;

function buildPlanDisplayMessages(
  message: MuxMessage,
  historySequence: number
): DisplayedMessage[] | undefined {
  const muxMeta = message.metadata?.muxMetadata;
  if (muxMeta?.type !== "plan-display") {
    return undefined;
  }

  return [
    {
      type: "plan-display",
      id: message.id,
      historyId: message.id,
      content: getTextPartContent(message.parts),
      path: muxMeta.path,
      historySequence,
    },
  ];
}

function buildUserDisplayedMessages(options: {
  message: MuxMessage;
  agentSkillSnapshot?: { frontmatterYaml?: string; body?: string };
  inlineSkillSnapshots?: InlineSkillSnapshotMap;
  baseTimestamp?: number;
  historySequence: number;
}): DisplayedMessage[] {
  const { message, agentSkillSnapshot, inlineSkillSnapshots, baseTimestamp, historySequence } =
    options;
  const muxMeta = message.metadata?.muxMetadata;
  const partsContent = getTextPartContent(message.parts);

  const fileParts = message.parts
    .filter((p): p is MuxFilePart => p.type === "file")
    .map((p) => ({
      url: typeof p.url === "string" ? p.url : "",
      mediaType: p.mediaType,
      filename: p.filename,
    }));

  let rawCommand = muxMeta && "rawCommand" in muxMeta ? muxMeta.rawCommand : undefined;
  const agentSkill =
    muxMeta?.type === "agent-skill"
      ? {
          skillName: muxMeta.skillName,
          scope: muxMeta.scope,
          snapshot: agentSkillSnapshot,
        }
      : undefined;

  const compactionFollowUp = getCompactionFollowUpContent(muxMeta);
  const compactionRequest =
    muxMeta?.type === "compaction-request"
      ? {
          parsed: {
            model: muxMeta.parsed.model,
            maxOutputTokens: muxMeta.parsed.maxOutputTokens,
            followUpContent: compactionFollowUp,
          } satisfies CompactionRequestData,
        }
      : undefined;

  // Reconstruct full rawCommand if follow-up text isn't already included.
  if (rawCommand && compactionRequest?.parsed.followUpContent && !rawCommand.includes("\n")) {
    const followUpText = getFollowUpContentText(compactionRequest.parsed.followUpContent);
    if (followUpText) {
      rawCommand = `${rawCommand}\n${followUpText}`;
    }
  }

  return [
    {
      type: "user",
      id: message.id,
      historyId: message.id,
      content: rawCommand ?? partsContent,
      commandPrefix: muxMeta?.commandPrefix,
      fileParts: fileParts.length > 0 ? fileParts : undefined,
      historySequence,
      isSynthetic: message.metadata?.synthetic === true ? true : undefined,
      isGoalContinuation: message.metadata?.kind === GOAL_CONTINUATION_KIND ? true : undefined,
      isBudgetLimitWrapup: message.metadata?.kind === GOAL_BUDGET_LIMIT_KIND ? true : undefined,
      timestamp: baseTimestamp,
      agentSkill,
      inlineSkillSnapshots,
      compactionRequest,
      reviews: muxMeta?.reviews,
      sideQuestionBranch: getStandaloneSideQuestionBranch(message),
      isSideQuestion: isSideQuestionUserMessage(message) ? true : undefined,
    },
  ];
}

function isRenderableDisplayPart(part: MuxMessage["parts"][number]): boolean {
  return (
    part.type === "reasoning" ||
    (part.type === "text" && Boolean(part.text)) ||
    isDynamicToolPart(part)
  );
}

function getRenderablePartStats(parts: MuxMessage["parts"]): {
  lastPartIndex: number;
  isReasoningOnlyMessage: boolean;
} {
  let lastPartIndex = -1;
  let renderableCount = 0;
  let renderableReasoningCount = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!isRenderableDisplayPart(part)) continue;
    lastPartIndex = i;
    renderableCount++;
    if (part.type === "reasoning") renderableReasoningCount++;
  }

  return {
    lastPartIndex,
    isReasoningOnlyMessage: renderableCount > 0 && renderableCount === renderableReasoningCount,
  };
}

function appendReasoningRow(
  displayedMessages: DisplayedMessage[],
  options: {
    message: MuxMessage;
    part: Extract<MuxMessage["parts"][number], { type: "reasoning" }>;
    partIndex: number;
    historySequence: number;
    streamSequence: number;
    isStreaming: boolean;
    isPartial: boolean;
    isLastPartOfMessage: boolean;
    isReasoningOnlyMessage: boolean;
    baseTimestamp?: number;
    streamIsReplay?: boolean;
  }
): void {
  displayedMessages.push({
    type: "reasoning",
    id: `${options.message.id}-${options.partIndex}`,
    historyId: options.message.id,
    content: options.part.text,
    historySequence: options.historySequence,
    streamSequence: options.streamSequence,
    isStreaming: options.isStreaming,
    isPartial: options.isPartial,
    isLastPartOfMessage: options.isLastPartOfMessage,
    isOnlyMessageContent: options.isReasoningOnlyMessage,
    timestamp: options.part.timestamp ?? options.baseTimestamp,
    streamPresentation: options.isStreaming
      ? { source: options.streamIsReplay ? "replay" : "live" }
      : undefined,
  });
}

function appendAssistantTextRow(
  displayedMessages: DisplayedMessage[],
  options: {
    message: MuxMessage;
    part: Extract<MuxMessage["parts"][number], { type: "text" }>;
    partIndex: number;
    historySequence: number;
    streamSequence: number;
    isStreaming: boolean;
    isPartial: boolean;
    isLastPartOfMessage: boolean;
    baseTimestamp?: number;
    streamIsReplay?: boolean;
  }
): void {
  const { message, part } = options;
  displayedMessages.push({
    type: "assistant",
    id: `${message.id}-${options.partIndex}`,
    historyId: message.id,
    content: getGoalClearedSummaryDisplayText(part.text, message.metadata?.muxMetadata),
    historySequence: options.historySequence,
    streamSequence: options.streamSequence,
    isStreaming: options.isStreaming,
    isPartial: options.isPartial,
    isLastPartOfMessage: options.isLastPartOfMessage,
    // Support both new enum ("user"|"idle") and legacy boolean (true).
    isCompacted: !!message.metadata?.compacted,
    isIdleCompacted: message.metadata?.compacted === "idle",
    sideQuestionBranch: getStandaloneSideQuestionBranch(message),
    isSideAnswer: isSideQuestionAnswerMessage(message) ? true : undefined,
    model: message.metadata?.model,
    routedThroughGateway: message.metadata?.routedThroughGateway,
    routeProvider: resolveRouteProvider(
      message.metadata?.routeProvider,
      message.metadata?.routedThroughGateway
    ),
    mode: message.metadata?.mode,
    agentId: message.metadata?.agentId ?? message.metadata?.mode,
    timestamp: part.timestamp ?? options.baseTimestamp,
    streamPresentation: options.isStreaming
      ? { source: options.streamIsReplay ? "replay" : "live" }
      : undefined,
  });
}

function getToolDisplayStatus(part: DynamicToolPart, isPartial: boolean): ToolDisplayStatus {
  if (part.state === "output-available") {
    return hasFailureResult(part.output) ? "failed" : "completed";
  }
  if (part.state === "output-redacted") {
    return part.failed ? "failed" : "redacted";
  }
  if (part.state === "input-available") {
    return part.toolName === "ask_user_question"
      ? "executing"
      : isPartial
        ? "interrupted"
        : "executing";
  }
  return "pending";
}

function getObjectField(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

function reconstructCodeExecutionNestedCalls(part: DynamicToolPart): NestedToolCalls | undefined {
  if (part.toolName !== "code_execution" || part.state !== "output-available") {
    return undefined;
  }

  const toolCalls = getObjectField(part.output, "toolCalls");
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  const nestedCalls: NestedToolCalls = [];
  for (const [idx, toolCall] of toolCalls.entries()) {
    if (typeof toolCall !== "object" || toolCall === null) {
      continue;
    }
    const record = toolCall as Record<string, unknown>;
    if (typeof record.toolName !== "string" || typeof record.duration_ms !== "number") {
      continue;
    }

    nestedCalls.push({
      toolCallId: `${part.toolCallId}-nested-${idx}`,
      toolName: record.toolName,
      input: record.args,
      output:
        record.result ?? (typeof record.error === "string" ? { error: record.error } : undefined),
      state: "output-available",
      timestamp: part.timestamp,
    });
  }

  return nestedCalls.length > 0 ? nestedCalls : undefined;
}

function getNestedCallsForDisplay(part: DynamicToolPart): NestedToolCalls | undefined {
  return part.nestedCalls ?? reconstructCodeExecutionNestedCalls(part);
}

function appendToolRows(
  displayedMessages: DisplayedMessage[],
  options: {
    message: MuxMessage;
    part: DynamicToolPart;
    partIndex: number;
    historySequence: number;
    isPartial: boolean;
    isLastPartOfMessage: boolean;
    baseTimestamp?: number;
    nextStreamSequence: () => number;
  }
): void {
  const { message, part } = options;
  const status = getToolDisplayStatus(part, options.isPartial);
  const nestedCalls = getNestedCallsForDisplay(part);
  displayedMessages.push({
    type: "tool",
    id: `${message.id}-${options.partIndex}`,
    historyId: message.id,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    args: part.input,
    result: part.state === "output-available" ? part.output : undefined,
    status,
    isPartial: options.isPartial,
    historySequence: options.historySequence,
    streamSequence: options.nextStreamSequence(),
    isLastPartOfMessage: options.isLastPartOfMessage,
    timestamp: part.timestamp ?? options.baseTimestamp,
    nestedCalls,
  });
}

function appendStreamErrorRows(
  displayedMessages: DisplayedMessage[],
  options: {
    message: MuxMessage;
    historySequence: number;
    hasActiveStream: boolean;
    baseTimestamp?: number;
  }
): void {
  const pushStreamErrorRow = (
    idSuffix: string,
    error: string,
    errorType: StreamErrorType
  ): void => {
    displayedMessages.push({
      type: "stream-error",
      id: `${options.message.id}-${idSuffix}`,
      historyId: options.message.id,
      error,
      errorType,
      historySequence: options.historySequence,
      model: options.message.metadata?.model,
      routedThroughGateway: options.message.metadata?.routedThroughGateway,
      timestamp: options.baseTimestamp,
    });
  };

  if (options.message.metadata?.error) {
    pushStreamErrorRow(
      "error",
      options.message.metadata.error,
      options.message.metadata.errorType ?? "unknown"
    );
    return;
  }

  // Stream ended cleanly *but* the provider truncated us at max_tokens. The
  // backend treats that as a successful completion, so synthesize a visible row
  // after the stream settles instead of silently ending the chat.
  if (!options.hasActiveStream && options.message.metadata?.finishReason === "length") {
    pushStreamErrorRow(
      "length",
      "The model hit its max output token limit before finishing this response. " +
        "Lower the thinking level (or split the turn into smaller steps) to give it more headroom.",
      "max_output_tokens"
    );
  }
}

function buildAssistantDisplayedMessages(options: {
  message: MuxMessage;
  baseTimestamp?: number;
  historySequence: number;
  hasActiveStream: boolean;
  streamIsReplay?: boolean;
  isContextBoundaryMessage: (message: MuxMessage) => boolean;
}): DisplayedMessage[] {
  const {
    message,
    baseTimestamp,
    historySequence,
    hasActiveStream,
    streamIsReplay,
    isContextBoundaryMessage,
  } = options;
  const displayedMessages: DisplayedMessage[] = [];
  const isPartial = message.metadata?.partial === true;
  const mergedParts = mergeAdjacentParts(message.parts);
  const { lastPartIndex, isReasoningOnlyMessage } = getRenderablePartStats(mergedParts);
  let streamSeq = 0;
  const nextStreamSequence = (): number => streamSeq++;

  if (isContextBoundaryMessage(message)) {
    displayedMessages.push(createCompactionBoundaryRow(message, historySequence));
  }

  mergedParts.forEach((part, partIndex) => {
    const isLastPart = partIndex === lastPartIndex;
    const isStreaming = hasActiveStream && isLastPart;

    if (part.type === "reasoning") {
      appendReasoningRow(displayedMessages, {
        message,
        part,
        partIndex,
        historySequence,
        streamSequence: nextStreamSequence(),
        isStreaming,
        isPartial,
        isLastPartOfMessage: isLastPart,
        isReasoningOnlyMessage,
        baseTimestamp,
        streamIsReplay,
      });
      return;
    }

    if (part.type === "text" && part.text) {
      appendAssistantTextRow(displayedMessages, {
        message,
        part,
        partIndex,
        historySequence,
        streamSequence: nextStreamSequence(),
        isStreaming,
        isPartial,
        isLastPartOfMessage: isLastPart,
        baseTimestamp,
        streamIsReplay,
      });
      return;
    }

    if (isDynamicToolPart(part)) {
      appendToolRows(displayedMessages, {
        message,
        part,
        partIndex,
        historySequence,
        isPartial,
        isLastPartOfMessage: isLastPart,
        baseTimestamp,
        nextStreamSequence,
      });
    }
  });

  appendStreamErrorRows(displayedMessages, {
    message,
    historySequence,
    hasActiveStream,
    baseTimestamp,
  });

  return displayedMessages;
}

export function buildDisplayedMessagesForMessage(
  options: BuildDisplayedMessagesForMessageOptions
): DisplayedMessage[] {
  const { message, agentSkillSnapshot, inlineSkillSnapshots, hasActiveStream } = options;
  const baseTimestamp = message.metadata?.timestamp;
  const historySequence = message.metadata?.historySequence ?? 0;
  const planRows = buildPlanDisplayMessages(message, historySequence);
  if (planRows) {
    return planRows;
  }

  if (message.role === "user") {
    return buildUserDisplayedMessages({
      message,
      agentSkillSnapshot,
      inlineSkillSnapshots,
      baseTimestamp,
      historySequence,
    });
  }

  if (message.role === "assistant") {
    return buildAssistantDisplayedMessages({
      message,
      baseTimestamp,
      historySequence,
      hasActiveStream,
      streamIsReplay: options.streamIsReplay,
      isContextBoundaryMessage: options.isContextBoundaryMessage,
    });
  }

  return [];
}
