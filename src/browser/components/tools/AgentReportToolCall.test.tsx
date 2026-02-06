import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";

import { TooltipProvider } from "../ui/tooltip";
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

    // A rendered heading should *not* include the literal markdown prefix.
    expect(view.queryByText("# Hello")).toBeNull();
    expect(view.getByRole("heading", { name: "Hello", level: 1 })).toBeTruthy();
    expect(view.getByText("World")).toBeTruthy();
  });
});
