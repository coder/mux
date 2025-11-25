import { useState, useEffect } from "react";
import App from "../App";
import { LoadingScreen } from "./LoadingScreen";
import { useWorkspaceStoreRaw } from "../stores/WorkspaceStore";
import { useGitStatusStoreRaw } from "../stores/GitStatusStore";
import { ProjectProvider } from "../contexts/ProjectContext";
import { ORPCProvider, useORPC, type ORPCClient } from "@/browser/orpc/react";
import { WorkspaceProvider, useWorkspaceContext } from "../contexts/WorkspaceContext";

interface AppLoaderProps {
  /** Optional pre-created ORPC client. If provided, skips internal connection setup. */
  client?: ORPCClient;
}

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
export function AppLoader(props: AppLoaderProps) {
  return (
    <ORPCProvider client={props.client}>
      <ProjectProvider>
        <WorkspaceProvider>
          <AppLoaderInner />
        </WorkspaceProvider>
      </ProjectProvider>
    </ORPCProvider>
  );
}

/**
 * Inner component that has access to both ProjectContext and WorkspaceContext.
 * Syncs stores and shows loading screen until ready.
 */
function AppLoaderInner() {
  const workspaceContext = useWorkspaceContext();
  const client = useORPC();

  // Get store instances
  const workspaceStore = useWorkspaceStoreRaw();
  const gitStatusStore = useGitStatusStoreRaw();

  // Track whether stores have been synced
  const [storesSynced, setStoresSynced] = useState(false);

  // Sync stores when metadata finishes loading
  useEffect(() => {
    workspaceStore.setClient(client);
    gitStatusStore.setClient(client);

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
    client,
  ]);

  // Show loading screen until stores are synced
  if (workspaceContext.loading || !storesSynced) {
    return <LoadingScreen />;
  }

  // Render App - all state available via contexts
  return <App />;
}
