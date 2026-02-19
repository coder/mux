import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

let currentWorkspaceState: {
  autoRetryStatus: { type: "auto-retry-scheduled" | "auto-retry-starting" } | null;
  isStreamStarting: boolean;
  canInterrupt: boolean;
  messages: Array<{ type: string; compactionRequest?: { parsed: unknown } }>;
} = {
  autoRetryStatus: null,
  isStreamStarting: false,
  canInterrupt: false,
  messages: [],
};

const answerAskUserQuestion = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: undefined })
);

const resumeStream = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: undefined })
);

const setAutoRetryEnabled = mock((input: unknown) => {
  const enabled =
    typeof input === "object" && input !== null && "enabled" in input
      ? (input as { enabled?: boolean }).enabled === true
      : false;

  return Promise.resolve({
    success: true as const,
    data: {
      // First call (enable=true) should look like user had retry disabled.
      previousEnabled: enabled ? false : true,
      enabled,
    },
  });
});

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      workspace: {
        answerAskUserQuestion,
        resumeStream,
        setAutoRetryEnabled,
      },
    },
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useWorkspaceStoreRaw: () => ({
    subscribeKey: (_workspaceId: string, _listener: () => void) => () => undefined,
    getWorkspaceState: (_workspaceId: string) => currentWorkspaceState,
  }),
}));

void mock.module("@/browser/utils/messages/sendOptions", () => ({
  getSendOptionsFromStorage: (_workspaceId: string) => ({
    model: "openai:gpt-4o",
    agentId: "exec",
  }),
}));

void mock.module("@/browser/utils/messages/compactionOptions", () => ({
  applyCompactionOverrides: (options: unknown, _parsed: unknown) => options,
}));

import { AskUserQuestionToolCall } from "./AskUserQuestionToolCall";

describe("AskUserQuestionToolCall", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    currentWorkspaceState = {
      autoRetryStatus: null,
      isStreamStarting: false,
      canInterrupt: false,
      messages: [],
    };

    answerAskUserQuestion.mockClear();
    resumeStream.mockClear();
    setAutoRetryEnabled.mockClear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("rolls back temporary auto-retry enablement when component unmounts", async () => {
    const view = render(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-1"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => {
      expect(answerAskUserQuestion).toHaveBeenCalledTimes(1);
      expect(resumeStream).toHaveBeenCalledTimes(1);
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(1);
    });

    view.unmount();

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-ask",
      enabled: true,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-ask",
      enabled: false,
    });
  });
});
