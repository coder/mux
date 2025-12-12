/**
 * DiffRenderer - Shared diff rendering component
 * Used by FileEditToolCall for read-only diff display.
 * ReviewPanel uses SelectableDiffRenderer for interactive line selection.
 */

import React, { useEffect, useState } from "react";
import { cn } from "@/common/lib/utils";
import { getLanguageFromPath } from "@/common/utils/git/languageDetector";
import { MessageSquare } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { groupDiffLines } from "@/browser/utils/highlighting/diffChunking";
import { useTheme, type ThemeMode } from "@/browser/contexts/ThemeContext";
import {
  highlightDiffChunk,
  type HighlightedChunk,
} from "@/browser/utils/highlighting/highlightDiffChunk";
import {
  highlightSearchMatches,
  type SearchHighlightConfig,
} from "@/browser/utils/highlighting/highlightSearchTerms";
import type { ReviewNoteData } from "@/common/types/review";

// Shared type for diff line types
export type DiffLineType = "add" | "remove" | "context" | "header";

interface DiffLineStyles {
  tintBase: string | null;
  codeTintTransparentPct: number;
  gutterTintTransparentPct: number;
  contentColor: string;
}

const tint = (base: string, transparentPct: number): string =>
  `color-mix(in srgb, ${base}, transparent ${transparentPct}%)`;

const DIFF_LINE_STYLES: Record<DiffLineType, DiffLineStyles> = {
  add: {
    tintBase: "var(--color-success)",
    codeTintTransparentPct: 94,
    gutterTintTransparentPct: 86,
    contentColor: "var(--color-text)",
  },
  remove: {
    tintBase: "var(--color-danger)",
    codeTintTransparentPct: 94,
    gutterTintTransparentPct: 86,
    contentColor: "var(--color-text)",
  },
  header: {
    tintBase: "var(--color-accent)",
    codeTintTransparentPct: 95,
    gutterTintTransparentPct: 90,
    contentColor: "var(--color-accent-light)",
  },
  context: {
    tintBase: null,
    codeTintTransparentPct: 100,
    gutterTintTransparentPct: 100,
    contentColor: "var(--color-text-secondary)",
  },
};

// Helper function for the diff *code* background. This should stay relatively subtle.
const getDiffLineBackground = (type: DiffLineType): string => {
  const style = DIFF_LINE_STYLES[type];
  return style.tintBase ? tint(style.tintBase, style.codeTintTransparentPct) : "transparent";
};

// Helper function for the diff *gutter* background (line numbers / +/- area).
// This is intentionally more saturated than the code background for contrast.
// Context lines have no special background (same as code area).
const getDiffLineGutterBackground = (type: DiffLineType): string => {
  const style = DIFF_LINE_STYLES[type];
  return style.tintBase ? tint(style.tintBase, style.gutterTintTransparentPct) : "transparent";
};

// Helper function for getting line content color.
// Only headers/context are tinted; actual code stays the normal foreground color.
const getLineContentColor = (type: DiffLineType): string => DIFF_LINE_STYLES[type].contentColor;

// Split diff into lines while preserving indices.
// We only remove the trailing empty line if the input ends with a newline.
const splitDiffLines = (diff: string): string[] => {
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
};

// Line number color - brighter for changed lines, dimmed for context.
const getLineNumberColor = (type: DiffLineType): string => {
  return type === "context"
    ? "color-mix(in srgb, var(--color-muted) 40%, transparent)"
    : "var(--color-text)";
};

// Indicator (+/-/space) character and color
const getIndicatorChar = (type: DiffLineType): string => {
  switch (type) {
    case "add":
      return "+";
    case "remove":
      return "−"; // Use proper minus sign for aesthetics
    default:
      return " ";
  }
};

const getIndicatorColor = (type: DiffLineType): string => {
  switch (type) {
    case "add":
      return "var(--color-success)";
    case "remove":
      return "var(--color-danger)";
    default:
      return "transparent";
  }
};

