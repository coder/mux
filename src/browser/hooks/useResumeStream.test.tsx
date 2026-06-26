import React from "react";
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

const currentWorkspaceState: MockWorkspaceState = {
  autoRetryStatus: null,
  isStreamStarting: false,
  canInterrupt: false,
  messages: [{ type: "user", id: "user-1", content: "Hi", historySequence: 1 }],
};

const resumeStream = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: { started: true } })
);
const setAutoRetryEnabled = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: { previousEnabled: false, enabled: true } })
);

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: { workspace: { resumeStream, setAutoRetryEnabled } },
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
  useWorkspaceStoreRaw: () => ({ getWorkspaceState: () => currentWorkspaceState }),
}));

import { useResumeStream, type UseResumeStreamOptions } from "./useResumeStream";

const Harness: React.FC<{ options?: UseResumeStreamOptions }> = (props) => {
  const { resume } = useResumeStream("ws-1", props.options);
  return (
    <button type="button" onClick={() => void resume()}>
      resume
    </button>
  );
};

describe("useResumeStream", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    resumeStream.mockClear();
    setAutoRetryEnabled.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("autoRetryOnFailure:false resumes without touching the auto-retry preference", async () => {
    const view = render(<Harness options={{ autoRetryOnFailure: false }} />);

    fireEvent.click(view.getByText("resume"));

    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
    });
    // The whole point of the option: never enable/disable auto-retry, so the
    // caller (e.g. a transient divider) can't cancel a scheduled retry on unmount.
    expect(setAutoRetryEnabled).not.toHaveBeenCalled();
  });

  test("default enables auto-retry for the resumed attempt", async () => {
    const view = render(<Harness />);

    fireEvent.click(view.getByText("resume"));

    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
    });
    expect(setAutoRetryEnabled).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
  });
});
