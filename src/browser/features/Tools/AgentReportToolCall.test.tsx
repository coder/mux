import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { AgentReportToolCall } from "./AgentReportToolCall";

describe("AgentReportToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    // Save original globals
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    // Set up test globals
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();

    // Restore original globals
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("renders reportMarkdown as markdown", () => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall
          args={{
            reportMarkdown: "# Hello\n\nWorld",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    // Validate that markdown body content renders regardless of whether another test
    // has mocked MarkdownCore into plain-text fallback mode in this Bun process.
    expect(view.getByText(/Hello/)).toBeTruthy();
    expect(view.getByText(/World/)).toBeTruthy();
  });
});
