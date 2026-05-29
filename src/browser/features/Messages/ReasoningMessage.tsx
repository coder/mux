import React, { useState, useRef, useLayoutEffect } from "react";
import type { DisplayedMessage } from "@/common/types/message";
import { TypewriterMarkdown } from "./TypewriterMarkdown";
import { normalizeReasoningMarkdown } from "./MarkdownStyles";
import { cn } from "@/common/lib/utils";
import { Shimmer } from "../AIElements/Shimmer";
import { Lightbulb } from "lucide-react";

interface ReasoningMessageProps {
  message: DisplayedMessage & { type: "reasoning" };
  className?: string;
  /**
   * Workspace this reasoning belongs to. Forwarded to TypewriterMarkdown so the
   * smoothing engine can target the model's live emission rate. Optional —
   * tests render this component without a workspace context.
   */
  workspaceId?: string;
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

export const ReasoningMessage: React.FC<ReasoningMessageProps> = ({
  message,
  className,
  workspaceId,
}) => {
  const [isExpanded, setIsExpanded] = useState(message.isStreaming);
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

  const wasStreamingRef = useRef(isStreaming);
  const isLastPartOfMessage =
    "isLastPartOfMessage" in message ? message.isLastPartOfMessage : false;
  // When the parent message contains *only* reasoning (e.g. the stream was
  // truncated at max_tokens before any text/tool emerged), collapsing leaves
  // the user staring at a single "Thinking" header and nothing else. Skip the
  // auto-collapse in that case so the work the model did is still readable;
  // the accompanying stream-error row from SMA explains why the turn stopped.
  const isOnlyMessageContent =
    "isOnlyMessageContent" in message ? message.isOnlyMessageContent === true : false;

  // Auto-collapse only when reasoning reached *natural* completion — i.e. the
  // stream ended while this reasoning part was still the terminal block of the
  // message. When another part (text/tool) follows the reasoning, its
  // `isLastPartOfMessage` flips false in the same aggregator snapshot that turns
  // `isStreaming` off, which used to trigger a mid-turn 200ms height→0 animation
  // (a very visible vertical tear). Keeping the reasoning expanded in that case
  // lets the user continue reading it while the assistant moves on.
  useLayoutEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;

    if (wasStreaming && !isStreaming && isLastPartOfMessage && !isOnlyMessageContent) {
      setIsExpanded(false);
    }
  }, [isStreaming, isLastPartOfMessage, isOnlyMessageContent]);

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

    if (!content) {
      return null;
    }

    // Preserve single newlines so short section headers (e.g. "Fixing …") don't get
    // collapsed into the previous paragraph by the markdown renderer.
    //
    // Use TypewriterMarkdown for both streaming and settled reasoning so the component
    // identity is stable across stream completion — swapping to MarkdownRenderer at
    // stream end would unmount/remount the markdown subtree and visibly flash the
    // content. isComplete={!isStreaming} cleanly bypasses the smoothing engine once
    // the stream ends, matching the prior static-render behavior.
    // React Compiler auto-memoizes this normalize call between renders that
    // share the same `content` value; no manual useMemo needed.
    const normalizedContent = normalizeReasoningMarkdown(content);

    return (
      <TypewriterMarkdown
        content={normalizedContent}
        isComplete={!isStreaming}
        preserveLineBreaks
        streamKey={message.historyId}
        streamSource={message.streamPresentation?.source}
        workspaceId={workspaceId}
      />
    );
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

      {/* Always render the content container to prevent layout shifts. Keep live and
          expanded content height uncontrolled so async markdown growth (Shiki/Mermaid)
          cannot be clipped by a stale measured height; only collapsed settled content
          gets height:0. */}
      <div
        className={cn(
          REASONING_FONT_CLASSES,
          "italic opacity-85 [&_p]:mt-0 [&_p]:mb-1 [&_p:last-child]:mb-0",
          !isStreaming && "overflow-hidden transition-opacity duration-200 ease-in-out"
        )}
        style={
          isStreaming
            ? undefined
            : {
                height: showExpandedContent ? undefined : 0,
                opacity: showExpandedContent ? 1 : 0,
              }
        }
        aria-hidden={!showExpandedContent}
      >
        {isStreaming || showExpandedContent ? renderContent() : null}
      </div>
    </div>
  );
};
