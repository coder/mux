import React from "react";
import type { ExtensionModule } from "@/extensions/api/ExtensionModule";
import { CostsTab } from "@/browser/components/RightSidebar/CostsTab";
import { ReviewPanel } from "@/browser/components/RightSidebar/CodeReview/ReviewPanel";
import { StatsTab } from "@/browser/components/RightSidebar/StatsTab";
import { ExplorerTab } from "@/browser/components/RightSidebar/ExplorerTab";
import { ErrorBoundary } from "@/browser/components/ErrorBoundary";
import {
  CostsTabLabel,
  ExplorerTabLabel,
  ReviewTabLabel,
  StatsTabLabel,
} from "@/browser/components/RightSidebar/tabs";

export const rightSidebarTabsBuiltinExtension: ExtensionModule = {
  id: "builtin:rightSidebarTabs",
  activate(ctx) {
    ctx.contribute.rightSidebar.registerTab({
      id: "costs",
      config: {
        name: "Costs",
        contentClassName: "overflow-y-auto p-[15px]",
      },
      renderLabel: (props) => <CostsTabLabel sessionCost={props.sessionCost ?? null} />,
      renderPanel: (props) => <CostsTab workspaceId={props.workspaceId} />,
    });

    ctx.contribute.rightSidebar.registerTab({
      id: "review",
      config: {
        name: "Review",
        contentClassName: "overflow-y-auto p-0",
      },
      renderLabel: (props) => <ReviewTabLabel reviewStats={props.reviewStats ?? null} />,
      renderPanel: (props) => (
        <ReviewPanel
          key={`${props.workspaceId}:${props.tabsetId}`}
          workspaceId={props.workspaceId}
          workspacePath={props.workspacePath}
          projectPath={props.projectPath}
          onReviewNote={props.onReviewNote}
          focusTrigger={props.focusTrigger}
          isCreating={props.isCreating}
          onStatsChange={props.onReviewStatsChange}
          onOpenFile={props.onOpenFile}
        />
      ),
    });

    ctx.contribute.rightSidebar.registerTab({
      id: "explorer",
      config: {
        name: "Explorer",
        contentClassName: "overflow-y-auto p-0",
      },
      renderLabel: () => <ExplorerTabLabel />,
      renderPanel: (props) => (
        <ExplorerTab
          workspaceId={props.workspaceId}
          workspacePath={props.workspacePath}
          onOpenFile={props.onOpenFile}
        />
      ),
    });

    ctx.contribute.rightSidebar.registerTab({
      id: "stats",
      config: {
        name: "Stats",
        contentClassName: "overflow-y-auto p-[15px]",
        featureFlag: "statsTab",
      },
      renderLabel: (props) => <StatsTabLabel sessionDuration={props.sessionDuration ?? null} />,
      renderPanel: (props) => (
        <ErrorBoundary workspaceInfo="Stats tab">
          <StatsTab workspaceId={props.workspaceId} />
        </ErrorBoundary>
      ),
    });
  },
};
