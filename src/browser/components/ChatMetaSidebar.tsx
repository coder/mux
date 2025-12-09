import React from "react";
import { cn } from "@/common/lib/utils";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceUsage } from "@/browser/stores/WorkspaceStore";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { useResizeObserver } from "@/browser/hooks/useResizeObserver";
import { CostsTab } from "./RightSidebar/CostsTab";
import { VerticalTokenMeter } from "./RightSidebar/VerticalTokenMeter";
import { calculateTokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";

interface ChatMetaSidebarProps {
  workspaceId: string;
  chatAreaRef: React.RefObject<HTMLDivElement>;
}

const ChatMetaSidebarComponent: React.FC<ChatMetaSidebarProps> = ({ workspaceId, chatAreaRef }) => {
  const usage = useWorkspaceUsage(workspaceId);
  const { options } = useProviderOptions();
  const use1M = options.anthropic?.use1MContext ?? false;
  const chatAreaSize = useResizeObserver(chatAreaRef);

  // Use lastContextUsage for context window display (last step = actual context size)
  const lastUsage = usage?.liveUsage ?? usage?.lastContextUsage;

  // Memoize vertical meter data calculation to prevent unnecessary re-renders
  const verticalMeterData = React.useMemo(() => {
    // Get model from last usage
    const model = lastUsage?.model ?? "unknown";
    return lastUsage
      ? calculateTokenMeterData(lastUsage, model, use1M, true)
      : { segments: [], totalTokens: 0, totalPercentage: 0 };
  }, [lastUsage, use1M]);

  // Calculate if we should show collapsed view with hysteresis
  // Strategy: Observe ChatArea width directly (independent of sidebar width)
  // - ChatArea has min-width: 750px and flex: 1
  // - Use hysteresis to prevent oscillation:
  //   * Collapse when chatAreaWidth <= 800px (tight space)
  //   * Expand when chatAreaWidth >= 1100px (lots of space)
  //   * Between 800-1100: maintain current state (dead zone)
  const COLLAPSE_THRESHOLD = 800; // Collapse below this
  const EXPAND_THRESHOLD = 1100; // Expand above this
  const chatAreaWidth = chatAreaSize?.width ?? 1000; // Default to large to avoid flash

  // Persist collapsed state globally (not per-workspace) since chat area width is shared
  // This prevents animation flash when switching workspaces - sidebar maintains its state
  const [showCollapsed, setShowCollapsed] = usePersistedState<boolean>(
    "chat-meta-sidebar:collapsed",
    false
  );

  React.useEffect(() => {
    if (chatAreaWidth <= COLLAPSE_THRESHOLD) {
      setShowCollapsed(true);
    } else if (chatAreaWidth >= EXPAND_THRESHOLD) {
      setShowCollapsed(false);
    }
    // Between thresholds: maintain current state (no change)
  }, [chatAreaWidth, setShowCollapsed]);

  return (
    <div
      className={cn(
        "bg-sidebar border-l border-border-light flex flex-col overflow-hidden transition-[width] duration-200 flex-shrink-0",
        showCollapsed ? "w-5 sticky right-0 z-10 shadow-[-2px_0_4px_rgba(0,0,0,0.2)]" : "w-80"
      )}
      role="complementary"
      aria-label="Workspace insights"
    >
      <div className={cn("flex flex-col h-full", showCollapsed && "hidden")}>
        <div className="flex-1 overflow-y-auto p-[15px]" role="region" aria-label="Cost breakdown">
          <CostsTab workspaceId={workspaceId} />
        </div>
      </div>
      <div className={cn("flex h-full", !showCollapsed && "hidden")}>
        <VerticalTokenMeter data={verticalMeterData} />
      </div>
    </div>
  );
};

// Memoize to prevent re-renders when parent (AIView) re-renders during streaming
// Only re-renders when workspaceId or chatAreaRef changes, or internal state updates
export const ChatMetaSidebar = React.memo(ChatMetaSidebarComponent);
