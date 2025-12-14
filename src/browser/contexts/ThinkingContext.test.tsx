import { GlobalWindow } from "happy-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { ThinkingProvider } from "./ThinkingContext";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { getModelKey, getThinkingLevelByModelKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";

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

    await waitFor(() => {
      expect(view.getByTestId("child").textContent).toBe("low");
    });

    expect(unmounts).toBe(0);
  });
  test("switching models restores the per-model thinking level", async () => {
    const workspaceId = "ws-1";

    // Model A
    updatePersistedState(getModelKey(workspaceId), "openai:gpt-5.2");
    updatePersistedState(getThinkingLevelByModelKey("openai:gpt-5.2"), "high");

    // Model B
    updatePersistedState(getThinkingLevelByModelKey("anthropic:claude-3.5"), "low");

    const view = render(
      <ThinkingProvider workspaceId={workspaceId}>
        <TestComponent workspaceId={workspaceId} />
      </ThinkingProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("high:ws-1");
    });

    // Change model -> should restore that model's stored thinking level
    act(() => {
      updatePersistedState(getModelKey(workspaceId), "anthropic:claude-3.5");
    });

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe("low:ws-1");
    });
  });
});
