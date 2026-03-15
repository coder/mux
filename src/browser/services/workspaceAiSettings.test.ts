import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { shouldApplyWorkspaceAiSettingsFromBackend } from "@/browser/utils/workspaceAiSettingsSync";
import {
  AGENT_AI_DEFAULTS_KEY,
  getAgentIdKey,
  getModelKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

import {
  getWorkspaceAiSettings,
  normalizeAgentId,
  setWorkspaceAiSettings,
  type WorkspaceAISettingsCache,
} from "./workspaceAiSettings";

let cleanupDom: (() => void) | null = null;
let workspaceCounter = 0;

function nextWorkspaceId(): string {
  workspaceCounter += 1;
  return `workspace-ai-settings-test-${workspaceCounter}`;
}

function readWorkspaceCache(workspaceId: string): WorkspaceAISettingsCache {
  return readPersistedState<WorkspaceAISettingsCache>(
    getWorkspaceAISettingsByAgentKey(workspaceId),
    {}
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("workspaceAiSettings", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  describe("getWorkspaceAiSettings", () => {
    test("returns per-agent cache when present", () => {
      const workspaceId = nextWorkspaceId();

      updatePersistedState(getAgentIdKey(workspaceId), " PLAN ");
      updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.4");
      updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
        plan: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" },
      });

      expect(getWorkspaceAiSettings(workspaceId)).toEqual({
        model: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      });
    });

    test("agent defaults override per-agent cache for thinking level", () => {
      const workspaceId = nextWorkspaceId();

      updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
        exec: { thinkingLevel: "high" },
      });
      updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
        exec: { model: "openai:gpt-5.4", thinkingLevel: "low" },
      });

      expect(getWorkspaceAiSettings(workspaceId, "exec")).toEqual({
        model: "openai:gpt-5.4",
        thinkingLevel: "high",
      });
    });

    test("agent defaults override per-agent cache for model", () => {
      const workspaceId = nextWorkspaceId();

      updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
        exec: { modelString: "anthropic:claude-sonnet-4-5" },
      });
      updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
        exec: { model: "openai:gpt-5.4", thinkingLevel: "medium" },
      });

      expect(getWorkspaceAiSettings(workspaceId, "exec")).toEqual({
        model: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      });
    });

    test("falls back to the legacy workspace thinking key when cache and defaults are missing", () => {
      const workspaceId = nextWorkspaceId();

      updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.4");
      updatePersistedState(getThinkingLevelKey(workspaceId), "medium");

      expect(getWorkspaceAiSettings(workspaceId, "exec")).toEqual({
        model: "openai:gpt-5.4",
        thinkingLevel: "medium",
      });
    });

    test("falls back to the canonical legacy per-model key when the workspace key is absent", () => {
      const workspaceId = nextWorkspaceId();
      const rawModel = "mux-gateway:openai/gpt-5.4";
      const canonicalModel = normalizeToCanonical(rawModel);

      expect(canonicalModel).toBe("openai:gpt-5.4");
      updatePersistedState(getModelKey(workspaceId), rawModel);
      updatePersistedState(getThinkingLevelByModelKey(canonicalModel), "high");

      expect(getWorkspaceAiSettings(workspaceId, "exec")).toEqual({
        model: rawModel,
        thinkingLevel: "high",
      });
    });

    test("falls back to the gateway-prefixed legacy per-model key when the canonical key is absent", () => {
      const workspaceId = nextWorkspaceId();
      const rawModel = "mux-gateway:openai/gpt-5.4";

      updatePersistedState(getModelKey(workspaceId), rawModel);
      updatePersistedState(getThinkingLevelByModelKey(rawModel), "low");

      expect(getWorkspaceAiSettings(workspaceId, "exec")).toEqual({
        model: rawModel,
        thinkingLevel: "low",
      });
    });

    test("prefers the canonical legacy per-model key over the gateway-prefixed key", () => {
      const workspaceId = nextWorkspaceId();
      const rawModel = "mux-gateway:openai/gpt-5.4";
      const canonicalModel = normalizeToCanonical(rawModel);

      updatePersistedState(getModelKey(workspaceId), rawModel);
      updatePersistedState(getThinkingLevelByModelKey(rawModel), "low");
      updatePersistedState(getThinkingLevelByModelKey(canonicalModel), "xhigh");

      expect(getWorkspaceAiSettings(workspaceId, "exec")).toEqual({
        model: rawModel,
        thinkingLevel: "xhigh",
      });
    });

    test("lazy-migrates recovered legacy thinking into the per-agent cache", () => {
      const workspaceId = nextWorkspaceId();

      updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.4");
      updatePersistedState(getThinkingLevelKey(workspaceId), "high");

      expect(getWorkspaceAiSettings(workspaceId, "exec")).toEqual({
        model: "openai:gpt-5.4",
        thinkingLevel: "high",
      });
      expect(readWorkspaceCache(workspaceId)).toEqual({
        exec: { model: "openai:gpt-5.4", thinkingLevel: "high" },
      });
    });

    test("returns hardcoded defaults when nothing is set", () => {
      const workspaceId = nextWorkspaceId();

      expect(getWorkspaceAiSettings(workspaceId, "exec")).toEqual({
        model: WORKSPACE_DEFAULTS.model,
        thinkingLevel: WORKSPACE_DEFAULTS.thinkingLevel,
      });
    });

    test("inherits from the source agent and seeds the target cache when requested", () => {
      const workspaceId = nextWorkspaceId();

      updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
        exec: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" },
      });

      expect(
        getWorkspaceAiSettings(workspaceId, "plan", {
          inheritFromAgentId: " exec ",
        })
      ).toEqual({
        model: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      });
      expect(readWorkspaceCache(workspaceId)).toEqual({
        exec: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" },
        plan: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" },
      });
    });
  });

  describe("setWorkspaceAiSettings", () => {
    test("writes to the per-agent cache and fills a missing model from the current workspace model", () => {
      const workspaceId = nextWorkspaceId();

      updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.4");

      setWorkspaceAiSettings(workspaceId, " EXEC ", { thinkingLevel: "high" });

      expect(readWorkspaceCache(workspaceId)).toEqual({
        exec: { model: "openai:gpt-5.4", thinkingLevel: "high" },
      });
    });

    test("calls the backend API when an api client is provided", async () => {
      const workspaceId = nextWorkspaceId();
      const updateAgentAISettings = mock(() => Promise.resolve(undefined));

      setWorkspaceAiSettings(
        workspaceId,
        "exec",
        { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" },
        {
          workspace: {
            updateAgentAISettings,
          },
        }
      );

      await flushMicrotasks();

      expect(updateAgentAISettings).toHaveBeenCalledTimes(1);
      expect(updateAgentAISettings).toHaveBeenCalledWith({
        workspaceId,
        agentId: "exec",
        aiSettings: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" },
      });
    });

    test("uses pending guards while the backend write is in flight and clears them afterward", async () => {
      const successfulWorkspaceId = nextWorkspaceId();
      let resolveRequest!: () => void;
      const requestComplete = new Promise<void>((resolve) => {
        resolveRequest = resolve;
      });

      setWorkspaceAiSettings(
        successfulWorkspaceId,
        "exec",
        { model: "openai:gpt-5.4", thinkingLevel: "xhigh" },
        {
          workspace: {
            updateAgentAISettings: mock(() => requestComplete),
          },
        }
      );

      expect(
        shouldApplyWorkspaceAiSettingsFromBackend(successfulWorkspaceId, "exec", {
          model: "openai:gpt-5.4",
          thinkingLevel: "off",
        })
      ).toBe(false);

      resolveRequest();
      await flushMicrotasks();

      expect(
        shouldApplyWorkspaceAiSettingsFromBackend(successfulWorkspaceId, "exec", {
          model: "openai:gpt-5.4",
          thinkingLevel: "off",
        })
      ).toBe(false);
      expect(
        shouldApplyWorkspaceAiSettingsFromBackend(successfulWorkspaceId, "exec", {
          model: "openai:gpt-5.4",
          thinkingLevel: "xhigh",
        })
      ).toBe(true);
      expect(
        shouldApplyWorkspaceAiSettingsFromBackend(successfulWorkspaceId, "exec", {
          model: "openai:gpt-5.4",
          thinkingLevel: "off",
        })
      ).toBe(true);

      const failedWorkspaceId = nextWorkspaceId();
      let rejectRequest!: (reason?: unknown) => void;
      const requestFailure = new Promise<void>((_, reject) => {
        rejectRequest = reject;
      });

      setWorkspaceAiSettings(
        failedWorkspaceId,
        "exec",
        { model: "openai:gpt-5.4", thinkingLevel: "medium" },
        {
          workspace: {
            updateAgentAISettings: mock(() => requestFailure),
          },
        }
      );

      expect(
        shouldApplyWorkspaceAiSettingsFromBackend(failedWorkspaceId, "exec", {
          model: "openai:gpt-5.4",
          thinkingLevel: "off",
        })
      ).toBe(false);

      rejectRequest(new Error("backend write failed"));
      await flushMicrotasks();

      expect(
        shouldApplyWorkspaceAiSettingsFromBackend(failedWorkspaceId, "exec", {
          model: "openai:gpt-5.4",
          thinkingLevel: "off",
        })
      ).toBe(true);
    });
  });

  describe("normalizeAgentId", () => {
    test('lowercases, trims, and defaults empty values to "exec"', () => {
      expect(normalizeAgentId(" PLAN ")).toBe("plan");
      expect(normalizeAgentId("")).toBe("exec");
      expect(normalizeAgentId("   ")).toBe("exec");
    });
  });
});
