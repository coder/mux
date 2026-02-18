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
  }, [engine, options.fullText, options.isStreaming, options.bypassSmoothing, options.streamKey]);

  if (!options.isStreaming || options.bypassSmoothing) {
    return {
      visibleText: options.fullText,
      isCaughtUp: true,
    };
  }

  const visiblePrefixLength = Math.min(visibleLength, engine.visibleLength, options.fullText.length);

  return {
    visibleText: options.fullText.slice(0, visiblePrefixLength),
    isCaughtUp: visiblePrefixLength === options.fullText.length,
  };
}
