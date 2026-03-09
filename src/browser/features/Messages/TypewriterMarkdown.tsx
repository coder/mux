import React, { useMemo } from "react";
import { useSmoothStreamingText } from "@/browser/hooks/useSmoothStreamingText";
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
  /** Unique key for the current stream — reset smooth engine on change. */
  streamKey?: string;
  /** Whether this stream originated from live tokens or replay. Defaults to "live". */
  streamSource?: "live" | "replay";
}

// Use React.memo to prevent unnecessary re-renders from parent
export const TypewriterMarkdown = React.memo<TypewriterMarkdownProps>(function TypewriterMarkdown({
  deltas,
  isComplete,
  className,
  preserveLineBreaks,
  streamKey,
  streamSource = "live",
}) {
  const fullContent = deltas.join("");
  const isStreaming = !isComplete && fullContent.length > 0;

  // Two-clock streaming: ingestion (fullContent) vs presentation (visibleText).
  // The jitter buffer reveals text at a steady cadence instead of bursty token clumps.
  // Replay and completed streams bypass smoothing entirely.
  const { visibleText } = useSmoothStreamingText({
    fullText: fullContent,
    isStreaming,
    bypassSmoothing: streamSource === "replay",
    streamKey: streamKey ?? "",
  });

  const streamingContextValue = useMemo(() => ({ isStreaming }), [isStreaming]);

  return (
    <StreamingContext.Provider value={streamingContextValue}>
      <div className={cn("markdown-content", className)}>
        <MarkdownCore
          content={visibleText}
          parseIncompleteMarkdown={isStreaming}
          preserveLineBreaks={preserveLineBreaks}
        />
      </div>
    </StreamingContext.Provider>
  );
});
