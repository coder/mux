import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { AgentProvider, type AgentContextValue } from "@/browser/contexts/AgentContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { AgentModePicker } from "../AgentModePicker/AgentModePicker";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";

const BUILT_INS: AgentDefinitionDescriptor[] = [
  {
    id: "exec",
    scope: "built-in",
    name: "Exec",
    uiSelectable: true,
    uiRoutable: true,
    subagentRunnable: false,
  },
  {
    id: "plan",
    scope: "built-in",
    name: "Plan",
    uiSelectable: true,
    uiRoutable: true,
    subagentRunnable: false,
    base: "plan",
  },
];

const HIDDEN_AGENT: AgentDefinitionDescriptor = {
  id: "explore",
  scope: "built-in",
  name: "Explore",
  uiSelectable: false,
  uiRoutable: false,
  subagentRunnable: true,
  base: "exec",
};
const CUSTOM_AGENT: AgentDefinitionDescriptor = {
  id: "review",
  scope: "project",
  name: "Review",
  description: "Review changes",
  uiSelectable: true,
  uiRoutable: true,
  subagentRunnable: false,
};

// Default context value properties shared by all test harnesses
const noop = () => {
  // intentional noop for tests
};
const defaultContextProps = {
  currentAgent: undefined,
  isAgentSelectionLocked: false,
  disableWorkspaceAgents: false,
  setDisableWorkspaceAgents: noop,
};

let cleanupDom: (() => void) | null = null;

describe("AgentModePicker", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders a stable label for explore before agent definitions load", () => {
    function Harness() {
      const [agentId, setAgentId] = React.useState("explore");
      return (
        <AgentProvider
          value={{
            agentId,
            setAgentId,
            agents: [],
            loaded: false,
            loadFailed: false,
            refresh: () => Promise.resolve(),
            refreshing: false,
            ...defaultContextProps,
          }}
        >
          <TooltipProvider>
            <AgentModePicker />
          </TooltipProvider>
        </AgentProvider>
      );
    }

    const { getByText } = render(<Harness />);

    // Regression: avoid "explore" -> "Explore" flicker while agents load.
    expect(getByText("Explore")).toBeTruthy();
  });

  test("locks the picker when workspace agent selection is locked", () => {
    function Harness() {
      const [agentId, setAgentId] = React.useState("exec");
      const contextValue: AgentContextValue & { isAgentSelectionLocked?: boolean } = {
        agentId,
        setAgentId,
        agents: [...BUILT_INS, HIDDEN_AGENT, CUSTOM_AGENT],
        loaded: true,
        loadFailed: false,
        refresh: () => Promise.resolve(),
        refreshing: false,
        ...defaultContextProps,
        currentAgent: BUILT_INS[0],
        isAgentSelectionLocked: true,
      };

      return (
        <AgentProvider value={contextValue}>
          <TooltipProvider>
            <div>
              <div data-testid="agentId">{agentId}</div>
              <AgentModePicker />
            </div>
          </TooltipProvider>
        </AgentProvider>
      );
    }

    const { getByLabelText, queryAllByTestId } = render(<Harness />);

    const triggerButton = getByLabelText("Select agent") as HTMLButtonElement;
    expect(triggerButton.textContent).toContain("Exec");
    expect(triggerButton.disabled).toBe(true);

    fireEvent.click(triggerButton);
    expect(queryAllByTestId("agent-option").length).toBe(0);
  });

  test("uiSelectable false without lock flag does not disable the picker", async () => {
    function Harness() {
      const [agentId, setAgentId] = React.useState("explore");
      const contextValue: AgentContextValue & { isAgentSelectionLocked?: boolean } = {
        agentId,
        setAgentId,
        agents: [...BUILT_INS, HIDDEN_AGENT, CUSTOM_AGENT],
        loaded: true,
        loadFailed: false,
        refresh: () => Promise.resolve(),
        refreshing: false,
        ...defaultContextProps,
        currentAgent: HIDDEN_AGENT,
      };

      return (
        <AgentProvider value={contextValue}>
          <TooltipProvider>
            <div>
              <div data-testid="agentId">{agentId}</div>
              <AgentModePicker />
            </div>
          </TooltipProvider>
        </AgentProvider>
      );
    }

    const { getByLabelText, queryAllByTestId } = render(<Harness />);

    const triggerButton = getByLabelText("Select agent") as HTMLButtonElement;
    expect(triggerButton.textContent).toContain("Explore");
    expect(triggerButton.disabled).toBe(false);

    fireEvent.click(triggerButton);

    await waitFor(() => {
      expect(queryAllByTestId("agent-option").length).toBeGreaterThan(0);
    });
  });

  test("selects a custom agent from the dropdown", async () => {
    function Harness() {
      const [agentId, setAgentId] = React.useState("exec");
      return (
        <AgentProvider
          value={{
            agentId,
            setAgentId,
            agents: [...BUILT_INS, CUSTOM_AGENT],
            loaded: true,
            loadFailed: false,
            refresh: () => Promise.resolve(),
            refreshing: false,
            ...defaultContextProps,
          }}
        >
          <TooltipProvider>
            <div>
              <div data-testid="agentId">{agentId}</div>
              <AgentModePicker />
            </div>
          </TooltipProvider>
        </AgentProvider>
      );
    }

    const { getByTestId, getByText, getByLabelText } = render(<Harness />);

    // Open picker via dropdown trigger
    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(getByText("Review")).toBeTruthy();
    });

    // Pick the custom agent
    fireEvent.click(getByText("Review"));

    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("review");
    });
  });

  test("does not render auto agent affordances", async () => {
    function Harness() {
      const [agentId, setAgentId] = React.useState("exec");
      return (
        <AgentProvider
          value={{
            agentId,
            setAgentId,
            agents: [...BUILT_INS, CUSTOM_AGENT],
            loaded: true,
            loadFailed: false,
            refresh: () => Promise.resolve(),
            refreshing: false,
            ...defaultContextProps,
          }}
        >
          <TooltipProvider>
            <AgentModePicker />
          </TooltipProvider>
        </AgentProvider>
      );
    }

    const { getByLabelText, queryByLabelText, queryByText } = render(<Harness />);
    const autoSelectLabel = ["Auto-select", "agent"].join(" ");

    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(queryByLabelText(autoSelectLabel)).toBeNull();
      expect(queryByText("Mux chooses the best agent")).toBeNull();
    });
  });
});
