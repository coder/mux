/**
 * Hook for voice input using OpenAI Whisper API via MediaRecorder.
 *
 * Records audio, sends to backend for Whisper transcription, returns text.
 * Hidden on mobile (native keyboards have built-in dictation).
 */

import { useState, useCallback, useRef, useEffect } from "react";

export type VoiceInputState = "idle" | "recording" | "transcribing";

export interface UseVoiceInputOptions {
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
  onSend?: () => void;
  openAIKeySet: boolean;
}

export interface UseVoiceInputResult {
  state: VoiceInputState;
  isSupported: boolean;
  isApiKeySet: boolean;
  /** Show UI on supported desktop platforms (mobile has native dictation) */
  shouldShowUI: boolean;
  start: () => void;
  stop: (options?: { send?: boolean }) => void;
  /** Cancel recording without transcribing (discard audio) */
  cancel: () => void;
  toggle: () => void;
}

// Platform checks (evaluated once)
const isMobile =
  typeof window !== "undefined" &&
  ("ontouchstart" in window || navigator.maxTouchPoints > 0) &&
  window.innerWidth < 768;

const isSupported = typeof window !== "undefined" && typeof MediaRecorder !== "undefined";

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const [state, setState] = useState<VoiceInputState>("idle");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const sendAfterTranscribeRef = useRef(false);
  const cancelledRef = useRef(false);

  // Store callbacks in refs to avoid stale closures
  const callbacksRef = useRef(options);
  useEffect(() => {
    callbacksRef.current = options;
  }, [options]);

  const transcribe = useCallback(async (audioBlob: Blob) => {
    setState("transcribing");
    const shouldSend = sendAfterTranscribeRef.current;
    sendAfterTranscribeRef.current = false;

    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
      );

      const result = await window.api.voice.transcribe(base64);

      if (result.success && result.data.trim()) {
        callbacksRef.current.onTranscript(result.data);
        if (shouldSend) {
          setTimeout(() => callbacksRef.current.onSend?.(), 0);
        }
      } else if (!result.success) {
        callbacksRef.current.onError?.(result.error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      callbacksRef.current.onError?.(`Transcription failed: ${message}`);
    } finally {
      setState("idle");
    }
  }, []);

  const start = useCallback(async () => {
    if (!isSupported || isMobile || state !== "idle" || !callbacksRef.current.openAIKeySet) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const wasCancelled = cancelledRef.current;
        cancelledRef.current = false;
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (wasCancelled) {
          setState("idle");
        } else {
          void transcribe(blob);
        }
      };

      recorder.onerror = () => {
        callbacksRef.current.onError?.("Recording failed");
        setState("idle");
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setState("recording");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isPermissionError =
        message.includes("Permission denied") || message.includes("NotAllowedError");
      callbacksRef.current.onError?.(
        isPermissionError
          ? "Microphone access denied. Please allow microphone access and try again."
          : `Failed to start recording: ${message}`
      );
    }
  }, [state, transcribe]);

  const stop = useCallback((options?: { send?: boolean }) => {
    if (options?.send) sendAfterTranscribeRef.current = true;
    if (mediaRecorderRef.current?.state !== "inactive") {
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (mediaRecorderRef.current?.state !== "inactive") {
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === "recording") {
      stop();
    } else if (state === "idle") {
      void start();
    }
  }, [state, start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return {
    state,
    isSupported,
    isApiKeySet: callbacksRef.current.openAIKeySet,
    shouldShowUI: isSupported && !isMobile,
    start: () => void start(),
    stop,
    cancel,
    toggle,
  };
}
