import { fireEvent, render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { useLocation } from "react-router-dom";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { TooltipProvider } from "@/browser/components/ui/tooltip";
import { SettingsButton } from "./SettingsButton";

function SettingsButtonTestHarness() {
  const location = useLocation();

  return (
    <>
      <SettingsButton />
      <div data-testid="pathname">{location.pathname}</div>
    </>
  );
}

describe("SettingsButton", () => {
  beforeEach(() => {
    const happyWindow = new GlobalWindow({ url: "https://mux.example.com/workspace/test" });
    globalThis.window = happyWindow as unknown as Window & typeof globalThis;
    globalThis.document = happyWindow.document as unknown as Document;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("switches to close mode while settings are open and restores previous route on click", async () => {
    const view = render(
      <RouterProvider>
        <SettingsProvider>
          <TooltipProvider delayDuration={0}>
            <SettingsButtonTestHarness />
          </TooltipProvider>
        </SettingsProvider>
      </RouterProvider>
    );

    const settingsButton = view.getByTestId("settings-button");
    expect(settingsButton.getAttribute("aria-label")).toBe("Open settings");

    fireEvent.click(settingsButton);

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/settings/general");
    });
    await waitFor(() => {
      expect(view.getByTestId("settings-button").getAttribute("aria-label")).toBe("Close settings");
    });

    fireEvent.click(view.getByTestId("settings-button"));

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/test");
    });
    await waitFor(() => {
      expect(view.getByTestId("settings-button").getAttribute("aria-label")).toBe("Open settings");
    });
  });
});
