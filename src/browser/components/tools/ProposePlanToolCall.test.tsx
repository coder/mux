import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { SendMessageOptions } from "@/common/orpc/types";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getAgentIdKey } from "@/common/constants/storage";

import { TooltipProvider } from "../ui/tooltip";

import { ProposePlanToolCall } from "./ProposePlanToolCall";

interface SendMessageArgs {
  workspaceId: string;
  message: string;
  options: SendMessageOptions;
}

type GetPlanContentResult =
  | { success: true; data: { content: string; path: string } }
  | { success: false; error: string };

interface MockApi {
  workspace: {
    getPlanContent: () => Promise<GetPlanContentResult>;
    sendMessage: (args: SendMessageArgs) => Promise<{ success: true; data: undefined }>;
  };
}

let mockApi: MockApi | null = null;

let startHereCalls: Array<{
  workspaceId: string | undefined;
  content: string;
  isCompacted: boolean;
  options: { deletePlanFile?: boolean; sourceMode?: string } | undefined;
}> = [];

const useStartHereMock = mock(
  (
    workspaceId: string | undefined,
    content: string,
    isCompacted: boolean,
    options?: { deletePlanFile?: boolean; sourceMode?: string }
  ) => {
    startHereCalls.push({ workspaceId, content, isCompacted, options });
    return {
      openModal: () => undefined,
      isStartingHere: false,
      buttonLabel: "Start Here",
      buttonEmoji: "",
      disabled: false,
      modal: null,
    };
  }
);

void mock.module("@/browser/hooks/useStartHere", () => ({
  useStartHere: useStartHereMock,
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: mockApi, status: "connected" as const, error: null }),
}));

void mock.module("@/browser/hooks/useOpenInEditor", () => ({
  useOpenInEditor: () => () => Promise.resolve({ success: true } as const),
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({
    workspaceMetadata: new Map<string, { runtimeConfig?: unknown }>(),
  }),
}));

void mock.module("@/browser/contexts/TelemetryEnabledContext", () => ({
  useLinkSharingEnabled: () => true,
}));

describe("ProposePlanToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    startHereCalls = [];
    mockApi = null;
    // Save original globals
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    // Set up test globals
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    // Restore original globals instead of setting to undefined
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("keeps plan file on disk and includes plan path note in Start Here content", () => {
    const planPath = "~/.mux/plans/demo/ws-123.md";

    render(
      <TooltipProvider>
        <ProposePlanToolCall
          args={{}}
          result={{
            success: true,
            planPath,
            // Old-format chat history may include planContent; this is the easiest path to
            // ensure the rendered Start Here message includes the full plan + the path note.
            planContent: "# My Plan\n\nDo the thing.",
          }}
          workspaceId="ws-123"
          isLatest={false}
        />
      </TooltipProvider>
    );

    expect(startHereCalls.length).toBe(1);
    expect(startHereCalls[0]?.options).toEqual({ sourceMode: "plan" });
    expect(startHereCalls[0]?.isCompacted).toBe(false);

    // The Start Here message should explicitly tell the user the plan file remains on disk.
    expect(startHereCalls[0]?.content).toContain("*Plan file preserved at:*");
    expect(startHereCalls[0]?.content).toContain(planPath);
  });

  test("switches to exec and sends a message when clicking Implement", async () => {
    const workspaceId = "ws-123";
    const planPath = "~/.mux/plans/demo/ws-123.md";

    // Start in plan mode.
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));

    const sendMessageCalls: SendMessageArgs[] = [];

    mockApi = {
      workspace: {
        getPlanContent: () =>
          Promise.resolve({
            success: true,
            data: { content: "# My Plan\n\nDo the thing.", path: planPath },
          }),
        sendMessage: (args: SendMessageArgs) => {
          sendMessageCalls.push(args);
          return Promise.resolve({ success: true, data: undefined });
        },
      },
    };

    const view = render(
      <TooltipProvider>
        <ProposePlanToolCall
          args={{}}
          status="completed"
          result={{
            success: true,
            planPath,
            planContent: "# My Plan\n\nDo the thing.",
          }}
          workspaceId={workspaceId}
          isLatest={true}
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.message).toBe("Implement the plan");
    // Clicking Implement should switch the workspace agent to exec.
    //
    // Note: some tests in this repo mock the `usePersistedState` module globally. In that case,
    // `updatePersistedState` won't actually write to localStorage here, so we assert the call.
    const agentKey = getAgentIdKey(workspaceId);
    const updatePersistedStateMaybeMock = updatePersistedState as unknown as {
      mock?: { calls: unknown[][] };
    };
    if (updatePersistedStateMaybeMock.mock) {
      expect(updatePersistedState).toHaveBeenCalledWith(agentKey, "exec");
    } else {
      expect(JSON.parse(window.localStorage.getItem(agentKey)!)).toBe("exec");
    }
  });
});
