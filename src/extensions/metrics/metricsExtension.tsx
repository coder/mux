import React from "react";
import type { ExtensionModule } from "@/extensions/api/ExtensionModule";
import { ErrorBoundary } from "@/browser/components/ErrorBoundary";
import { CostsTabLabel, StatsTabLabel } from "@/browser/components/RightSidebar/tabs";
import { CostsTab } from "@/extensions/metrics/browser/CostsTab";
import { StatsTab } from "@/extensions/metrics/browser/StatsTab";

export const metricsExtension: ExtensionModule = {
  id: "mux.metrics",
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
