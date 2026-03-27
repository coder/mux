import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  render(
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

  return { onSetPendingUrl };
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
    renderToolbar({ isConnected: false });

    expect(screen.getByLabelText("Back").disabled).toBe(true);
    expect(screen.getByLabelText("Forward").disabled).toBe(true);
    expect(screen.getByLabelText("Reload").disabled).toBe(true);
    expect(screen.getByLabelText("Browser URL").disabled).toBe(true);
  });

  test("disables all controls when no session is selected", () => {
    renderToolbar({ sessionName: null });

    expect(screen.getByLabelText("Back").disabled).toBe(true);
    expect(screen.getByLabelText("Forward").disabled).toBe(true);
    expect(screen.getByLabelText("Reload").disabled).toBe(true);
    expect(screen.getByLabelText("Browser URL").disabled).toBe(true);
  });

  test("shows the current URL when there is no pending navigation", () => {
    renderToolbar({ currentUrl: "https://current.example.com" });

    expect(screen.getByLabelText("Browser URL").value).toBe("https://current.example.com");
  });

  test("shows the pending URL when optimistic navigation is active", () => {
    renderToolbar({ pendingUrl: "https://pending.example.com" });

    expect(screen.getByLabelText("Browser URL").value).toBe("https://pending.example.com");
  });

  test("submits URL navigation on Enter", async () => {
    const { onSetPendingUrl } = renderToolbar();
    const input = screen.getByLabelText("Browser URL");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "https://next.example.com" } });
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
    renderToolbar();

    fireEvent.click(screen.getByLabelText("Back"));
    fireEvent.click(screen.getByLabelText("Forward"));
    fireEvent.click(screen.getByLabelText("Reload"));

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
    renderToolbar({ isPageLoading: true });

    expect(screen.getByTestId("browser-toolbar-loading-icon")).toBeTruthy();
    expect(screen.queryByTestId("browser-toolbar-reload-icon")).toBeNull();
  });

  test("Escape blurs the URL input", () => {
    renderToolbar();
    const input = screen.getByLabelText("Browser URL");

    fireEvent.focus(input);
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });

    expect(document.activeElement).not.toBe(input);
  });
});
