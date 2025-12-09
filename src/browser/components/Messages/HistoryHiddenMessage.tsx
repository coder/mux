import React from "react";
import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";

interface HistoryHiddenMessageProps {
  message: DisplayedMessage & { type: "history-hidden" };
  className?: string;
}

export const HistoryHiddenMessage: React.FC<HistoryHiddenMessageProps> = ({
  message,
  className,
}) => {
  return (
    <div
      className={cn(
        "my-5 rounded-sm border-l-[3px] border-accent bg-[var(--color-message-hidden-bg)] px-[15px] py-3",
        "font-sans text-center text-xs font-normal text-muted",
        className
      )}
    >
      {message.hiddenCount} older message{message.hiddenCount !== 1 ? "s" : ""} hidden for
      performance
    </div>
  );
};
