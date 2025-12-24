import React, { useLayoutEffect } from "react";
import { render, type RenderResult } from "@testing-library/react";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { TooltipProvider } from "@/browser/components/ui/tooltip";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { ReviewPanel } from "@/browser/components/RightSidebar/CodeReview/ReviewPanel";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

interface RenderReviewPanelParams {
  apiClient: APIClient;
  metadata: FrontendWorkspaceMetadata;
}

function ReviewPanelBootstrap(props: RenderReviewPanelParams) {
  const store = useWorkspaceStoreRaw();

  useLayoutEffect(() => {
    store.setClient(props.apiClient);
    store.syncWorkspaces(new Map([[props.metadata.id, props.metadata]]));

    return () => {
      store.removeWorkspace(props.metadata.id);
    };
  }, [store, props.apiClient, props.metadata]);

  return <ReviewPanel workspaceId={props.metadata.id} workspacePath={props.metadata.namedWorkspacePath} />;
}

export function renderReviewPanel(props: RenderReviewPanelParams): RenderResult {
  return render(
    <ThemeProvider forcedTheme="dark">
      <TooltipProvider delayDuration={0}>
        <APIProvider client={props.apiClient}>
          <ReviewPanelBootstrap {...props} />
        </APIProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
