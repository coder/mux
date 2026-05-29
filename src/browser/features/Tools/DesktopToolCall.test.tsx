import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { DesktopActionToolCall } from "./DesktopActionToolCall";
import { DesktopScreenshotToolCall } from "./DesktopScreenshotToolCall";

describe("desktop tool call renderers", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("DesktopActionToolCall prefers backend messages and shows errors inline", () => {
    const successView = render(
      <TooltipProvider>
        <DesktopActionToolCall
          toolName="desktop_click"
          args={{ x: 12, y: 34 }}
          result={{ success: true, message: "Clicked at (12, 34)" }}
          status="completed"
        />
      </TooltipProvider>
    );

    expect(successView.getByText("Clicked at (12, 34)")).toBeTruthy();
    successView.unmount();

    const errorView = render(
      <TooltipProvider>
        <DesktopActionToolCall
          toolName="desktop_key_press"
          args={{ key: "ctrl+shift+p" }}
          result={{ success: false, error: "Key press failed" }}
          status="failed"
        />
      </TooltipProvider>
    );

    expect(errorView.getByText("Pressed: ctrl+shift+p")).toBeTruthy();
    expect(errorView.getByText("Key press failed")).toBeTruthy();
  });

  test("DesktopScreenshotToolCall renders inline previews and parsed dimensions", () => {
    const view = render(
      <TooltipProvider>
        <DesktopScreenshotToolCall
          args={{ scaledWidth: 640, scaledHeight: 360 }}
          result={{
            type: "content",
            value: [
              {
                type: "text",
                text: "Desktop screenshot captured: 1280x720",
              },
              {
                type: "media",
                mediaType: "image/png",
                data: "cG5nLWRhdGE=",
              },
            ],
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    expect(view.getAllByText("1280×720").length).toBeGreaterThan(0);
    expect(view.getByText("Scale hint: 640×360")).toBeTruthy();
    expect(view.getByAltText("Tool result image 1")).toBeTruthy();
  });
});
