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

type ResultVoid = { success: true; data: undefined } | { success: false; error: string };

interface GetConfigResult {
  taskSettings: {
    maxParallelAgentTasks: number;
    maxTaskNestingDepth: number;
    proposePlanImplementReplacesChatHistory?: boolean;
  };
  agentAiDefaults: Record<string, unknown>;
  subagentAiDefaults: Record<string, unknown>;
}

interface MockApi {
  config: {
    getConfig: () => Promise<GetConfigResult>;
  };
  workspace: {
    getPlanContent: () => Promise<GetPlanContentResult>;
    replaceChatHistory: (args: {
      workspaceId: string;
      summaryMessage: unknown;
      deletePlanFile?: boolean;
    }) => Promise<ResultVoid>;
    sendMessage: (args: SendMessageArgs) => Promise<{ success: true; data: undefined }>;
  };
}

let mockApi: MockApi | null = null;

let startHereCalls: Array<{
  workspaceId: string | undefined;
  content: string;
  isCompacted: boolean;
  options: { deletePlanFile?: boolean; sourceAgentId?: string } | undefined;
}> = [];

const useStartHereMock = mock(
  (
    workspaceId: string | undefined,
    content: string,
    isCompacted: boolean,
    options?: { deletePlanFile?: boolean; sourceAgentId?: string }
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

  test("does not claim plan is in chat when Start Here content is a placeholder", () => {
    const planPath = "~/.mux/plans/demo/ws-123.md";

    render(
      <TooltipProvider>
        <ProposePlanToolCall
          args={{}}
          result={{
            success: true,
            planPath,
          }}
          workspaceId="ws-123"
          isLatest={false}
        />
      </TooltipProvider>
    );

    expect(startHereCalls.length).toBe(1);
    expect(startHereCalls[0]?.content).toContain("*Plan saved to");
    expect(startHereCalls[0]?.content).not.toContain(
      "Note: This chat already contains the full plan"
    );
    expect(startHereCalls[0]?.content).toContain("Read the plan file below");
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
    expect(startHereCalls[0]?.options).toEqual({ sourceAgentId: "plan" });
    expect(startHereCalls[0]?.isCompacted).toBe(false);

    // The Start Here message should explicitly tell the user the plan file remains on disk.
    expect(startHereCalls[0]?.content).toContain("*Plan file preserved at:*");
    expect(startHereCalls[0]?.content).toContain("Note: This chat already contains the full plan");
    expect(startHereCalls[0]?.content).toContain(planPath);
  });

  test("switches to exec and sends a message when clicking Implement", async () => {
    const workspaceId = "ws-123";
    const planPath = "~/.mux/plans/demo/ws-123.md";

    // Start in plan mode.
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));

    const sendMessageCalls: SendMessageArgs[] = [];

    mockApi = {
      config: {
        getConfig: () =>
          Promise.resolve({
            taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
            agentAiDefaults: {},
            subagentAiDefaults: {},
          }),
      },
      workspace: {
        getPlanContent: () =>
          Promise.resolve({
            success: true,
            data: { content: "# My Plan\n\nDo the thing.", path: planPath },
          }),
        replaceChatHistory: (_args) => Promise.resolve({ success: true, data: undefined }),
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

  test("replaces chat history before implementing when setting enabled", async () => {
    const workspaceId = "ws-123";
    const planPath = "~/.mux/plans/demo/ws-123.md";

    // Start in plan mode.
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));

    const calls: Array<"replaceChatHistory" | "sendMessage"> = [];
    const replaceChatHistoryCalls: Array<{
      workspaceId: string;
      summaryMessage: unknown;
      deletePlanFile?: boolean;
    }> = [];
    const sendMessageCalls: SendMessageArgs[] = [];

    mockApi = {
      config: {
        getConfig: () =>
          Promise.resolve({
            taskSettings: {
              maxParallelAgentTasks: 3,
              maxTaskNestingDepth: 3,
              proposePlanImplementReplacesChatHistory: true,
            },
            agentAiDefaults: {},
            subagentAiDefaults: {},
          }),
      },
      workspace: {
        getPlanContent: () =>
          Promise.resolve({
            success: true,
            data: { content: "# My Plan\n\nDo the thing.", path: planPath },
          }),
        replaceChatHistory: (args) => {
          calls.push("replaceChatHistory");
          replaceChatHistoryCalls.push(args);
          return Promise.resolve({ success: true, data: undefined });
        },
        sendMessage: (args: SendMessageArgs) => {
          calls.push("sendMessage");
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
    expect(replaceChatHistoryCalls.length).toBe(1);
    expect(calls).toEqual(["replaceChatHistory", "sendMessage"]);

    const replaceArgs = replaceChatHistoryCalls[0];
    expect(replaceArgs?.deletePlanFile).toBe(false);

    const summaryMessage = replaceArgs?.summaryMessage as {
      role?: string;
      metadata?: { agentId?: string };
      parts?: Array<{ type?: string; text?: string }>;
    };

    expect(summaryMessage.role).toBe("assistant");
    expect(summaryMessage.parts?.[0]?.text).toContain(
      "Note: This chat already contains the full plan"
    );
    expect(summaryMessage.metadata?.agentId).toBe("plan");
    expect(summaryMessage.parts?.[0]?.text).toContain("*Plan file preserved at:*");
    expect(summaryMessage.parts?.[0]?.text).toContain(planPath);
  });

  test("switches to orchestrator and sends a message when clicking Start Orchestrator", async () => {
    const workspaceId = "ws-123";
    const planPath = "~/.mux/plans/demo/ws-123.md";

    // Start in plan mode.
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));

    const replaceChatHistoryCalls: unknown[] = [];
    const sendMessageCalls: SendMessageArgs[] = [];

    mockApi = {
      config: {
        getConfig: () =>
          Promise.resolve({
            taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
            agentAiDefaults: {},
            subagentAiDefaults: {},
          }),
      },
      workspace: {
        getPlanContent: () =>
          Promise.resolve({
            success: true,
            data: { content: "# My Plan\n\nDo the thing.", path: planPath },
          }),
        replaceChatHistory: (args) => {
          replaceChatHistoryCalls.push(args);
          return Promise.resolve({ success: true, data: undefined });
        },
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

    fireEvent.click(view.getByRole("button", { name: "Start Orchestrator" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.message).toBe(
      "Start orchestrating the implementation of this plan."
    );
    expect(sendMessageCalls[0]?.options.agentId).toBe("orchestrator");
    expect(replaceChatHistoryCalls.length).toBe(0);

    // Clicking Start Orchestrator should switch the workspace agent to orchestrator.
    const agentKey = getAgentIdKey(workspaceId);
    const updatePersistedStateMaybeMock = updatePersistedState as unknown as {
      mock?: { calls: unknown[][] };
    };
    if (updatePersistedStateMaybeMock.mock) {
      expect(updatePersistedState).toHaveBeenCalledWith(agentKey, "orchestrator");
    } else {
      expect(JSON.parse(window.localStorage.getItem(agentKey)!)).toBe("orchestrator");
    }
  });

  test("replaces chat history before starting orchestrator when setting enabled", async () => {
    const workspaceId = "ws-123";
    const planPath = "~/.mux/plans/demo/ws-123.md";

    // Start in plan mode.
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));

    const calls: Array<"replaceChatHistory" | "sendMessage"> = [];
    const replaceChatHistoryCalls: Array<{
      workspaceId: string;
      summaryMessage: unknown;
      deletePlanFile?: boolean;
    }> = [];
    const sendMessageCalls: SendMessageArgs[] = [];

    mockApi = {
      config: {
        getConfig: () =>
          Promise.resolve({
            taskSettings: {
              maxParallelAgentTasks: 3,
              maxTaskNestingDepth: 3,
              proposePlanImplementReplacesChatHistory: true,
            },
            agentAiDefaults: {},
            subagentAiDefaults: {},
          }),
      },
      workspace: {
        getPlanContent: () =>
          Promise.resolve({
            success: true,
            data: { content: "# My Plan\n\nDo the thing.", path: planPath },
          }),
        replaceChatHistory: (args) => {
          calls.push("replaceChatHistory");
          replaceChatHistoryCalls.push(args);
          return Promise.resolve({ success: true, data: undefined });
        },
        sendMessage: (args: SendMessageArgs) => {
          calls.push("sendMessage");
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

    fireEvent.click(view.getByRole("button", { name: "Start Orchestrator" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.message).toBe(
      "Start orchestrating the implementation of this plan."
    );
    expect(sendMessageCalls[0]?.options.agentId).toBe("orchestrator");

    expect(replaceChatHistoryCalls.length).toBe(1);
    expect(calls).toEqual(["replaceChatHistory", "sendMessage"]);

    const replaceArgs = replaceChatHistoryCalls[0];
    expect(replaceArgs?.deletePlanFile).toBe(false);

    const summaryMessage = replaceArgs?.summaryMessage as {
      role?: string;
      metadata?: { agentId?: string };
      parts?: Array<{ type?: string; text?: string }>;
    };

    expect(summaryMessage.role).toBe("assistant");
    expect(summaryMessage.parts?.[0]?.text).toContain(
      "Note: This chat already contains the full plan"
    );
    expect(summaryMessage.parts?.[0]?.text).not.toContain("Orchestrator mode");
    expect(summaryMessage.metadata?.agentId).toBe("plan");
    expect(summaryMessage.parts?.[0]?.text).toContain("*Plan file preserved at:*");
    expect(summaryMessage.parts?.[0]?.text).toContain(planPath);
  });
});
