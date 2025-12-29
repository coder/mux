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

  test("when auto-opened via hotkey, Escape selects the pinned agent", async () => {
    const pinnedKey = getPinnedAgentIdKey("ws-123");
    window.localStorage.setItem(pinnedKey, JSON.stringify("review"));

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

    // Simulate ModeContext auto-opening the picker.
    window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_AGENT_PICKER));

    await waitFor(() => {
      expect(getByPlaceholderText("Search agents…")).toBeTruthy();
    });

    fireEvent.keyDown(getByPlaceholderText("Search agents…"), { key: "Escape" });

    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("review");
    });

    await waitFor(() => {
      expect(queryByPlaceholderText("Search agents…")).toBeNull();
    });
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

    const { getByPlaceholderText, getByTestId, getByText, queryByPlaceholderText } = render(
      <Harness />
    );

    fireEvent.click(getByText("Other…"));

    await waitFor(() => {
      expect(getByPlaceholderText("Search agents…")).toBeTruthy();
    });

    fireEvent.keyDown(getByPlaceholderText("Search agents…"), { key: "ArrowUp" });

    await waitFor(() => {
      expect(queryByPlaceholderText("Search agents…")).toBeNull();
    });

    expect(getByTestId("agentId").textContent).toBe("exec");
  });

  test("shows a non-selectable active agent in the segmented control", async () => {
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

    const { getAllByText, getByLabelText, getByPlaceholderText, getByText } = render(<Harness />);

    const exploreButton = getByText("Explore").closest("button");
    expect(exploreButton?.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(getByLabelText("Choose agent"));

    await waitFor(() => {
      expect(getByPlaceholderText("Search agents…")).toBeTruthy();
    });

    // Explore should not appear as a selectable option.
    expect(getAllByText("Explore").length).toBe(1);
  });

  test("pins a custom agent and keeps it available when switching back to Exec/Plan", async () => {
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

    const { getByPlaceholderText, getByTestId, getByText, getByLabelText, queryByText } = render(
      <Harness />
    );

    // Open picker via "Other…".
    fireEvent.click(getByText("Other…"));

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

    // Switch back to Exec.
    fireEvent.click(getByText("Exec"));
    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("exec");
    });

    // Pinned label should still be visible.
    expect(getByText("Review")).toBeTruthy();

    // Clicking the pinned button should select it.
    fireEvent.click(getByText("Review"));
    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("review");
    });

    // Opening the picker and selecting Exec should NOT clobber the pin.
    fireEvent.click(getByLabelText("Choose agent"));

    await waitFor(() => {
      expect(getByPlaceholderText("Search agents…")).toBeTruthy();
    });

    // Disambiguate from the segmented-control "Exec" button by clicking the dropdown's id label.
    fireEvent.click(getByText("exec"));

    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("exec");
    });

    expect(JSON.parse(window.localStorage.getItem(pinnedKey) ?? "null")).toBe("review");

    // Still shows the pinned quick option.
    expect(queryByText("Review")).toBeTruthy();
  });
});
