import { createContext, useContext, type ReactNode } from "react";
import { HashRouter, useLocation, useNavigate, useSearchParams } from "react-router-dom";
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

// Restore workspace from localStorage before HashRouter mounts (synchronous)
function initializeHashFromStorage(): void {
  const hash = window.location.hash;
  // Only restore if at root (no hash path)
  if (!hash || hash === "#" || hash === "#/") {
    const saved = readPersistedState<WorkspaceSelection | null>(SELECTED_WORKSPACE_KEY, null);
    if (saved?.workspaceId) {
      window.location.hash = `#/workspace/${encodeURIComponent(saved.workspaceId)}`;
    }
  }
}

function RouterContextInner(props: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

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
  // Initialize hash before router mounts
  initializeHashFromStorage();

  return (
    <HashRouter>
      <RouterContextInner>{props.children}</RouterContextInner>
    </HashRouter>
  );
}
