/**
 * Tests for useModelLRU hook
 *
 * Key invariant: newly-added DEFAULT_MODELS should show up in the selector even if the
 * persisted LRU list is already full.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { MODEL_ABBREVIATIONS } from "@/browser/utils/slashCommands/registry";
import { defaultModel } from "@/common/utils/ai/models";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { useModelLRU } from "./useModelLRU";

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: null }),
}));

describe("useModelLRU", () => {
  const MAX_LRU_SIZE = 12;

  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("merges in missing defaults even when LRU is full", async () => {
    const FALLBACK_MODEL = WORKSPACE_DEFAULTS.model ?? defaultModel;
    const DEFAULT_MODELS = [
      FALLBACK_MODEL,
      ...Array.from(new Set(Object.values(MODEL_ABBREVIATIONS))).filter(
        (m) => m !== FALLBACK_MODEL
      ),
    ].slice(0, MAX_LRU_SIZE);

    // The bug report: openai:gpt-5.2 exists in Settings/KNOWN_MODELS but can be missing in the
    // chat creation selector when model-lru is already at max size.
    expect(DEFAULT_MODELS).toContain("openai:gpt-5.2");

    const customModel1 = "openai:totally-custom-model";
    const customModel2 = "openai:totally-custom-model-2";

    // Create a full list that *doesn't* contain openai:gpt-5.2.
    const seededBase = DEFAULT_MODELS.filter((m) => m !== "openai:gpt-5.2");
    const seeded = [...seededBase, customModel1, customModel2].slice(0, MAX_LRU_SIZE);

    expect(seeded).toHaveLength(MAX_LRU_SIZE);
    expect(seeded).not.toContain("openai:gpt-5.2");
    expect(seeded).toContain(customModel2);

    globalThis.window.localStorage.setItem("model-lru", JSON.stringify(seeded));

    const { result } = renderHook(() => useModelLRU());

    await waitFor(() => expect(result.current.recentModels).toContain("openai:gpt-5.2"));

    // The newly-added default should be present, and we should stay within the cap.
    expect(result.current.recentModels.length).toBeLessThanOrEqual(MAX_LRU_SIZE);

    const persisted = JSON.parse(
      globalThis.window.localStorage.getItem("model-lru") ?? "[]"
    ) as string[];
    expect(persisted).toContain("openai:gpt-5.2");
    expect(persisted.length).toBeLessThanOrEqual(MAX_LRU_SIZE);

    // To make room, we should evict a non-default model rather than dropping the new default.
    expect(persisted).not.toContain(customModel2);
  });
});
