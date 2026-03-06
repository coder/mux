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
import {
  LAUNCH_BEHAVIOR_KEY,
  SELECTED_WORKSPACE_KEY,
  type LaunchBehavior,
} from "@/common/constants/storage";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar/ProjectSidebar";
import { getProjectRouteId } from "@/common/utils/projectRouteId";

export interface RouterContext {
  navigateToWorkspace: (workspaceId: string) => void;
  navigateToProject: (
    projectPath: string,
    sectionId?: string,
    draftId?: string,
    projectId?: string | null
  ) => void;
  replaceProjectSelector: (params: {
    projectPath: string;
    projectId?: string | null;
    sectionId?: string | null;
    draftId?: string | null;
  }) => void;
  navigateToHome: () => void;
  navigateToSettings: (section?: string) => void;
  navigateFromSettings: () => void;
  navigateToAnalytics: () => void;
  navigateFromAnalytics: () => void;
  currentWorkspaceId: string | null;

  /** Settings section from URL (null when not on settings page). */
  currentSettingsSection: string | null;

  /** Project identifier from URL (does not include full filesystem path). */
  currentProjectId: string | null;

  /** Optional project path carried via in-memory navigation state (not persisted on refresh). */
  currentProjectPathFromState: string | null;

  /** Section ID for pending workspace creation (from URL) */
  pendingSectionId: string | null;

  /** Draft ID for UI-only workspace creation drafts (from URL) */
  pendingDraftId: string | null;

  /** True when the analytics dashboard route is active. */
  isAnalyticsOpen: boolean;
}

const RouterContext = createContext<RouterContext | undefined>(undefined);

export function useRouter(): RouterContext {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error("useRouter must be used within RouterProvider");
  }
  return ctx;
}

