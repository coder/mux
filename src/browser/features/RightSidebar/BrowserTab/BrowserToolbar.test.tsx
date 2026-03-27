import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { ComponentProps } from "react";

const controlMock = mock(() => Promise.resolve(undefined));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      browser: {
        control: controlMock,
      },
    },
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { BrowserToolbar } from "./BrowserToolbar";

function renderToolbar(overrides: Partial<ComponentProps<typeof BrowserToolbar>> = {}) {
  const onSetPendingUrl = mock(() => undefined);

  const view = render(
    <BrowserToolbar
      workspaceId="workspace-1"
      sessionName="session-a"
      currentUrl="https://current.example.com"
      pendingUrl={null}
      isPageLoading={false}
      isConnected={true}
      onSetPendingUrl={onSetPendingUrl}
      {...overrides}
    />
  );

  return { onSetPendingUrl, ...view };
}

describe("BrowserToolbar", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    controlMock.mockReset();
    controlMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("disables all controls when the bridge is disconnected", () => {
    const view = renderToolbar({ isConnected: false });

    expect((view.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Forward") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Reload") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Browser URL") as HTMLInputElement).disabled).toBe(true);
  });

  test("disables all controls when no session is selected", () => {
    const view = renderToolbar({ sessionName: null });

    expect((view.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Forward") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Reload") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Browser URL") as HTMLInputElement).disabled).toBe(true);
  });

  test("shows the current URL when there is no pending navigation", () => {
    const view = renderToolbar({ currentUrl: "https://current.example.com" });

    expect((view.getByLabelText("Browser URL") as HTMLInputElement).value).toBe(
      "https://current.example.com"
    );
  });

  test("shows the pending URL when optimistic navigation is active", () => {
    const view = renderToolbar({ pendingUrl: "https://pending.example.com" });

    expect((view.getByLabelText("Browser URL") as HTMLInputElement).value).toBe(
      "https://pending.example.com"
    );
  });

  test("submits URL navigation on Enter", async () => {
    const { onSetPendingUrl, getByLabelText } = renderToolbar({
      pendingUrl: "https://next.example.com",
    });
    const input = getByLabelText("Browser URL") as HTMLInputElement;

    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetPendingUrl).toHaveBeenCalledWith("https://next.example.com");
    await waitFor(() => {
      expect(controlMock).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sessionName: "session-a",
        action: "open",
        url: "https://next.example.com",
      });
    });
  });

  test("sends back, forward, and reload commands", async () => {
    const view = renderToolbar();

    fireEvent.click(view.getByLabelText("Back"));
    fireEvent.click(view.getByLabelText("Forward"));
    fireEvent.click(view.getByLabelText("Reload"));

    await waitFor(() => {
      expect(controlMock).toHaveBeenNthCalledWith(1, {
        workspaceId: "workspace-1",
        sessionName: "session-a",
        action: "back",
      });
      expect(controlMock).toHaveBeenNthCalledWith(2, {
        workspaceId: "workspace-1",
        sessionName: "session-a",
        action: "forward",
      });
      expect(controlMock).toHaveBeenNthCalledWith(3, {
        workspaceId: "workspace-1",
        sessionName: "session-a",
        action: "reload",
      });
    });
  });

  test("shows a spinning loading icon while the page is loading", () => {
    const view = renderToolbar({ isPageLoading: true });

    expect(view.getByTestId("browser-toolbar-loading-icon")).toBeTruthy();
    expect(view.queryByTestId("browser-toolbar-reload-icon")).toBeNull();
  });

  test("Escape blurs the URL input", () => {
    const view = renderToolbar();
    const input = view.getByLabelText("Browser URL") as HTMLInputElement;

    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });

    expect(document.activeElement).not.toBe(input);
  });
});
