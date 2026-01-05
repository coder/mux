import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { SELECTED_WORKSPACE_KEY } from "@/common/constants/storage";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar";

export interface RouterContext {
  navigateToWorkspace: (workspaceId: string) => void;
  navigateToProject: (projectPath: string, sectionId?: string) => void;
  navigateToHome: () => void;
  currentWorkspaceId: string | null;
  currentProjectPath: string | null;
  /** Section ID for pending workspace creation (from URL) */
  pendingSectionId: string | null;
}

const RouterContext = createContext<RouterContext | undefined>(undefined);

export function useRouter(): RouterContext {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error("useRouter must be used within RouterProvider");
  }
  return ctx;
}

/** Get initial route from browser URL or localStorage. */
function getInitialRoute(): string {
  // In browser mode, read route directly from URL (enables refresh restoration)
  if (window.location.protocol !== "file:" && !window.location.pathname.endsWith("iframe.html")) {
    const url = window.location.pathname + window.location.search;
    // Only use URL if it's a valid route (starts with /, not just "/" or empty)
    if (url.startsWith("/") && url !== "/") {
      return url;
    }
  }

  // In Electron (file://), fallback to localStorage for workspace restoration
  const savedWorkspace = readPersistedState<WorkspaceSelection | null>(
    SELECTED_WORKSPACE_KEY,
    null
  );
  if (savedWorkspace?.workspaceId) {
    return `/workspace/${encodeURIComponent(savedWorkspace.workspaceId)}`;
  }
  return "/";
}

/** Sync router state to browser URL (dev server only, not Electron/Storybook). */
function useUrlSync(): void {
  const location = useLocation();
  useEffect(() => {
    // Skip in Storybook (conflicts with story navigation)
    if (window.location.pathname.endsWith("iframe.html")) return;
    // Skip in Electron (file:// breaks on reload)
    if (window.location.protocol === "file:") return;

    const url = location.pathname + location.search;
    if (url !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", url);
    }
  }, [location.pathname, location.search]);
}

function RouterContextInner(props: { children: ReactNode }) {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const location = useLocation();
  const [searchParams] = useSearchParams();
  useUrlSync();

  const workspaceMatch = /^\/workspace\/(.+)$/.exec(location.pathname);
  const currentWorkspaceId = workspaceMatch ? decodeURIComponent(workspaceMatch[1]) : null;
  const currentProjectPath = location.pathname === "/project" ? searchParams.get("path") : null;
  const pendingSectionId = location.pathname === "/project" ? searchParams.get("section") : null;

  const navigateToWorkspace = useCallback((id: string) => {
    void navigateRef.current(`/workspace/${encodeURIComponent(id)}`, { replace: true });
  }, []);

  const navigateToProject = useCallback((path: string, sectionId?: string) => {
    const url = sectionId
      ? `/project?path=${encodeURIComponent(path)}&section=${encodeURIComponent(sectionId)}`
      : `/project?path=${encodeURIComponent(path)}`;
    void navigateRef.current(url, { replace: true });
  }, []);

  const navigateToHome = useCallback(() => {
    void navigateRef.current("/", { replace: true });
  }, []);

  const value = useMemo<RouterContext>(
    () => ({
      navigateToWorkspace,
      navigateToProject,
      navigateToHome,
      currentWorkspaceId,
      currentProjectPath,
      pendingSectionId,
    }),
    [
      navigateToHome,
      navigateToProject,
      navigateToWorkspace,
      currentProjectPath,
      currentWorkspaceId,
      pendingSectionId,
    ]
  );

  return <RouterContext.Provider value={value}>{props.children}</RouterContext.Provider>;
}

export function RouterProvider(props: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={[getInitialRoute()]}>
      <RouterContextInner>{props.children}</RouterContextInner>
    </MemoryRouter>
  );
}
