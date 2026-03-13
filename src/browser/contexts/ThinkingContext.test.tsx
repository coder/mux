import { GlobalWindow } from "happy-dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { ThinkingProvider } from "./ThinkingContext";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import {
  AGENT_AI_DEFAULTS_KEY,
  getAgentIdKey,
  getModelKey,
  getProjectScopeId,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import type { RecursivePartial } from "@/browser/testUtils";

let currentClientMock: RecursivePartial<APIClient> = {};

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

const TestComponent: React.FC<TestProps> = (props) => {
  const [thinkingLevel] = useThinkingLevel();
  return (
    <div data-testid="thinking">
      {thinkingLevel}:{props.workspaceId}
    </div>
  );
};

const ThinkingControls: React.FC = () => {
  const [thinkingLevel, setThinkingLevel] = useThinkingLevel();
  return (
    <>
      <div data-testid="thinking-controls">{thinkingLevel}</div>
      <button onClick={() => setThinkingLevel("medium")}>Set medium</button>
    </>
  );
};

function renderWithAPI(children: React.ReactNode) {
  return render(<APIProvider client={currentClientMock as APIClient}>{children}</APIProvider>);
}

describe("ThinkingContext", () => {
  // Make getDefaultModel deterministic.
  // (getDefaultModel reads from the global "model-default" localStorage key.)
  beforeEach(() => {
    currentClientMock = {
      workspace: {
        updateAgentAISettings: mock(() =>
          Promise.resolve({
            success: true as const,
            data: undefined,
          })
        ),
      },
    };
    window.localStorage.clear();
    window.localStorage.setItem("model-default", JSON.stringify("openai:default"));
  });

  afterEach(() => {
    cleanup();
    currentClientMock = {};
  });

  test("switching models does not remount children", async () => {
    const workspaceId = "ws-1";

    updatePersistedState(getAgentIdKey(workspaceId), "exec");
    updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.2");
    updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
      exec: { model: "openai:gpt-5.2", thinkingLevel: "high" },
    });

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

    const view = renderWithAPI(
      <ThinkingProvider workspaceId={workspaceId}>
        <Child />
      </ThinkingProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("child").textContent).toBe("high");
    });

    act(() => {
      updatePersistedState(getModelKey(workspaceId), "anthropic:claude-3.5");
    });

    await waitFor(() => {
      expect(view.getByTestId("child").textContent).toBe("high");
    });

    expect(unmounts).toBe(0);
  });

  test("migrates legacy per-model thinking in project-scoped creation flow", async () => {
    const projectPath = "/Users/dev/migration-project";
    const projectScopeId = getProjectScopeId(projectPath);

    updatePersistedState(getModelKey(projectScopeId), "openai:gpt-5.2");
    updatePersistedState(getThinkingLevelByModelKey("openai:gpt-5.2"), "low");

    const ProjectChild: React.FC = () => {
      const [thinkingLevel] = useThinkingLevel();
      return <div data-testid="thinking-project-migration">{thinkingLevel}</div>;
    };

    const view = renderWithAPI(
      <ThinkingProvider projectPath={projectPath}>
        <ProjectChild />
      </ThinkingProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("thinking-project-migration").textContent).toBe("low");
    });

    const persisted = window.localStorage.getItem(getThinkingLevelKey(projectScopeId));
    expect(persisted).toBeTruthy();
    expect(JSON.parse(persisted!)).toBe("low");
  });

  test("manual workspace thinking updates the per-agent cache without bounce-back", async () => {
    const workspaceId = "ws-manual";

    updatePersistedState(getAgentIdKey(workspaceId), "exec");
    updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.2");
    updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
      exec: { model: "openai:gpt-5.2", thinkingLevel: "off" },
    });

    const view = renderWithAPI(
      <ThinkingProvider workspaceId={workspaceId}>
        <ThinkingControls />
      </ThinkingProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("thinking-controls").textContent).toBe("off");
    });

    fireEvent.click(view.getByRole("button", { name: "Set medium" }));

    await waitFor(() => {
      expect(view.getByTestId("thinking-controls").textContent).toBe("medium");
    });

    expect(readPersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {})).toEqual({
      exec: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
    });
  });

  test("reacts to agent default updates for existing workspaces", async () => {
    const workspaceId = "ws-defaults";

    updatePersistedState(getAgentIdKey(workspaceId), "exec");
    updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.2");
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      exec: { thinkingLevel: "low" },
    });

    const view = renderWithAPI(
      <ThinkingProvider workspaceId={workspaceId}>
        <TestComponent workspaceId={workspaceId} />
      </ThinkingProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("low:ws-defaults");
    });

    act(() => {
      updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
        exec: { thinkingLevel: "xhigh" },
      });
    });

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("xhigh:ws-defaults");
    });
  });

  test("restores the active agent's cached workspace thinking on agent switch", async () => {
    const workspaceId = "ws-switch";

    updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.2");
    updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
      exec: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
      plan: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "high" },
    });
    updatePersistedState(getAgentIdKey(workspaceId), "exec");

    const view = renderWithAPI(
      <ThinkingProvider workspaceId={workspaceId}>
        <TestComponent workspaceId={workspaceId} />
      </ThinkingProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("medium:ws-switch");
    });

    act(() => {
      updatePersistedState(getAgentIdKey(workspaceId), "plan");
    });

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("high:ws-switch");
    });

    act(() => {
      updatePersistedState(getAgentIdKey(workspaceId), "exec");
    });

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("medium:ws-switch");
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

    const view = renderWithAPI(
      <ThinkingProvider projectPath={projectPath}>
        <ProjectChild />
      </ThinkingProvider>
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
