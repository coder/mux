import { GlobalWindow } from "happy-dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import type { APIClient } from "@/browser/contexts/API";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RecursivePartial } from "@/browser/testUtils";

let currentClientMock: RecursivePartial<APIClient> = {};
let metadataMap = new Map<string, FrontendWorkspaceMetadata>();

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ workspaceMetadata: metadataMap }),
  useOptionalWorkspaceContext: () => ({ workspaceMetadata: metadataMap }),
}));

import { ThinkingProvider } from "./ThinkingContext";
import { APIProvider } from "@/browser/contexts/API";
import { AgentProvider, type AgentContextValue } from "@/browser/contexts/AgentContext";
import { ProviderOptionsProvider } from "@/browser/contexts/ProviderOptionsContext";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import {
  getModelKey,
  getProjectScopeId,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
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

type WorkspaceUpdateAgentAISettingsArgs = Parameters<
  APIClient["workspace"]["updateAgentAISettings"]
>[0];
type WorkspaceUpdateAgentAISettingsResult = Awaited<
  ReturnType<APIClient["workspace"]["updateAgentAISettings"]>
>;

const TestComponent: React.FC<TestProps> = (props) => {
  const [thinkingLevel] = useThinkingLevel();
  return (
    <div data-testid="thinking">
      {thinkingLevel}:{props.workspaceId}
    </div>
  );
};

const agentContextValue: AgentContextValue = {
  agentId: "exec",
  setAgentId: () => undefined,
  currentAgent: undefined,
  agents: [],
  loaded: true,
  loadFailed: false,
  refresh: () => Promise.resolve(),
  refreshing: false,
  disableWorkspaceAgents: false,
  setDisableWorkspaceAgents: () => undefined,
};

const ThinkingSetterComponent: React.FC = () => {
  const [, setThinkingLevel] = useThinkingLevel();
  return (
    <button data-testid="set-thinking-medium" onClick={() => setThinkingLevel("medium")}>
      Set thinking
    </button>
  );
};

const SendOptionsComponent: React.FC<{ workspaceId: string }> = (props) => {
  const options = useSendMessageOptions(props.workspaceId);
  return <div data-testid="base-model">{options.baseModel}</div>;
};

function renderWithAPI(children: React.ReactNode) {
  return render(<APIProvider client={currentClientMock as APIClient}>{children}</APIProvider>);
}

function createWorkspaceMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> & Pick<FrontendWorkspaceMetadata, "id">
): FrontendWorkspaceMetadata {
  return {
    projectPath: "/tmp/project",
    projectName: "project",
    name: "main",
    namedWorkspacePath: "/tmp/project/main",
    createdAt: "2026-01-01T00:00:00.000Z",
    runtimeConfig: { type: "local", srcBaseDir: "/tmp/.mux/src" },
    ...overrides,
  };
}

