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
  isStreamStarting: boolean;
  canInterrupt: boolean;
  messages: Array<Record<string, unknown>>;
}

function createWorkspaceState(overrides: Partial<MockWorkspaceState> = {}): MockWorkspaceState {
  return {
    autoRetryStatus: null,
    isStreamStarting: false,
    canInterrupt: false,
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
  | { success: true; data: { started: boolean } }
  | {
      success: false;
      error: {
        type: "runtime_start_failed";
        message: string;
      };
    };

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

let resumeStreamResult: ResumeStreamResult = { success: true, data: { started: true } };
let previousAutoRetryEnabled = false;
const resumeStream = mock((_input: unknown) => Promise.resolve(resumeStreamResult));
const setAutoRetryEnabled = mock((input: unknown) => {
  if (
    typeof input === "object" &&
    input !== null &&
    "enabled" in input &&
    (input as { enabled?: unknown }).enabled === false
  ) {
    previousAutoRetryEnabled = false;
  }

  return Promise.resolve({
    success: true as const,
    data: {
      previousEnabled: previousAutoRetryEnabled,
      enabled:
        typeof input === "object" && input !== null && "enabled" in input
          ? ((input as { enabled?: boolean }).enabled ?? true)
          : true,
    },
  });
});

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
  useWorkspaceStoreRaw: () => ({
    getWorkspaceState: (_workspaceId: string) => currentWorkspaceState,
  }),
}));

void mock.module("@/browser/hooks/usePersistedState", () => ({
  usePersistedState: () => [false, () => undefined] as const,
}));

import { RetryBarrier } from "./RetryBarrier";

describe("RetryBarrier", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    currentWorkspaceState = createWorkspaceState();
    resumeStreamResult = { success: true, data: { started: true } };
    previousAutoRetryEnabled = false;
    resumeStream.mockClear();
    setAutoRetryEnabled.mockClear();
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

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      enabled: false,
      persist: false,
    });
    expect(resumeStream).toHaveBeenCalledTimes(1);
  });

  test("restores disabled auto-retry preference after resumed stream reaches terminal state", async () => {
    previousAutoRetryEnabled = false;
    const resumeDeferred = createDeferred<ResumeStreamResult>();
    resumeStream.mockImplementationOnce((_input: unknown) => resumeDeferred.promise);

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(1);
    });

    currentWorkspaceState = createWorkspaceState({
      autoRetryStatus: { type: "auto-retry-starting", attempt: 1 },
      isStreamStarting: true,
      canInterrupt: true,
    });
    view.rerender(<RetryBarrier workspaceId="ws-1" />);

    resumeDeferred.resolve({ success: true, data: { started: true } });
    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
      expect(setAutoRetryEnabled.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    currentWorkspaceState = createWorkspaceState({
      autoRetryStatus: null,
      isStreamStarting: false,
      canInterrupt: false,
    });
    view.rerender(<RetryBarrier workspaceId="ws-1" />);

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      enabled: false,
      persist: false,
    });
    expect(view.queryByText("Retry failed:")).toBeNull();
  });

  test("restores preference when terminal state arrives without in-flight snapshots", async () => {
    resumeStreamResult = { success: true, data: { started: true } };
    previousAutoRetryEnabled = false;

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
      expect(setAutoRetryEnabled.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    currentWorkspaceState = createWorkspaceState({
      autoRetryStatus: null,
      isStreamStarting: false,
      canInterrupt: false,
      messages: [
        {
          type: "stream-error",
          messageId: "assistant-1",
          error: "Runtime failed to start",
          errorType: "runtime_start_failed",
        },
        {
          type: "stream-error",
          messageId: "assistant-2",
          error: "Runtime failed to start",
          errorType: "runtime_start_failed",
        },
      ],
    });
    view.rerender(<RetryBarrier workspaceId="ws-1" />);

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      enabled: false,
      persist: false,
    });
  });

  test("restores disabled auto-retry preference if barrier unmounts before terminal state", async () => {
    resumeStreamResult = { success: true, data: { started: true } };
    previousAutoRetryEnabled = false;

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
      expect(setAutoRetryEnabled.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    view.unmount();

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      enabled: false,
      persist: false,
    });
  });

  test("rolls back temporary retry enable when resume reports not started", async () => {
    resumeStreamResult = { success: true, data: { started: false } };
    previousAutoRetryEnabled = false;

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      enabled: false,
      persist: false,
    });
  });

  test("keeps auto-retry enabled when manual retry fails and preference was already on", async () => {
    previousAutoRetryEnabled = true;
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

    expect(setAutoRetryEnabled).toHaveBeenCalledTimes(1);
    expect(setAutoRetryEnabled).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(resumeStream).toHaveBeenCalledTimes(1);
  });
});
