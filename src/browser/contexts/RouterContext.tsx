import { createContext, useContext, useEffect, type ReactNode } from "react";
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { SELECTED_WORKSPACE_KEY } from "@/common/constants/storage";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar";

export interface RouterContext {
  navigateToWorkspace: (workspaceId: string) => void;
  navigateToProject: (projectPath: string) => void;
  navigateToHome: () => void;
  currentWorkspaceId: string | null;
  currentProjectPath: string | null;
}

const RouterContext = createContext<RouterContext | undefined>(undefined);

export function useRouter(): RouterContext {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error("useRouter must be used within RouterProvider");
  }
  return ctx;
}

/** Parses browser URL into router path, restoring from localStorage at root. */
function parseInitialUrl(): string {
  const { pathname, search } = window.location;
  const isRoot =
    pathname === "/" ||
    pathname === "" ||
    pathname === "blank" ||
    pathname.endsWith("index.html") ||
    pathname.endsWith("iframe.html");
  const effectiveSearch = pathname.endsWith("iframe.html") ? "" : search;

  if (isRoot && !effectiveSearch) {
    const saved = readPersistedState<WorkspaceSelection | null>(SELECTED_WORKSPACE_KEY, null);
    if (saved?.workspaceId) return `/workspace/${encodeURIComponent(saved.workspaceId)}`;
  }
  return pathname + search;
}

/** Syncs MemoryRouter state to browser URL (skipped in Electron/Storybook). */
function useUrlSync(): void {
  const location = useLocation();
  useEffect(() => {
    if (window.location.pathname.endsWith("iframe.html")) return;
    if (window.location.protocol === "file:") return;
    const url = location.pathname + location.search;
    if (url !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", url);
    }
  }, [location.pathname, location.search]);
}

function RouterContextInner(props: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  useUrlSync();

  const workspaceMatch = /^\/workspace\/(.+)$/.exec(location.pathname);
  const currentWorkspaceId = workspaceMatch ? decodeURIComponent(workspaceMatch[1]) : null;
  const currentProjectPath = location.pathname === "/project" ? searchParams.get("path") : null;

  const value: RouterContext = {
    navigateToWorkspace: (id: string) =>
      void navigate(`/workspace/${encodeURIComponent(id)}`, { replace: true }),
    navigateToProject: (path: string) =>
      void navigate(`/project?path=${encodeURIComponent(path)}`, { replace: true }),
    navigateToHome: () => void navigate("/", { replace: true }),
    currentWorkspaceId,
    currentProjectPath,
  };

  return <RouterContext.Provider value={value}>{props.children}</RouterContext.Provider>;
}

export function RouterProvider(props: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={[parseInitialUrl()]}>
      <RouterContextInner>{props.children}</RouterContextInner>
    </MemoryRouter>
  );
}
