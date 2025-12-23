/**
 * Voice input via OpenAI transcription (gpt-4o-transcribe).
 *
 * State machine: idle → requesting → recording → transcribing → idle
 *
 * Hidden on touch devices where native keyboard dictation is available.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { matchesKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import type { APIClient } from "@/browser/contexts/API";
import { trackVoiceTranscription } from "@/common/telemetry";

export type VoiceInputState = "idle" | "requesting" | "recording" | "transcribing";

export interface UseVoiceInputOptions {
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
  /** Called after successful transcription if stop({ send: true }) was used */
  onSend?: () => void;
  openAIKeySet: boolean;
  /**
   * When true, hook manages global keybinds during recording:
   * - Space: stop and send (requires release after start)
   * - Escape: cancel
   * - Ctrl+D / Cmd+D: stop without sending
   */
  useRecordingKeybinds?: boolean;
  /** oRPC API client for voice transcription */
  api?: APIClient | null;
}

export interface UseVoiceInputResult {
  state: VoiceInputState;
  isSupported: boolean;
  isApiKeySet: boolean;
  /** False on touch devices (they have native keyboard dictation) */
  shouldShowUI: boolean;
  /** True when running over HTTP (not localhost) - microphone requires secure context */
  requiresSecureContext: boolean;
  /** The active MediaRecorder instance when recording, for visualization */
  mediaRecorder: MediaRecorder | null;
  start: () => void;
  stop: (options?: { send?: boolean }) => void;
  cancel: () => void;
  toggle: () => void;
}

// =============================================================================
// Platform Detection
// =============================================================================

/**
 * Detect touch devices where native keyboard dictation is typically available.
 * This includes phones, tablets (iPad), and touch-enabled laptops in tablet mode.
 * We hide our voice UI on these devices to avoid redundancy with system dictation.
 */
function hasTouchDictation(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;

  const maxTouchPoints =
    typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  const hasTouch = "ontouchstart" in window || maxTouchPoints > 0;

  // Touch-only check: most touch devices have native dictation.
  // We don't check screen size because iPads are large but still have dictation.
  return hasTouch;
}

const HAS_TOUCH_DICTATION = hasTouchDictation();
const HAS_MEDIA_RECORDER = typeof window !== "undefined" && typeof MediaRecorder !== "undefined";
const HAS_GET_USER_MEDIA =
  typeof window !== "undefined" &&
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getUserMedia === "function";

// =============================================================================
// Global Key State Tracking
// =============================================================================

/**
 * Track whether space is currently pressed at the module level.
 * This runs outside React's render cycle, so it captures key state
 * accurately even during async operations like microphone access.
 */
let isSpaceCurrentlyHeld = false;

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === " ") isSpaceCurrentlyHeld = true;
    },
    true
  );
  window.addEventListener(
    "keyup",
    (e) => {
      if (e.key === " ") isSpaceCurrentlyHeld = false;
    },
    true
  );
  // Also reset on blur (user switches window while holding space)
  window.addEventListener("blur", () => {
    isSpaceCurrentlyHeld = false;
  });
}

