/**
 * Tests for provider options builder
 */

import { describe, test, expect, mock } from "bun:test";
import { buildProviderOptions } from "./providerOptions";
import type { ThinkingLevel } from "@/common/types/thinking";

// Mock the log module to avoid console noise
void mock.module("@/node/services/log", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  },
}));

// Mock enforceThinkingPolicy to pass through
void mock.module("@/browser/utils/thinking/policy", () => ({
  enforceThinkingPolicy: (_model: string, level: ThinkingLevel) => level,
}));

describe("buildProviderOptions - Anthropic", () => {
  describe("Opus 4.5 (effort parameter)", () => {
    test("should use effort parameter for claude-opus-4-5", () => {
      const result = buildProviderOptions("anthropic:claude-opus-4-5", "medium");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          effort: "medium",
        },
      });
    });

    test("should use effort parameter for claude-opus-4-5-20251101", () => {
      const result = buildProviderOptions("anthropic:claude-opus-4-5-20251101", "high");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          effort: "high",
        },
      });
    });

    test("should omit effort when thinking is off for Opus 4.5", () => {
      const result = buildProviderOptions("anthropic:claude-opus-4-5", "off");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
        },
      });
    });
  });

  describe("Other Anthropic models (thinking/budgetTokens)", () => {
    test("should use thinking.budgetTokens for claude-sonnet-4-5", () => {
      const result = buildProviderOptions("anthropic:claude-sonnet-4-5", "medium");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          thinking: {
            type: "enabled",
            budgetTokens: 10000,
          },
        },
      });
    });

    test("should use thinking.budgetTokens for claude-opus-4-1", () => {
      const result = buildProviderOptions("anthropic:claude-opus-4-1", "high");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          thinking: {
            type: "enabled",
            budgetTokens: 20000,
          },
        },
      });
    });

    test("should use thinking.budgetTokens for claude-haiku-4-5", () => {
      const result = buildProviderOptions("anthropic:claude-haiku-4-5", "low");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
          thinking: {
            type: "enabled",
            budgetTokens: 4000,
          },
        },
      });
    });

    test("should omit thinking when thinking is off for non-Opus 4.5", () => {
      const result = buildProviderOptions("anthropic:claude-sonnet-4-5", "off");

      expect(result).toEqual({
        anthropic: {
          disableParallelToolUse: false,
          sendReasoning: true,
        },
      });
    });
  });
});
