/**
 * TextFileViewer - Displays text file contents with syntax highlighting.
 * Shows inline diff when there are uncommitted changes.
 */

import React from "react";
import { parsePatch } from "diff";
import { RefreshCw } from "lucide-react";
import {
  DiffRenderer,
  SelectableDiffRenderer,
  type DiffLineType,
} from "@/browser/components/shared/DiffRenderer";
import type { ReviewActionCallbacks } from "@/browser/components/shared/InlineReviewNote";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/ui/tooltip";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useReviews } from "@/browser/hooks/useReviews";
import {
  highlightSearchInText,
  type SearchHighlightConfig,
} from "@/browser/utils/highlighting/highlightSearchTerms";
import { formatKeybind, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { getFileViewerSearchStateKey } from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import { getLanguageFromPath, getLanguageDisplayName } from "@/common/utils/git/languageDetector";
import type { ReviewNoteData } from "@/common/types/review";

interface TextFileViewerProps {
  workspaceId: string;
  content: string;
  filePath: string;
  size: number;
  /** Git diff for uncommitted changes (null if no changes or error) */
  diff: string | null;
  /** Callback to refresh the file contents */
  onRefresh?: () => void;
  /** Whether a background refresh is in progress */
  isRefreshing?: boolean;
  /** Callback when user submits a review note */
  onReviewNote?: (data: ReviewNoteData) => void;
}

interface FileViewerSearchState {
  input: string;
  useRegex: boolean;
  matchCase: boolean;
}

const MAX_HIGHLIGHT_CHUNK_BYTES = 30_000;
const SEARCH_DEBOUNCE_MS = 150;

// Format file size for display
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

type FileLineType = Exclude<DiffLineType, "header">;

interface FileDiffLine {
  type: FileLineType;
  content: string;
}

const DIFF_PREFIXES: Record<FileLineType, string> = {
  add: "+",
  remove: "-",
  context: " ",
};

const normalizeFileLines = (content: string): string[] => {
  const lines = content.split("\n");
  return lines.filter((line, idx) => idx < lines.length - 1 || line !== "");
};

/**
 * Build a unified diff view of the file with diff information.
 * Returns lines with diff-style annotations for consistent rendering.
 */
function buildUnifiedDiffLines(fileLines: string[], diffText: string): FileDiffLine[] | null {
  try {
    const patches = parsePatch(diffText);
    if (patches.length === 0) return null;

    const patch = patches[0];
    if (!patch.hunks || patch.hunks.length === 0) return null;

    const result: FileDiffLine[] = [];
    let newLineIdx = 0; // 0-based index into new file (current content)

    for (const hunk of patch.hunks) {
      // Add unchanged lines before this hunk
      const hunkStartInNew = hunk.newStart - 1; // 0-based

      // Lines before hunk exist in both old and new
      while (newLineIdx < hunkStartInNew && newLineIdx < fileLines.length) {
        result.push({
          type: "context",
          content: fileLines[newLineIdx],
        });
        newLineIdx++;
      }

      // Process hunk lines
      for (const line of hunk.lines) {
        const prefix = line[0];
        const lineContent = line.slice(1);

        if (prefix === "-") {
          // Removed line - exists in old file only
          result.push({
            type: "remove",
            content: lineContent,
          });
        } else if (prefix === "+") {
          // Added line - exists in new file only
          result.push({
            type: "add",
            content: lineContent,
          });
          newLineIdx++;
        } else if (prefix === " ") {
          // Context line - exists in both
          result.push({
            type: "context",
            content: lineContent,
          });
          newLineIdx++;
        }
        // Skip other prefixes (like '\')
      }
    }

    // Add remaining lines after last hunk
    while (newLineIdx < fileLines.length) {
      result.push({
        type: "context",
        content: fileLines[newLineIdx],
      });
      newLineIdx++;
    }

    return result;
  } catch {
    return null;
  }
}

function buildChunkedDiffContent(
  diffLines: FileDiffLine[],
  oldStart: number,
  newStart: number
): string {
  const result: string[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  let chunkSize = 0;
  let chunkLineCount = 0;

  for (const line of diffLines) {
    const lineSize = line.content.length;
    const nextSize = chunkLineCount === 0 ? lineSize : chunkSize + lineSize + 1;

    if (chunkLineCount > 0 && nextSize > MAX_HIGHLIGHT_CHUNK_BYTES) {
      result.push(`@@ -${oldLine} +${newLine} @@`);
      chunkSize = 0;
      chunkLineCount = 0;
    }

    result.push(`${DIFF_PREFIXES[line.type]}${line.content}`);
    chunkSize = chunkLineCount === 0 ? lineSize : chunkSize + lineSize + 1;
    chunkLineCount += 1;

    if (line.type === "add") {
      newLine += 1;
    } else if (line.type === "remove") {
      oldLine += 1;
    } else {
      oldLine += 1;
      newLine += 1;
    }
  }

  return result.join("\n");
}

export const TextFileViewer: React.FC<TextFileViewerProps> = (props) => {
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [searchState, setSearchState] = usePersistedState<FileViewerSearchState>(
    getFileViewerSearchStateKey(props.workspaceId),
    { input: "", useRegex: false, matchCase: false }
  );
  const [debouncedSearchTerm, setDebouncedSearchTerm] = React.useState("");

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchState.input);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchState.input]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.FOCUS_REVIEW_SEARCH)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const searchConfig = React.useMemo<SearchHighlightConfig | undefined>(
    () =>
      debouncedSearchTerm
        ? {
            searchTerm: debouncedSearchTerm,
            useRegex: searchState.useRegex,
            matchCase: searchState.matchCase,
          }
        : undefined,
    [debouncedSearchTerm, searchState.useRegex, searchState.matchCase]
  );

  const highlightedFilePath = React.useMemo(
    () => (searchConfig ? highlightSearchInText(props.filePath, searchConfig) : props.filePath),
    [props.filePath, searchConfig]
  );

  const {
    reviews,
    updateReviewNote,
    checkReview,
    uncheckReview,
    attachReview,
    detachReview,
    removeReview,
  } = useReviews(props.workspaceId);

  const inlineReviews = React.useMemo(
    () => reviews.filter((review) => review.data?.filePath === props.filePath),
    [reviews, props.filePath]
  );

  const reviewActions: ReviewActionCallbacks = React.useMemo(
    () => ({
      onEditComment: updateReviewNote,
      onComplete: checkReview,
      onUncheck: uncheckReview,
      onAttach: attachReview,
      onDetach: detachReview,
      onDelete: removeReview,
    }),
    [updateReviewNote, checkReview, uncheckReview, attachReview, detachReview, removeReview]
  );

  const language = getLanguageFromPath(props.filePath);
  const languageDisplayName = getLanguageDisplayName(language);

  const fileLines = normalizeFileLines(props.content);
  const lineCount = fileLines.length;
  const unifiedLines = props.diff ? buildUnifiedDiffLines(fileLines, props.diff) : null;
  const diffLines: FileDiffLine[] =
    unifiedLines ?? fileLines.map((content) => ({ type: "context", content }));
  const diffContent = buildChunkedDiffContent(diffLines, 1, 1);
  const addedCount = unifiedLines ? diffLines.filter((line) => line.type === "add").length : 0;
  const removedCount = unifiedLines ? diffLines.filter((line) => line.type === "remove").length : 0;
  const diffRendererProps = {
    content: diffContent,
    showLineNumbers: true,
    lineNumberMode: "new" as const,
    oldStart: 1,
    newStart: 1,
    filePath: props.filePath,
    fontSize: "11px",
    maxHeight: "none",
    className: "rounded-none border-0 [&>div]:overflow-x-visible",
  };

  const shouldUseSelectable =
    Boolean(props.onReviewNote) || Boolean(searchConfig) || inlineReviews.length > 0;

  return (
    <div data-testid="text-file-viewer" className="bg-background flex h-full flex-col">
      <div className="border-border-light flex flex-col border-b">
        <div className="text-muted-foreground flex items-center gap-3 px-2 py-1 text-[11px]">
          <span
            className="min-w-0 truncate"
            dangerouslySetInnerHTML={{ __html: highlightedFilePath }}
          />
          <span className="shrink-0">{formatSize(props.size)}</span>
          <span className="shrink-0">{lineCount.toLocaleString()} lines</span>
          {(addedCount > 0 || removedCount > 0) && (
            <span className="shrink-0">
              <span className="text-success-light">+{addedCount}</span>
              <span className="text-muted-foreground">/</span>
              <span className="text-warning-light">−{removedCount}</span>
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
        <div className="border-border-light flex items-center gap-1.5 border-t px-2 py-1">
          <input
            ref={searchInputRef}
            type="text"
            placeholder={`Search... (${formatKeybind(KEYBINDS.FOCUS_REVIEW_SEARCH)})`}
            value={searchState.input}
            onChange={(e) => setSearchState({ ...searchState, input: e.target.value })}
            className="bg-dark text-foreground border-border-medium placeholder:text-dim hover:border-accent focus:border-accent min-w-0 flex-1 rounded border px-1.5 py-0.5 font-mono text-[11px] transition-[border-color] duration-150 focus:outline-none"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  "font-monospace cursor-pointer border-none bg-transparent p-0 text-[11px] font-semibold transition-colors duration-150",
                  searchState.useRegex ? "text-accent-light" : "text-muted hover:text-foreground"
                )}
                onClick={() => setSearchState({ ...searchState, useRegex: !searchState.useRegex })}
              >
                .*
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {searchState.useRegex ? "Using regex search" : "Using substring search"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  "font-monospace cursor-pointer border-none bg-transparent p-0 text-[11px] font-semibold transition-colors duration-150",
                  searchState.matchCase ? "text-accent-light" : "text-muted hover:text-foreground"
                )}
                onClick={() =>
                  setSearchState({ ...searchState, matchCase: !searchState.matchCase })
                }
              >
                Aa
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {searchState.matchCase
                ? "Match case (case-sensitive)"
                : "Ignore case (case-insensitive)"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {shouldUseSelectable ? (
          <SelectableDiffRenderer
            {...diffRendererProps}
            onReviewNote={props.onReviewNote}
            inlineReviews={inlineReviews}
            reviewActions={reviewActions}
            searchConfig={searchConfig}
          />
        ) : (
          <DiffRenderer {...diffRendererProps} />
        )}
      </div>
    </div>
  );
};
