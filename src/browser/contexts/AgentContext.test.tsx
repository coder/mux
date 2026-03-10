import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { GLOBAL_SCOPE_ID, getAgentIdKey, getProjectScopeId } from "@/common/constants/storage";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { ProjectProvider } from "./ProjectContext";
import { RouterProvider } from "./RouterContext";
import { WorkspaceProvider } from "./WorkspaceContext";
import { useWorkspaceStoreRaw as getWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";

let mockAgentDefinitions: AgentDefinitionDescriptor[] = [];
let mockWorkspaceMetadata = new Map<string, { parentWorkspaceId?: string; agentId?: string }>();

import { AgentProvider, useAgent, type AgentContextValue } from "./AgentContext";

const AUTO_AGENT: AgentDefinitionDescriptor = {
  id: "auto",
  scope: "built-in",
  name: "Auto",
  uiSelectable: true,
  uiRoutable: true,
  subagentRunnable: false,
};

const EXEC_AGENT: AgentDefinitionDescriptor = {
  id: "exec",
  scope: "built-in",
  name: "Exec",
  uiSelectable: true,
  uiRoutable: true,
  subagentRunnable: false,
};

const PLAN_AGENT: AgentDefinitionDescriptor = {
  id: "plan",
  scope: "built-in",
  name: "Plan",
  uiSelectable: true,
  uiRoutable: true,
  subagentRunnable: false,
};

const LOCKED_AGENT: AgentDefinitionDescriptor = {
  id: "mux",
  scope: "built-in",
  name: "Mux",
  uiSelectable: false,
  uiRoutable: true,
  subagentRunnable: false,
};

interface HarnessProps {
  onChange: (value: AgentContextValue) => void;
}

function Harness(props: HarnessProps) {
  const value = useAgent();

  React.useEffect(() => {
    props.onChange(value);
  }, [props, value]);

  return null;
}

function createWorkspaceMetadata(
  workspaceId: string,
  overrides: { parentWorkspaceId?: string; agentId?: string } = {}
): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    projectPath: "/tmp/project",
    projectName: "project",
    name: "main",
    namedWorkspacePath: `/tmp/project/${workspaceId}`,
    createdAt: "2025-01-01T00:00:00.000Z",
    runtimeConfig: { type: "local", srcBaseDir: "/tmp/.mux/src" },
    ...overrides,
  };
}

function createEmptyAsyncIterable<T>(): AsyncIterable<T> {
  return (async function* () {
    await Promise.resolve();
  })();
}

function createApiClient(): APIClient {
  const workspaceMetadata = Array.from(
    mockWorkspaceMetadata.entries(),
    ([workspaceId, overrides]) => createWorkspaceMetadata(workspaceId, overrides)
  );

  return {
    agents: {
      list: () => Promise.resolve(mockAgentDefinitions),
    },
    workspace: {
      list: () => Promise.resolve(workspaceMetadata),
      onMetadata: async () => createEmptyAsyncIterable(),
      onChat: async () => createEmptyAsyncIterable(),
      getSessionUsage: () => Promise.resolve(undefined),
      activity: {
        list: () => Promise.resolve({}),
        subscribe: async () => createEmptyAsyncIterable(),
      },
      truncateHistory: () => Promise.resolve({ success: true as const, data: undefined }),
      interruptStream: () => Promise.resolve({ success: true as const, data: undefined }),
    },
    projects: {
      list: () => Promise.resolve([]),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
      },
    },
    server: {
      getLaunchProject: () => Promise.resolve(null),
    },
    terminal: {
      openWindow: () => Promise.resolve(),
    },
  } as unknown as APIClient;
}

function renderAgentHarness(props: {
  projectPath: string;
  workspaceId?: string;
  onChange: (value: AgentContextValue) => void;
}) {
  return render(
    <APIProvider client={createApiClient()}>
      <RouterProvider>
        <ProjectProvider>
          <WorkspaceProvider>
            <AgentProvider workspaceId={props.workspaceId} projectPath={props.projectPath}>
              <Harness onChange={props.onChange} />
            </AgentProvider>
          </WorkspaceProvider>
        </ProjectProvider>
      </RouterProvider>
    </APIProvider>
  );
}

