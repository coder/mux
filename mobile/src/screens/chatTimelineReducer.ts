import type { WorkspaceChatEvent } from "../types";
import type { DisplayedMessage } from "../types";

export type TimelineEntry =
  | { kind: "displayed"; key: string; message: DisplayedMessage }
  | { kind: "raw"; key: string; payload: WorkspaceChatEvent };

const DISPLAYABLE_MESSAGE_TYPES: ReadonlySet<DisplayedMessage["type"]> = new Set([
  "user",
  "assistant",
  "tool",
  "reasoning",
  "stream-error",
  "history-hidden",
  "workspace-init",
]);

function isDisplayedMessageEvent(event: WorkspaceChatEvent): event is DisplayedMessage {
  if (!event || typeof event !== "object") {
    return false;
  }
  const maybeType = (event as { type?: unknown }).type;
  if (typeof maybeType !== "string") {
    return false;
  }
  if (!DISPLAYABLE_MESSAGE_TYPES.has(maybeType as DisplayedMessage["type"])) {
    return false;
  }
  if (!("historySequence" in event)) {
    return false;
  }
  const sequence = (event as { historySequence?: unknown }).historySequence;
  return typeof sequence === "number" && Number.isFinite(sequence);
}

function isDeleteEvent(
  event: WorkspaceChatEvent
): event is { type: "delete"; historySequences: number[] } {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    (event as { type: unknown }).type === "delete" &&
    Array.isArray((event as { historySequences?: unknown }).historySequences)
  );
}

function hasHistoryIdentifier(
  message: DisplayedMessage
): message is DisplayedMessage & { historyId: string } {
  return typeof (message as { historyId?: unknown }).historyId === "string";
}
function compareDisplayedMessages(a: DisplayedMessage, b: DisplayedMessage): number {
  if (a.historySequence !== b.historySequence) {
    return a.historySequence - b.historySequence;
  }
  const seqA = "streamSequence" in a && typeof a.streamSequence === "number" ? a.streamSequence : 0;
  const seqB = "streamSequence" in b && typeof b.streamSequence === "number" ? b.streamSequence : 0;
  return seqA - seqB;
}

export function applyChatEvent(
  current: TimelineEntry[],
  event: WorkspaceChatEvent
): TimelineEntry[] {
  if (isDeleteEvent(event)) {
    const sequences = new Set(event.historySequences);
    return current.filter((entry) => {
      if (entry.kind !== "displayed") {
        return true;
      }
      return !sequences.has(entry.message.historySequence);
    });
  }

  if (isDisplayedMessageEvent(event)) {
    let timeline = current;
    const incomingSequence = event.historySequence;
    const eventHasHistoryId = hasHistoryIdentifier(event);
    const incomingHistoryId = eventHasHistoryId ? event.historyId : undefined;

    if (Number.isFinite(incomingSequence) && eventHasHistoryId && incomingSequence >= 0) {
      const hasConflictingFuture = timeline.some(
        (entry) =>
          entry.kind === "displayed" &&
          entry.message.historySequence >= incomingSequence &&
          hasHistoryIdentifier(entry.message) &&
          entry.message.historyId !== incomingHistoryId
      );

      if (hasConflictingFuture) {
        timeline = timeline.filter(
          (entry) =>
            entry.kind !== "displayed" ||
            entry.message.historySequence < incomingSequence ||
            (hasHistoryIdentifier(entry.message) && entry.message.historyId === incomingHistoryId)
        );
      }
    }

    // Check if message already exists (deduplicate)
    const existingIndex = timeline.findIndex(
      (item) => item.kind === "displayed" && item.message.id === event.id
    );

    if (existingIndex >= 0) {
      // Message already exists - check if it's an update
      const existingMessage = (
        timeline[existingIndex] as Extract<TimelineEntry, { kind: "displayed" }>
      ).message;

      // Check if it's a streaming update (either still streaming or finishing a stream)
      const wasStreaming =
        "isStreaming" in existingMessage && (existingMessage as any).isStreaming === true;
      const isStreamingUpdate =
        existingMessage.historySequence === event.historySequence &&
        "isStreaming" in event &&
        ((event as any).isStreaming === true ||
          (wasStreaming && (event as any).isStreaming === false));

      // Check if it's a tool status change (executing → completed/failed)
      const isToolStatusChange =
        existingMessage.type === "tool" &&
        event.type === "tool" &&
        existingMessage.historySequence === event.historySequence &&
        (existingMessage as any).status !== (event as any).status;

      const isWorkspaceInitUpdate =
        existingMessage.type === "workspace-init" && event.type === "workspace-init";

      if (isStreamingUpdate || isToolStatusChange || isWorkspaceInitUpdate) {
        // Update in place
        const updated = [...timeline];
        updated[existingIndex] = {
          kind: "displayed",
          key: `displayed-${event.id}`,
          message: event,
        };
        return updated;
      }

      // Same message, skip (already processed)
      return timeline;
    }

    // New message - add and sort only if needed
    const entry: TimelineEntry = {
      kind: "displayed",
      key: `displayed-${event.id}`,
      message: event,
    };

    // Check if we need to sort (is new message out of order?)
    const lastDisplayed = [...timeline]
      .reverse()
      .find(
        (item): item is Extract<TimelineEntry, { kind: "displayed" }> => item.kind === "displayed"
      );

    if (!lastDisplayed || compareDisplayedMessages(lastDisplayed.message, event) <= 0) {
      // New message is in order - just append (no sort needed)
      return [...timeline, entry];
    }

    // Out of order - need to sort
    const withoutExisting = timeline.filter(
      (item) => item.kind !== "displayed" || item.message.id !== event.id
    );
    const displayed = withoutExisting
      .filter(
        (item): item is Extract<TimelineEntry, { kind: "displayed" }> => item.kind === "displayed"
      )
      .concat(entry)
      .sort((left, right) => compareDisplayedMessages(left.message, right.message));
    const raw = withoutExisting.filter(
      (item): item is Extract<TimelineEntry, { kind: "raw" }> => item.kind === "raw"
    );
    return [...displayed, ...raw];
  }

  if (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    ((event as { type: unknown }).type === "caught-up" ||
      (event as { type: unknown }).type === "stream-start")
  ) {
    return current;
  }

  const rawEntry: TimelineEntry = {
    kind: "raw",
    key: `raw-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    payload: event,
  };
  return [...current, rawEntry];
}
