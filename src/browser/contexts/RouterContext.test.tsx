import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { StrictMode } from "react";
import { useLocation } from "react-router-dom";
import type { WorkspaceSelection } from "@/browser/components/AgentListItem/AgentListItem";
import { LAUNCH_BEHAVIOR_KEY, SELECTED_WORKSPACE_KEY } from "@/common/constants/storage";
import { RouterProvider, useRouter, type RouterContext } from "./RouterContext";

function createMatchMedia(isStandalone = false): typeof window.matchMedia {
  return ((query: string) =>
    ({
      matches: isStandalone && query === "(display-mode: standalone)",
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    }) satisfies MediaQueryList) as typeof window.matchMedia;
}

function installWindow(url: string, options?: { isStandalone?: boolean }) {
  // Happy DOM can default to an opaque origin ("null") which breaks URL-based
  // logic in RouterContext. Give it a stable origin.
  const happyWindow = new GlobalWindow({ url });
  globalThis.window = happyWindow as unknown as Window & typeof globalThis;
  globalThis.document = happyWindow.document as unknown as Document;
  globalThis.window.matchMedia = createMatchMedia(options?.isStandalone);
  globalThis.window.localStorage.clear();
  globalThis.window.sessionStorage.clear();
}

function PathnameObserver() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

describe("navigateFromSettings", () => {
  beforeEach(() => {
    installWindow("https://mux.example.com/workspace/test");
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

describe("browser startup launch behavior", () => {
  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("dashboard mode ignores a stale /workspace/:id URL", async () => {
    installWindow("https://mux.example.com/workspace/stale-123");
    window.localStorage.setItem(LAUNCH_BEHAVIOR_KEY, JSON.stringify("dashboard"));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });
  });

  test("last-workspace mode preserves a /workspace/:id URL", async () => {
    installWindow("https://mux.example.com/workspace/stale-123");
    window.localStorage.setItem(LAUNCH_BEHAVIOR_KEY, JSON.stringify("last-workspace"));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/stale-123");
    });
  });

  test("dashboard mode still preserves non-workspace routes", async () => {
    installWindow("https://mux.example.com/settings/general");
    window.localStorage.setItem(LAUNCH_BEHAVIOR_KEY, JSON.stringify("dashboard"));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/settings/general");
    });
  });

  test("default launch behavior ignores a stale /workspace/:id URL", async () => {
    installWindow("https://mux.example.com/workspace/stale-123");

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });
  });
});

describe("standalone PWA startup", () => {
  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("shows the dashboard on cold launch even if the launch URL points at a workspace", async () => {
    installWindow("https://mux.example.com/workspace/last-opened", { isStandalone: true });

    const view = render(
      <StrictMode>
        <RouterProvider>
          <PathnameObserver />
        </RouterProvider>
      </StrictMode>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
      expect(window.sessionStorage.getItem("muxStandaloneSessionInitialized")).toBe("1");
    });
  });

  test("ignores last-workspace launch behavior in standalone mode", async () => {
    installWindow("https://mux.example.com/", { isStandalone: true });

    const savedWorkspace: WorkspaceSelection = {
      workspaceId: "workspace-123",
      projectPath: "/tmp/project",
      projectName: "Test Project",
      namedWorkspacePath: "/tmp/project/workspace-123",
    };
    window.localStorage.setItem(LAUNCH_BEHAVIOR_KEY, JSON.stringify("last-workspace"));
    window.localStorage.setItem(SELECTED_WORKSPACE_KEY, JSON.stringify(savedWorkspace));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });
  });

  test("preserves non-workspace deep links on cold standalone launch", async () => {
    installWindow("https://mux.example.com/settings/general", { isStandalone: true });

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/settings/general");
    });
  });

  test("still restores the current route on reloads inside the same standalone window", async () => {
    installWindow("https://mux.example.com/workspace/reload-me", { isStandalone: true });
    window.sessionStorage.setItem("muxStandaloneSessionInitialized", "1");

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/reload-me");
    });
  });
});
