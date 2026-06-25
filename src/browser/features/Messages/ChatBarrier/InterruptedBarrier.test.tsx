import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";

interface MockWorkspaceState {
  autoRetryStatus: null;
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
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
    ],
    ...overrides,
  };
}

let currentWorkspaceState = createWorkspaceState();

let resumeStreamResult: { success: true; data: { started: boolean } } = {
  success: true,
  data: { started: true },
};
const resumeStream = mock((_input: unknown) => Promise.resolve(resumeStreamResult));
const setAutoRetryEnabled = mock((input: unknown) =>
  Promise.resolve({
    success: true as const,
    data: {
      previousEnabled: true,
      enabled:
        typeof input === "object" && input !== null && "enabled" in input
          ? ((input as { enabled?: boolean }).enabled ?? true)
          : true,
    },
  })
);

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

/* eslint-disable @typescript-eslint/no-require-imports */
const actualWorkspaceStore =
  require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
/* eslint-enable @typescript-eslint/no-require-imports */

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  ...actualWorkspaceStore,
  useWorkspaceState: () => currentWorkspaceState,
  useWorkspaceStoreRaw: () => ({
    getWorkspaceState: (_workspaceId: string) => currentWorkspaceState,
  }),
}));

import { InterruptedBarrier } from "./InterruptedBarrier";

describe("InterruptedBarrier", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    currentWorkspaceState = createWorkspaceState();
    resumeStreamResult = { success: true, data: { started: true } };
    resumeStream.mockClear();
    setAutoRetryEnabled.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("clicking the resumable interrupted label resumes the tail without touching auto-retry", async () => {
    const view = render(<InterruptedBarrier workspaceId="ws-1" resumable />);

    const label = view.getByRole("button", { name: "Continue interrupted response" });
    fireEvent.click(label);

    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
    });

    // A user-initiated (Esc) interrupt means "continue once" — it must NOT flip
    // the auto-retry preference, so the unmount-on-auto-retry path can't cancel
    // an in-flight scheduled retry.
    expect(setAutoRetryEnabled).not.toHaveBeenCalled();
    expect(resumeStream.mock.calls[0]?.[0]).toMatchObject({ workspaceId: "ws-1" });
  });

  test("a non-resumable divider renders no clickable control", () => {
    const view = render(<InterruptedBarrier workspaceId="ws-1" resumable={false} />);

    expect(view.queryByRole("button")).toBeNull();
    expect(view.getByText("interrupted")).toBeTruthy();
  });
});
