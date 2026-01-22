import { AlertTriangle, WifiOff } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";

/**
 * Banner shown at top of app when connection is reconnecting or degraded.
 * Provides user feedback about connection status.
 */
export function ConnectionStatusBanner() {
  const apiState = useAPI();

  // Only show for reconnecting or degraded states
  if (apiState.status !== "reconnecting" && apiState.status !== "degraded") {
    return null;
  }

  return (
    <div className="bg-warning/10 border-warning/30 text-warning flex items-center justify-center gap-2 border-b px-3 py-1.5 text-sm">
      {apiState.status === "reconnecting" && (
        <>
          <WifiOff className="h-4 w-4" aria-hidden="true" />
          <span>
            Reconnecting to server
            {apiState.attempt > 1 ? ` (attempt ${apiState.attempt})` : ""}…
          </span>
        </>
      )}
      {apiState.status === "degraded" && (
        <>
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <span>Connection unstable — some features may be delayed</span>
        </>
      )}
    </div>
  );
}
