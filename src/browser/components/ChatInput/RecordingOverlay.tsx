/**
 * Recording overlay - shows live audio visualization during voice recording.
 * Replaces the chat textarea when voice input is active.
 */

import React, { useRef, useState, useLayoutEffect, useEffect, useCallback } from "react";
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

// Sliding window config
const WINDOW_DURATION_MS = 10000; // 10 seconds of history
const SAMPLE_INTERVAL_MS = 50; // Sample every 50ms
const NUM_SAMPLES = Math.floor(WINDOW_DURATION_MS / SAMPLE_INTERVAL_MS); // 200 samples

interface RecordingOverlayProps {
  state: VoiceInputState;
  mode: UIMode;
  mediaRecorder: MediaRecorder | null;
  onStop: () => void;
}

export const RecordingOverlay: React.FC<RecordingOverlayProps> = (props) => {
  const isRecording = props.state === "recording";
  const isTranscribing = props.state === "transcribing";

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
      <div className="flex h-8 w-full items-center justify-center">
        {isRecording && props.mediaRecorder ? (
          <SlidingWaveform mediaRecorder={props.mediaRecorder} color={modeColor} height={32} />
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
            <span className="opacity-70">{formatKeybind(KEYBINDS.TOGGLE_VOICE_INPUT)}</span> review
            · <span className="opacity-70">esc</span> cancel
          </>
        ) : (
          "Transcribing..."
        )}
      </span>
    </button>
  );
};

/**
 * Sliding window waveform - shows amplitude over the last ~10 seconds.
 * New samples appear on the right and slide left over time.
 */
interface SlidingWaveformProps {
  mediaRecorder: MediaRecorder;
  color: string;
  height: number;
}

const SlidingWaveform: React.FC<SlidingWaveformProps> = (props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(600);

  // Audio analysis refs (persist across renders)
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const samplesRef = useRef<number[]>(new Array<number>(NUM_SAMPLES).fill(0));
  const animationFrameRef = useRef<number>(0);
  const lastSampleTimeRef = useRef<number>(0);

  // Measure container width
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

  // Set up audio analysis
  useEffect(() => {
    const stream = props.mediaRecorder.stream;
    if (!stream) return;

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    audioContextRef.current = audioContext;
    analyserRef.current = analyser;

    // Reset samples when starting
    samplesRef.current = new Array<number>(NUM_SAMPLES).fill(0);
    lastSampleTimeRef.current = performance.now();

    return () => {
      void audioContext.close();
      audioContextRef.current = null;
      analyserRef.current = null;
    };
  }, [props.mediaRecorder]);

  // Animation loop - sample audio and render
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const now = performance.now();
    const timeSinceLastSample = now - lastSampleTimeRef.current;

    // Take a new sample if enough time has passed
    if (timeSinceLastSample >= SAMPLE_INTERVAL_MS) {
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(dataArray);

      // Calculate RMS amplitude (0-1 range)
      let sum = 0;
      for (const sample of dataArray) {
        const normalized = (sample - 128) / 128; // -1 to 1
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // Shift samples left and add new one
      samplesRef.current.shift();
      samplesRef.current.push(rms);
      lastSampleTimeRef.current = now;
    }

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw waveform bars - calculate to fill full width
    const samples = samplesRef.current;
    const numBars = samples.length;

    // Calculate bar and gap sizes to fill exactly the canvas width
    // We want: numBars * barWidth + (numBars - 1) * gap = canvasWidth
    // With gap = barWidth * 0.4, we get:
    // numBars * barWidth + (numBars - 1) * 0.4 * barWidth = canvasWidth
    // barWidth * (numBars + 0.4 * numBars - 0.4) = canvasWidth
    // barWidth = canvasWidth / (1.4 * numBars - 0.4)
    const totalWidth = canvas.width;
    const barWidth = totalWidth / (1.4 * numBars - 0.4);
    const gap = barWidth * 0.4;
    const centerY = canvas.height / 2;

    ctx.fillStyle = props.color;

    for (let i = 0; i < numBars; i++) {
      const amplitude = samples[i];
      // Scale amplitude for visibility (boost quiet sounds)
      const scaledAmplitude = Math.min(1, amplitude * 3);
      const barHeight = Math.max(2, scaledAmplitude * canvas.height * 0.9);

      const x = i * (barWidth + gap);
      const y = centerY - barHeight / 2;

      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 1);
      ctx.fill();
    }

    animationFrameRef.current = requestAnimationFrame(draw);
  }, [props.color]);

  // Start/stop animation loop
  useEffect(() => {
    animationFrameRef.current = requestAnimationFrame(draw);
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [draw]);

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

/**
 * Simple pulsing animation for transcribing state
 */
const TranscribingAnimation: React.FC = () => (
  <div className="flex items-center gap-2 text-amber-500">
    <Loader2 className="h-5 w-5 animate-spin" />
  </div>
);
