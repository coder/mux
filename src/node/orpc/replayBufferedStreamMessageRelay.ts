import type { WorkspaceChatMessage } from "@/common/orpc/types";

type ReplayBufferedStreamMessage = Extract<
  WorkspaceChatMessage,
  {
    type: "stream-delta" | "reasoning-delta" | "stream-end" | "stream-abort" | "stream-error";
  }
>;

type ReplayBufferedDeltaMessage = Extract<
  ReplayBufferedStreamMessage,
  { type: "stream-delta" | "reasoning-delta" }
>;

function isReplayBufferedStreamMessage(
  message: WorkspaceChatMessage
): message is ReplayBufferedStreamMessage {
  return (
    message.type === "stream-delta" ||
    message.type === "reasoning-delta" ||
    message.type === "stream-end" ||
    message.type === "stream-abort" ||
    message.type === "stream-error"
  );
}

function isReplayBufferedDeltaMessage(
  message: ReplayBufferedStreamMessage
): message is ReplayBufferedDeltaMessage {
  return message.type === "stream-delta" || message.type === "reasoning-delta";
}

function isReplayMessage(message: WorkspaceChatMessage): boolean {
  return (message as { replay?: unknown }).replay === true;
}

function replayBufferedDeltaKey(message: ReplayBufferedDeltaMessage): string {
  return JSON.stringify([message.type, message.messageId, message.timestamp, message.delta]);
}

export function createReplayBufferedStreamMessageRelay(
  push: (message: WorkspaceChatMessage) => void
): {
  handleSessionMessage: (message: WorkspaceChatMessage) => void;
  finishReplay: () => void;
} {
  let isReplaying = true;
  const bufferedLiveStreamMessages: ReplayBufferedStreamMessage[] = [];

  // Counter (not a Set) so we don't drop more buffered events than were replayed.
  const replayedDeltaKeyCounts = new Map<string, number>();

  const noteReplayedDelta = (message: ReplayBufferedDeltaMessage) => {
    const key = replayBufferedDeltaKey(message);
    replayedDeltaKeyCounts.set(key, (replayedDeltaKeyCounts.get(key) ?? 0) + 1);
  };

  const shouldDropBufferedDelta = (message: ReplayBufferedDeltaMessage): boolean => {
    const key = replayBufferedDeltaKey(message);
    const remaining = replayedDeltaKeyCounts.get(key) ?? 0;
    if (remaining <= 0) {
      return false;
    }
    if (remaining === 1) {
      replayedDeltaKeyCounts.delete(key);
    } else {
      replayedDeltaKeyCounts.set(key, remaining - 1);
    }
    return true;
  };

  const handleSessionMessage = (message: WorkspaceChatMessage) => {
    if (isReplaying && isReplayBufferedStreamMessage(message)) {
      if (!isReplayMessage(message)) {
        // Preserve stream event order during replay buffering (P1): if we buffer only deltas,
        // terminal events like stream-end can overtake them and flip the message back to partial
        // in the frontend event processor.
        bufferedLiveStreamMessages.push(message);
        return;
      }

      // Track replayed deltas so we can skip replay/live duplicates (P2).
      if (isReplayBufferedDeltaMessage(message)) {
        noteReplayedDelta(message);
      }
    }

    push(message);
  };

  const finishReplay = () => {
    // Flush buffered live stream messages after replay (`caught-up` already queued by replayHistory).
    for (const message of bufferedLiveStreamMessages) {
      if (isReplayBufferedDeltaMessage(message) && shouldDropBufferedDelta(message)) {
        continue;
      }
      push(message);
    }

    isReplaying = false;

    // Avoid retaining replay delta keys (including delta text) for the lifetime of the subscription.
    replayedDeltaKeyCounts.clear();
    bufferedLiveStreamMessages.length = 0;
  };

  return { handleSessionMessage, finishReplay };
}
