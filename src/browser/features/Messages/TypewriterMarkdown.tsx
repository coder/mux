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

  // Shimmer-on-completion for newly-revealed visual lines.
  //
  // The CSS in globals.css does two things on streaming content:
  //  1. A static mask hides the bottom 1.6em (the visual row currently
  //     being typed) when content is at least ~1.5 line-heights tall.
  //     Below that threshold, the message renders fully visible so short
  //     replies aren't blanked out.
  //  2. A `::before` pseudo-element sits at `bottom: 1.6em; height: 1.6em`
  //     — directly on the line above the masked-tail in-progress row —
  //     and contains a horizontal `currentColor` gradient (transparent
  //     edges, translucent middle) that can be swept across via
  //     `transform: translateX(var(--stream-shimmer-x))`.
  //
  // When ResizeObserver reports height growth (a visual line wrapped, a
  // new paragraph opened, etc.), we animate `--stream-shimmer-x` from
  // off-screen-left to off-screen-right over ~700ms. The bright band
  // travels across the just-completed line, then disappears off-screen
  // until the next wrap. Each line gets a brief moment of arrival before
  // settling into a stable visual state.
  //
  // Why a shimmer instead of a fade-in:
  //  - User feedback: prior fade-in (animated mask `--reveal-y` offset)
  //    felt abrupt even after tuning duration/easing/band-width. Fade is
  //    a global transparency change; shimmer is a local highlight that's
  //    intrinsically gentler — the line appears at full opacity and is
  //    just visited by a brief brightening sweep.
  //
  // Why ResizeObserver and not the visibleText prop:
  //  - Height growth is the right signal because it directly tracks visual
  //    rows in the user's viewport. Character appends within the current
  //    in-progress row don't change height (no need to shimmer), but
  //    wrapping to a new row does — and so do width-driven re-wraps from
  //    sidebar collapse, window resize, zoom, etc.
  //  - Driving off `visibleText` would miss layout-only changes and would
  //    force a render cycle just to measure height.
  //
  // Why Element.animate() (WAAPI) instead of CSS transitions:
  //  - We want a fresh one-shot pulse on each height-growth event, not a
  //    transition triggered by a state change. WAAPI fires a new
  //    animation each time we call animate(); we cancel the prior one so
  //    consecutive wraps don't stack.
  //  - Custom property animation requires the @property declaration in
  //    globals.css (also there) so the `<percentage>` syntax is
  //    interpolatable on the compositor thread.
  const containerRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef<number>(0);
  const activeAnimationRef = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (!isLiveStreaming) return;
    const el = containerRef.current;
    if (!el) return;
    // Test environments (happy-dom) don't provide ResizeObserver; the
    // shimmer is a pure presentation concern, so degrade silently. Real
    // browsers (Electron Chromium) always have it.
    if (typeof ResizeObserver === "undefined") return;

    // Threshold below which the mask + shimmer overlay are disabled
    // entirely. Computed from the element's actual computed line-height
    // so it scales with font-size and line-height overrides. 1.5 ×
    // line-height puts the threshold between 1-line and 2-line content,
    // with a small margin for sub-pixel rounding.
    const lineHeightPx = parseFloat(getComputedStyle(el).lineHeight) || 22.4;
    const hideTailThresholdPx = lineHeightPx * 1.5;

    const applyHideTail = (h: number) => {
      el.toggleAttribute("data-stream-hide-tail", h >= hideTailThresholdPx);
    };

    // Seed the baseline AND the initial attribute synchronously, before
    // the browser paints, so a multi-line message that re-mounts (e.g.,
    // navigating back to a streaming workspace) doesn't flash without
    // the mask.
    lastHeightRef.current = el.offsetHeight;
    applyHideTail(lastHeightRef.current);

    const ro = new ResizeObserver(() => {
      const newHeight = el.offsetHeight;
      const oldHeight = lastHeightRef.current;
      const delta = newHeight - oldHeight;
      lastHeightRef.current = newHeight;

      const wasAbove = oldHeight >= hideTailThresholdPx;
      const isAbove = newHeight >= hideTailThresholdPx;
      if (wasAbove !== isAbove) applyHideTail(newHeight);

      if (delta <= 0) return;
      // Only shimmer when the overlay is actually mounted (above
      // threshold). Below threshold the pseudo-element doesn't exist and
      // an animate() call on the parent would have no visible effect.
      if (!isAbove) return;

      // Cancel any in-flight shimmer so consecutive wraps don't stack;
      // the most recent line gets the highlight.
      activeAnimationRef.current?.cancel();
      try {
        // 700ms with Material's standard ease-in-out: gentle accel/decel
        // so the sweep doesn't feel mechanical. The bright band starts
        // off-screen left (translateX(-100%) = its own width = -40% of
        // container) and exits off-screen right (translateX(250%) =
        // +100% of container). See globals.css for the percentage math.
        activeAnimationRef.current = el.animate(
          [{ "--stream-shimmer-x": "-100%" }, { "--stream-shimmer-x": "250%" }],
          { duration: 700, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "none" }
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
      el.removeAttribute("data-stream-hide-tail");
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
