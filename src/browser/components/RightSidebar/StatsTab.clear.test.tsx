import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { WorkspaceStatsSnapshot } from "@/common/orpc/types";
import { StatsTab } from "./StatsTab";

describe("StatsTab clear", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalWarn: typeof console.warn;
  let warnCalls: unknown[][];

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    // Ensure persisted state starts clean for each test.
    globalThis.window.localStorage.clear();

    warnCalls = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
  });

  afterEach(() => {
    cleanup();
    console.warn = originalWarn;

    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("renders inline error when workspace.stats.clear rejects", async () => {
    const workspaceId = "workspace-1";

    const snapshot: WorkspaceStatsSnapshot = {
      workspaceId,
      generatedAt: Date.now(),
      session: {
        totalDurationMs: 1000,
        totalToolExecutionMs: 0,
        totalStreamingMs: 900,
        totalTtftMs: 100,
        ttftCount: 1,
        responseCount: 1,
        totalOutputTokens: 10,
        totalReasoningTokens: 0,
        byModel: {
          "openai:gpt-4o": {
            model: "openai:gpt-4o",
            mode: "exec",
            agentId: undefined,
            totalDurationMs: 1000,
            totalToolExecutionMs: 0,
            totalStreamingMs: 900,
            totalTtftMs: 100,
            ttftCount: 1,
            responseCount: 1,
            totalOutputTokens: 10,
            totalReasoningTokens: 0,
          },
        },
      },
    };

    let rejectClear: ((error: unknown) => void) | null = null;
    const clearPromise = new Promise<void>((_, reject) => {
      rejectClear = reject;
    });

    const view = render(
      <StatsTab workspaceId={workspaceId} _snapshot={snapshot} _clearStats={() => clearPromise} />
    );

    const clearButton = view.getByRole("button", { name: "Clear stats" }) as HTMLButtonElement;
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(clearButton.disabled).toBe(true);
    });

    expect(rejectClear).toBeTruthy();
    rejectClear!(new Error("nope"));

    await waitFor(() => {
      expect(view.getByTestId("clear-stats-error")).toBeTruthy();
    });

    expect(view.getByTestId("clear-stats-error").textContent).toContain("Failed to clear stats");
    expect(warnCalls.length).toBeGreaterThan(0);
  });
});
