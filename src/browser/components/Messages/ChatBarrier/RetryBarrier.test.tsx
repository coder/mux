import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

interface MockWorkspaceState {
  autoRetryStatus:
    | {
        type: "auto-retry-scheduled";
        attempt: number;
        delayMs: number;
        scheduledAt: number;
      }
    | {
        type: "auto-retry-starting";
        attempt: number;
      }
    | {
        type: "auto-retry-abandoned";
        reason: string;
      }
    | null;
  messages: Array<Record<string, unknown>>;
}

function createWorkspaceState(overrides: Partial<MockWorkspaceState> = {}): MockWorkspaceState {
  return {
    autoRetryStatus: null,
    messages: [
      {
        type: "stream-error",
        messageId: "assistant-1",
        error: "Runtime failed to start",
        errorType: "runtime_start_failed",
      },
    ],
    ...overrides,
  };
}

let currentWorkspaceState = createWorkspaceState();

type ResumeStreamResult =
  | { success: true; data: undefined }
  | {
      success: false;
      error: {
        type: "runtime_start_failed";
        message: string;
      };
    };

let resumeStreamResult: ResumeStreamResult = { success: true, data: undefined };
const resumeStream = mock((_input: unknown) => Promise.resolve(resumeStreamResult));
const setAutoRetryEnabled = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: undefined })
);

const getSendOptionsFromStorage = mock((_workspaceId: string) => ({
  model: "openai:gpt-4o",
  agentId: "exec",
}));

const applyCompactionOverrides = mock((options: unknown, _parsed: unknown) => options);

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      workspace: {
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
  useWorkspaceState: () => currentWorkspaceState,
}));

void mock.module("@/browser/hooks/usePersistedState", () => ({
  usePersistedState: () => [false, () => undefined] as const,
}));

void mock.module("@/browser/utils/messages/sendOptions", () => ({
  getSendOptionsFromStorage,
}));

void mock.module("@/browser/utils/messages/compactionOptions", () => ({
  applyCompactionOverrides,
}));

import { RetryBarrier } from "./RetryBarrier";

describe("RetryBarrier", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    currentWorkspaceState = createWorkspaceState();
    resumeStreamResult = { success: true, data: undefined };
    resumeStream.mockClear();
    setAutoRetryEnabled.mockClear();
    getSendOptionsFromStorage.mockClear();
    applyCompactionOverrides.mockClear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("shows error details when manual resume fails before stream events", async () => {
    resumeStreamResult = {
      success: false,
      error: {
        type: "runtime_start_failed",
        message: "Runtime failed to start",
      },
    };

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(view.getByText("Retry failed:")).toBeTruthy();
    });
    expect(view.getByText(/Runtime failed to start/)).toBeTruthy();

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, { workspaceId: "ws-1", enabled: true });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      enabled: false,
    });
    expect(resumeStream).toHaveBeenCalledTimes(1);
  });
});
