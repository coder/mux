import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { GLOBAL_SCOPE_ID, getAgentIdKey, getProjectScopeId } from "@/common/constants/storage";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";

interface AgentsListInput {
  projectPath?: string;
  workspaceId?: string;
  disableWorkspaceAgents?: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  if (!resolve || !reject) {
    throw new Error("failed to create deferred promise");
  }

  return { promise, resolve, reject };
}

function createAgent(id: string, name: string): AgentDefinitionDescriptor {
  return {
    id,
    scope: "built-in",
    name,
    uiSelectable: true,
    subagentRunnable: false,
  };
}

const listAgentsMock = mock((_input: AgentsListInput) =>
  Promise.resolve<AgentDefinitionDescriptor[]>([])
);
let currentApiMock: { agents: { list: typeof listAgentsMock } } | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: currentApiMock,
    status: currentApiMock ? ("connected" as const) : ("connecting" as const),
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { AgentProvider, useAgent, type AgentContextValue } from "./AgentContext";

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
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;

    const dom = new GlobalWindow();
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.localStorage = dom.localStorage as unknown as Storage;

    listAgentsMock.mockReset();
    listAgentsMock.mockImplementation((_input: AgentsListInput) =>
      Promise.resolve<AgentDefinitionDescriptor[]>([])
    );
    currentApiMock = null;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    currentApiMock = null;
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

  test("uses workspace cache when revisiting a workspace while refetch is pending", async () => {
    const projectPath = "/tmp/project-cache";
    const latestByWorkspace = new Map<string, AgentDefinitionDescriptor[]>([
      ["ws-a", [createAgent("exec", "Exec")]],
      ["ws-b", [createAgent("plan", "Plan")]],
    ]);
    const pendingByWorkspace = new Map<string, Deferred<AgentDefinitionDescriptor[]>>();

    listAgentsMock.mockImplementation((input: AgentsListInput) => {
      const workspaceId = input.workspaceId;
      if (!workspaceId) {
        return Promise.resolve<AgentDefinitionDescriptor[]>([]);
      }

      const pending = pendingByWorkspace.get(workspaceId);
      if (pending) {
        return pending.promise;
      }

      return Promise.resolve(latestByWorkspace.get(workspaceId) ?? []);
    });

    currentApiMock = {
      agents: {
        list: listAgentsMock,
      },
    };

    let contextValue: AgentContextValue | undefined;
    const { rerender } = render(
      <AgentProvider workspaceId="ws-a" projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["exec"]);
    });

    rerender(
      <AgentProvider workspaceId="ws-b" projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["plan"]);
    });

    latestByWorkspace.set("ws-a", [createAgent("ask", "Ask")]);
    const wsADeferred = createDeferred<AgentDefinitionDescriptor[]>();
    pendingByWorkspace.set("ws-a", wsADeferred);

    rerender(
      <AgentProvider workspaceId="ws-a" projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(listAgentsMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["exec"]);
    });

    pendingByWorkspace.delete("ws-a");
    wsADeferred.resolve(latestByWorkspace.get("ws-a") ?? []);

    await waitFor(() => {
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["ask"]);
    });
  });

  test("uses project cache for first render in a sibling workspace", async () => {
    const projectPath = "/tmp/project-fallback";
    const latestByWorkspace = new Map<string, AgentDefinitionDescriptor[]>([
      ["ws-a", [createAgent("exec", "Exec")]],
      ["ws-b", [createAgent("plan", "Plan")]],
    ]);
    const pendingByWorkspace = new Map<string, Deferred<AgentDefinitionDescriptor[]>>();

    listAgentsMock.mockImplementation((input: AgentsListInput) => {
      const workspaceId = input.workspaceId;
      if (!workspaceId) {
        return Promise.resolve<AgentDefinitionDescriptor[]>([]);
      }

      const pending = pendingByWorkspace.get(workspaceId);
      if (pending) {
        return pending.promise;
      }

      return Promise.resolve(latestByWorkspace.get(workspaceId) ?? []);
    });

    currentApiMock = {
      agents: {
        list: listAgentsMock,
      },
    };

    let contextValue: AgentContextValue | undefined;
    const { rerender } = render(
      <AgentProvider workspaceId="ws-a" projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["exec"]);
    });

    const wsBDeferred = createDeferred<AgentDefinitionDescriptor[]>();
    pendingByWorkspace.set("ws-b", wsBDeferred);

    rerender(
      <AgentProvider workspaceId="ws-b" projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(
        listAgentsMock.mock.calls.some(
          ([input]: [AgentsListInput, ...unknown[]]) => input.workspaceId === "ws-b"
        )
      ).toBe(true);
      expect(contextValue?.loaded).toBe(false);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["exec"]);
      expect(contextValue?.agents.every((agent) => !agent.uiSelectable)).toBe(true);
    });

    pendingByWorkspace.delete("ws-b");
    wsBDeferred.resolve(latestByWorkspace.get("ws-b") ?? []);

    await waitFor(() => {
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["plan"]);
      expect(contextValue?.agents.every((agent) => agent.uiSelectable)).toBe(true);
    });
  });

  test("does not hydrate project scope from workspace-sourced project cache", async () => {
    const projectPath = "/tmp/project-scope-cache";
    const projectScopeKey = "__project__";
    const pendingByScope = new Map<string, Deferred<AgentDefinitionDescriptor[]>>();

    listAgentsMock.mockImplementation((input: AgentsListInput) => {
      const scopeKey = input.workspaceId ?? projectScopeKey;
      const pending = pendingByScope.get(scopeKey);
      if (pending) {
        return pending.promise;
      }

      if (scopeKey === "ws-a") {
        return Promise.resolve([createAgent("exec", "Exec")]);
      }

      return Promise.resolve([createAgent("ask", "Ask")]);
    });

    currentApiMock = {
      agents: {
        list: listAgentsMock,
      },
    };

    let contextValue: AgentContextValue | undefined;
    const { rerender } = render(
      <AgentProvider workspaceId="ws-a" projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["exec"]);
    });

    const projectDeferred = createDeferred<AgentDefinitionDescriptor[]>();
    pendingByScope.set(projectScopeKey, projectDeferred);

    rerender(
      <AgentProvider projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(
        listAgentsMock.mock.calls.some(
          ([input]: [AgentsListInput, ...unknown[]]) =>
            input.projectPath === projectPath && input.workspaceId === undefined
        )
      ).toBe(true);
      expect(contextValue?.loaded).toBe(false);
      expect(contextValue?.agents.length).toBe(0);
    });

    pendingByScope.delete(projectScopeKey);
    projectDeferred.resolve([createAgent("ask", "Ask")]);

    await waitFor(() => {
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["ask"]);
    });
  });

  test("keeps project-sourced fallback selectable in workspace scope", async () => {
    const projectPath = "/tmp/project-fallback-selectable";
    const projectScopeKey = "__project__";
    const pendingByScope = new Map<string, Deferred<AgentDefinitionDescriptor[]>>();

    listAgentsMock.mockImplementation((input: AgentsListInput) => {
      const scopeKey = input.workspaceId ?? projectScopeKey;
      const pending = pendingByScope.get(scopeKey);
      if (pending) {
        return pending.promise;
      }

      if (scopeKey === projectScopeKey) {
        return Promise.resolve([createAgent("exec", "Exec")]);
      }

      return Promise.resolve([createAgent("plan", "Plan")]);
    });

    currentApiMock = {
      agents: {
        list: listAgentsMock,
      },
    };

    let contextValue: AgentContextValue | undefined;
    const { rerender } = render(
      <AgentProvider projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["exec"]);
      expect(contextValue?.agents.every((agent) => agent.uiSelectable)).toBe(true);
    });

    const workspaceDeferred = createDeferred<AgentDefinitionDescriptor[]>();
    pendingByScope.set("ws-a", workspaceDeferred);

    rerender(
      <AgentProvider workspaceId="ws-a" projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(
        listAgentsMock.mock.calls.some(
          ([input]: [AgentsListInput, ...unknown[]]) =>
            input.projectPath === projectPath && input.workspaceId === "ws-a"
        )
      ).toBe(true);
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["exec"]);
      expect(contextValue?.agents.every((agent) => agent.uiSelectable)).toBe(true);
    });

    pendingByScope.delete("ws-a");
    workspaceDeferred.resolve([createAgent("plan", "Plan")]);

    await waitFor(() => {
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["plan"]);
      expect(contextValue?.agents.every((agent) => agent.uiSelectable)).toBe(true);
    });
  });

  test("does not reuse workspace cache across projects sharing a workspace id", async () => {
    const workspaceId = "ws-shared";
    const projectOne = "/tmp/project-one";
    const projectTwo = "/tmp/project-two";
    const latestByScope = new Map<string, AgentDefinitionDescriptor[]>([
      [`${projectOne}|${workspaceId}`, [createAgent("exec", "Exec")]],
      [`${projectTwo}|${workspaceId}`, [createAgent("plan", "Plan")]],
    ]);
    const pendingByScope = new Map<string, Deferred<AgentDefinitionDescriptor[]>>();

    listAgentsMock.mockImplementation((input: AgentsListInput) => {
      if (!input.workspaceId) {
        return Promise.resolve<AgentDefinitionDescriptor[]>([]);
      }

      const cacheScopeKey = `${input.projectPath ?? ""}|${input.workspaceId}`;
      const pending = pendingByScope.get(cacheScopeKey);
      if (pending) {
        return pending.promise;
      }

      return Promise.resolve(latestByScope.get(cacheScopeKey) ?? []);
    });

    currentApiMock = {
      agents: {
        list: listAgentsMock,
      },
    };

    let contextValue: AgentContextValue | undefined;
    const { rerender } = render(
      <AgentProvider workspaceId={workspaceId} projectPath={projectOne}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["exec"]);
    });

    const projectTwoScopeKey = `${projectTwo}|${workspaceId}`;
    const projectTwoDeferred = createDeferred<AgentDefinitionDescriptor[]>();
    pendingByScope.set(projectTwoScopeKey, projectTwoDeferred);

    rerender(
      <AgentProvider workspaceId={workspaceId} projectPath={projectTwo}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(
        listAgentsMock.mock.calls.some(
          ([input]: [AgentsListInput, ...unknown[]]) =>
            input.projectPath === projectTwo && input.workspaceId === workspaceId
        )
      ).toBe(true);
      expect(contextValue?.loaded).toBe(false);
      expect(contextValue?.agents.length).toBe(0);
    });

    pendingByScope.delete(projectTwoScopeKey);
    projectTwoDeferred.resolve(latestByScope.get(projectTwoScopeKey) ?? []);

    await waitFor(() => {
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["plan"]);
    });
  });

  test("cycle-agent keybind skips auto and rotates only manual agents", async () => {
    const projectPath = "/tmp/project-cycle";

    listAgentsMock.mockImplementation((input: AgentsListInput) => {
      if (input.workspaceId !== "ws-cycle") {
        return Promise.resolve<AgentDefinitionDescriptor[]>([]);
      }

      return Promise.resolve<AgentDefinitionDescriptor[]>([
        createAgent("exec", "Exec"),
        createAgent("plan", "Plan"),
        createAgent("auto", "Auto"),
      ]);
    });

    currentApiMock = {
      agents: {
        list: listAgentsMock,
      },
    };

    window.localStorage.setItem(getAgentIdKey("ws-cycle"), JSON.stringify("exec"));

    let contextValue: AgentContextValue | undefined;

    render(
      <AgentProvider workspaceId="ws-cycle" projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agentId).toBe("exec");
    });

    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: ".", ctrlKey: true }));

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("plan");
    });

    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: ".", ctrlKey: true }));

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
      expect(contextValue?.agentId).not.toBe("auto");
    });
  });

  test("cycle-agent keybind exits auto when only one manual agent is available", async () => {
    const projectPath = "/tmp/project-cycle-single";

    listAgentsMock.mockImplementation((input: AgentsListInput) => {
      if (input.workspaceId !== "ws-cycle-single") {
        return Promise.resolve<AgentDefinitionDescriptor[]>([]);
      }

      return Promise.resolve<AgentDefinitionDescriptor[]>([
        createAgent("exec", "Exec"),
        createAgent("auto", "Auto"),
      ]);
    });

    currentApiMock = {
      agents: {
        list: listAgentsMock,
      },
    };

    window.localStorage.setItem(getAgentIdKey("ws-cycle-single"), JSON.stringify("auto"));

    let contextValue: AgentContextValue | undefined;

    render(
      <AgentProvider workspaceId="ws-cycle-single" projectPath={projectPath}>
        <Harness onChange={(value) => (contextValue = value)} />
      </AgentProvider>
    );

    await waitFor(() => {
      expect(contextValue?.loaded).toBe(true);
      expect(contextValue?.agentId).toBe("auto");
    });

    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: ".", ctrlKey: true }));

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });
  });
});
