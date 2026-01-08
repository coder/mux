import React from "react";
import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";

interface StreamErrorMessageProps {
  message: DisplayedMessage & { type: "stream-error" };
  className?: string;
}

// Note: RetryBarrier handles retry actions. This component only displays the error.
export const StreamErrorMessage: React.FC<StreamErrorMessageProps> = ({ message, className }) => {
  // Runtime unavailable gets a distinct, friendlier presentation.
  // This is a permanent failure (container/runtime doesn't exist), not a transient stream error.
  // The backend sends "Container unavailable..." for Docker or "Runtime unavailable..." for others.
  if (message.errorType === "runtime_not_ready") {
    // Extract title from error message (e.g., "Container unavailable" or "Runtime unavailable")
    const title = message.error?.split(".")[0] ?? "Runtime Unavailable";
    return (
      <div className={cn("bg-error-bg border border-error rounded px-5 py-4 my-3", className)}>
        <div className="font-primary text-error mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <span className="text-base leading-none">⚠️</span>
          <span>{title}</span>
        </div>
        <div className="text-foreground/80 text-[13px] leading-relaxed">{message.error}</div>
      </div>
    );
  }

  const showCount = message.errorCount !== undefined && message.errorCount > 1;

  return (
    <div className={cn("bg-error-bg border border-error rounded px-5 py-4 my-3", className)}>
      <div className="font-primary text-error mb-3 flex items-center gap-2.5 text-[13px] font-semibold tracking-wide">
        <span className="text-base leading-none">●</span>
        <span>Stream Error</span>
        <code className="bg-foreground/5 text-foreground/80 border-foreground/10 rounded-sm border px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase">
          {message.errorType}
        </code>
        {showCount && (
          <span className="text-error ml-auto rounded-sm bg-red-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide">
            ×{message.errorCount}
          </span>
        )}
      </div>
      <div className="text-foreground font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">
        {message.error}
      </div>
    </div>
  );
};
