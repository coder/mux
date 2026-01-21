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
import { getProjectRouteId } from "@/common/utils/projectRouteId";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar";

export interface RouterContext {
  navigateToWorkspace: (workspaceId: string) => void;
  navigateToProject: (projectPath: string, sectionId?: string) => void;
  navigateToHome: () => void;
  currentWorkspaceId: string | null;

  /** Project identifier from URL (does not include full filesystem path). */
  currentProjectId: string | null;

  /** Optional project path carried via in-memory navigation state (not persisted on refresh). */
  currentProjectPathFromState: string | null;

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
  function getProjectPathFromLocationState(state: unknown): string | null {
    if (!state || typeof state !== "object") return null;
    if (!("projectPath" in state)) return null;
    const projectPath = (state as { projectPath?: unknown }).projectPath;
    return typeof projectPath === "string" ? projectPath : null;
  }

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
  const currentProjectId =
    location.pathname === "/project"
      ? (searchParams.get("project") ?? searchParams.get("path"))
      : null;
  const currentProjectPathFromState =
    location.pathname === "/project" ? getProjectPathFromLocationState(location.state) : null;

  // Back-compat: if we ever land on a legacy deep link (/project?path=<full path>),
  // immediately replace it with the non-path project id URL.
  useEffect(() => {
    if (location.pathname !== "/project") return;

    const params = new URLSearchParams(location.search);
    const legacyPath = params.get("path");
    const projectParam = params.get("project");
    if (!projectParam && legacyPath) {
      const section = params.get("section");
      const projectId = getProjectRouteId(legacyPath);
      const url = section
        ? `/project?project=${encodeURIComponent(projectId)}&section=${encodeURIComponent(section)}`
        : `/project?project=${encodeURIComponent(projectId)}`;
      void navigateRef.current(url, { replace: true, state: { projectPath: legacyPath } });
    }
  }, [location.pathname, location.search]);
  const pendingSectionId = location.pathname === "/project" ? searchParams.get("section") : null;

  const navigateToWorkspace = useCallback((id: string) => {
    void navigateRef.current(`/workspace/${encodeURIComponent(id)}`, { replace: true });
  }, []);

  const navigateToProject = useCallback((path: string, sectionId?: string) => {
    const projectId = getProjectRouteId(path);
    const url = sectionId
      ? `/project?project=${encodeURIComponent(projectId)}&section=${encodeURIComponent(sectionId)}`
      : `/project?project=${encodeURIComponent(projectId)}`;
    void navigateRef.current(url, { replace: true, state: { projectPath: path } });
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
      currentProjectId,
      currentProjectPathFromState,
      pendingSectionId,
    }),
    [
      navigateToHome,
      navigateToProject,
      navigateToWorkspace,
      currentProjectId,
      currentProjectPathFromState,
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
