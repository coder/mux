import React from "react";
import { cn } from "@/common/lib/utils";

export interface TerminalOutputProps {
  output: string;
  isError?: boolean;
  className?: string;
}

export const TerminalOutput: React.FC<TerminalOutputProps> = ({
  output,
  isError = false,
  className,
}) => {
  return (
    <pre
      className={cn(
        "m-0 p-2 bg-black/30 rounded-sm font-mono text-[11px] leading-relaxed",
        "overflow-x-auto max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all",
        isError ? "text-danger-soft" : "text-light",
        className
      )}
    >
      {output}
    </pre>
  );
};
