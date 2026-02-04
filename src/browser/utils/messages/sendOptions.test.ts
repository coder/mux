import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getModelKey,
  PREFERRED_SYSTEM_1_MODEL_KEY,
  PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
} from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { getSendOptionsFromStorage } from "./sendOptions";
import { normalizeModelPreference } from "./buildSendMessageOptions";

const dom = new GlobalWindow();
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).location = new URL("https://example.com/");
(globalThis as any).StorageEvent = dom.window.StorageEvent;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

describe("getSendOptionsFromStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("model-default", JSON.stringify("openai:default"));
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  test("normalizes stored model preference with shared helper", () => {
    const workspaceId = "ws-1";
    const rawModel = "mux-gateway:anthropic/claude-haiku-4-5";

    updatePersistedState(getModelKey(workspaceId), rawModel);

    const options = getSendOptionsFromStorage(workspaceId);
    const expectedModel = normalizeModelPreference(rawModel, "openai:default");

    expect(options.model).toBe(expectedModel);
    expect(options.thinkingLevel).toBe(WORKSPACE_DEFAULTS.thinkingLevel);
  });

  test("omits system1 thinking when set to off", () => {
    const workspaceId = "ws-2";

    updatePersistedState(PREFERRED_SYSTEM_1_MODEL_KEY, "openai:gpt-5.2");
    updatePersistedState(PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY, "off");

    const options = getSendOptionsFromStorage(workspaceId);
    expect(options.system1ThinkingLevel).toBeUndefined();

    updatePersistedState(PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY, "high");
    const withThinking = getSendOptionsFromStorage(workspaceId);
    expect(withThinking.system1ThinkingLevel).toBe("high");
  });
});
