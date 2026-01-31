import React from "react";
import type { ExtensionModule } from "@/extensions/api/ExtensionModule";
import { ExplorerTab } from "@/browser/components/RightSidebar/ExplorerTab";
import { ExplorerTabLabel } from "@/browser/components/RightSidebar/tabs";

export const rightSidebarTabsBuiltinExtension: ExtensionModule = {
  id: "builtin:rightSidebarTabs",
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
