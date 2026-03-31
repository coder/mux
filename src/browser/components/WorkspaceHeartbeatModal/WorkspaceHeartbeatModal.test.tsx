import "../../../../tests/ui/dom";

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as WorkspaceHeartbeatHookModule from "@/browser/hooks/useWorkspaceHeartbeat";
import type { HeartbeatFormSettings } from "@/browser/hooks/useWorkspaceHeartbeat";
import {
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

function createHeartbeatSettings(
  overrides: Partial<HeartbeatFormSettings> = {}
): HeartbeatFormSettings {
  return {
    enabled: false,
    intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
    ...overrides,
  };
}

describe("WorkspaceHeartbeatModal", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    settingsByWorkspaceId = new Map<string, HeartbeatFormSettings>();
    saveCalls = [];
    saveResult = true;
    hookError = null;
    hookIsLoading = false;
    hookIsSaving = false;

    spyOn(WorkspaceHeartbeatHookModule, "useWorkspaceHeartbeat").mockImplementation((params) => {
      const workspaceId = params.workspaceId;
      return {
        settings:
          workspaceId == null
            ? createHeartbeatSettings()
            : (settingsByWorkspaceId.get(workspaceId) ?? createHeartbeatSettings()),
        isLoading: hookIsLoading,
        isSaving: hookIsSaving,
        error: hookError,
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
            message: "Check the pending review queue and summarize next steps.",
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
        message: "Review the open PR status before sending a follow-up.",
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
        "Review the open PR status before sending a follow-up."
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
        "Review the open PR status before sending a follow-up."
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
            message: "",
          },
        },
      ]);
    });
  });
});