/** Get initial route from browser URL or default to home. */
function getInitialRoute(): string {
  const isStorybook = window.location.pathname.endsWith("iframe.html");

  // In browser mode (not Storybook), read route directly from URL (enables refresh restoration)
  if (window.location.protocol !== "file:" && !isStorybook) {
    const url = window.location.pathname + window.location.search;
    // Only use URL if it's a valid route (starts with /, not just "/" or empty)
    if (url.startsWith("/") && url !== "/") {
      return url;
    }
  }

  // In Storybook, stories seed localStorage via selectWorkspace() during setup.
  // Read that selection so stories start at the correct workspace view.
  if (isStorybook) {
    const savedWorkspace = readPersistedState<WorkspaceSelection | null>(
      SELECTED_WORKSPACE_KEY,
      null
    );
    if (savedWorkspace?.workspaceId) {
      return `/workspace/${encodeURIComponent(savedWorkspace.workspaceId)}`;
    }
  }

  const launchBehavior = readPersistedState<LaunchBehavior>(LAUNCH_BEHAVIOR_KEY, "dashboard");
  if (launchBehavior === "last-workspace") {
    const savedWorkspace = readPersistedState<WorkspaceSelection | null>(
      SELECTED_WORKSPACE_KEY,
      null
    );
    if (savedWorkspace?.workspaceId) {
      return `/workspace/${encodeURIComponent(savedWorkspace.workspaceId)}`;
    }
  }

  // "dashboard" and "new-chat" both start at /
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

function toNonEmptyTrimmed(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
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
  const settingsMatch = /^\/settings\/([^/]+)$/.exec(location.pathname);
  const currentSettingsSection = settingsMatch ? decodeURIComponent(settingsMatch[1]) : null;
  const isAnalyticsOpen = location.pathname === "/analytics";

  interface NonSettingsLocationSnapshot {
    url: string;
    state: unknown;
  }

  // When leaving settings, we need to restore the *full* previous location including
  // any in-memory navigation state (e.g. /project relies on { projectPath } state, and
  // the legacy ?path= deep link rewrite stores that path in location.state).
  // Include /analytics so Settings opened from Analytics can close back to Analytics.
  const lastNonSettingsLocationRef = useRef<NonSettingsLocationSnapshot>({
    url: getInitialRoute(),
    state: null,
  });
  // Keep a separate "close analytics" snapshot that intentionally excludes /analytics so
  // closing analytics still returns to the last non-analytics route.
  const lastNonAnalyticsLocationRef = useRef<NonSettingsLocationSnapshot>({
    url: getInitialRoute(),
    state: null,
  });
  useEffect(() => {
    if (!location.pathname.startsWith("/settings")) {
      const locationSnapshot: NonSettingsLocationSnapshot = {
        url: location.pathname + location.search,
        state: location.state,
      };
      lastNonSettingsLocationRef.current = locationSnapshot;
      if (location.pathname !== "/analytics") {
        lastNonAnalyticsLocationRef.current = locationSnapshot;
      }
    }
  }, [location.pathname, location.search, location.state]);

  const buildProjectUrl = useCallback(
    (params: {
      projectPath: string;
      projectId?: string | null;
      sectionId?: string | null;
      draftId?: string | null;
    }): string => {
      const selector = toNonEmptyTrimmed(params.projectId) ?? getProjectRouteId(params.projectPath);
      const nextParams = new URLSearchParams();
      nextParams.set("project", selector);

      const sectionId = toNonEmptyTrimmed(params.sectionId);
      if (sectionId) {
        nextParams.set("section", sectionId);
      }

      const draftId = toNonEmptyTrimmed(params.draftId);
      if (draftId) {
        nextParams.set("draft", draftId);
      }

      return `/project?${nextParams.toString()}`;
    },
    []
  );

  const replaceProjectSelector = useCallback(
    (params: {
      projectPath: string;
      projectId?: string | null;
      sectionId?: string | null;
      draftId?: string | null;
    }) => {
      const url = buildProjectUrl(params);
      void navigateRef.current(url, {
        replace: true,
        state: { projectPath: params.projectPath },
      });
    },
    [buildProjectUrl]
  );

  // Back-compat: if we ever land on a legacy deep link (/project?path=<full path>),
  // immediately replace it with the non-path project selector URL.
  useEffect(() => {
    if (location.pathname !== "/project") return;

    const params = new URLSearchParams(location.search);
    const legacyPath = params.get("path");
    const projectParam = params.get("project");
    if (!projectParam && legacyPath) {
      replaceProjectSelector({
        projectPath: legacyPath,
        sectionId: params.get("section"),
        draftId: params.get("draft"),
      });
    }
  }, [location.pathname, location.search, replaceProjectSelector]);
  const pendingSectionId = location.pathname === "/project" ? searchParams.get("section") : null;
  const pendingDraftId = location.pathname === "/project" ? searchParams.get("draft") : null;

  // Navigation functions use push (not replace) to build history for back/forward navigation.
  // See App.tsx handleMouseNavigation and KEYBINDS.NAVIGATE_BACK/FORWARD.
  const navigateToWorkspace = useCallback((id: string) => {
    void navigateRef.current(`/workspace/${encodeURIComponent(id)}`);
  }, []);

  const navigateToProject = useCallback(
    (path: string, sectionId?: string, draftId?: string, projectId?: string | null) => {
      const url = buildProjectUrl({ projectPath: path, projectId, sectionId, draftId });
      void navigateRef.current(url, { state: { projectPath: path } });
    },
    [buildProjectUrl]
  );

  const navigateToHome = useCallback(() => {
    void navigateRef.current("/");
  }, []);

  const navigateToSettings = useCallback((section?: string) => {
    const nextSection = section ?? "general";
    void navigateRef.current(`/settings/${encodeURIComponent(nextSection)}`);
  }, []);

  const navigateFromSettings = useCallback(() => {
    const lastLocation = lastNonSettingsLocationRef.current;
    if (!lastLocation.url || lastLocation.url.startsWith("/settings")) {
      void navigateRef.current("/");
      return;
    }
    void navigateRef.current(lastLocation.url, { state: lastLocation.state });
  }, []);

  const navigateToAnalytics = useCallback(() => {
    void navigateRef.current("/analytics");
  }, []);

  const navigateFromAnalytics = useCallback(() => {
    const lastLocation = lastNonAnalyticsLocationRef.current;
    if (
      !lastLocation.url ||
      lastLocation.url.startsWith("/settings") ||
      lastLocation.url === "/analytics"
    ) {
      void navigateRef.current("/");
      return;
    }
    void navigateRef.current(lastLocation.url, { state: lastLocation.state });
  }, []);

  const value = useMemo<RouterContext>(
    () => ({
      navigateToWorkspace,
      navigateToProject,
      replaceProjectSelector,
      navigateToHome,
      navigateToSettings,
      navigateFromSettings,
      navigateToAnalytics,
      navigateFromAnalytics,
      currentWorkspaceId,
      currentSettingsSection,
      currentProjectId,
      currentProjectPathFromState,
      pendingSectionId,
      pendingDraftId,
      isAnalyticsOpen,
    }),
    [
      navigateToHome,
      navigateToProject,
      replaceProjectSelector,
      navigateToSettings,
      navigateFromSettings,
      navigateToAnalytics,
      navigateFromAnalytics,
      navigateToWorkspace,
      currentWorkspaceId,
      currentSettingsSection,
      currentProjectId,
      currentProjectPathFromState,
      pendingSectionId,
      pendingDraftId,
      isAnalyticsOpen,
    ]
  );

  return <RouterContext.Provider value={value}>{props.children}</RouterContext.Provider>;
}

// Disable startTransition wrapping for navigation state updates so they
// batch with other normal-priority React state updates in the same tick.
// Without this, React processes navigation at transition (lower) priority,
// causing a flash of stale UI between normal-priority updates (e.g.
// setIsSending(false)) and the deferred route change.
export function RouterProvider(props: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={[getInitialRoute()]} unstable_useTransitions={false}>
      <RouterContextInner>{props.children}</RouterContextInner>
    </MemoryRouter>
  );
}
