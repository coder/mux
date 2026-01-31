import React from "react";
import type { ExtensionModule } from "@/extensions/api/ExtensionModule";
import { ExplorerTab } from "@/extensions/explorer/browser/ExplorerTab";
import { ExplorerTabLabel } from "@/browser/components/RightSidebar/tabs";

export const explorerExtension: ExtensionModule = {
  id: "mux.explorer",
  activate(ctx) {
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
  },
};