function setWorkspaceMetadata(metadata: FrontendWorkspaceMetadata) {
  metadataMap = new Map([[metadata.id, metadata]]);
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
    metadataMap = new Map();
    window.localStorage.clear();
    window.localStorage.setItem("model-default", JSON.stringify("openai:default"));
  });

  afterEach(() => {
    cleanup();
    metadataMap = new Map();
    currentClientMock = {};
  });

  test("uses metadata model before global default but keeps explicit model", async () => {
    const cases = [
      { workspaceId: "ws-model-metadata", override: null, expected: "openai:gpt-5.5" },
      {
        workspaceId: "ws-model-explicit",
        override: "anthropic:explicit-model",
        expected: "anthropic:explicit-model",
      },
    ];

    for (const testCase of cases) {
      const metadata = createWorkspaceMetadata({
        id: testCase.workspaceId,
        aiSettings: { model: "openai:gpt-5.5", thinkingLevel: "high" },
      });
      setWorkspaceMetadata(metadata);
      if (testCase.override == null) {
        window.localStorage.removeItem(getModelKey(testCase.workspaceId));
      } else {
        updatePersistedState(getModelKey(testCase.workspaceId), testCase.override);
      }

      const view = renderWithAPI(
        <ProviderOptionsProvider>
          <AgentProvider value={agentContextValue}>
            <ThinkingProvider workspaceId={testCase.workspaceId}>
              <SendOptionsComponent workspaceId={testCase.workspaceId} />
            </ThinkingProvider>
          </AgentProvider>
        </ProviderOptionsProvider>
      );

      await waitFor(() => {
        expect(view.getByTestId("base-model").textContent).toBe(testCase.expected);
      });
      cleanup();
    }
  });

  test("setting thinking uses metadata model before global default", async () => {
    const workspaceId = "ws-set-thinking-metadata-model";
    const updateAgentAISettings = mock<
      (args: WorkspaceUpdateAgentAISettingsArgs) => Promise<WorkspaceUpdateAgentAISettingsResult>
    >(() =>
      Promise.resolve({
        success: true as const,
        data: undefined,
      })
    );
    currentClientMock = {
      workspace: { updateAgentAISettings },
    };

    setWorkspaceMetadata(
      createWorkspaceMetadata({
        id: workspaceId,
        aiSettings: { model: "metadataModel:abc", thinkingLevel: "high" },
      })
    );
    window.localStorage.removeItem(getModelKey(workspaceId));

    const view = renderWithAPI(
      <ThinkingProvider workspaceId={workspaceId}>
        <ThinkingSetterComponent />
      </ThinkingProvider>
    );

    act(() => {
      view.getByTestId("set-thinking-medium").click();
    });

    await waitFor(() => {
      expect(updateAgentAISettings).toHaveBeenCalledWith({
        workspaceId,
        agentId: "exec",
        aiSettings: { model: "metadataModel:abc", thinkingLevel: "medium" },
      });
    });
  });

  test("uses metadata thinking before off but keeps explicit thinking", async () => {
    const cases = [
      {
        workspaceId: "ws-thinking-metadata",
        override: null,
        expected: "high:ws-thinking-metadata",
      },
      {
        workspaceId: "ws-thinking-explicit",
        override: "off" as const,
        expected: "off:ws-thinking-explicit",
      },
    ];

    for (const testCase of cases) {
      const metadata = createWorkspaceMetadata({
        id: testCase.workspaceId,
        aiSettings: { model: "openai:gpt-5.5", thinkingLevel: "high" },
      });
      setWorkspaceMetadata(metadata);
      if (testCase.override == null) {
        window.localStorage.removeItem(getThinkingLevelKey(testCase.workspaceId));
      } else {
        updatePersistedState(getThinkingLevelKey(testCase.workspaceId), testCase.override);
      }

      const view = renderWithAPI(
        <ThinkingProvider workspaceId={testCase.workspaceId}>
          <TestComponent workspaceId={testCase.workspaceId} />
        </ThinkingProvider>
      );

      await waitFor(() => {
        expect(view.getByTestId("thinking").textContent).toBe(testCase.expected);
      });
      cleanup();
    }
  });

  test("switching models does not remount children", async () => {
    const workspaceId = "ws-1";

    updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.2");
    updatePersistedState(getThinkingLevelKey(workspaceId), "high");

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

    const view = renderWithAPI(
      <ThinkingProvider workspaceId={workspaceId}>
        <TestComponent workspaceId={workspaceId} />
      </ThinkingProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("low:ws-1");
    });

    // Migration should have populated the new workspace-scoped key.
    const persisted = window.localStorage.getItem(getThinkingLevelKey(workspaceId));
    expect(persisted).toBeTruthy();
    expect(JSON.parse(persisted!)).toBe("low");

    // Switching models should not change the workspace-scoped value.
    act(() => {
      updatePersistedState(getModelKey(workspaceId), "anthropic:claude-3.5");
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
