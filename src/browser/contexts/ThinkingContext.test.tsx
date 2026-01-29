import { GlobalWindow } from "happy-dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { ThinkingProvider } from "./ThinkingContext";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { AgentProvider } from "@/browser/contexts/AgentContext";
import {
  getModelKey,
  getProjectScopeId,
  getThinkingLevelByModelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import type { APIClient } from "@/browser/contexts/API";
import type { RecursivePartial } from "@/browser/testUtils";
import type { ThinkingLevel } from "@/common/types/thinking";

const currentClientMock: RecursivePartial<APIClient> = {};
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: currentClientMock as APIClient,
    status: "connected" as const,
    error: null,
  }),
  APIProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { updatePersistedState } from "@/browser/hooks/usePersistedState";

// Setup basic DOM environment for testing-library
const dom = new GlobalWindow();
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).location = new URL("https://example.com/");

// Ensure globals exist for instanceof checks inside usePersistedState
(globalThis as any).StorageEvent = dom.window.StorageEvent;
(globalThis as any).CustomEvent = dom.window.CustomEvent;

(global as any).console = console;
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

interface TestProps {
  workspaceId: string;
}

type WorkspaceAISettingsByAgentCache = Partial<
  Record<string, { model: string; thinkingLevel: ThinkingLevel }>
>;

const TestComponent: React.FC<TestProps> = (props) => {
  const [thinkingLevel] = useThinkingLevel();
  return (
    <div data-testid="thinking">
      {thinkingLevel}:{props.workspaceId}
    </div>
  );
};

describe("ThinkingContext", () => {
  // Make getDefaultModel deterministic.
  // (getDefaultModel reads from the global "model-default" localStorage key.)
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("model-default", JSON.stringify("openai:default"));
  });

  afterEach(() => {
    cleanup();
  });

  test("switching models does not remount children", async () => {
    const workspaceId = "ws-1";

    updatePersistedState<WorkspaceAISettingsByAgentCache>(
      getWorkspaceAISettingsByAgentKey(workspaceId),
      { exec: { model: "openai:gpt-5.2", thinkingLevel: "high" } },
      {}
    );

    let unmounts = 0;

    const Child: React.FC = () => {
      React.useEffect(() => {
        return () => {
          unmounts += 1;
        };
      }, []);

      const [thinkingLevel] = useThinkingLevel();
      return <div data-testid="child">{thinkingLevel}</div>;
    };

    const view = render(
      <AgentProvider workspaceId={workspaceId}>
        <ThinkingProvider workspaceId={workspaceId}>
          <Child />
        </ThinkingProvider>
      </AgentProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("child").textContent).toBe("high");
    });

    act(() => {
      updatePersistedState<WorkspaceAISettingsByAgentCache>(
        getWorkspaceAISettingsByAgentKey(workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByAgentCache =
            prev && typeof prev === "object" ? prev : {};
          const existingThinking = record.exec?.thinkingLevel ?? "high";
          return {
            ...record,
            exec: { model: "anthropic:claude-3.5", thinkingLevel: existingThinking },
          };
        },
        {}
      );
    });

    // Thinking is workspace-scoped (not per-model), so switching models should not change it.
    await waitFor(() => {
      expect(view.getByTestId("child").textContent).toBe("high");
    });

    expect(unmounts).toBe(0);
  });
  test("migrates legacy per-model thinking to the workspace-scoped key", async () => {
    const workspaceId = "ws-1";

    updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.2");
    updatePersistedState(getThinkingLevelByModelKey("openai:gpt-5.2"), "low");

    const view = render(
      <AgentProvider workspaceId={workspaceId}>
        <ThinkingProvider workspaceId={workspaceId}>
          <TestComponent workspaceId={workspaceId} />
        </ThinkingProvider>
      </AgentProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("low:ws-1");
    });

    // Migration should have populated the workspace AI settings cache.
    const persisted = window.localStorage.getItem(getWorkspaceAISettingsByAgentKey(workspaceId));
    expect(persisted).toBeTruthy();
    expect(JSON.parse(persisted!)).toEqual({
      exec: { model: "openai:gpt-5.2", thinkingLevel: "low" },
    });

    // Switching models should not change the workspace-scoped value.
    act(() => {
      updatePersistedState<WorkspaceAISettingsByAgentCache>(
        getWorkspaceAISettingsByAgentKey(workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByAgentCache =
            prev && typeof prev === "object" ? prev : {};
          const existingThinking = record.exec?.thinkingLevel ?? "high";
          return {
            ...record,
            exec: { model: "anthropic:claude-3.5", thinkingLevel: existingThinking },
          };
        },
        {}
      );
    });

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("low:ws-1");
    });
  });

  test("cycles thinking level via keybind in project-scoped (creation) flow", async () => {
    const projectPath = "/Users/dev/my-project";

    // Force a model with a multi-level thinking policy.
    updatePersistedState(getModelKey(getProjectScopeId(projectPath)), "openai:gpt-4.1");

    const ProjectChild: React.FC = () => {
      const [thinkingLevel] = useThinkingLevel();
      return <div data-testid="thinking-project">{thinkingLevel}</div>;
    };

    const view = render(
      <AgentProvider projectPath={projectPath}>
        <ThinkingProvider projectPath={projectPath}>
          <ProjectChild />
        </ThinkingProvider>
      </AgentProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("thinking-project").textContent).toBe("off");
    });

    act(() => {
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true })
      );
    });

    await waitFor(() => {
      expect(view.getByTestId("thinking-project").textContent).toBe("low");
    });
  });
});