// =============================================================================
// Hook
// =============================================================================

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const [state, setState] = useState<VoiceInputState>("idle");

  // Refs for MediaRecorder lifecycle
  // We use both ref (for callbacks) and state (to trigger re-render for visualizer)
  const recorderRef = useRef<MediaRecorder | null>(null);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Flags set before stopping to control post-stop behavior
  const shouldSendRef = useRef(false);
  const wasCancelledRef = useRef(false);

  // Track recording start time for duration telemetry
  const recordingStartTimeRef = useRef<number>(0);

  // Keep callbacks fresh without recreating functions
  const callbacksRef = useRef(options);
  useEffect(() => {
    callbacksRef.current = options;
  }, [options]);

  // ---------------------------------------------------------------------------
  // Transcription
  // ---------------------------------------------------------------------------

  const transcribe = useCallback(async (audioBlob: Blob) => {
    setState("transcribing");

    // Capture and reset flags
    const shouldSend = shouldSendRef.current;
    shouldSendRef.current = false;

    // Calculate recording duration for telemetry
    const audioDurationSecs = (Date.now() - recordingStartTimeRef.current) / 1000;

    try {
      // Encode audio as base64 for IPC transport
      const buffer = await audioBlob.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buffer).reduce((str, byte) => str + String.fromCharCode(byte), "")
      );

      const api = callbacksRef.current.api;
      if (!api) {
        callbacksRef.current.onError?.("Voice API not available");
        trackVoiceTranscription(audioDurationSecs, false);
        return;
      }

      const result = await api.voice.transcribe({ audioBase64: base64 });

      if (!result.success) {
        callbacksRef.current.onError?.(result.error);
        trackVoiceTranscription(audioDurationSecs, false);
        return;
      }

      const text = result.data.trim();
      if (!text) {
        // Track empty transcription as success (API worked, just no speech)
        trackVoiceTranscription(audioDurationSecs, true);
        return;
      }

      // Track successful transcription
      trackVoiceTranscription(audioDurationSecs, true);

      callbacksRef.current.onTranscript(text);

      // If stop({ send: true }) was called, trigger send after React flushes
      if (shouldSend) {
        setTimeout(() => callbacksRef.current.onSend?.(), 0);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacksRef.current.onError?.(`Transcription failed: ${msg}`);
      trackVoiceTranscription(audioDurationSecs, false);
    } finally {
      setState("idle");
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Release microphone and clean up recorder
  // ---------------------------------------------------------------------------

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // ---------------------------------------------------------------------------
  // Start Recording
  // ---------------------------------------------------------------------------

  const start = useCallback(async () => {
    // Guard: only start from idle state with valid configuration
    const canStart =
      HAS_MEDIA_RECORDER &&
      HAS_GET_USER_MEDIA &&
      !HAS_TOUCH_DICTATION &&
      state === "idle" &&
      callbacksRef.current.openAIKeySet;

    if (!canStart) return;

    // Show loading state immediately while requesting mic access
    setState("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        // Check if this was a cancel (discard audio) or normal stop (transcribe)
        const cancelled = wasCancelledRef.current;
        wasCancelledRef.current = false;

        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        releaseStream();

        if (cancelled) {
          setState("idle");
        } else {
          void transcribe(blob);
        }
      };

      recorder.onerror = () => {
        callbacksRef.current.onError?.("Recording failed");
        releaseStream();
        setState("idle");
      };

      recorderRef.current = recorder;
      setMediaRecorder(recorder);
      recorder.start();
      recordingStartTimeRef.current = Date.now();
      setState("recording");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isPermissionDenied = msg.includes("Permission denied") || msg.includes("NotAllowed");

      callbacksRef.current.onError?.(
        isPermissionDenied
          ? "Microphone access denied. Please allow microphone access and try again."
          : `Failed to start recording: ${msg}`
      );
      setState("idle");
    }
  }, [state, transcribe, releaseStream]);

  // ---------------------------------------------------------------------------
  // Stop Recording (triggers transcription)
  // ---------------------------------------------------------------------------

  const stop = useCallback((options?: { send?: boolean }) => {
    if (options?.send) shouldSendRef.current = true;

    if (recorderRef.current?.state !== "inactive") {
      recorderRef.current?.stop();
      recorderRef.current = null;
      setMediaRecorder(null);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Cancel Recording (discard audio, no transcription)
  // ---------------------------------------------------------------------------

  const cancel = useCallback(() => {
    wasCancelledRef.current = true;
    stop();
  }, [stop]);

  // ---------------------------------------------------------------------------
  // Toggle (convenience for keybinds)
  // ---------------------------------------------------------------------------

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else if (state === "idle") void start();
  }, [state, start, stop]);

  // ---------------------------------------------------------------------------
  // Cleanup on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      recorderRef.current?.stop();
      releaseStream();
    };
  }, [releaseStream]);

  // ---------------------------------------------------------------------------
  // Recording keybinds (when useRecordingKeybinds is true)
  // ---------------------------------------------------------------------------

  // Track if space was held when recording started to prevent immediate send
  const spaceHeldAtStartRef = useRef(false);

  useEffect(() => {
    if (!options.useRecordingKeybinds || state !== "recording") {
      spaceHeldAtStartRef.current = false;
      return;
    }

    // Use global key state instead of assuming - handles async mic access delay
    spaceHeldAtStartRef.current = isSpaceCurrentlyHeld;

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") spaceHeldAtStartRef.current = false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === " " && !spaceHeldAtStartRef.current) {
        e.preventDefault();
        stop({ send: true });
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // Prevent global stream interrupt handler
        cancel();
      } else if (matchesKeybind(e, KEYBINDS.TOGGLE_VOICE_INPUT)) {
        e.preventDefault();
        stop();
      }
    };

    // Use capture phase to intercept before focused elements consume the event
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [options.useRecordingKeybinds, state, stop, cancel]);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    state,
    isSupported: HAS_MEDIA_RECORDER && HAS_GET_USER_MEDIA,
    isApiKeySet: callbacksRef.current.openAIKeySet,
    shouldShowUI: HAS_MEDIA_RECORDER && !HAS_TOUCH_DICTATION,
    requiresSecureContext: HAS_MEDIA_RECORDER && !HAS_GET_USER_MEDIA,
    mediaRecorder,
    start: () => void start(),
    stop,
    cancel,
    toggle,
  };
}
