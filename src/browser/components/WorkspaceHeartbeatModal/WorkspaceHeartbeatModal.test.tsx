import "../../../../tests/ui/dom";

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as APIModule from "@/browser/contexts/API";
import type { APIClient, UseAPIResult } from "@/browser/contexts/API";
import * as WorkspaceHeartbeatHookModule from "@/browser/hooks/useWorkspaceHeartbeat";
import type { HeartbeatFormSettings } from "@/browser/hooks/useWorkspaceHeartbeat";
import {
  HEARTBEAT_DEFAULT_CONTEXT_MODE,
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_DEFAULT_MESSAGE_BODY,
} from "@/constants/heartbeat";

void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode; className?: string }) => (
    <div className={props.className}>{props.children}</div>
  ),
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode; className?: string }) => (
    <h2 className={props.className}>{props.children}</h2>
  ),
}));

import { WorkspaceHeartbeatModal } from "./WorkspaceHeartbeatModal";

let cleanupDom: (() => void) | null = null;
let settingsByWorkspaceId = new Map<string, HeartbeatFormSettings>();
let saveCalls: Array<{ workspaceId: string; next: HeartbeatFormSettings }> = [];
let saveResult = true;
let hookError: string | null = null;
let hookIsLoading = false;
let hookIsSaving = false;
let useWorkspaceHeartbeatSpy: ReturnType<
  typeof spyOn<typeof WorkspaceHeartbeatHookModule, "useWorkspaceHeartbeat">
>;

type ConnectedUseAPIResult = Extract<UseAPIResult, { status: "connected" }>;
interface WorkspaceHeartbeatTestAPI {
  workspace: {
    heartbeat: {
      get: (input: { workspaceId: string }) => Promise<HeartbeatFormSettings | null>;
      set: (
        _input: unknown
      ) => Promise<{ success: true; data: void } | { success: false; error: string }>;
    };
  };
  config: {
    getConfig: () => Promise<{
      heartbeatDefaultIntervalMs?: number;
      heartbeatDefaultPrompt?: string;
    }>;
  };
}

function createHeartbeatSettings(
  overrides: Partial<HeartbeatFormSettings> = {}
): HeartbeatFormSettings {
  return {
    enabled: false,
    intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
    contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
    ...overrides,
  };
}

function createConnectedUseAPIResult(api: WorkspaceHeartbeatTestAPI): ConnectedUseAPIResult {
  return {
    api: api as APIClient,
    status: "connected",
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  };
}

const LONG_HEARTBEAT_MESSAGE = "Review pending work and summarize next steps. ".repeat(30).trim();

