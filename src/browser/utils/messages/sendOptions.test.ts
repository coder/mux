import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import {
  getModelKey,
  PREFERRED_SYSTEM_1_MODEL_KEY,
  PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
} from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { getSendOptionsFromStorage } from "./sendOptions";
import { normalizeModelPreference } from "./buildSendMessageOptions";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

describe("getSendOptionsFromStorage", () => {
  beforeEach(() => {
    const windowInstance = new GlobalWindow();
    (globalThis as any).window = windowInstance.window;
    (globalThis as any).document = windowInstance.window.document;
    (globalThis as any).location = new URL("https://example.com/");
    (globalThis as any).StorageEvent = windowInstance.window.StorageEvent;
    (globalThis as any).CustomEvent = windowInstance.window.CustomEvent;

    window.localStorage.clear();
    window.localStorage.setItem("model-default", JSON.stringify("openai:default"));
  });

  afterEach(() => {
    window.localStorage.clear();
    (globalThis as any).window = undefined;
    (globalThis as any).document = undefined;
    (globalThis as any).location = undefined;
    (globalThis as any).StorageEvent = undefined;
    (globalThis as any).CustomEvent = undefined;
  });

  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

  test("normalizes stored model preference with shared helper", () => {
    const workspaceId = "ws-1";
    const rawModel = "mux-gateway:anthropic/claude-haiku-4-5";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify(rawModel));

    const options = getSendOptionsFromStorage(workspaceId);
    const expectedModel = normalizeModelPreference(rawModel, "openai:default");

    expect(options.model).toBe(expectedModel);
    expect(options.thinkingLevel).toBe(WORKSPACE_DEFAULTS.thinkingLevel);
  });

  test("omits system1 thinking when set to off", () => {
    const workspaceId = "ws-2";

    window.localStorage.setItem(PREFERRED_SYSTEM_1_MODEL_KEY, JSON.stringify("openai:gpt-5.2"));
    window.localStorage.setItem(PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY, JSON.stringify("off"));

    const options = getSendOptionsFromStorage(workspaceId);
    expect(options.system1ThinkingLevel).toBeUndefined();

    window.localStorage.setItem(PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY, JSON.stringify("high"));
    const withThinking = getSendOptionsFromStorage(workspaceId);
    expect(withThinking.system1ThinkingLevel).toBe("high");
  });
});
