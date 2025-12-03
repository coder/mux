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
  const [containerWidth, setContainerWidth] = useState(400);

  // Measure container width for the canvas
  useLayoutEffect(() => {
    const measure = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const modeColor = MODE_COLORS[props.mode];

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
            barWidth={2}
            gap={1}
            barColor={modeColor}
            smoothingTimeConstant={0.5}
            fftSize={256}
            minDecibels={-80}
            maxDecibels={-20}
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
