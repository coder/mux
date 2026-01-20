/**
 * TextFileViewer - Displays text file contents with syntax highlighting.
 * Shows inline diff when there are uncommitted changes.
 */

import React from "react";
import { parsePatch } from "diff";
import { RefreshCw } from "lucide-react";
import { highlightCode } from "@/browser/utils/highlighting/highlightWorkerClient";
import { extractShikiLines } from "@/browser/utils/highlighting/shiki-shared";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { getLanguageFromPath, getLanguageDisplayName } from "@/common/utils/git/languageDetector";

interface TextFileViewerProps {
  content: string;
  filePath: string;
  size: number;
  /** Git diff for uncommitted changes (null if no changes or error) */
  diff: string | null;
  /** Callback to refresh the file contents */
  onRefresh?: () => void;
  /** Whether a background refresh is in progress */
  isRefreshing?: boolean;
}

// Format file size for display
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Line type for unified view
type LineType = "normal" | "added" | "removed";

interface UnifiedLine {
  type: LineType;
  content: string;
  oldLineNumber: number | null; // line number in old file (null for added lines)
  newLineNumber: number | null; // line number in new file (null for removed lines)
}

/**
 * Build a unified view of the file with diff information.
 * Returns lines with type annotations for coloring.
 */
function buildUnifiedView(content: string, diffText: string): UnifiedLine[] | null {
  try {
    const patches = parsePatch(diffText);
    if (patches.length === 0) return null;

    const patch = patches[0];
    if (!patch.hunks || patch.hunks.length === 0) return null;

    const fileLines = content.split("\n");
    const result: UnifiedLine[] = [];
    let newLineIdx = 0; // 0-based index into new file (current content)
    let oldLineIdx = 0; // 0-based index into old file

    for (const hunk of patch.hunks) {
      // Add unchanged lines before this hunk
      const hunkStartInNew = hunk.newStart - 1; // 0-based
      const hunkStartInOld = hunk.oldStart - 1; // 0-based

      // Lines before hunk exist in both old and new
      while (newLineIdx < hunkStartInNew && newLineIdx < fileLines.length) {
        result.push({
          type: "normal",
          content: fileLines[newLineIdx],
          oldLineNumber: oldLineIdx + 1,
          newLineNumber: newLineIdx + 1,
        });
        newLineIdx++;
        oldLineIdx++;
      }

      // Sync old line index to hunk start
      oldLineIdx = hunkStartInOld;

      // Process hunk lines
      for (const line of hunk.lines) {
        const prefix = line[0];
        const lineContent = line.slice(1);

        if (prefix === "-") {
          // Removed line - exists in old file only
          result.push({
            type: "removed",
            content: lineContent,
            oldLineNumber: oldLineIdx + 1,
            newLineNumber: null,
          });
          oldLineIdx++;
        } else if (prefix === "+") {
          // Added line - exists in new file only
          result.push({
            type: "added",
            content: lineContent,
            oldLineNumber: null,
            newLineNumber: newLineIdx + 1,
          });
          newLineIdx++;
        } else if (prefix === " ") {
          // Context line - exists in both
          result.push({
            type: "normal",
            content: lineContent,
            oldLineNumber: oldLineIdx + 1,
            newLineNumber: newLineIdx + 1,
          });
          newLineIdx++;
          oldLineIdx++;
        }
        // Skip other prefixes (like '\')
      }
    }

    // Add remaining lines after last hunk
    while (newLineIdx < fileLines.length) {
      const line = fileLines[newLineIdx];
      // Skip trailing empty line
      if (newLineIdx === fileLines.length - 1 && line === "") {
        break;
      }
      result.push({
        type: "normal",
        content: line,
        oldLineNumber: oldLineIdx + 1,
        newLineNumber: newLineIdx + 1,
      });
      newLineIdx++;
      oldLineIdx++;
    }

    return result;
  } catch {
    return null;
  }
}

