import { createContext, useContext, type ReactNode } from "react";
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { parseInitialUrl, useRouterUrlSync } from "../hooks/useRouterUrlSync";

// Navigation context value
export interface RouterContextValue {
  // Navigation functions
  navigateToWorkspace: (workspaceId: string) => void;
  navigateToProject: (projectPath: string) => void;
  navigateToHome: () => void;
  // Current route state (derived from URL)
  currentWorkspaceId: string | null;
  currentProjectPath: string | null;
}

const RouterContext = createContext<RouterContextValue | null>(null);

export function useRouter(): RouterContextValue {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error("useRouter must be used within RouterProvider");
  }
  return ctx;
}

/**
 * Inner provider that has access to router hooks.
 * Parses URL to derive current workspace/project state.
 */
function RouterContextInner(props: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // Sync router state to browser URL
  useRouterUrlSync();

  // Parse workspace ID from pathname: /workspace/:workspaceId
  let currentWorkspaceId: string | null = null;
  const workspaceMatch = /^\/workspace\/(.+)$/.exec(location.pathname);
  if (workspaceMatch) {
    currentWorkspaceId = decodeURIComponent(workspaceMatch[1]);
  }

  // Parse project path from query: /project?path=...
  const currentProjectPath = location.pathname === "/project" ? searchParams.get("path") : null;

  const value: RouterContextValue = {
    navigateToWorkspace: (workspaceId: string) => {
      void navigate(`/workspace/${encodeURIComponent(workspaceId)}`, { replace: true });
    },
    navigateToProject: (projectPath: string) => {
      void navigate(`/project?path=${encodeURIComponent(projectPath)}`, { replace: true });
    },
    navigateToHome: () => {
      void navigate("/", { replace: true });
    },
    currentWorkspaceId,
    currentProjectPath,
  };

  return <RouterContext.Provider value={value}>{props.children}</RouterContext.Provider>;
}

/**
 * Main router provider that wraps app with MemoryRouter and context.
 * Handles backward compatibility with legacy hash URLs.
 */
export function RouterProvider(props: { children: ReactNode }) {
  // Parse initial URL for MemoryRouter (handles legacy hash URLs)
  const initialEntry = parseInitialUrl();

  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <RouterContextInner>{props.children}</RouterContextInner>
    </MemoryRouter>
  );
}
