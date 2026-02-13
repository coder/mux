import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render, waitFor } from "@testing-library/react";

type GetPlanContentResult =
  | { success: true; data: { content: string; path: string } }
  | { success: false; error: string };

interface MockApiClient {
  workspace: {
    getPlanContent: () => Promise<GetPlanContentResult>;
  };
}

let mockApi: MockApiClient | null = null;

void mock.module("@/browser/components/ui/dialog", () => ({
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

void mock.module("@/browser/components/Messages/MarkdownCore", () => ({
  MarkdownCore: (props: { content: string }) => (
    <div data-testid="plan-markdown-core">{props.content}</div>
  ),
}));

void mock.module("@/browser/components/Messages/MarkdownRenderer", () => ({
  PlanMarkdownContainer: (props: { children: ReactNode }) => (
    <div data-testid="plan-markdown-container">{props.children}</div>
  ),
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: mockApi ? "connected" : "error",
    error: mockApi ? null : "API unavailable",
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { PlanFileDialog } from "./PlanFileDialog";

describe("PlanFileDialog", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    mockApi = null;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("fetches plan content only after the dialog opens", async () => {
    const getPlanContent = mock(() =>
      Promise.resolve({
        success: true,
        data: {
          content: "# Plan title\n\n- item",
          path: "/tmp/plan.md",
        },
      } satisfies GetPlanContentResult)
    );

    mockApi = {
      workspace: {
        getPlanContent,
      },
    };

    const onOpenChange = () => undefined;
    const view = render(
      <PlanFileDialog open={false} onOpenChange={onOpenChange} workspaceId="workspace-1" />
    );

    expect(getPlanContent).toHaveBeenCalledTimes(0);

    view.rerender(<PlanFileDialog open onOpenChange={onOpenChange} workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(getPlanContent).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(view.getByTestId("plan-markdown-core").textContent).toContain("# Plan title");
    });

    expect(view.getByText("/tmp/plan.md")).toBeTruthy();
  });

  test("shows API error responses in the dialog", async () => {
    const getPlanContent = mock(() =>
      Promise.resolve({
        success: false,
        error: "Plan file not found",
      } satisfies GetPlanContentResult)
    );

    mockApi = {
      workspace: {
        getPlanContent,
      },
    };

    const view = render(
      <PlanFileDialog open onOpenChange={() => undefined} workspaceId="workspace-2" />
    );

    await waitFor(() => {
      expect(getPlanContent).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(view.getByTestId("plan-file-dialog-error").textContent).toContain(
        "Plan file not found"
      );
    });
  });

  test("renders API-unavailable state when not connected", async () => {
    mockApi = null;

    const view = render(
      <PlanFileDialog open onOpenChange={() => undefined} workspaceId="workspace-3" />
    );

    await waitFor(() => {
      expect(view.getByTestId("plan-file-dialog-error").textContent).toContain("API unavailable");
    });
  });
});
