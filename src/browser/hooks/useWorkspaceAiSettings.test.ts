import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { readWorkspaceAiSettings } from "./useWorkspaceAiSettings";
import { updatePersistedState } from "./usePersistedState";
import { getWorkspaceAISettingsByAgentKey } from "@/common/constants/storage";

describe("readWorkspaceAiSettings", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
    globalThis.CustomEvent = globalThis.window.CustomEvent;
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
  });

  test("normalizes invalid thinking levels and persists the fix", () => {
    const workspaceId = "ws-invalid-thinking";

    updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
      exec: { model: "openai:gpt-4.1", thinkingLevel: "banana" },
    });

    const settings = readWorkspaceAiSettings({ workspaceId, agentId: "exec" });

    expect(settings.thinkingLevel).toBe("off");

    const persisted = globalThis.localStorage.getItem(
      getWorkspaceAISettingsByAgentKey(workspaceId)
    );
    expect(persisted).toBeTruthy();
    expect(JSON.parse(persisted!)).toEqual({
      exec: { model: "openai:gpt-4.1", thinkingLevel: "off" },
    });
  });
});
