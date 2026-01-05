import React from "react";
import { useAPI } from "@/browser/contexts/API";

/**
 * Displays connection status to the user when not fully connected.
 * - degraded: pings failing but WebSocket open (yellow warning)
 * - reconnecting: WebSocket closed, attempting reconnect (yellow warning with attempt count)
 * - error: failed to reconnect (red error with retry button)
 *
 * Does not render when connected or connecting (initial load).
 */
export const ConnectionStatusIndicator: React.FC = () => {
  const apiState = useAPI();

  // Don't show anything when connected or during initial connection
  if (apiState.status === "connected" || apiState.status === "connecting") {
    return null;
  }

  // Auth required is handled by a separate modal flow
  if (apiState.status === "auth_required") {
    return null;
  }

  if (apiState.status === "degraded") {
    return (
      <div className="flex items-center justify-center gap-2 py-1 text-xs text-yellow-600">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
        <span>Connection unstable — messages may be delayed</span>
      </div>
    );
  }

  if (apiState.status === "reconnecting") {
    return (
      <div className="flex items-center justify-center gap-2 py-1 text-xs text-yellow-600">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
        <span>
          Reconnecting to server
          {apiState.attempt > 1 && ` (attempt ${apiState.attempt})`}…
        </span>
      </div>
    );
  }

  if (apiState.status === "error") {
    return (
      <div className="flex items-center justify-center gap-2 py-1 text-xs text-red-500">
        <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
        <span>Connection lost</span>
        <button type="button" onClick={apiState.retry} className="underline hover:no-underline">
          Retry
        </button>
      </div>
    );
  }

  return null;
};
