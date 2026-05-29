import { fireEvent, render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { useLocation } from "react-router-dom";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { SettingsButton } from "../SettingsButton/SettingsButton";

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
    if (typeof window === "undefined" || typeof document === "undefined") {
      const happyWindow = new GlobalWindow({ url: "https://mux.example.com/workspace/test" });
      globalThis.window = happyWindow as unknown as Window & typeof globalThis;
      globalThis.document = happyWindow.document as unknown as Document;
    }

    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
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

    const initialPathname = view.getByTestId("pathname").textContent;
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
      expect(view.getByTestId("pathname").textContent).toBe(initialPathname);
    });
    await waitFor(() => {
      expect(view.getByTestId("settings-button").getAttribute("aria-label")).toBe("Open settings");
    });
  });
});
