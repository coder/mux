/**
 * Voice input via OpenAI transcription (gpt-4o-transcribe).
 *
 * State machine: idle → recording → transcribing → idle
 *
 * Hidden on touch devices where native keyboard dictation is available.
 */

import { useState, useCallback, useRef, useEffect } from "react";

export type VoiceInputState = "idle" | "recording" | "transcribing";

export interface UseVoiceInputOptions {
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
  /** Called after successful transcription if stop({ send: true }) was used */
  onSend?: () => void;
  openAIKeySet: boolean;
}

export interface UseVoiceInputResult {
  state: VoiceInputState;
  isSupported: boolean;
  isApiKeySet: boolean;
  /** False on touch devices (they have native keyboard dictation) */
  shouldShowUI: boolean;
  /** True when running over HTTP (not localhost) - microphone requires secure context */
  requiresSecureContext: boolean;
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
  if (typeof window === "undefined") return false;
  const hasTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  // Touch-only check: most touch devices have native dictation.
  // We don't check screen size because iPads are large but still have dictation.
  return hasTouch;
}

const HAS_TOUCH_DICTATION = hasTouchDictation();
const HAS_MEDIA_RECORDER = typeof window !== "undefined" && typeof MediaRecorder !== "undefined";
const HAS_GET_USER_MEDIA =
  typeof window !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";

// =============================================================================
// Hook
// =============================================================================

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const [state, setState] = useState<VoiceInputState>("idle");

  // Refs for MediaRecorder lifecycle
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Flags set before stopping to control post-stop behavior
  const shouldSendRef = useRef(false);
  const wasCancelledRef = useRef(false);

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

    try {
      // Encode audio as base64 for IPC transport
      const buffer = await audioBlob.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buffer).reduce((str, byte) => str + String.fromCharCode(byte), "")
      );

      const result = await window.api.voice.transcribe(base64);

      if (!result.success) {
        callbacksRef.current.onError?.(result.error);
        return;
      }

      const text = result.data.trim();
      if (!text) return; // Empty transcription, nothing to do

      callbacksRef.current.onTranscript(text);

      // If stop({ send: true }) was called, trigger send after React flushes
      if (shouldSend) {
        setTimeout(() => callbacksRef.current.onSend?.(), 0);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacksRef.current.onError?.(`Transcription failed: ${msg}`);
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
      recorder.start();
      setState("recording");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isPermissionDenied = msg.includes("Permission denied") || msg.includes("NotAllowed");

      callbacksRef.current.onError?.(
        isPermissionDenied
          ? "Microphone access denied. Please allow microphone access and try again."
          : `Failed to start recording: ${msg}`
      );
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
  // Return
  // ---------------------------------------------------------------------------

  return {
    state,
    isSupported: HAS_MEDIA_RECORDER && HAS_GET_USER_MEDIA,
    isApiKeySet: callbacksRef.current.openAIKeySet,
    shouldShowUI: HAS_MEDIA_RECORDER && !HAS_TOUCH_DICTATION,
    requiresSecureContext: HAS_MEDIA_RECORDER && !HAS_GET_USER_MEDIA,
    start: () => void start(),
    stop,
    cancel,
    toggle,
  };
}