// Shared line number widths interface
interface LineNumberWidths {
  oldWidthCh: number;
  newWidthCh: number;
}

// Shared line gutter component (line numbers)
interface DiffLineGutterProps {
  type: DiffLineType;
  oldLineNum: number | null;
  newLineNum: number | null;
  showLineNumbers: boolean;
  lineNumberWidths: LineNumberWidths;
}

const DiffLineGutter: React.FC<DiffLineGutterProps> = ({
  type,
  oldLineNum,
  newLineNum,
  showLineNumbers,
  lineNumberWidths,
}) => (
  <span
    className="font-monospace flex shrink-0 items-center gap-0.5 px-1 tabular-nums select-none"
    style={{ background: getDiffLineGutterBackground(type) }}
  >
    {showLineNumbers && (
      <>
        <span
          className="text-right"
          style={{
            width: `${lineNumberWidths.oldWidthCh}ch`,
            color: getLineNumberColor(type),
          }}
        >
          {oldLineNum ?? ""}
        </span>
        <span
          className="ml-3 text-right"
          style={{
            width: `${lineNumberWidths.newWidthCh}ch`,
            color: getLineNumberColor(type),
          }}
        >
          {newLineNum ?? ""}
        </span>
      </>
    )}
  </span>
);

// Shared indicator component (+/- with optional hover replacement)
interface DiffIndicatorProps {
  type: DiffLineType;
  /** Render review button overlay on hover */
  reviewButton?: React.ReactNode;
}

const DiffIndicator: React.FC<DiffIndicatorProps> = ({ type, reviewButton }) => (
  <span className="relative inline-block w-4 shrink-0 text-center select-none">
    <span
      className={cn("transition-opacity", reviewButton && "group-hover:opacity-0")}
      style={{ color: getIndicatorColor(type) }}
    >
      {getIndicatorChar(type)}
    </span>
    {reviewButton}
  </span>
);

/**
 * Container component for diff rendering - exported for custom diff displays
 * Used by FileEditToolCall for wrapping custom diff content
 */
export const DiffContainer: React.FC<
  React.PropsWithChildren<{ fontSize?: string; maxHeight?: string; className?: string }>
> = ({ children, fontSize, maxHeight, className }) => {
  const resolvedMaxHeight = maxHeight ?? "400px";
  const [isExpanded, setIsExpanded] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = React.useState(false);
  const clampContent = resolvedMaxHeight !== "none" && !isExpanded;

  React.useEffect(() => {
    if (maxHeight === "none") {
      setIsExpanded(false);
    }
  }, [maxHeight]);

  React.useEffect(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }

    const updateOverflowState = () => {
      setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
    };

    updateOverflowState();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(updateOverflowState);
      resizeObserver.observe(element);
    }

    return () => {
      resizeObserver?.disconnect();
    };
  }, [resolvedMaxHeight, clampContent]);

  const showOverflowControls = clampContent && isOverflowing;

  return (
    <div
      className={cn(
        "relative m-0 rounded-sm border border-border-light bg-code-bg py-1.5 [&_*]:text-[inherit]",
        className
      )}
    >
      <div
        ref={contentRef}
        className={cn(
          "grid overflow-x-auto",
          clampContent ? "overflow-y-hidden" : "overflow-y-visible",
          showOverflowControls && "pb-6"
        )}
        style={{
          fontSize: fontSize ?? "12px",
          lineHeight: 1.4,
          maxHeight: clampContent ? resolvedMaxHeight : undefined,
          gridTemplateColumns: "minmax(min-content, 1fr)",
        }}
      >
        {children}
      </div>

      {showOverflowControls && (
        <>
          <div className="via-[color-mix(in srgb, var(--color-code-bg) 80%, transparent)] pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--color-code-bg)] to-transparent" />
          <div className="absolute inset-x-0 bottom-0 flex justify-center pb-1.5">
            <button
              className="bg-dark/60 text-foreground/80 hover:text-foreground border border-white/20 px-2 py-0.5 text-[10px] tracking-wide uppercase backdrop-blur transition hover:border-white/40"
              onClick={() => setIsExpanded(true)}
            >
              Expand diff
            </button>
          </div>
        </>
      )}
    </div>
  );
};

