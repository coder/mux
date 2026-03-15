import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { SendMessageOptions } from "@/common/orpc/types";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { AgentProvider } from "@/browser/contexts/AgentContext";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  AGENT_AI_DEFAULTS_KEY,
  getAgentIdKey,
  getModelKey,
  getPlanContentKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";

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
      mode?: "destructive" | "append-compaction-boundary" | null;
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

let selectableDiffRendererCalls: Array<{ filePath?: string }> = [];

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

void mock.module("@/browser/hooks/useReviews", () => ({
  useReviews: () => ({
    reviews: [],
    pendingCount: 0,
    attachedCount: 0,
    checkedCount: 0,
    attachedReviews: [],
    addReview: (data: unknown) => ({
      id: "test-review",
      data,
      status: "attached" as const,
      createdAt: Date.now(),
    }),
    attachReview: () => undefined,
    detachReview: () => undefined,
    attachAllPending: () => undefined,
    detachAllAttached: () => undefined,
    checkReview: () => undefined,
    uncheckReview: () => undefined,
    removeReview: () => undefined,
    updateReviewNote: () => undefined,
    clearChecked: () => undefined,
    clearAll: () => undefined,
    getReview: () => undefined,
  }),
}));

void mock.module("@/browser/features/Shared/DiffRenderer", () => ({
  SelectableDiffRenderer: (props: { filePath?: string }) => {
    selectableDiffRendererCalls.push({ filePath: props.filePath });
    return <div data-testid="selectable-diff-renderer" data-filepath={props.filePath ?? ""} />;
  },
}));

void mock.module("@/common/types/review", () => ({
  isPlanFilePath: (filePath: string) => /[/\\]plans[/\\]/.test(filePath),
  normalizePlanFilePath: (filePath: string) => {
    const normalizedPath = filePath.replace(/\\/g, "/");
    const tildeMuxMatch = /^~\/\.mux\/plans\/(.+)$/.exec(normalizedPath);
    if (tildeMuxMatch?.[1]) {
      return `.mux/plans/${tildeMuxMatch[1]}`;
    }

    return normalizedPath;
  },
}));

const TEST_AGENTS: AgentDefinitionDescriptor[] = [
  {
    id: "exec",
    scope: "built-in",
    name: "Exec",
    uiSelectable: true,
    uiRoutable: true,
    subagentRunnable: true,
    aiDefaults: {
      model: "openai:gpt-5.2",
      thinkingLevel: "low",
    },
  },
  {
    id: "plan",
    scope: "built-in",
    name: "Plan",
    uiSelectable: true,
    uiRoutable: true,
    subagentRunnable: true,
    aiDefaults: {
      model: "anthropic:claude-sonnet-4-5",
      thinkingLevel: "high",
    },
  },
  {
    id: "orchestrator",
    scope: "built-in",
    name: "Orchestrator",
    uiSelectable: true,
    uiRoutable: true,
    subagentRunnable: true,
    base: "exec",
    aiDefaults: {
      model: "openai:gpt-5.2-pro",
      thinkingLevel: "medium",
    },
  },
];

const noop = () => {
  // intentional noop for tests
};

function renderToolCall(content: JSX.Element, agentId = "plan") {
  return render(
    <AgentProvider
      value={{
        agentId,
        setAgentId: noop,
        currentAgent: TEST_AGENTS.find((entry) => entry.id === agentId),
        agents: TEST_AGENTS,
        loaded: true,
        loadFailed: false,
        refresh: () => Promise.resolve(),
        refreshing: false,
        disableWorkspaceAgents: false,
        setDisableWorkspaceAgents: noop,
      }}
    >
      <TooltipProvider>{content}</TooltipProvider>
    </AgentProvider>
  );
}

