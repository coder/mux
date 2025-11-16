import React from "react";
import { cn } from "@/lib/utils";
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
        "my-5 py-3 px-[15px] bg-white/[0.03] border-l-[3px] border-accent rounded-sm",
        "text-muted text-xs font-normal text-center font-sans",
        className
      )}
    >
      {message.hiddenCount} older message{message.hiddenCount !== 1 ? "s" : ""} hidden for
      performance
    </div>
  );
};
