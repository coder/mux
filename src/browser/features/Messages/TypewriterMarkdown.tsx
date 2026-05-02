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
  // The CSS mask in globals.css hides the bottom ~1 visual line (the line
  // currently being typed) — but only when there's a completed line above it
  // to look at. We toggle `data-stream-hide-tail` to gate the mask:
  //  - Below ~1.5 line-heights of rendered content (single-line streams),
  //    the attribute is absent and the message renders fully visible. This
  //    avoids blanking out short replies before they wrap.
  //  - Once content reaches ~1.5+ lines, the attribute is set and the mask
  //    hides the in-progress line. Subsequent wraps fade in the previously
  //    in-progress line as it becomes a completed line.
  //
  // When the rendered height GROWS while above-threshold — because a visual
  // line wrapped, a new paragraph was added, etc. — we briefly push the
  // transparent strip up by `delta` so the just-revealed content is initially
  // also covered, then animate `--reveal-y` back to 0 over 250ms. The mask
  // gradient sweeps past the new content, fading it in.
  //
  // The first-time threshold crossing (1 line → 2 lines) does NOT pulse,
  // because the about-to-be-completed line was already visible without a
  // mask; a pulse would briefly hide it and re-fade it in (a flicker).
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

    // Threshold below which the mask is disabled entirely. Computed from the
    // element's actual computed line-height so it scales with font-size and
    // line-height overrides. 1.5 × line-height puts the threshold between
    // 1-line and 2-line content, with a small margin for sub-pixel rounding.
    const lineHeightPx = parseFloat(getComputedStyle(el).lineHeight) || 22.4;
    const hideTailThresholdPx = lineHeightPx * 1.5;

    const applyHideTail = (h: number) => {
      el.toggleAttribute("data-stream-hide-tail", h >= hideTailThresholdPx);
    };

    // Seed the baseline AND the initial attribute synchronously, before the
    // browser paints, so a multi-line message that re-mounts (e.g., navigating
    // back to a streaming workspace) doesn't flash without the mask.
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
      // Pulse only when the mask was already on AND the element grew further.
      // The first-time threshold crossing doesn't pulse: the just-completed
      // first line was already visible without a mask, and a pulse would
      // briefly hide and re-reveal it (flicker).
      if (!wasAbove || !isAbove) return;

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
