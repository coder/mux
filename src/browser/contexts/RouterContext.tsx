import { createContext, useContext, useEffect, type ReactNode } from "react";
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

function RouterContextInner(props: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // Restore from localStorage on first load at root
  useEffect(() => {
    if (location.pathname === "/") {
      const saved = readPersistedState<WorkspaceSelection | null>(SELECTED_WORKSPACE_KEY, null);
      if (saved?.workspaceId) {
        void navigate(`/workspace/${encodeURIComponent(saved.workspaceId)}`, { replace: true });
      }
    }
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <HashRouter>
      <RouterContextInner>{props.children}</RouterContextInner>
    </HashRouter>
  );
}
