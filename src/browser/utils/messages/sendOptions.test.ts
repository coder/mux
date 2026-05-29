import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getModelKey } from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { installDom } from "../../../../tests/ui/dom";
import { getSendOptionsFromStorage } from "./sendOptions";
import { normalizeModelPreference } from "./buildSendMessageOptions";

let cleanupDom: (() => void) | null = null;

describe("getSendOptionsFromStorage", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    window.localStorage.setItem("model-default", JSON.stringify("openai:default"));
  });

  afterEach(() => {
    window.localStorage.clear();
    cleanupDom?.();
    cleanupDom = null;
  });

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
