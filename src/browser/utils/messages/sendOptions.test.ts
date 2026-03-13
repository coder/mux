import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import {
  AGENT_AI_DEFAULTS_KEY,
  getAgentIdKey,
  getModelKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  PREFERRED_SYSTEM_1_MODEL_KEY,
  PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
} from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { getSendOptionsFromStorage } from "./sendOptions";
import { normalizeModelPreference } from "./buildSendMessageOptions";

function readWorkspaceCache(workspaceId: string) {
  const raw = window.localStorage.getItem(getWorkspaceAISettingsByAgentKey(workspaceId));
  return raw ? (JSON.parse(raw) as Record<string, { model: string; thinkingLevel: string }>) : null;
}

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

  test("preserves explicit gateway-scoped stored model preferences", () => {
    const workspaceId = "ws-1";
    const rawModel = "mux-gateway:anthropic/claude-haiku-4-5";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify(rawModel));

    const options = getSendOptionsFromStorage(workspaceId);

    expect(options.model).toBe(rawModel);
    expect(options.thinkingLevel).toBe(WORKSPACE_DEFAULTS.thinkingLevel);
  });

  test("keeps direct-provider model preferences normalized via the shared helper", () => {
    expect(normalizeModelPreference(" openai:gpt-5.2 ", "anthropic:default")).toBe(
      "openai:gpt-5.2"
    );
  });

  test("derives workspace thinking from per-agent settings and defaults instead of the flat key", () => {
    const workspaceId = "ws-derived";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify("openai:gpt-5.2"));
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("exec"));
    window.localStorage.setItem(getThinkingLevelKey(workspaceId), JSON.stringify("medium"));
    window.localStorage.setItem(
      getWorkspaceAISettingsByAgentKey(workspaceId),
      JSON.stringify({
        exec: { model: "openai:gpt-5.2", thinkingLevel: "low" },
      })
    );
    window.localStorage.setItem(
      AGENT_AI_DEFAULTS_KEY,
      JSON.stringify({
        exec: { thinkingLevel: "high" },
      })
    );

    const withDefaults = getSendOptionsFromStorage(workspaceId);
    expect(withDefaults.thinkingLevel).toBe("high");

    window.localStorage.setItem(AGENT_AI_DEFAULTS_KEY, JSON.stringify({}));
    const withWorkspaceCache = getSendOptionsFromStorage(workspaceId);
    expect(withWorkspaceCache.thinkingLevel).toBe("low");
  });

  test("uses legacy thinking level for existing workspace with empty agent cache", () => {
    const workspaceId = "ws-legacy";

    window.localStorage.setItem(getThinkingLevelKey(workspaceId), JSON.stringify("medium"));

    const options = getSendOptionsFromStorage(workspaceId);

    expect(options.thinkingLevel).toBe("medium");
    expect(readWorkspaceCache(workspaceId)).toEqual({
      auto: { model: WORKSPACE_DEFAULTS.model, thinkingLevel: "medium" },
    });
  });

  test("falls back to per-model thinking key for unmigrated existing workspace", () => {
    const workspaceId = "ws-unmigrated";
    const model = "openai:gpt-5.2";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify(model));
    window.localStorage.setItem(getThinkingLevelByModelKey(model), JSON.stringify("high"));

    const options = getSendOptionsFromStorage(workspaceId);

    expect(options.thinkingLevel).toBe("high");
    expect(readWorkspaceCache(workspaceId)).toEqual({
      auto: { model, thinkingLevel: "high" },
    });
  });

  test("recovers canonical legacy per-model thinking when the current model is gateway-prefixed", () => {
    const workspaceId = "ws-gateway-legacy";
    const gatewayModel = "openrouter:openai/gpt-5";
    const canonicalModel = "openai:gpt-5";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify(gatewayModel));
    window.localStorage.setItem(getThinkingLevelByModelKey(canonicalModel), JSON.stringify("high"));

    const options = getSendOptionsFromStorage(workspaceId);

    expect(options.thinkingLevel).toBe("high");
    expect(readWorkspaceCache(workspaceId)).toEqual({
      auto: { model: gatewayModel, thinkingLevel: "high" },
    });
  });

  test("recovers gateway-only legacy per-model thinking when canonical key is absent", () => {
    const workspaceId = "ws-gateway-only-legacy";
    const gatewayModel = "openrouter:openai/gpt-5";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify(gatewayModel));
    window.localStorage.setItem(getThinkingLevelByModelKey(gatewayModel), JSON.stringify("medium"));

    const options = getSendOptionsFromStorage(workspaceId);

    expect(options.thinkingLevel).toBe("medium");
    expect(readWorkspaceCache(workspaceId)).toEqual({
      auto: { model: gatewayModel, thinkingLevel: "medium" },
    });
  });

  test("prefers canonical legacy per-model thinking over gateway-keyed legacy data", () => {
    const workspaceId = "ws-canonical-legacy-preferred";
    const gatewayModel = "openrouter:openai/gpt-5";
    const canonicalModel = "openai:gpt-5";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify(gatewayModel));
    window.localStorage.setItem(getThinkingLevelByModelKey(gatewayModel), JSON.stringify("medium"));
    window.localStorage.setItem(getThinkingLevelByModelKey(canonicalModel), JSON.stringify("high"));

    const options = getSendOptionsFromStorage(workspaceId);

    expect(options.thinkingLevel).toBe("high");
    expect(readWorkspaceCache(workspaceId)).toEqual({
      auto: { model: gatewayModel, thinkingLevel: "high" },
    });
  });

  test("lazy-migrates recovered gateway-keyed legacy thinking into the per-agent workspace cache", () => {
    const workspaceId = "ws-gateway-raw-migrate";
    const gatewayModel = "openrouter:openai/gpt-5";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify(gatewayModel));
    window.localStorage.setItem(getThinkingLevelByModelKey(gatewayModel), JSON.stringify("medium"));

    const options = getSendOptionsFromStorage(workspaceId);

    expect(options.thinkingLevel).toBe("medium");
    expect(readWorkspaceCache(workspaceId)).toEqual({
      auto: { model: gatewayModel, thinkingLevel: "medium" },
    });
  });

  test("lazy-migrates recovered per-model thinking into the per-agent workspace cache on first read", () => {
    const workspaceId = "ws-migrate";
    const model = "openai:gpt-5.2";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify(model));
    window.localStorage.setItem(getThinkingLevelByModelKey(model), JSON.stringify("medium"));

    getSendOptionsFromStorage(workspaceId);

    expect(readWorkspaceCache(workspaceId)).toEqual({
      auto: { model, thinkingLevel: "medium" },
    });
  });

  test("uses legacy thinking level when auto agent has only legacy plan/exec workspace cache entries", () => {
    const workspaceId = "ws-legacy-auto";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify("openai:gpt-5.2"));
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("auto"));
    window.localStorage.setItem(getThinkingLevelKey(workspaceId), JSON.stringify("high"));
    window.localStorage.setItem(
      getWorkspaceAISettingsByAgentKey(workspaceId),
      JSON.stringify({
        exec: { model: "openai:gpt-5.2", thinkingLevel: "low" },
        plan: { model: "openai:gpt-5.2", thinkingLevel: "low" },
      })
    );

    const options = getSendOptionsFromStorage(workspaceId);

    expect(options.thinkingLevel).toBe("high");
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

  test("includes Anthropic prompt cache TTL from persisted provider options", () => {
    const workspaceId = "ws-3";

    window.localStorage.setItem(
      "provider_options_anthropic",
      JSON.stringify({
        cacheTtl: "1h",
      })
    );

    const options = getSendOptionsFromStorage(workspaceId);
    expect(options.providerOptions?.anthropic?.cacheTtl).toBe("1h");
  });
});
