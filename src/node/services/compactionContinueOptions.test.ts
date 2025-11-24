import { describe, expect, it } from "bun:test";
import type { SendMessageOptions } from "@/common/types/ipc";
import { buildContinueMessageOptions } from "./compactionContinueOptions";

const baseOptions = (): SendMessageOptions => ({
  model: "anthropic:claude-3-5-sonnet",
  thinkingLevel: "medium",
  toolPolicy: [],
  additionalSystemInstructions: "be helpful",
  mode: "compact",
  maxOutputTokens: 2048,
});

describe("buildContinueMessageOptions", () => {
  it("uses resumeModel when provided and drops compact overrides", () => {
    const options = baseOptions();
    const result = buildContinueMessageOptions(options, "anthropic:claude-3-5-haiku");

    expect(result).not.toBe(options);
    expect(result.model).toBe("anthropic:claude-3-5-haiku");
    expect(result.mode).toBeUndefined();
    expect(result.maxOutputTokens).toBeUndefined();
    expect(result.thinkingLevel).toBe("medium");
    expect(result.toolPolicy).toEqual([]);
    // Ensure original options untouched
    expect(options.model).toBe("anthropic:claude-3-5-sonnet");
    expect(options.mode).toBe("compact");
    expect(options.maxOutputTokens).toBe(2048);
  });

  it("falls back to compaction model when resumeModel is missing", () => {
    const options = baseOptions();
    const result = buildContinueMessageOptions(options);

    expect(result.model).toBe(options.model);
  });
});