describe("AgentContext", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(() => {
    mockAgentDefinitions = [];
    mockWorkspaceMetadata = new Map();

    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;

    const dom = new GlobalWindow();
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.localStorage = dom.localStorage as unknown as Storage;
    window.api = {
      platform: "darwin",
      versions: {},
      consumePendingDeepLinks: () => [],
      onDeepLink: () => () => undefined,
    };
  });

  afterEach(() => {
    cleanup();
    getWorkspaceStoreRaw().dispose();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  });

  test("project-scoped agent falls back to global default when project preference is unset", async () => {
    const projectPath = "/tmp/project";
    window.localStorage.setItem(getAgentIdKey(GLOBAL_SCOPE_ID), JSON.stringify("ask"));

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({ projectPath, onChange: (value) => (contextValue = value) });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("ask");
    });
  });

  test("project-scoped preference takes precedence over global default", async () => {
    const projectPath = "/tmp/project";
    window.localStorage.setItem(getAgentIdKey(GLOBAL_SCOPE_ID), JSON.stringify("ask"));
    window.localStorage.setItem(
      getAgentIdKey(getProjectScopeId(projectPath)),
      JSON.stringify("plan")
    );

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({ projectPath, onChange: (value) => (contextValue = value) });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("plan");
    });
  });

  test("cycle shortcut switches from auto to exec", async () => {
    const projectPath = "/tmp/project";
    mockAgentDefinitions = [AUTO_AGENT, EXEC_AGENT, PLAN_AGENT];
    window.localStorage.setItem(getAgentIdKey(GLOBAL_SCOPE_ID), JSON.stringify("auto"));

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({ projectPath, onChange: (value) => (contextValue = value) });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("auto");
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["auto", "exec", "plan"]);
    });

    window.api = { platform: "darwin", versions: {} };

    fireEvent.keyDown(window, {
      key: ".",
      ctrlKey: true,
      metaKey: true,
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });
  });

  test("cycle shortcut exits auto even when only one manual agent is available", async () => {
    const projectPath = "/tmp/project";
    mockAgentDefinitions = [AUTO_AGENT, EXEC_AGENT];
    window.localStorage.setItem(getAgentIdKey(GLOBAL_SCOPE_ID), JSON.stringify("auto"));

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({ projectPath, onChange: (value) => (contextValue = value) });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("auto");
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["auto", "exec"]);
    });

    window.api = { platform: "darwin", versions: {} };

    fireEvent.keyDown(window, {
      key: ".",
      ctrlKey: true,
      metaKey: true,
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });
  });

  test("shortcut actions do not override a locked workspace agent", async () => {
    const projectPath = "/tmp/project";
    mockAgentDefinitions = [AUTO_AGENT, EXEC_AGENT, PLAN_AGENT];
    mockWorkspaceMetadata.set(MUX_HELP_CHAT_WORKSPACE_ID, { agentId: "mux" });
    window.localStorage.setItem(getAgentIdKey(MUX_HELP_CHAT_WORKSPACE_ID), JSON.stringify("exec"));

    let contextValue: AgentContextValue | undefined;
    let openPickerEvents = 0;
    const handleOpenPicker = () => {
      openPickerEvents += 1;
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_AGENT_PICKER, handleOpenPicker as EventListener);

    try {
      renderAgentHarness({
        workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
        projectPath,
        onChange: (value) => (contextValue = value),
      });

      await waitFor(() => {
        // Backend-assigned agent overrides stale localStorage in locked workspaces.
        expect(contextValue?.agentId).toBe("mux");
      });

      window.api = { platform: "darwin", versions: {} };

      // Open picker shortcut should no-op for locked workspaces.
      fireEvent.keyDown(window, {
        key: "A",
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
      });

      // Cycle + toggle-auto should no-op as well.
      fireEvent.keyDown(window, {
        key: ".",
        ctrlKey: true,
        metaKey: true,
      });
      fireEvent.keyDown(window, {
        key: ">",
        code: "Period",
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
      });

      await waitFor(() => {
        expect(contextValue?.agentId).toBe("mux");
      });
      expect(openPickerEvents).toBe(0);
    } finally {
      window.removeEventListener(
        CUSTOM_EVENTS.OPEN_AGENT_PICKER,
        handleOpenPicker as EventListener
      );
    }
  });

  test("non-selectable agent in mutable workspace does not block shortcut actions", async () => {
    const projectPath = "/tmp/project";
    mockAgentDefinitions = [LOCKED_AGENT, AUTO_AGENT, EXEC_AGENT, PLAN_AGENT];
    window.localStorage.setItem(
      getAgentIdKey(getProjectScopeId(projectPath)),
      JSON.stringify("mux")
    );

    let contextValue: AgentContextValue | undefined;
    let openPickerEvents = 0;
    const handleOpenPicker = () => {
      openPickerEvents += 1;
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_AGENT_PICKER, handleOpenPicker as EventListener);

    try {
      renderAgentHarness({ projectPath, onChange: (value) => (contextValue = value) });

      await waitFor(() => {
        expect(contextValue?.agentId).toBe("mux");
      });

      window.api = { platform: "darwin", versions: {} };

      fireEvent.keyDown(window, {
        key: "A",
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
      });

      fireEvent.keyDown(window, {
        key: ".",
        ctrlKey: true,
        metaKey: true,
      });

      await waitFor(() => {
        expect(contextValue?.agentId).toBe("exec");
      });
      expect(openPickerEvents).toBe(1);
    } finally {
      window.removeEventListener(
        CUSTOM_EVENTS.OPEN_AGENT_PICKER,
        handleOpenPicker as EventListener
      );
    }
  });

  test("toggle auto shortcut switches between manual and auto", async () => {
    const projectPath = "/tmp/project";
    mockAgentDefinitions = [AUTO_AGENT, EXEC_AGENT, PLAN_AGENT];
    window.localStorage.setItem(getAgentIdKey(GLOBAL_SCOPE_ID), JSON.stringify("exec"));

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({ projectPath, onChange: (value) => (contextValue = value) });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });

    window.api = { platform: "darwin", versions: {} };

    fireEvent.keyDown(window, {
      key: ">",
      code: "Period",
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("auto");
    });

    fireEvent.keyDown(window, {
      key: ">",
      code: "Period",
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });
  });
});
