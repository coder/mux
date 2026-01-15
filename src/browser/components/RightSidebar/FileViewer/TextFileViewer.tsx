/**
 * TextFileViewer - Displays text file contents with syntax highlighting.
 * Uses HighlightedCode component for syntax-aware rendering.
 * Shows git diff when available.
 */

import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { parsePatch } from "diff";
import { HighlightedCode } from "@/browser/components/tools/shared/HighlightedCode";
import { DiffRenderer } from "@/browser/components/shared/DiffRenderer";
import { getLanguageFromPath, getLanguageDisplayName } from "@/common/utils/git/languageDetector";

interface TextFileViewerProps {
  content: string;
  filePath: string;
  size: number;
  /** Git diff for uncommitted changes (null if no changes or error) */
  diff: string | null;
}

// Format file size for display
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const TextFileViewer: React.FC<TextFileViewerProps> = (props) => {
  // Detect language from file extension
  const language = getLanguageFromPath(props.filePath);
  const languageDisplayName = getLanguageDisplayName(language);

  // Count lines - match HighlightedCode's filtering of trailing empty line
  const lines = props.content.split("\n");
  const lineCount = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);

  // Track whether diff section is expanded
  const [diffExpanded, setDiffExpanded] = React.useState(true);

  // Parse diff to get hunks
  const diffHunks = React.useMemo(() => {
    if (!props.diff) return null;
    try {
      const patches = parsePatch(props.diff);
      if (patches.length === 0 || patches[0].hunks.length === 0) return null;
      return patches[0].hunks;
    } catch {
      return null;
    }
  }, [props.diff]);

  const hasDiff = diffHunks && diffHunks.length > 0;

  return (
    <div className="bg-background flex h-full flex-col">
      {/* Diff section (if there are uncommitted changes) */}
      {hasDiff && (
        <div className="border-border-light shrink-0 border-b">
          <button
            type="button"
            className="text-muted-foreground hover:bg-accent/50 flex w-full items-center gap-1 px-2 py-1 text-xs"
            onClick={() => setDiffExpanded(!diffExpanded)}
          >
            {diffExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span className="font-medium">Uncommitted Changes</span>
            <span className="text-muted">
              ({diffHunks.length} hunk{diffHunks.length > 1 ? "s" : ""})
            </span>
          </button>
          {diffExpanded && (
            <div className="max-h-[300px] overflow-auto">
              {diffHunks.map((hunk, idx) => (
                <DiffRenderer
                  key={idx}
                  content={hunk.lines.join("\n")}
                  showLineNumbers={true}
                  oldStart={hunk.oldStart}
                  newStart={hunk.newStart}
                  filePath={props.filePath}
                  fontSize="11px"
                  maxHeight="none"
                  className="rounded-none"
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Code content - fills available space */}
      <div className="min-h-0 flex-1 overflow-auto">
        <HighlightedCode
          code={props.content}
          language={language}
          showLineNumbers={true}
          className="text-xs"
        />
      </div>

      {/* Status line */}
      <div className="border-border-light text-muted-foreground flex shrink-0 items-center gap-3 border-t px-2 py-1 text-xs">
        <span>{formatSize(props.size)}</span>
        <span>{lineCount.toLocaleString()} lines</span>
        <span className="ml-auto">{languageDisplayName}</span>
      </div>
    </div>
  );
};
