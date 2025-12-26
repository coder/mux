/**
 * Recording overlay - shows live audio visualization during voice recording.
 * Replaces the chat textarea when voice input is active.
 */

import React, { useRef, useState, useLayoutEffect, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import type { UIMode } from "@/common/types/mode";
import type { VoiceInputState } from "@/browser/hooks/useVoiceInput";

/** Canvas fill colors for the waveform (slightly lighter than CSS vars for visibility) */
const MODE_COLORS: Record<UIMode, string> = {
  plan: "hsl(210, 70%, 55%)",
  exec: "hsl(268, 94%, 65%)",
};

/** Tailwind classes for recording state, keyed by mode */
const RECORDING_CLASSES: Record<UIMode, string> = {
  plan: "cursor-pointer border-plan-mode bg-plan-mode/10",
  exec: "cursor-pointer border-exec-mode bg-exec-mode/10",
};

const TEXT_CLASSES: Record<UIMode, string> = {
  plan: "text-plan-mode-light",
  exec: "text-exec-mode-light",
};

// Waveform shows last 10 seconds of audio, sampled every 50ms (200 samples)
const WINDOW_DURATION_MS = 10_000;
const SAMPLE_INTERVAL_MS = 50;
const NUM_SAMPLES = WINDOW_DURATION_MS / SAMPLE_INTERVAL_MS;

// Render at 60fps using setInterval instead of RAF to avoid
// waking JavaScript at 120Hz+ on high refresh rate displays
const RENDER_INTERVAL_MS = 1000 / 60;

interface RecordingOverlayProps {
  state: VoiceInputState;
  mode: UIMode;
  mediaRecorder: MediaRecorder | null;
  onStop: () => void;
}

export const RecordingOverlay: React.FC<RecordingOverlayProps> = (props) => {
  const isRecording = props.state === "recording";
  const isRequesting = props.state === "requesting";

  const containerClasses = cn(
    "mb-1 flex w-full flex-col items-center justify-center gap-1 rounded-md border px-3 py-2 transition-all focus:outline-none",
    isRecording ? RECORDING_CLASSES[props.mode] : "cursor-wait border-amber-500 bg-amber-500/10"
  );

  // Status text for non-recording states
  const statusText = isRequesting ? "Requesting microphone..." : "Transcribing...";

  return (
    <button
      type="button"
      onClick={isRecording ? props.onStop : undefined}
      disabled={!isRecording}
      className={containerClasses}
      aria-label={isRecording ? "Stop recording" : statusText}
    >
      <div className="flex h-8 w-full items-center justify-center">
        {isRecording && props.mediaRecorder ? (
          <SlidingWaveform
            mediaRecorder={props.mediaRecorder}
            color={MODE_COLORS[props.mode]}
            height={32}
          />
        ) : (
          <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
        )}
      </div>

      <span
        className={cn(
          "text-xs font-medium",
          isRecording ? TEXT_CLASSES[props.mode] : "text-amber-500"
        )}
      >
        {isRecording ? <RecordingHints /> : statusText}
      </span>
    </button>
  );
};

/** Keyboard hint display for recording state */
const RecordingHints: React.FC = () => (
  <>
    <span className="opacity-70">space</span> send ·{" "}
    <span className="opacity-70">{formatKeybind(KEYBINDS.TOGGLE_VOICE_INPUT)}</span> review ·{" "}
    <span className="opacity-70">esc</span> cancel
  </>
);

// =============================================================================
// SlidingWaveform - Canvas-based amplitude visualization
// =============================================================================

interface SlidingWaveformProps {
  mediaRecorder: MediaRecorder;
  color: string;
  height: number;
}

/**
 * Renders a sliding window of audio amplitude over time.
 * New samples appear on the right and scroll left as time passes.
 * Falls back to a simple pulsing indicator if Web Audio API fails.
 */
const SlidingWaveform: React.FC<SlidingWaveformProps> = (props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(600);
  const [audioError, setAudioError] = useState(false);

  // Audio analysis state (refs to avoid re-renders)
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const samplesRef = useRef<number[]>(new Array<number>(NUM_SAMPLES).fill(0));
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSampleTimeRef = useRef<number>(0);
  // Pre-allocate typed array to avoid GC pressure during animation
  const dataArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  // Track container width for responsive canvas
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(container);
    setContainerWidth(container.offsetWidth);

    return () => observer.disconnect();
  }, []);

  // Initialize Web Audio API analyser
  useEffect(() => {
    const stream = props.mediaRecorder.stream;
    if (!stream) return;

    try {
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
      samplesRef.current = new Array<number>(NUM_SAMPLES).fill(0);
      lastSampleTimeRef.current = performance.now();

      return () => {
        void audioContext.close();
        audioContextRef.current = null;
        analyserRef.current = null;
        dataArrayRef.current = null;
      };
    } catch (err) {
      console.error("Failed to initialize audio visualization:", err);
      setAudioError(true);
    }
  }, [props.mediaRecorder]);

  // Render loop using setInterval at 60fps
  // Unlike RAF which fires at display refresh rate (120Hz+), setInterval
  // fires at a fixed rate, reducing CPU wake-ups on high refresh displays
  useEffect(() => {
    if (audioError) return;

    const draw = () => {
      const canvas = canvasRef.current;
      const analyser = analyserRef.current;
      const dataArray = dataArrayRef.current;
      if (!canvas || !analyser || !dataArray) return;

      // Sample audio at fixed intervals (reuse pre-allocated array)
      const now = performance.now();
      if (now - lastSampleTimeRef.current >= SAMPLE_INTERVAL_MS) {
        analyser.getByteTimeDomainData(dataArray);

        // Calculate RMS (root mean square) amplitude
        let sum = 0;
        for (const sample of dataArray) {
          const normalized = (sample - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / dataArray.length);

        samplesRef.current.shift();
        samplesRef.current.push(rms);
        lastSampleTimeRef.current = now;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Render bars
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const samples = samplesRef.current;
      const numBars = samples.length;
      // Bar sizing: bars fill full width with 40% gap ratio
      const barWidth = canvas.width / (1.4 * numBars - 0.4);
      const gap = barWidth * 0.4;
      const centerY = canvas.height / 2;

      ctx.fillStyle = props.color;

      for (let i = 0; i < numBars; i++) {
        const scaledAmplitude = Math.min(1, samples[i] * 3); // Boost for visibility
        const barHeight = Math.max(2, scaledAmplitude * canvas.height * 0.9);
        const x = i * (barWidth + gap);
        const y = centerY - barHeight / 2;

        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(x, y, barWidth, barHeight, 1);
        } else {
          ctx.rect(x, y, barWidth, barHeight);
        }
        ctx.fill();
      }
    };

    // Initial draw, then interval
    draw();
    intervalRef.current = setInterval(draw, RENDER_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [props.color, audioError]);

  // Fallback: simple pulsing indicator if Web Audio API unavailable
  if (audioError) {
    return (
      <div className="flex h-full w-full items-center justify-center gap-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="animate-pulse rounded-full"
            style={{
              width: 4,
              height: 12 + (i % 3) * 4,
              backgroundColor: props.color,
              animationDelay: `${i * 100}ms`,
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full w-full items-center justify-center">
      <canvas
        ref={canvasRef}
        width={containerWidth}
        height={props.height}
        style={{ width: containerWidth, height: props.height }}
      />
    </div>
  );
};
