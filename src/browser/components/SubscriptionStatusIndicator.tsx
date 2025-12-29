import React from "react";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";

interface SubscriptionStatusIndicatorProps {
  workspaceId: string;
}

/**
 * Displays workspace chat subscription status when reconnecting.
 * Shows a subtle banner when the subscription watchdog detects a stall
 * and is restarting the subscription.
 */
export const SubscriptionStatusIndicator: React.FC<SubscriptionStatusIndicatorProps> = (props) => {
  const state = useWorkspaceState(props.workspaceId);

  if (state.subscriptionStatus !== "reconnecting") {
    return null;
  }

  return (
    <div className="flex items-center justify-center gap-2 py-1 text-xs text-yellow-600">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
      <span>Reconnecting chat stream…</span>
    </div>
  );
};
