import { useEffect, useRef } from "react";
import { useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { readPersistedState } from "./usePersistedState";
import { SELECTED_WORKSPACE_KEY } from "@/common/constants/storage";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar";

/**
 * Parses the current browser URL into a router-compatible location.
 * Handles backward compatibility with legacy hash URLs and localStorage.
 */
export function parseInitialUrl(): string {
  const { pathname, search, hash } = window.location;

  // Legacy hash URL: #workspace=abc123 → /workspace/abc123
  if (hash.startsWith("#workspace=")) {
    const workspaceId = decodeURIComponent(hash.substring("#workspace=".length));
    return `/workspace/${encodeURIComponent(workspaceId)}`;
  }

  // Legacy hash URL: #/path/to/project → /project?path=/path/to/project
  if (hash.length > 1 && !hash.startsWith("#/workspace") && !hash.startsWith("#/project")) {
    const projectPath = decodeURIComponent(hash.substring(1));
    return `/project?path=${encodeURIComponent(projectPath)}`;
  }

  // If URL is root (or about:blank in tests), check localStorage for saved workspace
  if ((pathname === "/" || pathname === "" || pathname === "blank") && !search) {
    const savedWorkspace = readPersistedState<WorkspaceSelection | null>(
      SELECTED_WORKSPACE_KEY,
      null
    );
    if (savedWorkspace?.workspaceId) {
      return `/workspace/${encodeURIComponent(savedWorkspace.workspaceId)}`;
    }
  }

  // Standard URL: use pathname + search
  return pathname + search;
}

/**
 * Syncs React Router's MemoryRouter state with the browser URL.
 * Uses replaceState to update URL without adding to history.
 *
 * This enables proper URLs while working with Electron's file:// protocol
 * in production, which doesn't support HTML5 pushState.
 */
export function useRouterUrlSync(): void {
  const location = useLocation();
  const initialSyncDone = useRef(false);

  useEffect(() => {
    // Skip sync in Storybook iframe to avoid test runner issues
    if (typeof window !== "undefined" && window.location.pathname.endsWith("iframe.html")) {
      return;
    }

    // Build the URL from router location
    const url = location.pathname + location.search;

    // Avoid unnecessary URL updates
    const currentUrl = window.location.pathname + window.location.search;
    if (url !== currentUrl) {
      window.history.replaceState(null, "", url);
    }

    initialSyncDone.current = true;
  }, [location.pathname, location.search]);
}

/**
 * Creates URL for navigating to a workspace
 */
export function workspaceUrl(workspaceId: string): string {
  return `/workspace/${encodeURIComponent(workspaceId)}`;
}

/**
 * Creates URL for the project page (workspace creation)
 */
export function projectUrl(projectPath: string): string {
  return `/project?path=${encodeURIComponent(projectPath)}`;
}

/**
 * Hook that returns typed navigation helpers
 */
export function useAppNavigate(): {
  navigate: NavigateFunction;
  toWorkspace: (workspaceId: string) => void;
  toProject: (projectPath: string) => void;
  toHome: () => void;
} {
  const navigate = useNavigate();

  return {
    navigate,
    toWorkspace: (workspaceId: string) => {
      void navigate(workspaceUrl(workspaceId), { replace: true });
    },
    toProject: (projectPath: string) => {
      void navigate(projectUrl(projectPath), { replace: true });
    },
    toHome: () => {
      void navigate("/", { replace: true });
    },
  };
}
