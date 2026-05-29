import { describe, expect, test } from "bun:test";

import { computeTimingPercentages } from "./timingPercentages";

describe("computeTimingPercentages", () => {
  test("rounds and distributes so components sum to 100% when breakdown covers total", () => {
    const result = computeTimingPercentages({
      totalDurationMs: 151_300,
      ttftMs: 4_300,
      modelMs: 56_000,
      toolsMs: 91_000,
    });

    expect(result).toEqual({ ttft: 3, model: 37, tools: 60 });
    expect(result.ttft + result.model + result.tools).toBe(100);
  });

  test("handles equal thirds (stable tie-breaking)", () => {
    const result = computeTimingPercentages({
      totalDurationMs: 3,
      ttftMs: 1,
      modelMs: 1,
      toolsMs: 1,
    });

    expect(result).toEqual({ ttft: 34, model: 33, tools: 33 });
    expect(result.ttft + result.model + result.tools).toBe(100);
  });

  test("returns all zeros when totalDurationMs is 0", () => {
    expect(
      computeTimingPercentages({
        totalDurationMs: 0,
        ttftMs: 10,
        modelMs: 10,
        toolsMs: 10,
      })
    ).toEqual({ ttft: 0, model: 0, tools: 0 });
  });

  test("keeps totals aligned with the covered share when the breakdown is incomplete", () => {
    const result = computeTimingPercentages({
      totalDurationMs: 100,
      ttftMs: 10,
      modelMs: 10,
      toolsMs: 10,
    });

    expect(result).toEqual({ ttft: 10, model: 10, tools: 10 });
    expect(result.ttft + result.model + result.tools).toBe(30);
  });

  test("clamps negative and non-finite inputs", () => {
    const result = computeTimingPercentages({
      totalDurationMs: Number.POSITIVE_INFINITY,
      ttftMs: -10,
      modelMs: Number.NaN,
      toolsMs: 10,
    });

    expect(result).toEqual({ ttft: 0, model: 0, tools: 0 });
  });
});
