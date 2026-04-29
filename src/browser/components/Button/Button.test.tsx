import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { Button } from "./Button";

describe("Button", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
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