interface DiffRendererProps {
  /** Raw diff content with +/- prefixes */
  content: string;
  /** Whether to show line numbers (default: true) */
  showLineNumbers?: boolean;
  /** Starting old line number for context */
  oldStart?: number;
  /** Starting new line number for context */
  newStart?: number;
  /** File path for language detection (optional, enables syntax highlighting) */
  filePath?: string;
  /** Font size for diff content (default: "12px") */
  fontSize?: string;
  /** Max height for diff container (default: "400px", use "none" for no limit) */
  maxHeight?: string;
  /** Additional className for container (e.g., "rounded-none" to remove rounding) */
  className?: string;
}

/**
 * Hook to pre-process and highlight diff content in chunks
 * Runs once when content/language changes (NOT search - that's applied post-process)
 *
 * CACHING: Once highlighted with real language, result is cached even if enableHighlighting
 * becomes false later. This prevents re-highlighting during scroll when hunks leave viewport.
 */
function useHighlightedDiff(
  content: string,
  language: string,
  oldStart: number,
  newStart: number,
  themeMode: ThemeMode
): HighlightedChunk[] | null {
  const [chunks, setChunks] = useState<HighlightedChunk[] | null>(null);
  // Track if we've already highlighted with real syntax (to prevent downgrading)
  const hasHighlightedRef = React.useRef(false);

  useEffect(() => {
    // If already highlighted and trying to switch to plain text, keep the highlighted version
    if (hasHighlightedRef.current && language === "text") {
      return; // Keep cached highlighted chunks
    }

    let cancelled = false;

    async function highlight() {
      // Split into lines (preserve indices for selection + rendering)
      const lines = splitDiffLines(content);

      // Group into chunks
      const diffChunks = groupDiffLines(lines, oldStart, newStart);

      // Highlight each chunk (without search decorations - those are applied later)
      const highlighted = await Promise.all(
        diffChunks.map((chunk) => highlightDiffChunk(chunk, language, themeMode))
      );

      if (!cancelled) {
        setChunks(highlighted);
        // Mark as highlighted if using real language (not plain text)
        if (language !== "text") {
          hasHighlightedRef.current = true;
        }
      }
    }

    void highlight();

    return () => {
      cancelled = true;
    };
  }, [content, language, oldStart, newStart, themeMode]);

  return chunks;
}

/**
 * DiffRenderer - Renders diff content with consistent styling
 *
 * Expects content with standard diff format:
 * - Lines starting with '+' are additions (green)
 * - Lines starting with '-' are removals (red)
 * - Lines starting with ' ' or anything else are context
 * - Lines starting with '@@' are headers (blue)
 */