describe("ProposePlanToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    startHereCalls = [];
    selectableDiffRendererCalls = [];
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
    mock.restore();
    // Restore original globals instead of setting to undefined
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("does not claim plan is in chat when Start Here content is a placeholder", () => {
    const planPath = "~/.mux/plans/demo/ws-123.md";

    renderToolCall(
      <ProposePlanToolCall
        args={{}}
        result={{
          success: true,
          planPath,
        }}
        workspaceId="ws-123"
        isLatest={false}
      />
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

    renderToolCall(
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
    );

    expect(startHereCalls.length).toBe(1);
    expect(startHereCalls[0]?.options).toEqual({ sourceAgentId: "plan" });
    expect(startHereCalls[0]?.isCompacted).toBe(false);

    // The Start Here message should explicitly tell the user the plan file remains on disk.
    expect(startHereCalls[0]?.content).toContain("*Plan file preserved at:*");
    expect(startHereCalls[0]?.content).toContain("Note: This chat already contains the full plan");
    expect(startHereCalls[0]?.content).toContain(planPath);
  });

  test("shows Annotate button for latest completed plan with workspaceId", () => {
    const planPath = "~/.mux/plans/demo/ws-123.md";

    const view = renderToolCall(
      <ProposePlanToolCall
        args={{}}
        status="completed"
        result={{
          success: true,
          planPath,
          planContent: "# My Plan\n\nDo the thing.",
        }}
        workspaceId="ws-123"
        isLatest={true}
      />
    );

    expect(view.getByRole("button", { name: "Annotate" })).toBeDefined();
  });

  test("hides Annotate button for non-latest plans", () => {
    const planPath = "~/.mux/plans/demo/ws-123.md";

    const view = renderToolCall(
      <ProposePlanToolCall
        args={{}}
        status="completed"
        result={{
          success: true,
          planPath,
          planContent: "# My Plan\n\nDo the thing.",
        }}
        workspaceId="ws-123"
        isLatest={false}
      />
    );

    expect(view.queryByRole("button", { name: "Annotate" })).toBeNull();
  });

  test("hides Annotate button while latest plan call is still executing", async () => {
    const workspaceId = "ws-123";
    const planPath = "~/.mux/plans/demo/ws-123.md";
    let getPlanContentCalls = 0;

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
        getPlanContent: () => {
          getPlanContentCalls += 1;
          return Promise.resolve({
            success: true,
            data: { content: "# My Plan\n\nDo the thing.", path: planPath },
          });
        },
        replaceChatHistory: (_args) => Promise.resolve({ success: true, data: undefined }),
        sendMessage: (_args) => Promise.resolve({ success: true, data: undefined }),
      },
    };

    const view = renderToolCall(
      <ProposePlanToolCall args={{}} status="executing" workspaceId={workspaceId} isLatest={true} />
    );

    await waitFor(() => expect(getPlanContentCalls).toBe(1));
    expect(view.queryByRole("button", { name: "Annotate" })).toBeNull();
  });

  test("passes normalized plan path to annotation view", () => {
    const rawPlanPath = "~/.mux/plans/demo/ws-123.md";

    const view = renderToolCall(
      <ProposePlanToolCall
        args={{}}
        status="completed"
        result={{
          success: true,
          planPath: rawPlanPath,
          planContent: "# My Plan\n\nDo the thing.",
        }}
        workspaceId="ws-123"
        isLatest={true}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Annotate" }));

    const renderer = view.getByTestId("selectable-diff-renderer");
    expect(renderer.getAttribute("data-filepath")).toBe(".mux/plans/demo/ws-123.md");
    expect(selectableDiffRendererCalls[selectableDiffRendererCalls.length - 1]?.filePath).toBe(
      ".mux/plans/demo/ws-123.md"
    );
  });

  test("hides Annotate button when completed propose_plan result is an error", () => {
    const workspaceId = "ws-123";
    const planPath = "~/.mux/plans/demo/ws-123.md";

    updatePersistedState(getPlanContentKey(workspaceId), {
      content: "# Cached Plan\n\nDo the thing.",
      path: planPath,
    });

    const view = renderToolCall(
      <ProposePlanToolCall
        args={{}}
        status="completed"
        result={{ success: false, error: "failed to generate plan" }}
        workspaceId={workspaceId}
        isLatest={true}
      />
    );

    expect(view.queryByRole("button", { name: "Annotate" })).toBeNull();
  });

  test("annotate mode and raw mode are mutually exclusive", () => {
    const planPath = "~/.mux/plans/demo/ws-123.md";

    const view = renderToolCall(
      <ProposePlanToolCall
        args={{}}
        status="completed"
        result={{
          success: true,
          planPath,
          planContent: "# My Plan\n\nDo the thing.",
        }}
        workspaceId="ws-123"
        isLatest={true}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Annotate" }));
    expect(view.getByRole("button", { name: "Exit Annotate" })).toBeDefined();
    expect(view.getByTestId("plan-annotation-view")).toBeDefined();

    fireEvent.click(view.getByRole("button", { name: "Show Text" }));
    expect(view.queryByTestId("plan-annotation-view")).toBeNull();
    expect(view.container.querySelector("pre")).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Annotate" }));
    expect(view.getByRole("button", { name: "Exit Annotate" })).toBeDefined();
    expect(view.getByTestId("plan-annotation-view")).toBeDefined();
    expect(view.container.querySelector("pre")).toBeNull();
  });

  test("exposes the plan body as an explicit transcript quote root", () => {
    const planContent = "# My Plan\n\nDo the thing.";
    const view = renderToolCall(
      <ProposePlanToolCall
        args={{}}
        status="completed"
        result={{
          success: true,
          planPath: "~/.mux/plans/demo/ws-123.md",
          planContent,
        }}
        workspaceId="ws-123"
        isLatest={true}
      />
    );

    const quoteRoots = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-transcript-quote-root]")
    );
    expect(quoteRoots).toHaveLength(1);
    const quoteRoot = quoteRoots.find(
      (element) => element.getAttribute("data-transcript-quote-text") === planContent
    );
    expect(quoteRoot).toBeDefined();
  });

  test("keeps the plan transcript quote root in ephemeral previews", () => {
    const planContent = "# Preview Plan\n\nShip it.";
    const view = renderToolCall(
      <ProposePlanToolCall
        args={{}}
        status="completed"
        content={planContent}
        path="~/.mux/plans/demo/ws-123.md"
        workspaceId="ws-123"
        isEphemeralPreview={true}
      />
    );

    const quoteRoots = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-transcript-quote-root]")
    );
    expect(quoteRoots).toHaveLength(1);
    const quoteRoot = quoteRoots.find(
      (element) => element.getAttribute("data-transcript-quote-text") === planContent
    );
    expect(quoteRoot).toBeDefined();
  });

  test("does not toggle annotate mode with Shift+A in ephemeral previews", () => {
    const planPath = "~/.mux/plans/demo/ws-123.md";

    const view = renderToolCall(
      <>
        <ProposePlanToolCall
          args={{}}
          status="completed"
          content="# My Plan\n\nDo the thing."
          path={planPath}
          workspaceId="ws-123"
          isEphemeralPreview={true}
        />
        <ProposePlanToolCall
          args={{}}
          status="completed"
          content="# Another Plan\n\nDo the other thing."
          path={planPath}
          workspaceId="ws-123"
          isEphemeralPreview={true}
        />
      </>
    );

    expect(view.getAllByRole("button", { name: "Annotate" }).length).toBe(2);

    fireEvent.keyDown(document, { key: "a", shiftKey: true });

    expect(view.queryByRole("button", { name: "Exit Annotate" })).toBeNull();
    expect(view.getAllByRole("button", { name: "Annotate" }).length).toBe(2);
  });

  test("switches to exec and sends a message when clicking Implement", async () => {
    const workspaceId = "ws-123";
    const planPath = "~/.mux/plans/demo/ws-123.md";
    const planModel = "anthropic:claude-sonnet-4-5";
    const planThinking = "high";
    const execModel = "openai:gpt-5.2";
    const execThinking = "low";

    // Start in plan mode.
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));
    updatePersistedState(getModelKey(workspaceId), planModel);
    updatePersistedState(getThinkingLevelKey(workspaceId), planThinking);
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      exec: { modelString: execModel, thinkingLevel: execThinking },
    });

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

    const view = renderToolCall(
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
    );

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.message).toBe("Implement the plan");
    expect(sendMessageCalls[0]?.options.agentId).toBe("exec");
    expect(sendMessageCalls[0]?.options.model).toBe(execModel);
    expect(sendMessageCalls[0]?.options.thinkingLevel).toBe(execThinking);

    // Clicking Implement should switch the workspace agent to exec and persist the
    // resolved per-agent workspace settings without rewriting the legacy thinking key.
    const agentKey = getAgentIdKey(workspaceId);
    const modelKey = getModelKey(workspaceId);
    const thinkingKey = getThinkingLevelKey(workspaceId);
    const workspaceAiSettingsKey = getWorkspaceAISettingsByAgentKey(workspaceId);
    const updatePersistedStateMaybeMock = updatePersistedState as unknown as {
      mock?: { calls: unknown[][] };
    };
    if (updatePersistedStateMaybeMock.mock) {
      expect(updatePersistedState).toHaveBeenCalledWith(
        workspaceAiSettingsKey,
        {
          exec: { model: execModel, thinkingLevel: execThinking },
        },
        {}
      );
      expect(updatePersistedState).toHaveBeenCalledWith(agentKey, "exec");
      expect(updatePersistedState).toHaveBeenCalledWith(modelKey, execModel);
      expect(updatePersistedState).not.toHaveBeenCalledWith(thinkingKey, execThinking);
    } else {
      expect(JSON.parse(window.localStorage.getItem(agentKey)!)).toBe("exec");
      expect(JSON.parse(window.localStorage.getItem(modelKey)!)).toBe(execModel);
      expect(JSON.parse(window.localStorage.getItem(thinkingKey)!)).toBe(planThinking);
      expect(JSON.parse(window.localStorage.getItem(workspaceAiSettingsKey)!)).toEqual({
        exec: { model: execModel, thinkingLevel: execThinking },
      });
    }
  });

  test("uses workspace-by-agent override for Implement when exec defaults inherit", async () => {
    const workspaceId = "ws-123";
    const planPath = "~/.mux/plans/demo/ws-123.md";
    const planModel = "anthropic:claude-sonnet-4-5";
    const planThinking = "high";
    const execWorkspaceModel = "openai:gpt-5.2-pro";
    const execWorkspaceThinking = "medium";

    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));
    updatePersistedState(getModelKey(workspaceId), planModel);
    updatePersistedState(getThinkingLevelKey(workspaceId), planThinking);
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {});
    updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
      exec: { model: execWorkspaceModel, thinkingLevel: execWorkspaceThinking },
    });

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

    const view = renderToolCall(
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
    );

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.options.agentId).toBe("exec");
    expect(sendMessageCalls[0]?.options.model).toBe(execWorkspaceModel);
    expect(sendMessageCalls[0]?.options.thinkingLevel).toBe(execWorkspaceThinking);
  });

  test("inherits the current workspace thinking for Implement when exec has no seeded settings", async () => {
    const workspaceId = "ws-inherit-implement";
    const planPath = "~/.mux/plans/demo/ws-inherit-implement.md";
    const planModel = "anthropic:claude-sonnet-4-5";
    const planThinking = "high";

    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));
    updatePersistedState(getModelKey(workspaceId), planModel);
    updatePersistedState(getThinkingLevelKey(workspaceId), planThinking);
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {});

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

    const view = renderToolCall(
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
    );

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.options.agentId).toBe("exec");
    expect(sendMessageCalls[0]?.options.model).toBe(planModel);
    expect(sendMessageCalls[0]?.options.thinkingLevel).toBe(planThinking);
    expect(
      JSON.parse(window.localStorage.getItem(getWorkspaceAISettingsByAgentKey(workspaceId))!)
    ).toEqual({
      plan: { model: planModel, thinkingLevel: planThinking },
      exec: { model: planModel, thinkingLevel: planThinking },
    });
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
      mode?: "destructive" | "append-compaction-boundary" | null;
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

    const view = renderToolCall(
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
    );

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(replaceChatHistoryCalls.length).toBe(1);
    expect(calls).toEqual(["replaceChatHistory", "sendMessage"]);

    const replaceArgs = replaceChatHistoryCalls[0];
    expect(replaceArgs?.deletePlanFile).toBe(false);
    expect(replaceArgs?.mode).toBe("append-compaction-boundary");

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
    const planModel = "anthropic:claude-sonnet-4-5";
    const planThinking = "high";
    const orchestratorModel = "openai:gpt-5.2-pro";
    const orchestratorThinking = "medium";

    // Start in plan mode.
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));
    updatePersistedState(getModelKey(workspaceId), planModel);
    updatePersistedState(getThinkingLevelKey(workspaceId), planThinking);
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      orchestrator: { modelString: orchestratorModel, thinkingLevel: orchestratorThinking },
    });

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

    const view = renderToolCall(
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
    );

    fireEvent.click(view.getByRole("button", { name: "Start Orchestrator" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.message).toBe(
      "Start orchestrating the implementation of this plan."
    );
    expect(sendMessageCalls[0]?.options.agentId).toBe("orchestrator");
    expect(sendMessageCalls[0]?.options.model).toBe(orchestratorModel);
    expect(sendMessageCalls[0]?.options.thinkingLevel).toBe(orchestratorThinking);
    expect(replaceChatHistoryCalls.length).toBe(0);

    // Clicking Start Orchestrator should switch the workspace agent and persist the
    // resolved per-agent workspace settings without rewriting the legacy thinking key.
    const agentKey = getAgentIdKey(workspaceId);
    const modelKey = getModelKey(workspaceId);
    const thinkingKey = getThinkingLevelKey(workspaceId);
    const workspaceAiSettingsKey = getWorkspaceAISettingsByAgentKey(workspaceId);
    const updatePersistedStateMaybeMock = updatePersistedState as unknown as {
      mock?: { calls: unknown[][] };
    };
    if (updatePersistedStateMaybeMock.mock) {
      expect(updatePersistedState).toHaveBeenCalledWith(
        workspaceAiSettingsKey,
        {
          orchestrator: { model: orchestratorModel, thinkingLevel: orchestratorThinking },
        },
        {}
      );
      expect(updatePersistedState).toHaveBeenCalledWith(agentKey, "orchestrator");
      expect(updatePersistedState).toHaveBeenCalledWith(modelKey, orchestratorModel);
      expect(updatePersistedState).not.toHaveBeenCalledWith(thinkingKey, orchestratorThinking);
    } else {
      expect(JSON.parse(window.localStorage.getItem(agentKey)!)).toBe("orchestrator");
      expect(JSON.parse(window.localStorage.getItem(modelKey)!)).toBe(orchestratorModel);
      expect(JSON.parse(window.localStorage.getItem(thinkingKey)!)).toBe(planThinking);
      expect(JSON.parse(window.localStorage.getItem(workspaceAiSettingsKey)!)).toEqual({
        orchestrator: { model: orchestratorModel, thinkingLevel: orchestratorThinking },
      });
    }
  });

  test("inherits the current workspace thinking for Start Orchestrator when it has no seeded settings", async () => {
    const workspaceId = "ws-inherit-orchestrator";
    const planPath = "~/.mux/plans/demo/ws-inherit-orchestrator.md";
    const planModel = "anthropic:claude-sonnet-4-5";
    const planThinking = "high";

    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));
    updatePersistedState(getModelKey(workspaceId), planModel);
    updatePersistedState(getThinkingLevelKey(workspaceId), planThinking);
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {});

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

    const view = renderToolCall(
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
    );

    fireEvent.click(view.getByRole("button", { name: "Start Orchestrator" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.options.agentId).toBe("orchestrator");
    expect(sendMessageCalls[0]?.options.model).toBe(planModel);
    expect(sendMessageCalls[0]?.options.thinkingLevel).toBe(planThinking);
    expect(
      JSON.parse(window.localStorage.getItem(getWorkspaceAISettingsByAgentKey(workspaceId))!)
    ).toEqual({
      plan: { model: planModel, thinkingLevel: planThinking },
      orchestrator: { model: planModel, thinkingLevel: planThinking },
    });
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
      mode?: "destructive" | "append-compaction-boundary" | null;
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

    const view = renderToolCall(
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
    expect(replaceArgs?.mode).toBe("append-compaction-boundary");

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
