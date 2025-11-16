import React from "react";
import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";

interface InitMessageProps {
  message: Extract<DisplayedMessage, { type: "workspace-init" }>;
  className?: string;
}

export const InitMessage = React.memo<InitMessageProps>(({ message, className }) => {
  const isError = message.status === "error";

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 border-b p-3 font-mono text-xs text-[#ddd]",
        isError ? "bg-[#3a1e1e] border-[#653737]" : "bg-[#1e2a3a] border-[#2f3f52]",
        className
      )}
    >
      <div className="flex items-center gap-2 text-[#ccc]">
        <span>🔧</span>
        <div>
          {message.status === "running" ? (
            <span>Running init hook...</span>
          ) : message.status === "success" ? (
            <span>✅ Init hook completed successfully</span>
          ) : (
            <span>
              Init hook exited with code {message.exitCode}. Workspace is ready, but some setup
              failed.
            </span>
          )}
          <div className="mt-0.5 font-mono text-[11px] text-[#888]">{message.hookPath}</div>
        </div>
      </div>
      {message.lines.length > 0 && (
        <pre className="m-0 max-h-[120px] overflow-auto rounded border border-white/[0.08] bg-black/15 px-2 py-1.5 whitespace-pre-wrap">
          {message.lines.join("\n")}
        </pre>
      )}
    </div>
  );
});

InitMessage.displayName = "InitMessage";
