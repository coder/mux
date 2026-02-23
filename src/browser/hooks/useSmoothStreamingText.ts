import { useEffect, useRef, useState } from "react";
import { SmoothTextEngine } from "@/browser/utils/streaming/SmoothTextEngine";

export interface UseSmoothStreamingTextOptions {
  fullText: string;
  isStreaming: boolean;
  bypassSmoothing: boolean;
  /** Changing this resets the engine (new stream). */
  streamKey: string;
}

export interface UseSmoothStreamingTextResult {
  visibleText: string;
  isCaughtUp: boolean;
}

const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function sliceAtGraphemeBoundary(text: string, maxCodeUnitLength: number): string {
  if (maxCodeUnitLength <= 0) {
    return "";
  }

  if (maxCodeUnitLength >= text.length) {
    return text;
  }

  if (graphemeSegmenter) {
    let safeEnd = 0;

    for (const segment of graphemeSegmenter.segment(text)) {
      const segmentEnd = segment.index + segment.segment.length;
      if (segmentEnd > maxCodeUnitLength) {
        break;
      }
      safeEnd = segmentEnd;
    }

    return text.slice(0, safeEnd);
  }

  let safeEnd = 0;
  for (const codePoint of Array.from(text)) {
    const codePointEnd = safeEnd + codePoint.length;
    if (codePointEnd > maxCodeUnitLength) {
      break;
    }
    safeEnd = codePointEnd;
  }

  return text.slice(0, safeEnd);
}

export function useSmoothStreamingText(
  options: UseSmoothStreamingTextOptions
): UseSmoothStreamingTextResult {
  const engineRef = useRef(new SmoothTextEngine());
  const previousStreamKeyRef = useRef(options.streamKey);

  if (previousStreamKeyRef.current !== options.streamKey) {
    engineRef.current.reset();
    previousStreamKeyRef.current = options.streamKey;
  }

  const engine = engineRef.current;
  engine.update(options.fullText, options.isStreaming, options.bypassSmoothing);

  const [visibleLength, setVisibleLength] = useState(() => engine.visibleLength);
  const visibleLengthRef = useRef(visibleLength);
  visibleLengthRef.current = visibleLength;

  const rafIdRef = useRef<number | null>(null);
  const previousTimestampRef = useRef<number | null>(null);

  // Frame callback stored as a ref so effects don't depend on it, preventing
  // teardown/restart of the RAF loop on every text delta. Reads from refs and
  // the stable engine instance, so the captured closure is always correct.
  const frameRef = useRef<FrameRequestCallback>(null!);
  frameRef.current = (timestampMs: number) => {
    if (previousTimestampRef.current !== null) {
      const nextLength = engine.tick(timestampMs - previousTimestampRef.current);
      if (nextLength !== visibleLengthRef.current) {
        visibleLengthRef.current = nextLength;
        setVisibleLength(nextLength);
      }
    }
    previousTimestampRef.current = timestampMs;
    if (!engine.isCaughtUp) {
      rafIdRef.current = requestAnimationFrame(frameRef.current);
    } else {
      rafIdRef.current = null;
      previousTimestampRef.current = null;
    }
  };

  // Sync engine state → React and re-arm RAF when new deltas arrive after
  // catch-up. No cleanup: this effect only observes + one-shot starts; the
  // lifecycle effect below owns resource teardown.
  useEffect(() => {
    if (visibleLengthRef.current !== engine.visibleLength) {
      visibleLengthRef.current = engine.visibleLength;
      setVisibleLength(engine.visibleLength);
    }

    if (
      rafIdRef.current === null &&
      options.isStreaming &&
      !options.bypassSmoothing &&
      !engine.isCaughtUp
    ) {
      rafIdRef.current = requestAnimationFrame(frameRef.current);
    }
  }, [engine, options.fullText, options.isStreaming, options.bypassSmoothing, options.streamKey]);

  // Lifecycle: stop RAF when streaming ends or stream key changes, and on unmount.
  useEffect(() => {
    if (!options.isStreaming || options.bypassSmoothing) {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      previousTimestampRef.current = null;
    }
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      previousTimestampRef.current = null;
    };
  }, [options.isStreaming, options.bypassSmoothing, options.streamKey]);

  if (!options.isStreaming || options.bypassSmoothing) {
    return {
      visibleText: options.fullText,
      isCaughtUp: true,
    };
  }

  const visiblePrefixLength = Math.min(
    visibleLength,
    engine.visibleLength,
    options.fullText.length
  );

  const visibleText = sliceAtGraphemeBoundary(options.fullText, visiblePrefixLength);

  return {
    visibleText,
    isCaughtUp: visibleText.length === options.fullText.length,
  };
}