export const DiffRenderer: React.FC<DiffRendererProps> = ({
  content,
  showLineNumbers = true,
  oldStart = 1,
  newStart = 1,
  filePath,
  fontSize,
  maxHeight,
  className,
}) => {
  // Detect language for syntax highlighting (memoized to prevent repeated detection)
  const { theme } = useTheme();
  const language = React.useMemo(
    () => (filePath ? getLanguageFromPath(filePath) : "text"),
    [filePath]
  );

  const highlightedChunks = useHighlightedDiff(content, language, oldStart, newStart, theme);

  const lineNumberWidths = React.useMemo(() => {
    if (!showLineNumbers || !highlightedChunks) {
      return { oldWidthCh: 2, newWidthCh: 2 };
    }

    let oldWidthCh = 0;
    let newWidthCh = 0;

    for (const chunk of highlightedChunks) {
      for (const line of chunk.lines) {
        if (line.oldLineNumber !== null) {
          oldWidthCh = Math.max(oldWidthCh, String(line.oldLineNumber).length);
        }
        if (line.newLineNumber !== null) {
          newWidthCh = Math.max(newWidthCh, String(line.newLineNumber).length);
        }
      }
    }

    return {
      oldWidthCh: Math.max(2, oldWidthCh),
      newWidthCh: Math.max(2, newWidthCh),
    };
  }, [highlightedChunks, showLineNumbers]);

  // Show loading state while highlighting
  if (!highlightedChunks) {
    return (
      <DiffContainer fontSize={fontSize} maxHeight={maxHeight} className={className}>
        <div style={{ opacity: 0.5, padding: "8px" }}>Processing...</div>
      </DiffContainer>
    );
  }

  return (
    <DiffContainer fontSize={fontSize} maxHeight={maxHeight} className={className}>
      {highlightedChunks.flatMap((chunk) =>
        chunk.lines.map((line) => {
          return (
            <div key={line.originalIndex} className="flex w-full">
              <DiffLineGutter
                type={chunk.type}
                oldLineNum={line.oldLineNumber}
                newLineNum={line.newLineNumber}
                showLineNumbers={showLineNumbers}
                lineNumberWidths={lineNumberWidths}
              />
              <span
                className="font-monospace min-w-0 flex-1 whitespace-pre [&_span:not(.search-highlight)]:!bg-transparent"
                style={{
                  background: getDiffLineBackground(chunk.type),
                  color: getLineContentColor(chunk.type),
                }}
              >
                <DiffIndicator type={chunk.type} />
                <span dangerouslySetInnerHTML={{ __html: line.html }} />
              </span>
            </div>
          );
        })
      )}
    </DiffContainer>
  );
};

// Selectable version of DiffRenderer for Code Review
interface SelectableDiffRendererProps extends Omit<DiffRendererProps, "filePath"> {
  /** File path for generating review notes */
  filePath: string;
  /** Callback when user submits a review note with structured data */
  onReviewNote?: (data: ReviewNoteData) => void;
  /** Callback when user clicks on a line (to activate parent hunk) */
  onLineClick?: () => void;
  /** Search highlight configuration (optional) */
  searchConfig?: SearchHighlightConfig;
  /** Enable syntax highlighting (default: true). Set to false to skip highlighting for off-screen hunks */
  enableHighlighting?: boolean;
}

interface LineSelection {
  startIndex: number;
  endIndex: number;
}

// CSS class for diff line wrapper - used by arbitrary selector in CommentButton
const SELECTABLE_DIFF_LINE_CLASS = "selectable-diff-line";

// Separate component to prevent re-rendering diff lines on every keystroke
interface ReviewNoteInputProps {
  selection: LineSelection;
  lineData: Array<{
    index: number;
    type: DiffLineType;
    oldLineNum: number | null;
    newLineNum: number | null;
    raw: string; // Original line with +/- prefix
  }>;
  filePath: string;
  showLineNumbers: boolean;
  lineNumberWidths: { oldWidthCh: number; newWidthCh: number };
  onSubmit: (data: ReviewNoteData) => void;
  onCancel: () => void;
}

