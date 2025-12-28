import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { AgentProvider } from "@/browser/contexts/AgentContext";
import { TooltipProvider } from "@/browser/components/ui/tooltip";
import { AgentModePicker } from "./AgentModePicker";
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
