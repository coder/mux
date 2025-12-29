import React from "react";
import { AlertTriangle, X } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { usePersistedState } from "@/browser/hooks/usePersistedState";

const ROSETTA_BANNER_DISMISSED_KEY = "rosettaBannerDismissedAt";
const DISMISS_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Banner shown when Mux is running under Rosetta 2 translation.
 * Users can dismiss it, but it will re-appear after 30 days.
 */
export const RosettaBanner: React.FC = () => {
  const [dismissedAt, setDismissedAt] = usePersistedState<number | null>(
    ROSETTA_BANNER_DISMISSED_KEY,
    null
  );

  // Only show on macOS running under Rosetta
  const isRosetta = window.api?.isRosetta === true;

  // Check if dismissal has expired (30 days)
  const isDismissed = dismissedAt !== null && Date.now() - dismissedAt < DISMISS_DURATION_MS;

  if (!isRosetta || isDismissed) {
    return null;
  }

  return (
    <div
      className={cn(
        "bg-warning/10 border-warning/30 text-warning flex items-center justify-between gap-3 border-b px-4 py-2 text-sm"
      )}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0" />
        <span>
          Mux is running under Rosetta. For better performance,{" "}
          <a
            href="https://mux.coder.com/download"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            download the native Apple Silicon version
          </a>
          .
        </span>
      </div>
      <button
        type="button"
        onClick={() => setDismissedAt(Date.now())}
        className="hover:text-warning/80 shrink-0 p-1 transition-colors"
        aria-label="Dismiss Rosetta warning"
      >
        <X className="size-4" />
      </button>
    </div>
  );
};
