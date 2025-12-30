import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { AgentProvider } from "@/browser/contexts/AgentContext";
import { TooltipProvider } from "@/browser/components/ui/tooltip";
import { AgentModePicker } from "./AgentModePicker";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { getPinnedAgentIdKey } from "@/common/constants/storage";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";

const BUILT_INS: AgentDefinitionDescriptor[] = [
  {
    id: "exec",
    scope: "built-in",
    name: "Exec",
    uiSelectable: true,
    subagentRunnable: false,
    policyBase: "exec",
  },
  {
    id: "plan",
    scope: "built-in",
    name: "Plan",
    uiSelectable: true,
    subagentRunnable: false,
    policyBase: "plan",
  },
];

const HIDDEN_AGENT: AgentDefinitionDescriptor = {
  id: "explore",
  scope: "built-in",
  name: "Explore",
  uiSelectable: false,
  subagentRunnable: true,
  policyBase: "exec",
};
const CUSTOM_AGENT: AgentDefinitionDescriptor = {
  id: "review",
  scope: "project",
  name: "Review",
  description: "Review changes",
  uiSelectable: true,
  subagentRunnable: false,
  policyBase: "exec",
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
          }}
        >
          <TooltipProvider>
            <AgentModePicker workspaceId="ws-123" />
          </TooltipProvider>
        </AgentProvider>
      );
    }

    const { getByText } = render(<Harness />);

    // Regression: avoid "explore" -> "Explore" flicker while agents load.
    expect(getByText("Explore")).toBeTruthy();
  });

  test("Escape closes the picker without changing selection", async () => {
    function Harness() {
      const [agentId, setAgentId] = React.useState("plan");
      return (
        <AgentProvider
          value={{
            agentId,
            setAgentId,
            agents: [...BUILT_INS, CUSTOM_AGENT],
            loaded: true,
            loadFailed: false,
          }}
        >
          <TooltipProvider>
            <div>
              <div data-testid="agentId">{agentId}</div>
              <AgentModePicker workspaceId="ws-123" />
            </div>
          </TooltipProvider>
        </AgentProvider>
      );
    }

    const { getByPlaceholderText, getByTestId, queryByPlaceholderText } = render(<Harness />);

    // Simulate ModeContext opening the picker.
    window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_AGENT_PICKER));

    await waitFor(() => {
      expect(getByPlaceholderText("Search agents…")).toBeTruthy();
    });

    fireEvent.keyDown(getByPlaceholderText("Search agents…"), { key: "Escape" });

    // Escape should close the picker without changing the agent
    await waitFor(() => {
      expect(queryByPlaceholderText("Search agents…")).toBeNull();
    });

    expect(getByTestId("agentId").textContent).toBe("plan");
  });

  test("ArrowUp closes the picker without selecting an agent", async () => {
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
          }}
        >
          <TooltipProvider>
            <div>
              <div data-testid="agentId">{agentId}</div>
              <AgentModePicker workspaceId="ws-123" />
            </div>
          </TooltipProvider>
        </AgentProvider>
      );
    }

    const { getByPlaceholderText, getByTestId, getByLabelText, queryByPlaceholderText } = render(
      <Harness />
    );

    // Open the dropdown via the trigger button
    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(getByPlaceholderText("Search agents…")).toBeTruthy();
    });

    fireEvent.keyDown(getByPlaceholderText("Search agents…"), { key: "ArrowUp" });

    await waitFor(() => {
      expect(queryByPlaceholderText("Search agents…")).toBeNull();
    });

    expect(getByTestId("agentId").textContent).toBe("exec");
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
          }}
        >
          <TooltipProvider>
            <div>
              <div data-testid="agentId">{agentId}</div>
              <AgentModePicker workspaceId="ws-123" />
            </div>
          </TooltipProvider>
        </AgentProvider>
      );
    }

    const { getAllByText, getByLabelText, getByPlaceholderText } = render(<Harness />);

    // The trigger button should show the current agent name "Explore"
    const triggerButton = getByLabelText("Select agent");
    expect(triggerButton.textContent).toContain("Explore");

    // Open dropdown
    fireEvent.click(triggerButton);

    await waitFor(() => {
      expect(getByPlaceholderText("Search agents…")).toBeTruthy();
    });

    // Explore should not appear as a selectable option in the dropdown (only in trigger).
    // The text "Explore" appears once in trigger, so if dropdown opened it should still be just one.
    expect(getAllByText("Explore").length).toBe(1);
  });

  test("pins a custom agent and persists it in storage", async () => {
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
          }}
        >
          <TooltipProvider>
            <div>
              <div data-testid="agentId">{agentId}</div>
              <AgentModePicker workspaceId="ws-123" />
            </div>
          </TooltipProvider>
        </AgentProvider>
      );
    }

    const { getByPlaceholderText, getByTestId, getByText, getByLabelText } = render(<Harness />);

    // Open picker via dropdown trigger
    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(getByPlaceholderText("Search agents…")).toBeTruthy();
    });

    // Pick the custom agent -> should pin + select it.
    fireEvent.click(getByText("Review"));

    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("review");
    });

    const pinnedKey = getPinnedAgentIdKey("ws-123");
    expect(JSON.parse(window.localStorage.getItem(pinnedKey) ?? "null")).toBe("review");

    // Open dropdown again and select Exec.
    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(getByPlaceholderText("Search agents…")).toBeTruthy();
    });

    // Click on Exec row (use id "exec" to disambiguate)
    fireEvent.click(getByText("exec"));

    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("exec");
    });

    // Selecting a built-in agent should NOT clobber the pin.
    expect(JSON.parse(window.localStorage.getItem(pinnedKey) ?? "null")).toBe("review");
  });
});