const ReviewNoteInput: React.FC<ReviewNoteInputProps> = React.memo(
  ({ selection, lineData, filePath, showLineNumbers, lineNumberWidths, onSubmit, onCancel }) => {
    const [noteText, setNoteText] = React.useState("");
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);

    // Auto-focus on mount
    React.useEffect(() => {
      textareaRef.current?.focus();
    }, []);

    // Auto-expand textarea as user types
    React.useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }, [noteText]);

    const handleSubmit = () => {
      if (!noteText.trim()) return;

      const [start, end] = [selection.startIndex, selection.endIndex].sort((a, b) => a - b);
      const selectedLineData = lineData.slice(start, end + 1);

      const oldLineNumbers = selectedLineData
        .map((lineInfo) => lineInfo.oldLineNum)
        .filter((lineNum): lineNum is number => lineNum !== null);
      const newLineNumbers = selectedLineData
        .map((lineInfo) => lineInfo.newLineNum)
        .filter((lineNum): lineNum is number => lineNum !== null);

      const formatRange = (nums: number[]) => {
        if (nums.length === 0) return null;
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        return min === max ? `${min}` : `${min}-${max}`;
      };

      const oldRange = formatRange(oldLineNumbers);
      const newRange = formatRange(newLineNumbers);
      const lineRange = [oldRange ? `-${oldRange}` : null, newRange ? `+${newRange}` : null]
        .filter((part): part is string => Boolean(part))
        .join(" ");

      const oldWidth = Math.max(1, ...oldLineNumbers.map((n) => String(n).length));
      const newWidth = Math.max(1, ...newLineNumbers.map((n) => String(n).length));

      const allLines = selectedLineData.map((lineInfo) => {
        const indicator = lineInfo.raw[0] ?? " "; // +, -, or space
        const content = lineInfo.raw.slice(1); // Remove the indicator

        const oldStr = lineInfo.oldLineNum === null ? "" : String(lineInfo.oldLineNum);
        const newStr = lineInfo.newLineNum === null ? "" : String(lineInfo.newLineNum);

        return `${oldStr.padStart(oldWidth)} ${newStr.padStart(newWidth)} ${indicator} ${content}`;
      });

      // Elide middle lines if more than 20 lines selected (show 10 at start, 10 at end)
      let selectedCode: string;
      const CONTEXT_LINES = 10;
      const MAX_FULL_LINES = CONTEXT_LINES * 2;
      if (allLines.length <= MAX_FULL_LINES) {
        selectedCode = allLines.join("\n");
      } else {
        const omittedCount = allLines.length - MAX_FULL_LINES;
        selectedCode = [
          ...allLines.slice(0, CONTEXT_LINES),
          `    (${omittedCount} lines omitted)`,
          ...allLines.slice(-CONTEXT_LINES),
        ].join("\n");
      }

      const selectedDiff = selectedLineData.map((lineInfo) => lineInfo.raw).join("\n");
      const oldStart = oldLineNumbers.length ? Math.min(...oldLineNumbers) : 1;
      const newStart = newLineNumbers.length ? Math.min(...newLineNumbers) : 1;

      // Pass structured data instead of formatted message
      onSubmit({
        filePath,
        lineRange,
        selectedCode,
        selectedDiff,
        oldStart,
        newStart,
        userNote: noteText.trim(),
      });
    };

    // Determine the predominant line type for background matching
    const [start, end] = [selection.startIndex, selection.endIndex].sort((a, b) => a - b);
    const selectedTypes = lineData.slice(start, end + 1).map((l) => l.type);
    // Use the last selected line's type (where the input appears)
    const lineType = selectedTypes[selectedTypes.length - 1] ?? "context";

    return (
      <div className="flex w-full" style={{ background: getDiffLineBackground(lineType) }}>
        {/* Gutter spacer to align with diff lines */}
        <span
          className="font-monospace flex shrink-0 items-center gap-0.5 px-1 tabular-nums select-none"
          style={{ background: getDiffLineGutterBackground(lineType) }}
        >
          {showLineNumbers && (
            <>
              <span style={{ width: `${lineNumberWidths.oldWidthCh}ch` }} />
              <span className="ml-3" style={{ width: `${lineNumberWidths.newWidthCh}ch` }} />
            </>
          )}
        </span>
        {/* Indicator spacer */}
        <span className="inline-block w-4 shrink-0" />
        {/* Input container with accent styling */}
        <div className="min-w-0 flex-1 py-1.5 pr-3">
          <div
            className="flex w-full max-w-[560px] overflow-hidden rounded border border-[var(--color-review-accent)]/30 shadow-sm"
            style={{
              background: "hsl(from var(--color-review-accent) h s l / 0.08)",
            }}
          >
            {/* Left accent bar */}
            <div
              className="w-[3px] shrink-0"
              style={{ background: "var(--color-review-accent)" }}
            />
            <textarea
              ref={textareaRef}
              className="text-primary placeholder:text-muted/70 min-w-0 flex-1 resize-none overflow-y-hidden bg-transparent px-2 py-1.5 text-[12px] leading-[1.5] transition-colors focus:outline-none"
              style={{
                minHeight: "calc(12px * 1.5 * 2 + 12px)",
              }}
              placeholder="Add a review note… (Enter to submit, Shift+Enter for newline, Esc to cancel)"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();

                if (e.key === "Enter") {
                  if (e.shiftKey) {
                    // Shift+Enter: allow newline (default behavior)
                    return;
                  }
                  // Enter: submit
                  e.preventDefault();
                  handleSubmit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancel();
                }
              }}
            />
          </div>
        </div>
      </div>
    );
  }
);

