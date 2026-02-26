import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { GLOBAL_SCOPE_ID, getAgentIdKey, getProjectScopeId } from "@/common/constants/storage";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";

let mockAgentDefinitions: AgentDefinitionDescriptor[] = [];
const apiClient = {
  agents: {
    list: () => Promise.resolve(mockAgentDefinitions),
  },
};

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: apiClient,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { AgentProvider, useAgent, type AgentContextValue } from "./AgentContext";

const AUTO_AGENT: AgentDefinitionDescriptor = {
  id: "auto",
  scope: "built-in",
  name: "Auto",
  uiSelectable: true,
  subagentRunnable: false,
};

const EXEC_AGENT: AgentDefinitionDescriptor = {
  id: "exec",
  scope: "built-in",
  name: "Exec",
  uiSelectable: true,
  subagentRunnable: false,
};

const PLAN_AGENT: AgentDefinitionDescriptor = {
  id: "plan",
  scope: "built-in",
  name: "Plan",
  uiSelectable: true,
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

describe("AgentContext", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(() => {
    mockAgentDefinitions = [];

    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;

    const dom = new GlobalWindow();
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.localStorage = dom.localStorage as unknown as Storage;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  });

  test("project-scoped agent falls back to global default when project preference is unset", async () => {
    const projectPath = "/tmp/project";
    window.localStorage.setItem(getAgentIdKey(GLOBAL_SCOPE_ID), JSON.stringify("ask"));

    let contextValue: AgentContextValue | undefined;

    render(
      <AgentProvider projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

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

    render(
      <AgentProvider projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("plan");
    });
  });

  test("cycle shortcut switches from auto to exec", async () => {
    const projectPath = "/tmp/project";
    mockAgentDefinitions = [AUTO_AGENT, EXEC_AGENT, PLAN_AGENT];
    window.localStorage.setItem(getAgentIdKey(GLOBAL_SCOPE_ID), JSON.stringify("auto"));

    let contextValue: AgentContextValue | undefined;

    render(
      <AgentProvider projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

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
});
