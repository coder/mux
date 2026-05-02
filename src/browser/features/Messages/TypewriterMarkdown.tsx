import React, { useLayoutEffect, useRef } from "react";
import { useSmoothStreamingText } from "@/browser/hooks/useSmoothStreamingText";
import { useWorkspaceStreamingStats } from "@/browser/stores/WorkspaceStore";
import { cn } from "@/common/lib/utils";
import { MarkdownCore } from "./MarkdownCore";
import { StreamingContext } from "./StreamingContext";

interface TypewriterMarkdownProps {
  /** Full text to render. During streaming this grows monotonically. */
  content: string;
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
  /**
   * Workspace this content belongs to. When provided, the smoothing engine is
   * fed the live model emission rate so the visible cursor tracks the model's
   * actual output rather than the constant BASE rate. Optional because some
   * surfaces (storybook, preview popovers) render markdown without a workspace.
   */
  workspaceId?: string;
}

// React Compiler memoizes this component automatically based on prop changes;
// no manual React.memo wrapper. The previous deltas: string[] shape forced a new
// array literal on every parent render and defeated the memo anyway.
export const TypewriterMarkdown: React.FC<TypewriterMarkdownProps> = ({
  content,
  isComplete,
  className,
  preserveLineBreaks,
  streamKey,
  streamSource = "live",
  workspaceId,
}) => {
  const isStreaming = !isComplete && content.length > 0;

  // Read the live model emission rate (chars/sec) for the active stream of this
  // workspace. The hook subscribes to its own MapStore so per-delta updates
  // re-render this component WITHOUT cascading through the parent — see
  // useWorkspaceStreamingStats.
  //
  // Subscribe to the real workspace key ONLY while this message is actively
  // streaming. Completed historical messages subscribe to the stable empty-key
  // sentinel, which is never bumped — so a long transcript of finished
  // assistant messages does not re-render on every delta of a new stream.
  // (Hooks must run unconditionally; we toggle the key, not the call site.)
  const subscriptionKey = isStreaming && workspaceId ? workspaceId : "";
  const streamingStats = useWorkspaceStreamingStats(subscriptionKey);
  const liveCharsPerSec = isStreaming && workspaceId ? (streamingStats?.charsPerSec ?? 0) : 0;

  // Two-clock streaming: ingestion (content) vs presentation (visibleText).
  // The jitter buffer reveals text at a steady cadence instead of bursty token clumps.
  // Replay and completed streams bypass smoothing entirely.
  const { visibleText } = useSmoothStreamingText({
    fullText: content,
    isStreaming,
    bypassSmoothing: streamSource === "replay",
    streamKey: streamKey ?? "",
    liveCharsPerSec,
  });

  // React Compiler memoizes this object; no manual useMemo needed.
  const streamingContextValue = { isStreaming };

  // Gate the viewport-aware fade-in mask (see globals.css) on LIVE streams
  // only. Replay rows are emitted as isStreaming=true with
  // streamSource="replay" while the backend rebuilds history on reconnect
  // (StreamingMessageAggregator emits `streamPresentation: { source: "replay" }`);
  // without this guard, every replayed message would briefly fade in on
  // reconnect/load. Completed messages also have isStreaming=false so the
  // attribute is naturally absent. Using `|| undefined` keeps the attribute
  // *off the DOM* (not "false") so the [data-streaming="true"] CSS selector
  // simply cannot match.
  const isLiveStreaming = isStreaming && streamSource !== "replay";

  // Temporal fade-in for newly-completed visual lines.
  //
  // The CSS mask in globals.css always hides the bottom ~1 visual line (the
  // line currently being typed). When the rendered height GROWS — because a
  // visual line wrapped, a new paragraph was added, etc. — we briefly push
  // the transparent strip up by `delta` so the just-revealed content is
  // initially also covered, then animate `--reveal-y` back to 0 over 250ms.
  // The mask gradient sweeps past the new content, fading it in.
  //
  // Why ResizeObserver and not the visibleText prop:
  //  - Height growth is the right signal because it directly tracks visual
  //    rows in the user's viewport. Character appends within the current
  //    in-progress row don't change height (no need to fade), but wrapping
  //    to a new row does — and so do width-driven re-wraps from sidebar
  //    collapse, window resize, zoom, etc.
  //  - Driving off `visibleText` would miss layout-only changes and would
  //    force a render cycle just to measure height.
  //
  // Why Element.animate() (WAAPI) instead of CSS transitions:
  //  - We need to set --reveal-y to a value that depends on the runtime
  //    delta (height growth in px). A CSS transition can interpolate
  //    between two values but we'd still need JS to set the start value
  //    before the layout commits. `animate()` runs entirely on the
  //    compositor thread once started — no extra paint.
  //  - Custom property animation requires the @property declaration in
  //    globals.css (also there) so the syntax `<length>` is interpolatable.
  const containerRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef<number>(0);
  const activeAnimationRef = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (!isLiveStreaming) return;
    const el = containerRef.current;
    if (!el) return;
    // Test environments (happy-dom) don't provide ResizeObserver; the fade
    // is a pure presentation concern, so degrade silently. Real browsers
    // (Electron Chromium) always have it.
    if (typeof ResizeObserver === "undefined") return;
    // Seed the baseline so the first observed callback (which fires once
    // synchronously when observe() is called in modern browsers) does not
    // misinterpret the initial height as a delta.
    lastHeightRef.current = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const newHeight = el.offsetHeight;
      const delta = newHeight - lastHeightRef.current;
      lastHeightRef.current = newHeight;
      if (delta <= 0) return;
      // Cancel any in-flight pulse so consecutive wraps don't stack and
      // produce visual jitter; the most recent delta wins.
      activeAnimationRef.current?.cancel();
      try {
        activeAnimationRef.current = el.animate(
          [{ "--reveal-y": `${delta}px` }, { "--reveal-y": "0px" }],
          { duration: 250, easing: "ease-out", fill: "none" }
        );
      } catch {
        // Older runtimes without @property-typed-custom-property support
        // (none of which we ship to). Silently fall back to no animation.
        activeAnimationRef.current = null;
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      activeAnimationRef.current?.cancel();
      activeAnimationRef.current = null;
    };
  }, [isLiveStreaming]);

  return (
    <StreamingContext.Provider value={streamingContextValue}>
      <div
        ref={containerRef}
        className={cn("markdown-content", className)}
        data-streaming={isLiveStreaming || undefined}
      >
        <MarkdownCore
          content={visibleText}
          parseIncompleteMarkdown={isStreaming}
          preserveLineBreaks={preserveLineBreaks}
        />
      </div>
    </StreamingContext.Provider>
  );
};
