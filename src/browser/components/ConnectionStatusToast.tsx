import React from "react";
import { useAPI } from "@/browser/contexts/API";

const wrapperClassName =
  "pointer-events-none absolute right-[15px] bottom-full left-[15px] z-[1000] mb-2 [&>*]:pointer-events-auto";

/**
 * Connection status banner that uses the same *overlay placement* as ChatInputToast.
 *
 * This avoids layout shifts in:
 * - the creation screen (new chat)
 * - the workspace chat window
 */
export const ConnectionStatusToast: React.FC = () => {
  const apiState = useAPI();

  // Don't show anything when connected or during initial connection.
  // Auth required is handled by a separate modal flow.
  if (
    apiState.status === "connected" ||
    apiState.status === "connecting" ||
    apiState.status === "auth_required"
  ) {
    return null;
  }

  if (apiState.status === "degraded" || apiState.status === "reconnecting") {
    return (
      <div className={wrapperClassName}>
        <div
          role="status"
          aria-live="polite"
          className="bg-warning/10 border-warning/30 text-warning flex animate-[toastSlideIn_0.2s_ease-out] items-center gap-2 rounded border px-3 py-1.5 text-xs shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
        >
          <span className="bg-warning inline-block h-2 w-2 animate-pulse rounded-full" />
          <span>
            {apiState.status === "degraded" ? (
              "Connection unstable — messages may be delayed"
            ) : (
              <>
                Reconnecting to server
                {apiState.attempt > 1 && ` (attempt ${apiState.attempt})`}…
              </>
            )}
          </span>
        </div>
      </div>
    );
  }

  if (apiState.status === "error") {
    return (
      <div className={wrapperClassName}>
        <div
          role="alert"
          aria-live="assertive"
          className="bg-toast-error-bg border-toast-error-border text-toast-error-text flex animate-[toastSlideIn_0.2s_ease-out] items-center gap-2 rounded border px-3 py-1.5 text-xs shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
        >
          <span className="bg-danger inline-block h-2 w-2 rounded-full" />
          <span>Connection lost</span>
          <button type="button" onClick={apiState.retry} className="underline hover:no-underline">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return null;
};