export const TextFileViewer: React.FC<TextFileViewerProps> = (props) => {
  const { theme: themeMode } = useTheme();
  const isLightTheme = themeMode === "light" || themeMode.endsWith("-light");
  const language = getLanguageFromPath(props.filePath);
  const languageDisplayName = getLanguageDisplayName(language);

  // Count lines
  const fileLines = props.content.split("\n");
  const lineCount = fileLines.length - (fileLines[fileLines.length - 1] === "" ? 1 : 0);

  // Build unified view if we have a diff
  const unifiedLines = React.useMemo(() => {
    if (!props.diff) return null;
    return buildUnifiedView(props.content, props.diff);
  }, [props.content, props.diff]);

  // Syntax highlight all unique line contents
  // Store highlighted lines by index to preserve context for repeated lines
  const [highlightedLines, setHighlightedLines] = React.useState<string[] | null>(null);

  React.useEffect(() => {
    const linesToHighlight = unifiedLines
      ? unifiedLines.map((l) => l.content)
      : fileLines.filter((l, i, arr) => i < arr.length - 1 || l !== "");

    const theme = isLightTheme ? "light" : "dark";

    let cancelled = false;

    async function highlight() {
      try {
        const code = linesToHighlight.join("\n");
        const html = await highlightCode(code, language, theme);
        if (cancelled) return;

        const highlighted = extractShikiLines(html);
        setHighlightedLines(highlighted);
      } catch {
        if (!cancelled) setHighlightedLines(null);
      }
    }

    void highlight();
    return () => {
      cancelled = true;
    };
  }, [unifiedLines, fileLines, language, isLightTheme]);

  const addedCount = unifiedLines?.filter((l) => l.type === "added").length ?? 0;
  const removedCount = unifiedLines?.filter((l) => l.type === "removed").length ?? 0;

  const hasDiff = unifiedLines !== null;

  // Render a single line (with one or two line number columns)
  const renderLine = (
    content: string,
    oldLineNum: number | null,
    newLineNum: number | null,
    type: LineType,
    key: number
  ) => {
    const highlighted = highlightedLines?.[key];
    const bgClass =
      type === "added" ? "bg-green-500/20" : type === "removed" ? "bg-red-500/20" : "";

    return (
      <div key={key} className={`${bgClass} flex`}>
        {hasDiff ? (
          <>
            <div className="w-10 shrink-0 pr-1 text-right text-[var(--color-muted)] select-none">
              {oldLineNum ?? ""}
            </div>
            <div className="w-10 shrink-0 pr-2 text-right text-[var(--color-muted)] select-none">
              {newLineNum ?? ""}
            </div>
          </>
        ) : (
          <div className="w-10 shrink-0 pr-2 text-right text-[var(--color-muted)] select-none">
            {newLineNum ?? ""}
          </div>
        )}
        <div
          className="code-line min-w-0 flex-1"
          {...(highlighted
            ? { dangerouslySetInnerHTML: { __html: highlighted } }
            : { children: content || "\u00A0" })}
        />
      </div>
    );
  };

  // Width of line number gutter(s)
  const gutterWidth = hasDiff ? "5rem" : "2.5rem"; // w-10 = 2.5rem, two columns for diff

  return (
    <div data-testid="text-file-viewer" className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-code-bg)]">
        {/* Content wrapper - min-h-full so gutter extends when content is short */}
        <div
          className="relative min-h-full text-[11px]"
          style={{ fontFamily: "var(--font-monospace)" }}
        >
          {/* Gutter background + border that extends full height of content */}
          <div
            className={`pointer-events-none absolute inset-y-0 left-0 border-r border-[var(--color-border-light)] ${isLightTheme ? "bg-black/5" : "bg-black/20"}`}
            style={{ width: gutterWidth }}
          />
          {/* Lines */}
          {unifiedLines
            ? unifiedLines.map((line, idx) =>
                renderLine(line.content, line.oldLineNumber, line.newLineNumber, line.type, idx)
              )
            : fileLines
                .filter((_, i, arr) => i < arr.length - 1 || fileLines[i] !== "")
                .map((content, idx) => renderLine(content, idx + 1, idx + 1, "normal", idx))}
        </div>
      </div>

      {/* Status line */}
      <div className="border-border-light text-muted-foreground flex shrink-0 items-center gap-3 border-t px-2 py-1 text-xs">
        <span className="min-w-0 truncate">{props.filePath}</span>
        <span className="shrink-0">{formatSize(props.size)}</span>
        <span className="shrink-0">{lineCount.toLocaleString()} lines</span>
        {(addedCount > 0 || removedCount > 0) && (
          <span className="shrink-0">
            <span className="text-green-600 dark:text-green-500">+{addedCount}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-red-600 dark:text-red-500">-{removedCount}</span>
          </span>
        )}
        <span className="ml-auto shrink-0">{languageDisplayName}</span>
        {props.onRefresh && (
          <button
            type="button"
            className="text-muted hover:bg-accent/50 hover:text-foreground rounded p-0.5"
            onClick={props.onRefresh}
            title="Refresh file"
            disabled={props.isRefreshing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${props.isRefreshing ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>
    </div>
  );
};
