import type { ReactNode } from "react";
import type { TabType } from "@/browser/types/rightSidebar";
import type {
  TabConfig,
  TabLabelProps,
  TabRenderContext,
} from "@/browser/components/RightSidebar/tabs/registry";

export interface RightSidebarTabContribution {
  id: TabType;
  config: TabConfig;
  renderLabel: (props: TabLabelProps) => ReactNode;
  renderPanel: (ctx: TabRenderContext) => ReactNode;
}

export class ExtensionRegistry {
  private rightSidebarTabs = new Map<TabType, RightSidebarTabContribution>();

  registerRightSidebarTab(contribution: RightSidebarTabContribution): () => void {
    if (this.rightSidebarTabs.has(contribution.id)) {
      console.warn(`RightSidebar tab already registered: ${contribution.id} (overwriting)`);
    }

    this.rightSidebarTabs.set(contribution.id, contribution);

    return () => {
      const current = this.rightSidebarTabs.get(contribution.id);
      if (current === contribution) {
        this.rightSidebarTabs.delete(contribution.id);
      }
    };
  }

  getRightSidebarTab(tabId: TabType): RightSidebarTabContribution | undefined {
    return this.rightSidebarTabs.get(tabId);
  }

  listRightSidebarTabs(): RightSidebarTabContribution[] {
    return [...this.rightSidebarTabs.values()];
  }
}