ReviewNoteInput.displayName = "ReviewNoteInput";

export const SelectableDiffRenderer = React.memo<SelectableDiffRendererProps>(
  ({
    content,
    showLineNumbers = true,
    oldStart = 1,
    newStart = 1,
    filePath,
    fontSize,
    maxHeight,
    className,
    onReviewNote,
    onLineClick,
    searchConfig,
    enableHighlighting = true,
  }) => {
    const { theme } = useTheme();
    const [selection, setSelection] = React.useState<LineSelection | null>(null);

    // Detect language for syntax highlighting (memoized to prevent repeated detection)
    const language = React.useMemo(
      () => (filePath ? getLanguageFromPath(filePath) : "text"),
      [filePath]
    );

    // Only highlight if enabled (for viewport optimization)
    const highlightedChunks = useHighlightedDiff(
      content,
      enableHighlighting ? language : "text",
      oldStart,
      newStart,
      theme
    );

    // Parse raw lines once for use in lineData
    const rawLines = React.useMemo(() => splitDiffLines(content), [content]);

    // Build lineData from highlighted chunks (memoized to prevent repeated parsing)
    // Includes raw content for review note submission
    const lineData = React.useMemo(() => {
      if (!highlightedChunks) return [];

      const data: Array<{
        index: number;
        type: DiffLineType;
        oldLineNum: number | null;
        newLineNum: number | null;
        html: string;
        raw: string; // Original line with +/- prefix
      }> = [];

      highlightedChunks.forEach((chunk) => {
        chunk.lines.forEach((line) => {
          data.push({
            index: line.originalIndex,
            type: chunk.type,
            oldLineNum: line.oldLineNumber,
            newLineNum: line.newLineNumber,
            html: line.html,
            raw: rawLines[line.originalIndex] ?? "",
          });
        });
      });

      return data;
    }, [highlightedChunks, rawLines]);

    // Memoize highlighted line data to avoid re-parsing HTML on every render
    // Only recalculate when lineData or searchConfig changes
    const highlightedLineData = React.useMemo(() => {
      if (!searchConfig) return lineData;

      return lineData.map((line) => ({
        ...line,
        html: highlightSearchMatches(line.html, searchConfig),
      }));
    }, [lineData, searchConfig]);

    const lineNumberWidths = React.useMemo(() => {
      if (!showLineNumbers) {
        return { oldWidthCh: 2, newWidthCh: 2 };
      }

      let oldWidthCh = 0;
      let newWidthCh = 0;

      for (const line of lineData) {
        if (line.oldLineNum !== null) {
          oldWidthCh = Math.max(oldWidthCh, String(line.oldLineNum).length);
        }
        if (line.newLineNum !== null) {
          newWidthCh = Math.max(newWidthCh, String(line.newLineNum).length);
        }
      }

      return {
        oldWidthCh: Math.max(2, oldWidthCh),
        newWidthCh: Math.max(2, newWidthCh),
      };
    }, [lineData, showLineNumbers]);

    const handleCommentButtonClick = (lineIndex: number, shiftKey: boolean) => {
      // Notify parent that this hunk should become active
      onLineClick?.();

      // Shift-click: extend existing selection
      if (shiftKey && selection) {
        const start = selection.startIndex;
        setSelection({
          startIndex: start,
          endIndex: lineIndex,
        });
        return;
      }

      // Regular click: start new selection
      setSelection({
        startIndex: lineIndex,
        endIndex: lineIndex,
      });
    };

    const handleSubmitNote = (data: ReviewNoteData) => {
      if (!onReviewNote) return;
      onReviewNote(data);
      setSelection(null);
    };

    const handleCancelNote = () => {
      setSelection(null);
    };

    const isLineSelected = (index: number) => {
      if (!selection) return false;
      const [start, end] = [selection.startIndex, selection.endIndex].sort((a, b) => a - b);
      return index >= start && index <= end;
    };

    // Show loading state while highlighting
    if (!highlightedChunks || highlightedLineData.length === 0) {
      return (
        <DiffContainer fontSize={fontSize} maxHeight={maxHeight} className={className}>
          <div style={{ opacity: 0.5, padding: "8px" }}>Processing...</div>
        </DiffContainer>
      );
    }

    return (
      <DiffContainer fontSize={fontSize} maxHeight={maxHeight} className={className}>
        {highlightedLineData.map((lineInfo, displayIndex) => {
          const isSelected = isLineSelected(displayIndex);

          return (
            <React.Fragment key={displayIndex}>
              <div
                className={cn(SELECTABLE_DIFF_LINE_CLASS, "flex w-full relative cursor-text group")}
                style={{
                  background: isSelected
                    ? "hsl(from var(--color-review-accent) h s l / 0.16)"
                    : "transparent",
                }}
              >
                <DiffLineGutter
                  type={lineInfo.type}
                  oldLineNum={lineInfo.oldLineNum}
                  newLineNum={lineInfo.newLineNum}
                  showLineNumbers={showLineNumbers}
                  lineNumberWidths={lineNumberWidths}
                />
                <span
                  className="font-monospace min-w-0 flex-1 whitespace-pre [&_span:not(.search-highlight)]:!bg-transparent"
                  style={{
                    background: getDiffLineBackground(lineInfo.type),
                    color: getLineContentColor(lineInfo.type),
                  }}
                >
                  <DiffIndicator
                    type={lineInfo.type}
                    reviewButton={
                      onReviewNote && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-sm text-[var(--color-review-accent)]/60 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:text-[var(--color-review-accent)] active:scale-90"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCommentButtonClick(displayIndex, e.shiftKey);
                              }}
                              aria-label="Add review comment"
                            >
                              <MessageSquare className="size-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" align="start">
                            Add review comment
                            <br />
                            (Shift-click to select range)
                          </TooltipContent>
                        </Tooltip>
                      )
                    }
                  />
                  <span dangerouslySetInnerHTML={{ __html: lineInfo.html }} />
                </span>
              </div>

              {/* Show textarea after the last selected line */}
              {isSelected &&
                selection &&
                displayIndex === Math.max(selection.startIndex, selection.endIndex) && (
                  <ReviewNoteInput
                    selection={selection}
                    lineData={lineData}
                    filePath={filePath}
                    showLineNumbers={showLineNumbers}
                    lineNumberWidths={lineNumberWidths}
                    onSubmit={handleSubmitNote}
                    onCancel={handleCancelNote}
                  />
                )}
            </React.Fragment>
          );
        })}
      </DiffContainer>
    );
  }
);

SelectableDiffRenderer.displayName = "SelectableDiffRenderer";
