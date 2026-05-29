import type { MuxMessage } from "@/common/types/message";

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MISSING_TIMESTAMP = -1;

function updateFnv1a(hash: number, value: string): number {
  let next = hash >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    next ^= value.charCodeAt(index);
    next = Math.imul(next, FNV_PRIME) >>> 0;
  }
  return next >>> 0;
}

/**
 * Build a deterministic fingerprint for persisted history rows strictly older than
 * the provided cursor sequence. Reconnect since-mode uses this to detect deletes/
 * rewrites below the cursor and safely fall back to full replay.
 */
export function computePriorHistoryFingerprint(
  messages: readonly MuxMessage[],
  anchorHistorySequence: number
): string | undefined {
  const priorEntries: Array<{
    id: string;
    historySequence: number;
    timestamp: number;
    role: MuxMessage["role"];
    partsFingerprint: string;
  }> = [];

  for (const message of messages) {
    const historySequence = message.metadata?.historySequence;
    if (historySequence === undefined || historySequence >= anchorHistorySequence) {
      continue;
    }

    priorEntries.push({
      id: message.id,
      historySequence,
      timestamp: message.metadata?.timestamp ?? MISSING_TIMESTAMP,
      role: message.role,
      // Include serialized part content so in-place rewrites that keep id/seq/timestamp
      // still invalidate the fingerprint and force a safe full replay fallback.
      partsFingerprint: JSON.stringify(message.parts),
    });
  }

  if (priorEntries.length === 0) {
    return undefined;
  }

  priorEntries.sort(
    (left, right) => left.historySequence - right.historySequence || left.id.localeCompare(right.id)
  );

  let hash = FNV_OFFSET_BASIS;
  for (const entry of priorEntries) {
    hash = updateFnv1a(
      hash,
      `${entry.historySequence}|${entry.id}|${entry.timestamp}|${entry.role}|${entry.partsFingerprint};`
    );
  }

  return hash.toString(16).padStart(8, "0");
}
