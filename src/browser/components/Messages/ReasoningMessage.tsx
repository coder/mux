import React, { useState, useEffect, useRef, useLayoutEffect } from "react";
import type { DisplayedMessage } from "@/common/types/message";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { TypewriterMarkdown } from "./TypewriterMarkdown";
import { normalizeReasoningMarkdown } from "./MarkdownStyles";
import { cn } from "@/common/lib/utils";
import { Shimmer } from "../ai-elements/shimmer";
import { Lightbulb } from "lucide-react";

interface ReasoningMessageProps {
  message: DisplayedMessage & { type: "reasoning" };
  className?: string;
}

const REASONING_FONT_CLASSES = "font-primary text-[12px] leading-[18px]";
const MAX_SUMMARY_CHARS = 240;

function parseLeadingBoldSummary(
  summary: string
): { boldText: string; trailingText: string } | null {
  // OpenAI reasoning summaries commonly start with markdown bold: "**Title**".
  // Parse only a leading pair so we can keep the cheap plain-text header render while
  // preserving the expected visual emphasis.
  if (!summary.startsWith("**")) {
    return null;
  }

  const closingMarkerIndex = summary.indexOf("**", 2);
  if (closingMarkerIndex <= 2) {
    return null;
  }

  const boldText = summary.slice(2, closingMarkerIndex).trim();
  if (!boldText) {
    return null;
  }

  return {
    boldText,
    trailingText: summary.slice(closingMarkerIndex + 2),
  };
}

export const ReasoningMessage: React.FC<ReasoningMessageProps> = ({ message, className }) => {
  const [isExpanded, setIsExpanded] = useState(message.isStreaming);
  // Track the height when expanded to reserve space during collapse transitions
  const [expandedHeight, setExpandedHeight] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const content = message.content;
  const isStreaming = message.isStreaming;
  const trimmedContent = content?.trim() ?? "";
  const hasContent = trimmedContent.length > 0;
  const summaryLineRaw = hasContent ? (trimmedContent.split(/\r?\n/)[0] ?? "") : "";
  const summaryLine =
    summaryLineRaw.length > MAX_SUMMARY_CHARS
      ? `${summaryLineRaw.slice(0, MAX_SUMMARY_CHARS)}…`
      : summaryLineRaw;
  const parsedLeadingBoldSummary = parseLeadingBoldSummary(summaryLine);
  const hasAdditionalLines = hasContent && /[\r\n]/.test(trimmedContent);
  // OpenAI models often emit terse, single-line traces; surface them inline instead of hiding behind the label.
  const isSingleLineTrace = !isStreaming && hasContent && !hasAdditionalLines;
  const isCollapsible = !isStreaming && hasContent && hasAdditionalLines;
  const showEllipsis = isCollapsible && !isExpanded;
  const showExpandedContent = isExpanded && !isSingleLineTrace;

  // Capture expanded height before collapsing to enable smooth transitions
  useLayoutEffect(() => {
    if (contentRef.current && isExpanded && !isSingleLineTrace) {
      setExpandedHeight(contentRef.current.scrollHeight);
    }
  }, [isExpanded, isSingleLineTrace, content]);

  const wasStreamingRef = useRef(isStreaming);

  // Auto-collapse only when a stream transitions from active -> completed.
  // Keep user-triggered expansion working for completed messages.
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;

    if (wasStreaming && !isStreaming) {
      setIsExpanded(false);
    }
  }, [isStreaming]);

  const toggleExpanded = () => {
    if (!isCollapsible) {
      return;
    }

    setIsExpanded(!isExpanded);
  };

  // Render appropriate content based on state
  const renderContent = () => {
    // Empty streaming state
    if (isStreaming && !content) {
      return <div className="text-thinking-mode opacity-60">Thinking...</div>;
    }

    // Preserve single newlines so short section headers (e.g. "Fixing …") don't get
    // collapsed into the previous paragraph by the markdown renderer.
    //
    // Also apply a small heuristic fixup for providers that omit a leading newline
    // before bold section headers (e.g. `...!**Deciding...**\n\n`).
    // Streaming text gets typewriter effect.
    if (isStreaming) {
      return (
        <TypewriterMarkdown
          deltas={[normalizeReasoningMarkdown(content)]}
          isComplete={false}
          preserveLineBreaks
          streamKey={message.historyId}
          streamSource={message.streamPresentation?.source}
        />
      );
    }

    // Completed text renders as static content
    return content ? (
      <MarkdownRenderer content={normalizeReasoningMarkdown(content)} preserveLineBreaks />
    ) : null;
  };

  return (
    <div
      className={cn(
        "my-2 px-2 py-1 bg-[color-mix(in_srgb,var(--color-thinking-mode)_5%,transparent)] rounded relative",
        className
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 select-none",
          isCollapsible && "cursor-pointer",
          isExpanded && !isSingleLineTrace && "mb-1.5"
        )}
        onClick={isCollapsible ? toggleExpanded : undefined}
      >
        <div
          className={cn(
            "flex flex-1 items-center gap-1 min-w-0 text-xs opacity-80",
            "text-thinking-mode"
          )}
        >
          <span className="text-xs">
            <Lightbulb className={cn("size-3.5", isStreaming && "animate-pulse")} />
          </span>
          <div className="flex min-w-0 items-center gap-1 truncate">
            {isStreaming ? (
              <Shimmer colorClass="var(--color-thinking-mode)">Thinking...</Shimmer>
            ) : hasContent ? (
              <span className={cn("truncate whitespace-nowrap text-text", REASONING_FONT_CLASSES)}>
                {parsedLeadingBoldSummary ? (
                  <>
                    <strong>{parsedLeadingBoldSummary.boldText}</strong>
                    {parsedLeadingBoldSummary.trailingText}
                  </>
                ) : (
                  summaryLine
                )}
              </span>
            ) : (
              "Thought"
            )}
            {showEllipsis && (
              <span
                className="text-[11px] tracking-widest text-[color:var(--color-text)] opacity-70"
                data-testid="reasoning-ellipsis"
              >
                ...
              </span>
            )}
          </div>
        </div>
        {isCollapsible && (
          <span
            className={cn(
              "text-thinking-mode opacity-60 transition-transform duration-200 ease-in-out text-xs",
              isExpanded ? "rotate-90" : "rotate-0"
            )}
          >
            ▸
          </span>
        )}
      </div>

      {/* Always render the content container to prevent layout shifts.
          Use CSS transitions for smooth height changes instead of conditional rendering. */}
      <div
        ref={contentRef}
        className={cn(
          REASONING_FONT_CLASSES,
          "italic opacity-85 [&_p]:mt-0 [&_p]:mb-1 [&_p:last-child]:mb-0",
          "overflow-hidden transition-[height,opacity] duration-200 ease-in-out"
        )}
        style={{
          height: showExpandedContent ? (expandedHeight ?? "auto") : 0,
          opacity: showExpandedContent ? 1 : 0,
        }}
        aria-hidden={!showExpandedContent}
      >
        {isStreaming || showExpandedContent ? renderContent() : null}
      </div>
    </div>
  );
};
