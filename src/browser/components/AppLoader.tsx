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
import { PolicyProvider, usePolicy } from "@/browser/contexts/PolicyContext";
import { PolicyBlockedScreen } from "@/browser/components/PolicyBlockedScreen";
import { APIProvider, useAPI, type APIClient } from "@/browser/contexts/API";
import { useIdleCompactionHandler } from "@/browser/hooks/useIdleCompactionHandler";
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
        <PolicyProvider>
          <RouterProvider>
            <ProjectProvider>
              <WorkspaceProvider>
                <AppLoaderInner />
              </WorkspaceProvider>
            </ProjectProvider>
          </RouterProvider>
        </PolicyProvider>
      </APIProvider>
    </ThemeProvider>
  );
}

/**
 * Inner component that has access to both ProjectContext and WorkspaceContext.
 * Syncs stores and shows loading screen until ready.
 */
function AppLoaderInner() {
  const policyState = usePolicy();
  const workspaceContext = useWorkspaceContext();
  const projectContext = useProjectContext();
  const apiState = useAPI();
  const api = apiState.api;

  // Idle compaction should be registered at the app level so it can serialize across
  // all workspaces (and won't reset when switching workspaces).
  //
  // Avoid triggering background compactions when mux is blocked by policy.
  const idleCompactionApi = policyState.status.state === "blocked" ? null : api;
  useIdleCompactionHandler({ api: idleCompactionApi });

  // Get store instances
  const workspaceStoreInstance = useWorkspaceStoreRaw();
  const gitStatusStore = useGitStatusStoreRaw();
  const backgroundBashStore = useBackgroundBashStoreRaw();

  // Track whether stores have been synced
  const [storesSynced, setStoresSynced] = useState(false);

  // Sync stores when metadata finishes loading
  useEffect(() => {
    // Keep store clients in sync even during backend restarts (api can be null while reconnecting).
    workspaceStoreInstance.setClient(api ?? null);
    gitStatusStore.setClient(api ?? null);
    backgroundBashStore.setClient(api ?? null);
    getPRStatusStoreInstance().setClient(api ?? null);

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

  if (policyState.status.state === "blocked") {
    return <PolicyBlockedScreen reason={policyState.status.reason} />;
  }

  // If we're in browser mode and auth is required, show the token prompt before any data loads.
  if (apiState.status === "auth_required") {
    return <AuthTokenModal isOpen={true} onSubmit={apiState.authenticate} error={apiState.error} />;
  }

  // Show loading screen until both projects and workspaces are loaded and stores synced
  if (projectContext.loading || workspaceContext.loading || !storesSynced) {
    return <LoadingScreen />;
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
