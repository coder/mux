import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { AgentProvider } from "@/browser/contexts/AgentContext";
import { TooltipProvider } from "@/browser/components/ui/tooltip";
import { AgentModePicker } from "./AgentModePicker";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";

const AUTO_AGENT: AgentDefinitionDescriptor = {
  id: "auto",
  scope: "built-in",
  name: "Auto",
  uiSelectable: true,
  subagentRunnable: false,
  uiColor: "var(--color-auto-mode)",
};

const BUILT_INS: AgentDefinitionDescriptor[] = [
  {
    id: "exec",
    scope: "built-in",
    name: "Exec",
    uiSelectable: true,
    subagentRunnable: false,
  },
  {
    id: "plan",
    scope: "built-in",
    name: "Plan",
    uiSelectable: true,
    subagentRunnable: false,
    base: "plan",
  },
];

const HIDDEN_AGENT: AgentDefinitionDescriptor = {
  id: "explore",
  scope: "built-in",
  name: "Explore",
  uiSelectable: false,
  subagentRunnable: true,
  base: "exec",
};
const CUSTOM_AGENT: AgentDefinitionDescriptor = {
  id: "review",
  scope: "project",
  name: "Review",
  description: "Review changes",
  uiSelectable: true,
  subagentRunnable: false,
};

// Default context value properties shared by all test harnesses
const noop = () => {
  // intentional noop for tests
};
const defaultContextProps = {
  currentAgent: undefined,
  disableWorkspaceAgents: false,
  setDisableWorkspaceAgents: noop,
};

describe("AgentModePicker", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
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

  test("shows a non-selectable active agent in the dropdown trigger", async () => {
    function Harness() {
      const [agentId, setAgentId] = React.useState("explore");
      return (
        <AgentProvider
          value={{
            agentId,
            setAgentId,
            agents: [...BUILT_INS, HIDDEN_AGENT, CUSTOM_AGENT],
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

    const { getAllByText, getByLabelText, getAllByTestId } = render(<Harness />);

    // The trigger button should show the current agent name "Explore"
    const triggerButton = getByLabelText("Select agent");
    expect(triggerButton.textContent).toContain("Explore");

    // Open dropdown
    fireEvent.click(triggerButton);

    await waitFor(() => {
      expect(getAllByTestId("agent-option").length).toBeGreaterThan(0);
    });

    // Explore should not appear as a selectable option in the dropdown (only in trigger).
    expect(getAllByText("Explore").length).toBe(1);
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

  test("toggling auto-select switch on sets agentId to auto", async () => {
    function Harness() {
      const [agentId, setAgentId] = React.useState("exec");
      return (
        <AgentProvider
          value={{
            agentId,
            setAgentId,
            agents: [...BUILT_INS, AUTO_AGENT],
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

    const { getByTestId, getByLabelText, getByText } = render(<Harness />);

    // Start with exec
    expect(getByTestId("agentId").textContent).toBe("exec");

    // Open picker
    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(getByText("Auto")).toBeTruthy();
    });

    // Click the auto toggle area
    fireEvent.click(getByText("Auto"));

    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("auto");
    });
  });

  test("toggling auto-select switch off defaults to exec", async () => {
    function Harness() {
      const [agentId, setAgentId] = React.useState("auto");
      return (
        <AgentProvider
          value={{
            agentId,
            setAgentId,
            agents: [...BUILT_INS, AUTO_AGENT],
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

    const { getByTestId, getByLabelText } = render(<Harness />);

    // Start with auto
    expect(getByTestId("agentId").textContent).toBe("auto");

    // Open picker
    fireEvent.click(getByLabelText("Select agent"));

    // The trigger also shows "Auto" so use the Switch's aria-label to
    // uniquely target the toggle inside the dropdown.
    await waitFor(() => {
      expect(getByLabelText("Auto-select agent")).toBeTruthy();
    });

    // Click the Switch to turn auto off
    fireEvent.click(getByLabelText("Auto-select agent"));

    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("exec");
    });
  });

  test("clicking a specific agent while auto is on switches to that agent", async () => {
    function Harness() {
      const [agentId, setAgentId] = React.useState("auto");
      return (
        <AgentProvider
          value={{
            agentId,
            setAgentId,
            agents: [...BUILT_INS, AUTO_AGENT],
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

    // Start with auto
    expect(getByTestId("agentId").textContent).toBe("auto");

    // Open picker
    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(getByText("Plan")).toBeTruthy();
    });

    // Click Plan agent directly — should switch away from auto
    fireEvent.click(getByText("Plan"));

    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("plan");
    });
  });

  test("numbered quick-select while auto is active switches to exec", async () => {
    function Harness() {
      const [agentId, setAgentId] = React.useState("auto");
      return (
        <AgentProvider
          value={{
            agentId,
            setAgentId,
            agents: [...BUILT_INS, AUTO_AGENT],
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

    expect(getByTestId("agentId").textContent).toBe("auto");

    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(getByText("Plan")).toBeTruthy();
    });

    fireEvent.keyDown(window, {
      key: "1",
      ctrlKey: true,
      metaKey: true,
    });

    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("exec");
    });
  });
});
