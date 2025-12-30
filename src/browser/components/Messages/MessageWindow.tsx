import { cn } from "@/common/lib/utils";
import type { DisplayedMessage, MuxMessage, QueuedMessage } from "@/common/types/message";
import { formatTimestamp } from "@/browser/utils/ui/dateTime";
import { Code2Icon } from "lucide-react";
import type { ReactNode } from "react";
import React, { useMemo, useState } from "react";
import { useChatHostContext } from "@/browser/contexts/ChatHostContext";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { Button } from "../ui/button";

export interface ButtonConfig {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  tooltip?: string; // Optional tooltip text
}

interface MessageWindowProps {
  label: ReactNode;
  variant?: "assistant" | "user";
  message: MuxMessage | DisplayedMessage | QueuedMessage;
  buttons?: ButtonConfig[];
  children: ReactNode;
  className?: string;
  rightLabel?: ReactNode;
  backgroundEffect?: ReactNode; // Optional background effect (e.g., animation)
}

export const MessageWindow: React.FC<MessageWindowProps> = ({
  label,
  variant = "assistant",
  message,
  buttons = [],
  children,
  rightLabel,
  backgroundEffect,
}) => {
  const [showJson, setShowJson] = useState(false);

  const { uiSupport } = useChatHostContext();
  const canShowJson = uiSupport.jsonRawView === "supported";
  const isShowingJson = canShowJson && showJson;

  // Get timestamp from message if available
  const timestamp =
    "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : null;

  // Memoize formatted timestamp to avoid recalculating on every render
  const formattedTimestamp = useMemo(
    () => (timestamp ? formatTimestamp(timestamp) : null),
    [timestamp]
  );

  const isLastPartOfMessage = useMemo(() => {
    if ("isLastPartOfMessage" in message && message.isLastPartOfMessage && !message.isPartial) {
      return true;
    }
    return false;
  }, [message]);

  // We do not want to display these on every message, otherwise it spams the UI
  // with buttons and timestamps
  const showMetaRow = useMemo(() => {
    return variant === "user" || isLastPartOfMessage;
  }, [variant, isLastPartOfMessage]);

  return (
    <div
      className={cn(
        "mt-4 mb-1 flex flex-col relative isolate",
        variant === "user" && "ml-auto w-fit",
        variant === "assistant" && "w-full text-foreground",
        isLastPartOfMessage && "mb-4"
      )}
      data-message-block
    >
      <div
        className={cn(
          variant === "user" &&
            "bg-[var(--color-user-surface)] border border-[var(--color-user-border)] rounded-lg px-3 py-2 overflow-hidden shadow-sm",
          variant === "assistant" && "px-1 py-1"
        )}
      >
        {backgroundEffect}
        <div className="relative z-10 flex flex-col gap-2">
          <div data-message-content>
            {isShowingJson ? (
              <pre className="m-0 overflow-x-auto rounded-xl border border-[var(--color-message-debug-border)] bg-[var(--color-message-debug-bg)] p-3 text-[12px] leading-snug whitespace-pre-wrap text-[var(--color-message-debug-text)]">
                {JSON.stringify(message, null, 2)}
              </pre>
            ) : (
              children
            )}
          </div>
        </div>
      </div>
      {showMetaRow && (
        <div
          className={cn(
            "mt-2 flex flex-wrap items-center justify-between gap-3 text-[11px]",
            variant === "user" ? "ml-auto text-muted" : "text-muted"
          )}
          data-message-meta
        >
          <div className="flex flex-wrap items-center gap-0.5" data-message-meta-actions>
            {buttons.map((button, index) => (
              <IconActionButton key={index} button={button} />
            ))}
            {canShowJson && (
              <IconActionButton
                button={{
                  label: isShowingJson ? "Hide JSON" : "Show JSON",
                  icon: <Code2Icon />,
                  active: isShowingJson,
                  onClick: () => setShowJson(!isShowingJson),
                  tooltip: isShowingJson ? "Hide raw JSON" : "Show raw JSON",
                }}
              />
            )}
          </div>
          <div
            className="text-muted flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs"
            data-message-meta-right
          >
            {rightLabel}
            {label && (
              <div className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap">
                {label}
              </div>
            )}
            {formattedTimestamp && <span data-message-timestamp>{formattedTimestamp}</span>}
          </div>
        </div>
      )}
    </div>
  );
};

interface IconActionButtonProps {
  button: ButtonConfig;
}

const IconActionButton: React.FC<IconActionButtonProps> = ({ button }) => {
  const content = (
    <Button
      onClick={button.onClick}
      disabled={button.disabled}
      aria-label={button.label}
      variant="ghost"
      size="icon"
      className="text-placeholder flex h-6 w-6 items-center justify-center [&_svg]:size-3.5"
    >
      {button.icon ?? (
        <span className="text-[10px] font-semibold tracking-wide uppercase">{button.label}</span>
      )}
    </Button>
  );

  if (button.tooltip || button.label) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent align="center">{button.tooltip ?? button.label}</TooltipContent>
      </Tooltip>
    );
  }

  return content;
};
