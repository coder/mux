/**
 * Shared TPS + token counting utilities.
 *
 * Used by both backend (stats subscription) and frontend (streaming UI).
 */

export interface DeltaRecord {
  tokens: number;
  timestamp: number;
  type: "text" | "reasoning" | "tool-args";
}

const DEFAULT_TPS_WINDOW_MS = 60000; // 60 second trailing window

/**
 * Calculate tokens-per-second from a history of delta records.
 */
export function calculateTPS(deltas: DeltaRecord[], now: number = Date.now()): number {
  if (deltas.length === 0) return 0;

  const windowStart = now - DEFAULT_TPS_WINDOW_MS;
  const recentDeltas = deltas.filter((d) => d.timestamp >= windowStart);
  if (recentDeltas.length === 0) return 0;

  const totalTokens = recentDeltas.reduce((sum, d) => sum + (d.tokens || 0), 0);
  const timeSpanMs = now - recentDeltas[0].timestamp;
  const timeSpanSec = timeSpanMs / 1000;
  if (timeSpanSec <= 0) return 0;

  return Math.round(totalTokens / timeSpanSec);
}

export function calculateTokenCount(deltas: DeltaRecord[]): number {
  if ((deltas?.length ?? 0) === 0) return 0;
  return deltas.reduce((sum, d) => sum + (d.tokens || 0), 0);
}

export interface DeltaRecordStorage {
  addDelta(record: DeltaRecord): void;
  getTokenCount(): number;
  calculateTPS(now?: number): number;
  getRecentDeltas(): DeltaRecord[];
}

export function createDeltaStorage(windowMs: number = DEFAULT_TPS_WINDOW_MS): DeltaRecordStorage {
  let recentDeltas: DeltaRecord[] = [];
  let olderTokenCount = 0;

  const prune = (now: number): void => {
    if (recentDeltas.length === 0) return;
    const threshold = now - windowMs;

    let pruneCount = 0;
    for (const delta of recentDeltas) {
      if (delta.timestamp < threshold) {
        olderTokenCount += delta.tokens || 0;
        pruneCount += 1;
      } else {
        break;
      }
    }

    if (pruneCount > 0) {
      recentDeltas = recentDeltas.slice(pruneCount);
    }
  };

  return {
    addDelta(record: DeltaRecord) {
      recentDeltas.push(record);
      prune(record.timestamp);
    },
    getTokenCount() {
      return olderTokenCount + calculateTokenCount(recentDeltas);
    },
    calculateTPS(now: number = Date.now()) {
      prune(now);
      return calculateTPS(recentDeltas, now);
    },
    getRecentDeltas() {
      return recentDeltas;
    },
  };
}