describe("WorkspaceHeartbeatModal", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    settingsByWorkspaceId = new Map<string, HeartbeatFormSettings>();
    saveCalls = [];
    saveResult = true;
    hookError = null;
    hookIsLoading = false;
    hookIsSaving = false;

    useWorkspaceHeartbeatSpy = spyOn(
      WorkspaceHeartbeatHookModule,
      "useWorkspaceHeartbeat"
    ).mockImplementation((params) => {
      const workspaceId = params.workspaceId;
      return {
        settings:
          workspaceId == null
            ? createHeartbeatSettings()
            : (settingsByWorkspaceId.get(workspaceId) ?? createHeartbeatSettings()),
        isLoading: hookIsLoading,
        isSaving: hookIsSaving,
        error: hookError,
        globalDefaultPrompt: undefined,
        save: (next: HeartbeatFormSettings) => {
          if (!workspaceId) {
            return Promise.resolve(false);
          }

          saveCalls.push({ workspaceId, next });
          if (saveResult) {
            settingsByWorkspaceId.set(workspaceId, { ...next });
          }
          return Promise.resolve(saveResult);
        },
      } satisfies WorkspaceHeartbeatHookModule.UseWorkspaceHeartbeatResult;
    });
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("reveals the message field when enabled and saves a custom message", async () => {
    settingsByWorkspaceId.set(
      "ws-1",
      createHeartbeatSettings({
        enabled: false,
        message: "Review the current workspace status before acting.",
      })
    );
    const onOpenChange = mock((_open: boolean) => undefined);
    const view = render(
      <WorkspaceHeartbeatModal workspaceId="ws-1" open={true} onOpenChange={onOpenChange} />
    );

    expect(view.queryByLabelText("Heartbeat message")).toBeNull();

    fireEvent.click(view.getByRole("switch", { name: "Enable workspace heartbeats" }));

    const messageField = (await waitFor(() =>
      view.getByLabelText("Heartbeat message")
    )) as HTMLTextAreaElement;
    expect(messageField.value).toBe("Review the current workspace status before acting.");
    expect(messageField.placeholder).toBe(HEARTBEAT_DEFAULT_MESSAGE_BODY);

    fireEvent.input(messageField, {
      target: { value: "Check the pending review queue and summarize next steps." },
    });
    await waitFor(() => {
      expect(messageField.value).toBe("Check the pending review queue and summarize next steps.");
    });
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveCalls).toEqual([
        {
          workspaceId: "ws-1",
          next: {
            enabled: true,
            intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
            contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
            message: "Check the pending review queue and summarize next steps.",
          },
        },
      ]);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("loads global heartbeat defaults when the workspace has no saved heartbeat config", async () => {
    useWorkspaceHeartbeatSpy.mockRestore();

    const globalIntervalMs = 6 * 60_000;
    const globalPrompt = "test";
    const workspaceHeartbeatGetMock = mock(() => Promise.resolve(null));
    const workspaceHeartbeatSetMock = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    const getConfigMock = mock(() =>
      Promise.resolve({
        heartbeatDefaultIntervalMs: globalIntervalMs,
        heartbeatDefaultPrompt: globalPrompt,
      })
    );
    const mockApi: WorkspaceHeartbeatTestAPI = {
      workspace: {
        heartbeat: {
          get: workspaceHeartbeatGetMock,
          set: workspaceHeartbeatSetMock,
        },
      },
      config: {
        getConfig: getConfigMock,
      },
    };
    spyOn(APIModule, "useAPI").mockImplementation(() => createConnectedUseAPIResult(mockApi));

    const view = render(
      <WorkspaceHeartbeatModal
        workspaceId="ws-1"
        open={true}
        onOpenChange={mock((_open: boolean) => undefined)}
      />
    );

    const intervalField = (await waitFor(() =>
      view.getByLabelText("Heartbeat interval in minutes")
    )) as HTMLInputElement;
    expect(intervalField.value).toBe("6");
    expect(workspaceHeartbeatGetMock).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect(getConfigMock).toHaveBeenCalled();

    fireEvent.click(view.getByRole("switch", { name: "Enable workspace heartbeats" }));

    const messageField = (await waitFor(() =>
      view.getByLabelText("Heartbeat message")
    )) as HTMLTextAreaElement;
    // Global prompt is not seeded into the form to avoid persisting it as a workspace
    // override on save. The backend handles prompt fallback at execution time.
    expect(messageField.value).toBe("");
  });

  test("saves the selected heartbeat context mode and updates helper copy", async () => {
    settingsByWorkspaceId.set(
      "ws-1",
      createHeartbeatSettings({
        enabled: true,
        contextMode: "normal",
      })
    );

    const view = render(
      <WorkspaceHeartbeatModal
        workspaceId="ws-1"
        open={true}
        onOpenChange={mock((_open: boolean) => undefined)}
      />
    );

    const contextModeField = (await waitFor(() =>
      view.getByLabelText("Heartbeat context mode")
    )) as HTMLSelectElement;
    expect(contextModeField.value).toBe("normal");
    expect(view.getByText("Send the heartbeat on the current request context.")).toBeTruthy();

    fireEvent.change(contextModeField, { target: { value: "reset" } });

    await waitFor(() => {
      expect(contextModeField.value).toBe("reset");
    });
    expect(
      view.getByText(
        "Adds a visible context-reset marker, preserves history, and sends the heartbeat on a fresh request context without generating a summary."
      )
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveCalls).toEqual([
        {
          workspaceId: "ws-1",
          next: {
            enabled: true,
            intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
            contextMode: "reset",
            message: "",
          },
        },
      ]);
    });
  });

  test("saves messages longer than 1000 characters without a client-side cap", async () => {
    expect(LONG_HEARTBEAT_MESSAGE.length).toBeGreaterThan(1_000);
    settingsByWorkspaceId.set("ws-1", createHeartbeatSettings({ enabled: true }));

    const onOpenChange = mock((_open: boolean) => undefined);
    const view = render(
      <WorkspaceHeartbeatModal workspaceId="ws-1" open={true} onOpenChange={onOpenChange} />
    );

    const messageField = (await waitFor(() =>
      view.getByLabelText("Heartbeat message")
    )) as HTMLTextAreaElement;
    expect(messageField.getAttribute("maxlength")).toBeNull();

    fireEvent.input(messageField, {
      target: { value: LONG_HEARTBEAT_MESSAGE },
    });
    await waitFor(() => {
      expect(messageField.value).toBe(LONG_HEARTBEAT_MESSAGE);
    });
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveCalls).toEqual([
        {
          workspaceId: "ws-1",
          next: {
            enabled: true,
            intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
            contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
            message: LONG_HEARTBEAT_MESSAGE,
          },
        },
      ]);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("reopens with the saved message for the same workspace and does not bleed across workspaces", async () => {
    settingsByWorkspaceId.set(
      "ws-1",
      createHeartbeatSettings({
        enabled: true,
        message: LONG_HEARTBEAT_MESSAGE,
      })
    );
    settingsByWorkspaceId.set("ws-2", createHeartbeatSettings({ enabled: true }));

    const view = render(
      <WorkspaceHeartbeatModal
        workspaceId="ws-1"
        open={true}
        onOpenChange={mock((_open: boolean) => undefined)}
      />
    );

    await waitFor(() => {
      expect((view.getByLabelText("Heartbeat message") as HTMLTextAreaElement).value).toBe(
        LONG_HEARTBEAT_MESSAGE
      );
    });

    view.rerender(
      <WorkspaceHeartbeatModal
        workspaceId="ws-1"
        open={false}
        onOpenChange={mock((_open: boolean) => undefined)}
      />
    );
    view.rerender(
      <WorkspaceHeartbeatModal
        workspaceId="ws-1"
        open={true}
        onOpenChange={mock((_open: boolean) => undefined)}
      />
    );

    await waitFor(() => {
      expect((view.getByLabelText("Heartbeat message") as HTMLTextAreaElement).value).toBe(
        LONG_HEARTBEAT_MESSAGE
      );
    });

    view.rerender(
      <WorkspaceHeartbeatModal
        workspaceId="ws-2"
        open={true}
        onOpenChange={mock((_open: boolean) => undefined)}
      />
    );

    await waitFor(() => {
      expect((view.getByLabelText("Heartbeat message") as HTMLTextAreaElement).value).toBe("");
    });
  });

  test("clearing the message removes the override instead of saving whitespace", async () => {
    settingsByWorkspaceId.set(
      "ws-1",
      createHeartbeatSettings({
        enabled: true,
        message: "Review the open PR status before sending a follow-up.",
      })
    );

    const view = render(
      <WorkspaceHeartbeatModal
        workspaceId="ws-1"
        open={true}
        onOpenChange={mock((_open: boolean) => undefined)}
      />
    );

    const messageField = (await waitFor(() =>
      view.getByLabelText("Heartbeat message")
    )) as HTMLTextAreaElement;
    fireEvent.input(messageField, { target: { value: "   " } });
    await waitFor(() => {
      expect(messageField.value).toBe("   ");
    });
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveCalls).toEqual([
        {
          workspaceId: "ws-1",
          next: {
            enabled: true,
            intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
            contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
            message: "",
          },
        },
      ]);
    });
  });
});
