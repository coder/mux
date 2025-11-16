import React from "react";
import type { DisplayedMessage } from "@/common/types/message";
import { cn } from "@/lib/utils";

interface StreamErrorMessageProps {
  message: DisplayedMessage & { type: "stream-error" };
  className?: string;
}

// Note: RetryBarrier now handles all retry UI. This component just displays the error.
export const StreamErrorMessage: React.FC<StreamErrorMessageProps> = ({ message, className }) => {
  const showCount = message.errorCount !== undefined && message.errorCount > 1;

  return (
    <div className={cn("bg-error-bg border border-error rounded px-5 py-4 my-3", className)}>
      <div className="font-primary text-error mb-3 flex items-center gap-2.5 text-[13px] font-semibold tracking-wide">
        <span className="text-base leading-none">●</span>
        <span>Stream Error</span>
        <span className="text-secondary rounded-sm bg-black/40 px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase">
          {message.errorType}
        </span>
        {showCount && (
          <span className="text-error ml-auto rounded-sm bg-red-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide">
            ×{message.errorCount}
          </span>
        )}
      </div>
      <div className="text-foreground font-mono text-[13px] leading-relaxed break-words">
        {message.error}
      </div>
    </div>
  );
};
