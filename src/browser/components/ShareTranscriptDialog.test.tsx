import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import type { WorkspaceStore } from "@/browser/stores/WorkspaceStore";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { APIProvider } from "@/browser/contexts/API";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { addEphemeralMessage } from "@/browser/stores/WorkspaceStore";
import * as muxMd from "@/common/lib/muxMd";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode; className?: string }) => (
    <h2 className={props.className}>{props.children}</h2>
  ),
}));

import { ShareTranscriptDialog } from "./ShareTranscriptDialog";

const TEST_WORKSPACE_ID = "ws-1";

function getStore(): WorkspaceStore {
  return (useWorkspaceStoreRaw as unknown as () => WorkspaceStore)();
}

function createApiClient(): APIClient {
  return {
    signing: {
      capabilities: () => Promise.resolve({ publicKey: null, githubUser: null, error: null }),
      clearIdentityCache: () => Promise.resolve({ success: true }),
      signMessage: () => Promise.resolve({ sig: "sig", publicKey: "public-key" }),
    },
    workspace: {
      getPlanContent: () => Promise.resolve({ success: false, error: "not-needed" }),
    },
  } as unknown as APIClient;
}

function renderDialog() {
  return render(
    <APIProvider client={createApiClient()}>
      <TooltipProvider>
        <ShareTranscriptDialog
          workspaceId={TEST_WORKSPACE_ID}
          workspaceName="workspace-1"
          workspaceTitle="Workspace 1"
          open
          onOpenChange={() => undefined}
        />
      </TooltipProvider>
    </APIProvider>
  );
}

describe("ShareTranscriptDialog", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalGetComputedStyle: typeof globalThis.getComputedStyle;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    const dom = new GlobalWindow();
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    originalGetComputedStyle = globalThis.getComputedStyle;
    globalThis.getComputedStyle = globalThis.window.getComputedStyle.bind(globalThis.window);

    // Ensure test isolation from other suites that attach a mock ORPC client.
    // Share dialog tests operate on local ephemeral messages and should not race
    // onChat reconnect loops from unrelated WorkspaceStore tests.
    getStore().setClient(null);

    spyOn(console, "error").mockImplementation(() => undefined);

    spyOn(muxMd, "uploadToMuxMd").mockResolvedValue({
      url: "https://mux.md/s/share-1",
      id: "share-1",
      key: "encryption-key",
      mutateKey: "mutate-1",
      expiresAt: Date.now() + 60_000,
    });
    spyOn(muxMd, "deleteFromMuxMd").mockResolvedValue(undefined);
    getStore().addWorkspace({
      id: TEST_WORKSPACE_ID,
      name: "workspace-1",
      title: "Workspace 1",
      projectName: "project",
      projectPath: "/tmp/project",
      namedWorkspacePath: "/tmp/project/workspace-1",
      runtimeConfig: { type: "local" },
      createdAt: new Date().toISOString(),
    });
    addEphemeralMessage(TEST_WORKSPACE_ID, {
      id: "user-message-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
  });

  afterEach(() => {
    getStore().removeWorkspace(TEST_WORKSPACE_ID);
    cleanup();
    mock.restore();
    globalThis.getComputedStyle = originalGetComputedStyle;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("deletes an existing shared transcript link and clears the URL", async () => {
    renderDialog();
    const body = within(document.body);

    fireEvent.click(body.getByRole("button", { name: "Generate link" }));

    await waitFor(() => expect(body.getByTestId("share-transcript-url")).toBeTruthy());

    fireEvent.click(body.getByTestId("delete-share-transcript-url"));

    await waitFor(() => expect(muxMd.deleteFromMuxMd).toHaveBeenCalledWith("share-1", "mutate-1"));
    await waitFor(() => expect(body.queryByTestId("share-transcript-url")).toBeNull());
  });

  test("keeps shared transcript URL and surfaces an error when delete fails", async () => {
    (muxMd.deleteFromMuxMd as unknown as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.reject(new Error("Delete failed"))
    );

    renderDialog();
    const body = within(document.body);

    fireEvent.click(body.getByRole("button", { name: "Generate link" }));

    await waitFor(() => expect(body.getByTestId("share-transcript-url")).toBeTruthy());

    fireEvent.click(body.getByTestId("delete-share-transcript-url"));

    await waitFor(() => expect(muxMd.deleteFromMuxMd).toHaveBeenCalledWith("share-1", "mutate-1"));
    await waitFor(() => expect(body.getByRole("alert").textContent).toContain("Delete failed"));
    expect(body.getByTestId("share-transcript-url")).toBeTruthy();
  });
});
