import { cn } from "@/common/lib/utils";
import type { DisplayedMessage, MuxMessage, QueuedMessage } from "@/common/types/message";
import { formatTimestamp } from "@/browser/utils/ui/dateTime";
import { Code2Icon } from "lucide-react";
import type { ReactNode } from "react";
import React, { useMemo, useState } from "react";
import { Tooltip, TooltipWrapper } from "../Tooltip";
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
        "mt-4 mb-1 flex w-full flex-col relative isolate w-fit",
        variant === "user" && "ml-auto",
        variant === "assistant" && "text-white",
        isLastPartOfMessage && "mb-4"
      )}
      data-message-block
    >
      <div
        className={cn(
          variant === "user" &&
            "bg-neutral-700/50 border border-user-border/20 rounded-lg px-3 py-2 overflow-hidden",
          variant === "assistant" && "px-1 py-1"
        )}
      >
        {backgroundEffect}
        <div className="relative z-10 flex flex-col gap-2">
          <div data-message-content>
            {showJson ? (
              <pre className="m-0 overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 text-[12px] leading-snug whitespace-pre-wrap text-white/80">
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
            variant === "user" ? "ml-auto text-white/60" : "text-white/60"
          )}
          data-message-meta
        >
          <div className="flex flex-wrap items-center gap-0.5" data-message-meta-actions>
            {buttons.map((button, index) => (
              <IconActionButton key={index} button={button} />
            ))}
            <IconActionButton
              button={{
                label: showJson ? "Hide JSON" : "Show JSON",
                icon: <Code2Icon />,
                active: showJson,
                onClick: () => setShowJson(!showJson),
                tooltip: showJson ? "Hide raw JSON" : "Show raw JSON",
              }}
            />
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
      <TooltipWrapper inline>
        {content}
        <Tooltip align="center">{button.tooltip ?? button.label}</Tooltip>
      </TooltipWrapper>
    );
  }

  return content;
};
