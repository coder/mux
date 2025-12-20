import React from "react";
import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";
import { Loader2, Wrench, CheckCircle2, AlertCircle } from "lucide-react";
import { Shimmer } from "../ai-elements/shimmer";

interface InitMessageProps {
  message: Extract<DisplayedMessage, { type: "workspace-init" }>;
  className?: string;
}

export const InitMessage = React.memo<InitMessageProps>(({ message, className }) => {
  const isError = message.status === "error";
  const isRunning = message.status === "running";
  const isSuccess = message.status === "success";

  return (
    <div
      className={cn(
        "my-2 rounded border px-3 py-2",
        isError ? "border-init-error-border bg-init-error-bg" : "border-init-border bg-init-bg",
        className
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex-shrink-0",
            isError ? "text-error" : isSuccess ? "text-success" : "text-accent"
          )}
        >
          {isRunning ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : isSuccess ? (
            <CheckCircle2 className="size-3.5" />
          ) : isError ? (
            <AlertCircle className="size-3.5" />
          ) : (
            <Wrench className="size-3.5" />
          )}
        </span>
        <span className="font-primary text-foreground text-[12px]">
          {isRunning ? (
            <Shimmer colorClass="var(--color-accent)">Running init hook...</Shimmer>
          ) : isSuccess ? (
            "Init hook completed"
          ) : (
            <span className="text-error">Init hook failed (exit code {message.exitCode})</span>
          )}
        </span>
      </div>
      <div className="text-muted mt-1 truncate font-mono text-[11px]">{message.hookPath}</div>
      {message.lines.length > 0 && (
        <pre
          className={cn(
            "m-0 mt-2.5 max-h-[120px] overflow-auto rounded-sm",
            "bg-black/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap",
            isError ? "text-danger-soft" : "text-light"
          )}
        >
          {message.lines.join("\n")}
        </pre>
      )}
    </div>
  );
});

InitMessage.displayName = "InitMessage";
