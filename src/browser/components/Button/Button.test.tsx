import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { Button } from "./Button";

describe("Button", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("uses title as the tooltip source while preserving the accessible name for icon-only buttons", async () => {
    const view = render(
      <TooltipProvider delayDuration={0}>
        <Button title="Save changes (Enter)" size="icon">
          <span aria-hidden="true">*</span>
        </Button>
      </TooltipProvider>
    );

    const button = view.getByRole("button", { name: "Save changes (Enter)" });
    expect(button.getAttribute("title")).toBeNull();
    expect(button.getAttribute("data-state")).toBe("closed");

    fireEvent.focus(button);

    await waitFor(() => {
      expect(button.getAttribute("data-state")).not.toBe("closed");
    });
  });
});
