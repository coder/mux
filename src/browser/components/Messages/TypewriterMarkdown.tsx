import React, { useMemo } from "react";
import { cn } from "@/common/lib/utils";
import { MarkdownCore } from "./MarkdownCore";
import { StreamingContext } from "./StreamingContext";

interface TypewriterMarkdownProps {
  deltas: string[];
  isComplete: boolean;
  className?: string;
  /**
   * Preserve single newlines as line breaks (like GitHub-flavored markdown).
   * Useful for plain-text-ish content (e.g. reasoning blocks) where line breaks
   * are often intentional.
   */
  preserveLineBreaks?: boolean;
}

// Use React.memo to prevent unnecessary re-renders from parent
export const TypewriterMarkdown = React.memo<TypewriterMarkdownProps>(function TypewriterMarkdown({
  deltas,
  isComplete,
  className,
  preserveLineBreaks,
}) {
  // Simply join all deltas - no artificial delays or character-by-character rendering
  const content = deltas.join("");

  // Show cursor only when streaming (not complete)
  const isStreaming = !isComplete && content.length > 0;

  const streamingContextValue = useMemo(() => ({ isStreaming }), [isStreaming]);

  return (
    <StreamingContext.Provider value={streamingContextValue}>
      <div className={cn("markdown-content", className)}>
        <MarkdownCore
          content={content}
          parseIncompleteMarkdown={isStreaming}
          preserveLineBreaks={preserveLineBreaks}
        />
      </div>
    </StreamingContext.Provider>
  );
});
