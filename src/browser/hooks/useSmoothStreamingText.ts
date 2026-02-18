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

  // Keep React state in sync when update()/reset() changes visible length
  // outside the RAF loop (flush, shrink clamp, stream key reset).
  useEffect(() => {
    if (visibleLengthRef.current === engine.visibleLength) {
      return;
    }

    visibleLengthRef.current = engine.visibleLength;
    setVisibleLength(engine.visibleLength);
  }, [engine, options.fullText, options.isStreaming, options.bypassSmoothing, options.streamKey]);

  useEffect(() => {
    if (!options.isStreaming || options.bypassSmoothing || engine.isCaughtUp) {
      return;
    }

    let rafId: number | null = null;
    let previousTimestampMs: number | null = null;

    const frame = (timestampMs: number) => {
      if (previousTimestampMs !== null) {
        const nextLength = engine.tick(timestampMs - previousTimestampMs);

        if (nextLength !== visibleLengthRef.current) {
          visibleLengthRef.current = nextLength;
          setVisibleLength(nextLength);
        }
      }

      previousTimestampMs = timestampMs;

      if (!engine.isCaughtUp && options.isStreaming && !options.bypassSmoothing) {
        rafId = requestAnimationFrame(frame);
      } else {
        rafId = null;
      }
    };

    rafId = requestAnimationFrame(frame);

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
    // Keep the RAF loop stable across fullText updates; engine.update() handles new deltas.
  }, [engine, options.isStreaming, options.bypassSmoothing, options.streamKey]);

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
