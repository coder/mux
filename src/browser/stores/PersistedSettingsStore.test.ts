import { GlobalWindow } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { waitFor } from "@testing-library/react";
import { persistedSettingsStore } from "./PersistedSettingsStore";
import type { APIClient } from "@/browser/contexts/API";

const dom = new GlobalWindow();
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(globalThis as any).StorageEvent = dom.window.StorageEvent;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

describe("PersistedSettingsStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    persistedSettingsStore.dispose();
  });

  afterEach(() => {
    persistedSettingsStore.dispose();
  });

  it("falls back to localStorage when backend has no value", () => {
    window.localStorage.setItem("thinkingLevel:model:openai:gpt-5.2", JSON.stringify("high"));

    expect(persistedSettingsStore.getThinkingLevelForModel("openai:gpt-5.2")).toBe("high");
  });

  it("updates snapshot optimistically when setting thinking", async () => {
    await persistedSettingsStore.setAIThinkingLevel("openai:gpt-5.2", "low");

    const snapshot = persistedSettingsStore.getSnapshot();
    expect(snapshot.settings.ai?.thinkingLevelByModel?.["openai:gpt-5.2"]).toBe("low");
  });

  it("refreshes from backend and reacts to onChanged", async () => {
    let callCount = 0;

    const get = mock(() => {
      callCount += 1;
      return Promise.resolve(
        callCount === 1
          ? { ai: { thinkingLevelByModel: { "openai:gpt-5.2": "high" } } }
          : { ai: { thinkingLevelByModel: { "openai:gpt-5.2": "low" } } }
      );
    });

    const change = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = () => res();
      });
      return { promise, resolve };
    })();

    const onChanged = mock(() => {
      async function* iter() {
        await change.promise;
        // Yield once to trigger a refresh.
        yield undefined;
      }
      return Promise.resolve(iter());
    });

    const api = {
      persistedSettings: {
        get,
        onChanged,
        setAIThinkingLevel: () => Promise.resolve({ success: true, data: undefined }),
      },
    } as unknown as APIClient;

    persistedSettingsStore.init(api);

    await waitFor(() => {
      expect(persistedSettingsStore.getThinkingLevelForModel("openai:gpt-5.2")).toBe("high");
    });

    change.resolve();

    await waitFor(() => {
      expect(persistedSettingsStore.getThinkingLevelForModel("openai:gpt-5.2")).toBe("low");
    });

    expect(get).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });
});
