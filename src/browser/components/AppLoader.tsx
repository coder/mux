import { useState, useEffect } from "react";
import App from "../App";
import { AuthTokenModal } from "./AuthTokenModal";
import { ThemeProvider } from "../contexts/ThemeContext";
import { LoadingScreen } from "./LoadingScreen";
import { useWorkspaceStoreRaw, workspaceStore } from "../stores/WorkspaceStore";
import { useGitStatusStoreRaw } from "../stores/GitStatusStore";
import { useBackgroundBashStoreRaw } from "../stores/BackgroundBashStore";
import { getPRStatusStoreInstance } from "../stores/PRStatusStore";
import { ProjectProvider, useProjectContext } from "../contexts/ProjectContext";
import { APIProvider, useAPI, type APIClient } from "@/browser/contexts/API";
import { WorkspaceProvider, useWorkspaceContext } from "../contexts/WorkspaceContext";
import { RouterProvider } from "../contexts/RouterContext";
import { TelemetryEnabledProvider } from "../contexts/TelemetryEnabledContext";
import { TerminalRouterProvider } from "../terminal/TerminalRouterContext";

interface AppLoaderProps {
  /** Optional pre-created ORPC api?. If provided, skips internal connection setup. */
  client?: APIClient;
}

/**
 * AppLoader handles all initialization before rendering the main App:
 * 1. Load workspace metadata and projects (via contexts)
 * 2. Sync stores with loaded data
 * 3. Only render App when everything is ready
 *
 * WorkspaceContext handles workspace selection restoration from URL.
 * RouterProvider must wrap WorkspaceProvider since workspace state is derived from URL.
 * WorkspaceProvider must be nested inside ProjectProvider so it can call useProjectContext().
 * This ensures App.tsx can assume stores are always synced and removes
 * the need for conditional guards in effects.
 */
export function AppLoader(props: AppLoaderProps) {
  return (
    <ThemeProvider>
      <APIProvider client={props.client}>
        <RouterProvider>
          <ProjectProvider>
            <WorkspaceProvider>
              <AppLoaderInner />
            </WorkspaceProvider>
          </ProjectProvider>
        </RouterProvider>
      </APIProvider>
    </ThemeProvider>
  );
}

/**
 * Inner component that has access to both ProjectContext and WorkspaceContext.
 * Syncs stores and shows loading screen until ready.
 */
function AppLoaderInner() {
  const workspaceContext = useWorkspaceContext();
  const projectContext = useProjectContext();
  const apiState = useAPI();
  const api = apiState.api;

  // Get store instances
  const workspaceStoreInstance = useWorkspaceStoreRaw();
  const gitStatusStore = useGitStatusStoreRaw();
  const backgroundBashStore = useBackgroundBashStoreRaw();

  // Track whether stores have been synced
  const [storesSynced, setStoresSynced] = useState(false);

  // Sync stores when metadata finishes loading
  useEffect(() => {
    if (api) {
      workspaceStoreInstance.setClient(api);
      gitStatusStore.setClient(api);
      backgroundBashStore.setClient(api);
      getPRStatusStoreInstance().setClient(api);
    }

    if (!workspaceContext.loading) {
      workspaceStoreInstance.syncWorkspaces(workspaceContext.workspaceMetadata);
      gitStatusStore.syncWorkspaces(workspaceContext.workspaceMetadata);

      // Wire up file-modification subscription (idempotent - only subscribes once)
      gitStatusStore.subscribeToFileModifications((listener) =>
        workspaceStore.subscribeFileModifyingTool(listener)
      );

      setStoresSynced(true);
    } else {
      setStoresSynced(false);
    }
  }, [
    workspaceContext.loading,
    workspaceContext.workspaceMetadata,
    workspaceStoreInstance,
    gitStatusStore,
    backgroundBashStore,
    api,
  ]);

  // If we're in browser mode and auth is required, show the token prompt before any data loads.
  if (apiState.status === "auth_required") {
    return <AuthTokenModal isOpen={true} onSubmit={apiState.authenticate} error={apiState.error} />;
  }

  const isInitialLoading = projectContext.loading || workspaceContext.loading || !storesSynced;

  const loadErrors: Array<{ title: string; message: string }> = [];
  if (workspaceContext.loadError) {
    loadErrors.push({ title: "Workspaces", message: workspaceContext.loadError });
  }
  if (projectContext.loadError) {
    loadErrors.push({ title: "Projects", message: projectContext.loadError });
  }
  if (isInitialLoading && apiState.status === "error") {
    loadErrors.push({ title: "Connection", message: apiState.error });
  }

  const statusMessage =
    apiState.status === "connecting"
      ? "Connecting to server…"
      : apiState.status === "reconnecting"
        ? `Reconnecting to server${apiState.attempt > 1 ? ` (attempt ${apiState.attempt})` : ""}…`
        : apiState.status === "degraded"
          ? "Connection unstable — messages may be delayed"
          : null;

  const handleRetry = () => {
    if (apiState.status === "error") {
      apiState.retry();
    }
    void workspaceContext.retryLoadWorkspaces();
    void projectContext.retryLoadProjects();
  };

  if (loadErrors.length > 0) {
    return (
      <LoadingScreen
        message="We ran into a problem while loading Mux data."
        errors={loadErrors}
        onRetry={handleRetry}
        retryLabel="Retry loading"
      />
    );
  }

  // Show loading screen until both projects and workspaces are loaded and stores synced
  if (isInitialLoading) {
    return <LoadingScreen statusMessage={statusMessage ?? undefined} />;
  }

  // Render App - all state available via contexts
  return (
    <TelemetryEnabledProvider>
      <TerminalRouterProvider>
        <App />
      </TerminalRouterProvider>
    </TelemetryEnabledProvider>
  );
}
