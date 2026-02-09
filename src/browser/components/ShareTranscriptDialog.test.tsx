import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { TooltipProvider } from "@/browser/components/ui/tooltip";

const uploadToMuxMdMock = mock(() =>
  Promise.resolve({
    url: "https://mux.md/s/share-1",
    id: "share-1",
    mutateKey: "mutate-1",
    expiresAt: Date.now() + 60_000,
  })
);

const deleteFromMuxMdMock = mock(() => Promise.resolve(undefined));
const updateMuxMdExpirationMock = mock(() => Promise.resolve(Date.now() + 60_000));
const buildChatJsonlForSharingMock = mock(() => '{"role":"user","parts":[]}');
const getWorkspaceStateMock = mock(() => ({
  muxMessages: [],
  currentModel: null,
  currentThinkingLevel: null,
}));

void mock.module("@/common/lib/muxMd", () => ({
  uploadToMuxMd: uploadToMuxMdMock,
  deleteFromMuxMd: deleteFromMuxMdMock,
  updateMuxMdExpiration: updateMuxMdExpirationMock,
}));

void mock.module("@/browser/components/ui/dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode; className?: string }) => (
    <h2 className={props.className}>{props.children}</h2>
  ),
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: null,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({
    workspaceMetadata: new Map<string, { title?: string }>(),
  }),
}));

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useWorkspaceStoreRaw: () => ({
    getWorkspaceState: getWorkspaceStateMock,
  }),
}));

void mock.module("@/common/utils/messages/transcriptShare", () => ({
  buildChatJsonlForSharing: buildChatJsonlForSharingMock,
}));

void mock.module("@/browser/utils/messages/sendOptions", () => ({
  getSendOptionsFromStorage: () => ({
    model: "claude-sonnet-4-20250514",
    thinkingLevel: "high",
  }),
}));

import { ShareTranscriptDialog } from "./ShareTranscriptDialog";

function renderDialog() {
  return render(
    <TooltipProvider>
      <ShareTranscriptDialog
        workspaceId="ws-1"
        workspaceName="workspace-1"
        workspaceTitle="Workspace 1"
        open
        onOpenChange={() => undefined}
      />
    </TooltipProvider>
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

    uploadToMuxMdMock.mockReset();
    uploadToMuxMdMock.mockResolvedValue({
      url: "https://mux.md/s/share-1",
      id: "share-1",
      mutateKey: "mutate-1",
      expiresAt: Date.now() + 60_000,
    });

    deleteFromMuxMdMock.mockReset();
    deleteFromMuxMdMock.mockResolvedValue(undefined);

    updateMuxMdExpirationMock.mockReset();
    updateMuxMdExpirationMock.mockResolvedValue(Date.now() + 60_000);

    buildChatJsonlForSharingMock.mockReset();
    buildChatJsonlForSharingMock.mockReturnValue('{"role":"user","parts":[]}');

    getWorkspaceStateMock.mockReset();
    getWorkspaceStateMock.mockReturnValue({
      muxMessages: [],
      currentModel: null,
      currentThinkingLevel: null,
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.getComputedStyle = originalGetComputedStyle;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("deletes an existing shared transcript link and clears the URL", async () => {
    const view = renderDialog();

    fireEvent.click(view.getByRole("button", { name: "Generate link" }));

    await waitFor(() => expect(view.getByTestId("share-transcript-url")).toBeTruthy());

    fireEvent.click(view.getByTestId("delete-share-transcript-url"));

    await waitFor(() => expect(deleteFromMuxMdMock).toHaveBeenCalledWith("share-1", "mutate-1"));
    await waitFor(() => expect(view.queryByTestId("share-transcript-url")).toBeNull());
  });

  test("keeps shared transcript URL and surfaces an error when delete fails", async () => {
    deleteFromMuxMdMock.mockImplementationOnce(() => Promise.reject(new Error("Delete failed")));

    const view = renderDialog();

    fireEvent.click(view.getByRole("button", { name: "Generate link" }));

    await waitFor(() => expect(view.getByTestId("share-transcript-url")).toBeTruthy());

    fireEvent.click(view.getByTestId("delete-share-transcript-url"));

    await waitFor(() => expect(deleteFromMuxMdMock).toHaveBeenCalledWith("share-1", "mutate-1"));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Delete failed"));
    expect(view.getByTestId("share-transcript-url")).toBeTruthy();
  });
});
