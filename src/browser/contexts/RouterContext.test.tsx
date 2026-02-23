import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { useLocation } from "react-router-dom";
import { RouterProvider, useRouter, type RouterContext } from "./RouterContext";

describe("navigateFromSettings", () => {
  beforeEach(() => {
    // Happy DOM can default to an opaque origin ("null") which breaks URL-based
    // logic in RouterContext. Give it a stable origin.
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

  test("restores the previous location.state when leaving settings", async () => {
    let latestRouter: RouterContext | null = null;

    function Observer() {
      const router = useRouter();
      const location = useLocation();
      latestRouter = router;

      return (
        <div>
          <div data-testid="pathname">{location.pathname}</div>
          <div data-testid="projectPathFromState">{router.currentProjectPathFromState ?? ""}</div>
        </div>
      );
    }

    const view = render(
      <RouterProvider>
        <Observer />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(latestRouter).not.toBeNull();
    });

    // Use a project path that cannot be recovered from the URL alone, so losing
    // location.state would break the /project view.
    const projectPath = "/tmp/unconfigured-project";

    act(() => {
      latestRouter!.navigateToProject(projectPath);
    });

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/project");
      expect(view.getByTestId("projectPathFromState").textContent).toBe(projectPath);
    });

    // Allow effects to flush so RouterContext has a chance to snapshot the last
    // non-settings location before we navigate into settings.
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      latestRouter!.navigateToSettings("general");
    });

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/settings/general");
    });

    act(() => {
      latestRouter!.navigateFromSettings();
    });

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/project");
      expect(view.getByTestId("projectPathFromState").textContent).toBe(projectPath);
    });
  });
});
