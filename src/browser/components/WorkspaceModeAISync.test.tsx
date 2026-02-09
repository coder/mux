import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render, waitFor } from "@testing-library/react";

import { AgentProvider } from "@/browser/contexts/AgentContext";
import { consumeWorkspaceModelChange } from "@/browser/utils/modelChange";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { AGENT_AI_DEFAULTS_KEY, getModelKey } from "@/common/constants/storage";

import { WorkspaceModeAISync } from "./WorkspaceModeAISync";

let workspaceCounter = 0;

function nextWorkspaceId(): string {
  workspaceCounter += 1;
  return `workspace-mode-ai-sync-test-${workspaceCounter}`;
}

const noop = () => {
  // intentional noop for tests
};

describe("WorkspaceModeAISync", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
  });

  test("only records explicit model changes when agentId changes", async () => {
    const workspaceId = nextWorkspaceId();

    const execModel = "openai:gpt-4o-mini";
    const planModel = "anthropic:claude-3-5-sonnet-latest";

    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      exec: { modelString: execModel },
      plan: { modelString: planModel },
    });

    // Start with a different model so the mount sync performs an update.
    updatePersistedState(getModelKey(workspaceId), "some-legacy-model");

    function Harness(props: { agentId: string }) {
      return (
        <AgentProvider
          value={{
            agentId: props.agentId,
            setAgentId: noop,
            currentAgent: undefined,
            agents: [],
            loaded: true,
            loadFailed: false,
            refresh: () => Promise.resolve(),
            refreshing: false,
            disableWorkspaceAgents: false,
            setDisableWorkspaceAgents: noop,
          }}
        >
          <WorkspaceModeAISync workspaceId={workspaceId} />
        </AgentProvider>
      );
    }

    const { rerender } = render(<Harness agentId="exec" />);

    // Mount sync should update the model but NOT record an explicit change entry.
    await waitFor(() => {
      expect(readPersistedState(getModelKey(workspaceId), "")).toBe(execModel);
    });
    expect(consumeWorkspaceModelChange(workspaceId, execModel)).toBeNull();

    // Switching agents (within the same workspace) should be treated as explicit.
    rerender(<Harness agentId="plan" />);

    await waitFor(() => {
      expect(readPersistedState(getModelKey(workspaceId), "")).toBe(planModel);
    });
    expect(consumeWorkspaceModelChange(workspaceId, planModel)).toBe("agent");
  });
});
