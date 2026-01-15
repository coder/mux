import React, { useState, useEffect, useRef, useLayoutEffect } from "react";
import { Lightbulb } from "lucide-react";
import { cn } from "@/utils/cn";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type { DisplayedReasoningMessage } from "@/types";

interface ReasoningMessageProps {
  message: DisplayedReasoningMessage;
  className?: string;
}

const REASONING_FONT_CLASSES = "font-primary text-[12px] leading-[18px]";

/**
 * Reasoning/thinking message component for shared/read-only rendering.
 */
export const ReasoningMessage: React.FC<ReasoningMessageProps> = ({ message, className }) => {
  const [isExpanded, setIsExpanded] = useState(message.isStreaming);
  const [expandedHeight, setExpandedHeight] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const content = message.content;
  const isStreaming = message.isStreaming;
  const trimmedContent = content?.trim() ?? "";
  const hasContent = trimmedContent.length > 0;
  const summaryLine = hasContent ? (trimmedContent.split(/\r?\n/)[0] ?? "") : "";
  const hasAdditionalLines = hasContent && /[\r\n]/.test(trimmedContent);
  const isSingleLineTrace = !isStreaming && hasContent && !hasAdditionalLines;
  const isCollapsible = !isStreaming && hasContent && hasAdditionalLines;
  const showEllipsis = isCollapsible && !isExpanded;
  const showExpandedContent = isExpanded && !isSingleLineTrace;

  // Capture expanded height for smooth transitions
  useLayoutEffect(() => {
    if (contentRef.current && isExpanded && !isSingleLineTrace) {
      setExpandedHeight(contentRef.current.scrollHeight);
    }
  }, [isExpanded, isSingleLineTrace, content]);

  // Auto-collapse when streaming ends
  useEffect(() => {
    if (!isStreaming) {
      setIsExpanded(false);
    }
  }, [isStreaming]);

  const toggleExpanded = () => {
    if (isCollapsible) {
      setIsExpanded(!isExpanded);
    }
  };

  const renderContent = () => {
    if (isStreaming && !content) {
      return <div className="text-thinking-mode opacity-60">Thinking...</div>;
    }
    return content ? <MarkdownRenderer content={content} /> : null;
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
              <span className="animate-pulse">Thinking...</span>
            ) : hasContent ? (
              <span className="truncate">{summaryLine}</span>
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
        {renderContent()}
      </div>
    </div>
  );
};
