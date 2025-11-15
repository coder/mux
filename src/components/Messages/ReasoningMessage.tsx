import React, { useState, useEffect } from "react";
import type { DisplayedMessage } from "@/types/message";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { TypewriterMarkdown } from "./TypewriterMarkdown";
import { cn } from "@/lib/utils";
import { Shimmer } from "../ai-elements/shimmer";
import { Lightbulb } from "lucide-react";

interface ReasoningMessageProps {
  message: DisplayedMessage & { type: "reasoning" };
  className?: string;
}

export const ReasoningMessage: React.FC<ReasoningMessageProps> = ({ message, className }) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const content = message.content;
  const isStreaming = message.isStreaming;

  // Auto-collapse when streaming ends
  useEffect(() => {
    if (!isStreaming) {
      setIsExpanded(false);
    }
  }, [isStreaming]);

  const toggleExpanded = () => {
    if (!isStreaming) {
      setIsExpanded(!isExpanded);
    }
  };

  // Render appropriate content based on state
  const renderContent = () => {
    // Empty streaming state
    if (isStreaming && !content) {
      return <div className="text-thinking-mode opacity-60">Thinking...</div>;
    }

    // Streaming text gets typewriter effect
    if (isStreaming) {
      return <TypewriterMarkdown deltas={[content]} isComplete={false} />;
    }

    // Completed text renders as static content
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
          "flex cursor-pointer items-center justify-between gap-2 select-none",
          isExpanded && "mb-1.5"
        )}
        onClick={toggleExpanded}
      >
        <div className="text-thinking-mode flex items-center gap-1 text-xs opacity-80">
          <span className="text-xs">
            <Lightbulb className={cn("size-3.5", isStreaming && "animate-pulse")} />
          </span>
          <span>
            {isStreaming ? (
              <Shimmer colorClass="var(--color-thinking-mode)">Thinking...</Shimmer>
            ) : (
              "Thought..."
            )}
          </span>
        </div>
        {!isStreaming && (
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

      {isExpanded && (
        <div className="font-primary text-sm leading-6 italic opacity-85 [&_p]:mt-0 [&_p]:mb-1 [&_p:last-child]:mb-0">
          {renderContent()}
        </div>
      )}
    </div>
  );
};
