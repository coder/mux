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

type ResumeStreamResult =
  | { success: true; data: { started: boolean } }
  | { success: false; error: { type: "runtime_start_failed"; message: string } };
let resumeStreamResult: ResumeStreamResult = { success: true, data: { started: true } };
const resumeStream = mock((_input: unknown) => Promise.resolve(resumeStreamResult));
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

const Harness: React.FC<{ workspaceId?: string; options?: UseResumeStreamOptions }> = (props) => {
  const { resume, error } = useResumeStream(props.workspaceId ?? "ws-1", props.options);
  // (workspaceId/options come straight from props so tests can rerender with new identity)
  return (
    <div>
      <button type="button" onClick={() => void resume()}>
        resume
      </button>
      {error && <div data-testid="resume-error">{error}</div>}
    </div>
  );
};

describe("useResumeStream", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
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

  test("clears the error when workspaceId changes (no cross-workspace bleed)", async () => {
    resumeStreamResult = {
      success: false,
      error: { type: "runtime_start_failed", message: "Runtime failed to start" },
    };

    const view = render(<Harness workspaceId="ws-A" options={{ autoRetryOnFailure: false }} />);
    fireEvent.click(view.getByText("resume"));

    await waitFor(() => {
      expect(view.getByTestId("resume-error")).toBeTruthy();
    });

    // Same always-mounted hook now serves a different workspace: its error must reset.
    view.rerender(<Harness workspaceId="ws-B" options={{ autoRetryOnFailure: false }} />);

    expect(view.queryByTestId("resume-error")).toBeNull();
  });

  test("clears the error when the resume target (resetKey) changes in the same workspace", async () => {
    resumeStreamResult = {
      success: false,
      error: { type: "runtime_start_failed", message: "Runtime failed to start" },
    };

    const view = render(
      <Harness workspaceId="ws-1" options={{ autoRetryOnFailure: false, resetKey: "turn-1" }} />
    );
    fireEvent.click(view.getByText("resume"));

    await waitFor(() => {
      expect(view.getByTestId("resume-error")).toBeTruthy();
    });

    // A later interrupted turn in the same workspace must not inherit the old error.
    view.rerender(
      <Harness workspaceId="ws-1" options={{ autoRetryOnFailure: false, resetKey: "turn-2" }} />
    );

    expect(view.queryByTestId("resume-error")).toBeNull();
  });
});
