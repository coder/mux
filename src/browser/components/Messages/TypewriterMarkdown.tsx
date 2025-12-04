import React, { useMemo } from "react";
import { cn } from "@/common/lib/utils";
import { MarkdownCore } from "./MarkdownCore";
import { StreamingContext } from "./StreamingContext";

interface TypewriterMarkdownProps {
  deltas: string[];
  isComplete: boolean;
  className?: string;
}

// Use React.memo to prevent unnecessary re-renders from parent
export const TypewriterMarkdown = React.memo<TypewriterMarkdownProps>(function TypewriterMarkdown({
  deltas,
  isComplete,
  className,
}) {
  // Simply join all deltas - no artificial delays or character-by-character rendering
  const content = deltas.join("");

  // Show cursor only when streaming (not complete)
  const isStreaming = !isComplete && content.length > 0;

  const streamingContextValue = useMemo(() => ({ isStreaming }), [isStreaming]);

  return (
    <StreamingContext.Provider value={streamingContextValue}>
      <div className={cn("markdown-content", className)}>
        <MarkdownCore content={content} parseIncompleteMarkdown={isStreaming} />
      </div>
    </StreamingContext.Provider>
  );
});
