import { useState, useEffect } from "react";
import App from "../App";
import { LoadingScreen } from "./LoadingScreen";
import { useWorkspaceStoreRaw } from "../stores/WorkspaceStore";
import { useGitStatusStoreRaw } from "../stores/GitStatusStore";
import { ProjectProvider } from "../contexts/ProjectContext";
import { WorkspaceProvider, useWorkspaceContext } from "../contexts/WorkspaceContext";

/**
 * AppLoader handles all initialization before rendering the main App:
 * 1. Load workspace metadata and projects (via contexts)
 * 2. Sync stores with loaded data
 * 3. Only render App when everything is ready
 *
 * WorkspaceContext handles workspace selection restoration (localStorage, URL hash, launch project).
 * WorkspaceProvider must be nested inside ProjectProvider so it can call useProjectContext().
 * This ensures App.tsx can assume stores are always synced and removes
 * the need for conditional guards in effects.
 */
export function AppLoader() {
  return (
    <ProjectProvider>
      <WorkspaceProvider>
        <AppLoaderInner />
      </WorkspaceProvider>
    </ProjectProvider>
  );
}

/**
 * Inner component that has access to both ProjectContext and WorkspaceContext.
 * Syncs stores and shows loading screen until ready.
 */
function AppLoaderInner() {
  const workspaceContext = useWorkspaceContext();

  // Get store instances
  const workspaceStore = useWorkspaceStoreRaw();
  const gitStatusStore = useGitStatusStoreRaw();

  // Track whether stores have been synced
  const [storesSynced, setStoresSynced] = useState(false);

  // Sync stores when metadata finishes loading
  useEffect(() => {
    if (!workspaceContext.loading) {
      workspaceStore.syncWorkspaces(workspaceContext.workspaceMetadata);
      gitStatusStore.syncWorkspaces(workspaceContext.workspaceMetadata);
      setStoresSynced(true);
    } else {
      setStoresSynced(false);
    }
  }, [
    workspaceContext.loading,
    workspaceContext.workspaceMetadata,
    workspaceStore,
    gitStatusStore,
  ]);

  // Show loading screen until stores are synced
  if (workspaceContext.loading || !storesSynced) {
    return <LoadingScreen />;
  }

  // Render App - all state available via contexts
  return <App />;
}
