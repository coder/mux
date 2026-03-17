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

  test("treats title as custom tooltip content instead of forwarding a native title attribute", async () => {
    const view = render(
      <TooltipProvider delayDuration={0}>
        <Button title="Open sidebar">Open</Button>
      </TooltipProvider>
    );

    const button = view.getByRole("button", { name: "Open" });
    expect(button.getAttribute("title")).toBeNull();
    expect(button.getAttribute("data-state")).toBe("closed");

    fireEvent.focus(button);

    await waitFor(() => {
      expect(button.getAttribute("data-state")).not.toBe("closed");
    });
  });
});
