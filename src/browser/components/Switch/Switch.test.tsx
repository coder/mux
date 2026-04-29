import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { Switch } from "./Switch";

describe("Switch", () => {
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
    const onCheckedChange = mock((_checked: boolean) => null);
    const view = render(
      <TooltipProvider delayDuration={0}>
        <Switch checked={false} onCheckedChange={onCheckedChange} title="Toggle feature" />
      </TooltipProvider>
    );

    const switchElement = view.getByRole("switch", { name: "Toggle feature" });
    expect(switchElement.getAttribute("title")).toBeNull();
  });
});
