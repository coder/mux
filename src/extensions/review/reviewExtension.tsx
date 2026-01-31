import React from "react";
import type { ExtensionModule } from "@/extensions/api/ExtensionModule";
import { ReviewPanel } from "@/extensions/review/browser/CodeReview/ReviewPanel";
import { ReviewTabLabel } from "@/browser/components/RightSidebar/tabs";

export const reviewExtension: ExtensionModule = {
  id: "mux.review",
  activate(ctx) {
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
  },
};
