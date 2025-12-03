/**
 * Recording overlay - shows live audio visualization during voice recording.
 * Replaces the chat textarea when voice input is active.
 */

import React, { useRef, useState, useLayoutEffect } from "react";
import { LiveAudioVisualizer } from "react-audio-visualize";
import { Loader2 } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import type { UIMode } from "@/common/types/mode";
import type { VoiceInputState } from "@/browser/hooks/useVoiceInput";

// Mode color values for the visualizer (CSS var values from globals.css)
const MODE_COLORS = {
  plan: "hsl(210, 70%, 55%)", // Slightly lighter than --color-plan-mode for visibility
  exec: "hsl(268, 94%, 65%)", // Slightly lighter than --color-exec-mode for visibility
} as const;

// FFT size determines number of frequency bins (fftSize / 2)
// Higher = more bars but less responsive, lower = fewer bars but more responsive
const FFT_SIZE = 128; // 64 bars
const NUM_BARS = FFT_SIZE / 2;

interface RecordingOverlayProps {
  state: VoiceInputState;
  mode: UIMode;
  mediaRecorder: MediaRecorder | null;
  onStop: () => void;
}

export const RecordingOverlay: React.FC<RecordingOverlayProps> = (props) => {
  const isRecording = props.state === "recording";
  const isTranscribing = props.state === "transcribing";
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(600);

  // Measure container width for the canvas using ResizeObserver
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(container);
    // Initial measurement
    setContainerWidth(container.offsetWidth);

    return () => observer.disconnect();
  }, []);

  const modeColor = MODE_COLORS[props.mode];

  // Calculate bar dimensions to fill the container width
  // Total width = numBars * barWidth + (numBars - 1) * gap
  // We want gap = barWidth / 2 for nice spacing
  // So: width = numBars * barWidth + (numBars - 1) * barWidth/2
  //           = barWidth * (numBars + (numBars - 1) / 2)
  //           = barWidth * (1.5 * numBars - 0.5)
  const barWidth = Math.max(2, Math.floor(containerWidth / (1.5 * NUM_BARS - 0.5)));
  const gap = Math.max(1, Math.floor(barWidth / 2));

  // Border and background classes based on state
  const containerClasses = cn(
    "mb-1 flex w-full flex-col items-center justify-center gap-1 rounded-md border px-3 py-2 transition-all focus:outline-none",
    isRecording
      ? props.mode === "plan"
        ? "cursor-pointer border-plan-mode bg-plan-mode/10"
        : "cursor-pointer border-exec-mode bg-exec-mode/10"
      : "cursor-wait border-amber-500 bg-amber-500/10"
  );

  return (
    <button
      type="button"
      onClick={isRecording ? props.onStop : undefined}
      disabled={isTranscribing}
      className={containerClasses}
      aria-label={isRecording ? "Stop recording" : "Transcribing..."}
    >
      {/* Visualizer / Animation Area */}
      <div ref={containerRef} className="flex h-8 w-full items-center justify-center">
        {isRecording && props.mediaRecorder ? (
          <LiveAudioVisualizer
            mediaRecorder={props.mediaRecorder}
            width={containerWidth}
            height={32}
            barWidth={barWidth}
            gap={gap}
            barColor={modeColor}
            smoothingTimeConstant={0.8}
            fftSize={FFT_SIZE}
            minDecibels={-70}
            maxDecibels={-30}
          />
        ) : (
          <TranscribingAnimation />
        )}
      </div>

      {/* Status Text */}
      <span
        className={cn(
          "text-xs font-medium",
          isRecording
            ? props.mode === "plan"
              ? "text-plan-mode-light"
              : "text-exec-mode-light"
            : "text-amber-500"
        )}
      >
        {isRecording ? (
          <>
            <span className="opacity-70">space</span> send ·{" "}
            <span className="opacity-70">{formatKeybind(KEYBINDS.TOGGLE_VOICE_INPUT)}</span> review ·{" "}
            <span className="opacity-70">esc</span> cancel
          </>
        ) : (
          "Transcribing..."
        )}
      </span>
    </button>
  );
};

/**
 * Simple pulsing animation for transcribing state
 */
const TranscribingAnimation: React.FC = () => (
  <div className="flex items-center gap-2 text-amber-500">
    <Loader2 className="h-5 w-5 animate-spin" />
  </div>
);
