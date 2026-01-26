import React from "react";
import { FileIcon } from "@/browser/components/FileIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/ui/tooltip";

// Format token display - show k for thousands with 1 decimal
const formatTokens = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens.toLocaleString();

// Strip "./" prefix from file paths for cleaner display
const formatPath = (path: string) => (path.startsWith("./") ? path.slice(2) : path);

interface FileBreakdownProps {
  files: Array<{ path: string; tokens: number }>;
  totalTokens: number;
}

const FileBreakdownComponent: React.FC<FileBreakdownProps> = ({ files, totalTokens }) => {
  if (files.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1">
      {files.map((file) => {
        const percentage = totalTokens > 0 ? (file.tokens / totalTokens) * 100 : 0;
        const displayPath = formatPath(file.path);
        return (
          <div key={file.path} className="flex items-center gap-1.5">
            <FileIcon filePath={file.path} className="text-secondary shrink-0 text-xs" />
            <Tooltip>
              <TooltipTrigger className="dir-rtl text-foreground min-w-0 flex-1 truncate text-left text-xs">
                <bdi>{displayPath}</bdi>
              </TooltipTrigger>
              <TooltipContent side="left">{displayPath}</TooltipContent>
            </Tooltip>
            <span className="text-muted shrink-0 text-[11px]">
              {formatTokens(file.tokens)} ({percentage.toFixed(1)}%)
            </span>
          </div>
        );
      })}
    </div>
  );
};

export const FileBreakdown = React.memo(FileBreakdownComponent);
