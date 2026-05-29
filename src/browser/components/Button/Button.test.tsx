import { cleanup, render } from "@testing-library/react";
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

  test("uses title as the accessible name without leaving a native title", () => {
    const view = render(
      <TooltipProvider delayDuration={0}>
        <Button title="Save changes (Enter)" size="icon">
          <span aria-hidden="true">*</span>
        </Button>
      </TooltipProvider>
    );

    const button = view.getByRole("button", { name: "Save changes (Enter)" });
    expect(button.getAttribute("title")).toBeNull();
  });
});
