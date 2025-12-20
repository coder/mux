import { GlobalWindow } from "happy-dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { ThinkingProvider } from "./ThinkingContext";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { getModelKey, getThinkingLevelByModelKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";

// Mock useAPI to avoid requiring APIProvider in tests
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: null, status: "disconnected" as const, error: null }),
}));

// Setup basic DOM environment for testing-library
const dom = new GlobalWindow();
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
(global as any).window = dom.window;
(global as any).document = dom.window.document;

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

describe("ThinkingContext", () => {
  // Make getDefaultModel deterministic.
  // (getDefaultModel reads from the global "model-default" localStorage key.)
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("model-default", JSON.stringify("openai:default"));
  });

  afterEach(() => {
    cleanup();
  });

  test("switching models does not remount children", async () => {
    const workspaceId = "ws-1";

    updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.2");
    updatePersistedState(getThinkingLevelByModelKey("openai:gpt-5.2"), "high");
    updatePersistedState(getThinkingLevelByModelKey("anthropic:claude-3.5"), "low");

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

    const view = render(
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

    // Thinking is per-model, so switching models changes the thinking level.
    await waitFor(() => {
      expect(view.getByTestId("child").textContent).toBe("low");
    });

    expect(unmounts).toBe(0);
  });

  test("thinking level is per-model", async () => {
    const workspaceId = "ws-1";

    updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.2");
    updatePersistedState(getThinkingLevelByModelKey("openai:gpt-5.2"), "high");

    const view = render(
      <ThinkingProvider workspaceId={workspaceId}>
        <TestComponent workspaceId={workspaceId} />
      </ThinkingProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("high:ws-1");
    });

    // The per-model key should be used.
    const persisted = window.localStorage.getItem(getThinkingLevelByModelKey("openai:gpt-5.2"));
    expect(persisted).toBeTruthy();
    expect(JSON.parse(persisted!)).toBe("high");

    // Switching models should change thinking level to the new model's value.
    act(() => {
      updatePersistedState(getModelKey(workspaceId), "anthropic:claude-3.5");
    });

    // New model has no saved thinking level, should default to "off".
    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("off:ws-1");
    });
  });
});
