import { describe, test, expect } from "bun:test";
import {
  getBestCompletionFromPrompts,
  normalizePromptKey,
  normalizePromptText,
  scorePrompt,
  shouldStorePrompt,
  type StoredPrompt,
} from "./useChatPromptHistory";

describe("useChatPromptHistory (pure helpers)", () => {
  test("normalizePromptText collapses whitespace and trims but preserves casing", () => {
    expect(normalizePromptText("  Rebase   on   main  ")).toBe("Rebase on main");
  });

  test("normalizePromptKey lowercases and collapses whitespace", () => {
    expect(normalizePromptKey("  Rebase   on   main  ")).toBe("rebase on main");
  });

  test("shouldStorePrompt rejects empty, slash commands, multi-line, and long text", () => {
    expect(shouldStorePrompt("   ")).toBe(false);
    expect(shouldStorePrompt("/model gpt-4")).toBe(false);
    expect(shouldStorePrompt("hello\nworld")).toBe(false);
    expect(shouldStorePrompt("x".repeat(1000))).toBe(false);
    expect(shouldStorePrompt("rebase on main")).toBe(true);
  });

  test("scorePrompt prefers recency, but frequency can win", () => {
    const now = Date.now();

    const recentLowFreq: StoredPrompt = {
      text: "rebase on main",
      key: "rebase on main",
      useCount: 1,
      lastUsedAt: now - 1 * 60 * 60 * 1000,
    };

    const staleHighFreq: StoredPrompt = {
      text: "revert this",
      key: "revert this",
      useCount: 5,
      lastUsedAt: now - 100 * 60 * 60 * 1000,
    };

    // Tuned so recency should edge out in this case.
    expect(scorePrompt(recentLowFreq, now)).toBeGreaterThan(scorePrompt(staleHighFreq, now));

    const somewhatStaleVeryHighFreq: StoredPrompt = {
      text: "rebase on main",
      key: "rebase on main",
      useCount: 100,
      lastUsedAt: now - 10 * 60 * 60 * 1000,
    };

    expect(scorePrompt(somewhatStaleVeryHighFreq, now)).toBeGreaterThan(
      scorePrompt(recentLowFreq, now)
    );
  });

  test("getBestCompletionFromPrompts matches prefix case-insensitively and excludes exact match", () => {
    const now = 1_700_000_000_000;

    const prompts: StoredPrompt[] = [
      { text: "rebase on main", key: "rebase on main", useCount: 3, lastUsedAt: now - 1000 },
      {
        text: "reset --hard",
        key: "reset --hard",
        useCount: 10,
        lastUsedAt: now - 10 * 60 * 60 * 1000,
      },
    ];

    expect(getBestCompletionFromPrompts(prompts, "re", now)).toBe("rebase on main");
    expect(getBestCompletionFromPrompts(prompts, "RE", now)).toBe("rebase on main");
    expect(getBestCompletionFromPrompts(prompts, "rebase on main", now)).toBe(null);
  });
});
