import React, { useEffect, useRef } from "react";
import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";
import { Loader2, Wrench, CheckCircle2, AlertCircle } from "lucide-react";
import { Shimmer } from "../ai-elements/shimmer";

interface InitMessageProps {
  message: Extract<DisplayedMessage, { type: "workspace-init" }>;
  className?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export const InitMessage = React.memo<InitMessageProps>(({ message, className }) => {
  const isError = message.status === "error";
  const isRunning = message.status === "running";
  const isSuccess = message.status === "success";
  const preRef = useRef<HTMLPreElement>(null);

  // Auto-scroll to bottom while running
  useEffect(() => {
    if (isRunning && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [isRunning, message.lines.length]);

  const durationText =
    message.durationMs !== null ? ` in ${formatDuration(message.durationMs)}` : "";

  // Prepend truncation notice if lines were dropped
  const outputText = message.truncatedLines
    ? `... ${message.truncatedLines.toLocaleString()} earlier lines truncated ...\n${message.lines.join("\n")}`
    : message.lines.join("\n");

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
            `Init hook completed${durationText}`
          ) : (
            <span className="text-error">
              Init hook failed (exit code {message.exitCode}){durationText}
            </span>
          )}
        </span>
      </div>
      <div className="text-muted mt-1 truncate font-mono text-[11px]">{message.hookPath}</div>
      {message.lines.length > 0 && (
        <pre
          ref={preRef}
          className={cn(
            "m-0 mt-2.5 max-h-[120px] overflow-auto rounded-sm",
            "bg-black/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap",
            isError ? "text-danger-soft" : "text-light"
          )}
        >
          {outputText}
        </pre>
      )}
    </div>
  );
});

InitMessage.displayName = "InitMessage";
