import { describe, expect, test } from "bun:test";
import type { ProviderCacheHitModelRow } from "@/common/orpc/schemas/analytics";
import { aggregateProviderCacheHitRows } from "./analyticsService";

describe("aggregateProviderCacheHitRows", () => {
  test("rolls model rows up to providers using weighted token ratios", () => {
    const rows: ProviderCacheHitModelRow[] = [
      {
        model: "openai:gpt-4o",
        cached_tokens: 20,
        total_prompt_tokens: 100,
        response_count: 4,
      },
      {
        model: "openai:gpt-4.1",
        cached_tokens: 30,
        total_prompt_tokens: 60,
        response_count: 3,
      },
      {
        model: "anthropic:claude-sonnet-4-5",
        cached_tokens: 24,
        total_prompt_tokens: 40,
        response_count: 2,
      },
    ];

    expect(aggregateProviderCacheHitRows(rows)).toEqual([
      {
        provider: "anthropic",
        cacheHitRatio: 0.6,
        responseCount: 2,
      },
      {
        provider: "openai",
        cacheHitRatio: 0.3125,
        responseCount: 7,
      },
    ]);
  });

  test("buckets missing or malformed model providers under unknown", () => {
    const rows: ProviderCacheHitModelRow[] = [
      {
        model: "",
        cached_tokens: 10,
        total_prompt_tokens: 20,
        response_count: 1,
      },
      {
        model: "unknown",
        cached_tokens: 10,
        total_prompt_tokens: 0,
        response_count: 2,
      },
      {
        model: "custom-model-without-provider",
        cached_tokens: 5,
        total_prompt_tokens: 10,
        response_count: 1,
      },
    ];

    expect(aggregateProviderCacheHitRows(rows)).toEqual([
      {
        provider: "unknown",
        cacheHitRatio: 25 / 30,
        responseCount: 4,
      },
    ]);
  });

  test("normalizes mux-gateway model prefixes before provider grouping", () => {
    const rows: ProviderCacheHitModelRow[] = [
      {
        model: "mux-gateway:openai/gpt-4.1",
        cached_tokens: 12,
        total_prompt_tokens: 30,
        response_count: 2,
      },
    ];

    expect(aggregateProviderCacheHitRows(rows)).toEqual([
      {
        provider: "openai",
        cacheHitRatio: 0.4,
        responseCount: 2,
      },
    ]);
  });
});
