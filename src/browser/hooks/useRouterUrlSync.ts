import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { readPersistedState } from "./usePersistedState";
import { SELECTED_WORKSPACE_KEY } from "@/common/constants/storage";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar";

/**
 * Parses the current browser URL into a router-compatible location.
 * Restores last workspace from localStorage when at root URL.
 */
export function parseInitialUrl(): string {
  const { pathname, search } = window.location;

  // If URL is at root (dev server), about:blank (tests), file:// path (packaged Electron),
  // or iframe.html (Storybook), check localStorage for saved workspace from previous session
  const isRootOrFileUrl =
    pathname === "/" ||
    pathname === "" ||
    pathname === "blank" ||
    pathname.endsWith("index.html") ||
    pathname.endsWith("iframe.html");
  // For iframe.html (Storybook), ignore search params when checking for root URL
  const effectiveSearch = pathname.endsWith("iframe.html") ? "" : search;
  if (isRootOrFileUrl && !effectiveSearch) {
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
 * In browser/server mode, this enables proper URLs that survive refresh.
 * In Electron (file:// protocol), we skip URL sync since it would break page reload.
 */
export function useRouterUrlSync(): void {
  const location = useLocation();

  useEffect(() => {
    // Skip sync in Storybook iframe to avoid test runner issues
    if (typeof window !== "undefined" && window.location.pathname.endsWith("iframe.html")) {
      return;
    }

    // Skip sync in Electron (file:// protocol) - updating URL would break page reload
    // since Electron would try to load /workspace/abc as a file instead of index.html
    if (window.location.protocol === "file:") {
      return;
    }

    // Build the URL from router location
    const url = location.pathname + location.search;

    // Avoid unnecessary URL updates
    const currentUrl = window.location.pathname + window.location.search;
    if (url !== currentUrl) {
      window.history.replaceState(null, "", url);
    }
  }, [location.pathname, location.search]);
}
