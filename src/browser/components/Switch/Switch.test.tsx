import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { Switch } from "./Switch";

describe("Switch", () => {
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

  test("uses title as the tooltip source while preserving the accessible name", async () => {
    const onCheckedChange = mock((_checked: boolean) => null);
    const view = render(
      <TooltipProvider delayDuration={0}>
        <Switch checked={false} onCheckedChange={onCheckedChange} title="Toggle feature" />
      </TooltipProvider>
    );

    const switchElement = view.getByRole("switch", { name: "Toggle feature" });
    expect(switchElement.getAttribute("title")).toBeNull();
    expect(switchElement.getAttribute("data-state")).toBe("closed");

    fireEvent.focus(switchElement);

    await waitFor(() => {
      expect(switchElement.getAttribute("data-state")).not.toBe("closed");
    });
  });
});
