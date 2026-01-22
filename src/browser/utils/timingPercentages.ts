export interface TimingPercentages {
  ttft: number;
  model: number;
  tools: number;
}

function sanitizeMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

/**
 * Compute integer percentages for a TTFT/model/tools timing breakdown.
 *
 * - Uses `totalDurationMs` as the denominator (so missing/invalid timing data can still
 *   surface as a bar that doesn't fill to 100%).
 * - Distributes rounding so the displayed integers sum to the rounded total.
 */
export function computeTimingPercentages(params: {
  totalDurationMs: number;
  ttftMs: number;
  modelMs: number;
  toolsMs: number;
}): TimingPercentages {
  const totalDurationMs = sanitizeMs(params.totalDurationMs);
  const ttftMs = sanitizeMs(params.ttftMs);
  const modelMs = sanitizeMs(params.modelMs);
  const toolsMs = sanitizeMs(params.toolsMs);

  if (totalDurationMs <= 0) {
    return { ttft: 0, model: 0, tools: 0 };
  }

  const items = [
    { key: "ttft", raw: (ttftMs / totalDurationMs) * 100 },
    { key: "model", raw: (modelMs / totalDurationMs) * 100 },
    { key: "tools", raw: (toolsMs / totalDurationMs) * 100 },
  ] as const;

  const rawSum = items.reduce((acc, item) => acc + item.raw, 0);
  const targetTotal = Math.max(0, Math.min(100, Math.round(rawSum)));

  const computed = items.map((item, index) => {
    const floored = Math.floor(item.raw);
    return {
      key: item.key,
      index,
      remainder: item.raw - floored,
      value: floored,
    };
  });

  const remaining = targetTotal - computed.reduce((acc, item) => acc + item.value, 0);

  if (remaining > 0) {
    // Add percentage points to items with the largest remainders.
    const byRemainder = [...computed].sort((a, b) => {
      if (b.remainder !== a.remainder) return b.remainder - a.remainder;
      return a.index - b.index;
    });

    for (let i = 0; i < remaining; i++) {
      byRemainder[i % byRemainder.length].value += 1;
    }
  } else if (remaining < 0) {
    // Remove percentage points from items with the smallest remainders.
    const toRemove = -remaining;
    const byRemainder = [...computed].sort((a, b) => {
      if (a.remainder !== b.remainder) return a.remainder - b.remainder;
      return a.index - b.index;
    });

    let left = toRemove;
    for (const item of byRemainder) {
      if (left <= 0) break;
      if (item.value <= 0) continue;
      item.value -= 1;
      left -= 1;
    }

    // Extremely defensive: if timing data is severely invalid, clamp by removing any
    // remaining difference from the largest bucket.
    if (left > 0) {
      const largest = byRemainder[byRemainder.length - 1];
      if (largest) {
        largest.value = Math.max(0, largest.value - left);
      }
    }
  }

  const result: TimingPercentages = { ttft: 0, model: 0, tools: 0 };
  for (const item of computed) {
    const clamped = Math.max(0, Math.min(100, item.value));
    if (item.key === "ttft") result.ttft = clamped;
    else if (item.key === "model") result.model = clamped;
    else result.tools = clamped;
  }

  // Final defensive clamp: ensure we hit the target total, even if earlier logic was
  // perturbed by bad inputs (NaN/Inf/etc.).
  const sum = result.ttft + result.model + result.tools;
  if (sum !== targetTotal) {
    const delta = targetTotal - sum;
    result.tools = Math.max(0, Math.min(100, result.tools + delta));
  }

  return result;
}
