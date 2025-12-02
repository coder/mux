/**
 * Hook for voice input using OpenAI Whisper API via MediaRecorder.
 *
 * Features:
 * - Records audio using MediaRecorder (webm/opus format)
 * - Sends to backend which calls OpenAI Whisper for transcription
 * - Shows recording state while capturing
 * - Shows transcribing state while processing
 * - Hidden on mobile (native keyboards have built-in dictation)
 * - Disabled when OpenAI API key not configured
 */

import { useState, useCallback, useRef, useEffect } from "react";

// Check if we're on a mobile device (touch-based)
function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  // Check for touch capability and small screen as heuristics
  return ("ontouchstart" in window || navigator.maxTouchPoints > 0) && window.innerWidth < 768;
}

// Check if MediaRecorder is available
function isMediaRecorderSupported(): boolean {
  return typeof window !== "undefined" && typeof MediaRecorder !== "undefined";
}

export interface UseVoiceInputOptions {
  /** Called when transcript text is received */
  onTranscript: (text: string, isFinal: boolean) => void;
  /** Called when an error occurs */
  onError?: (error: string) => void;
  /** Whether OpenAI API key is configured */
  openAIKeySet: boolean;
}

export interface UseVoiceInputResult {
  /** Whether voice input is currently recording */
  isListening: boolean;
  /** Whether transcription is in progress */
  isTranscribing: boolean;
  /** Whether the browser supports MediaRecorder */
  isSupported: boolean;
  /** Whether we should show voice UI (supported, not mobile, API key set) */
  shouldShowUI: boolean;
  /** Start recording for voice input */
  startListening: () => void;
  /** Stop recording and transcribe */
  stopListening: () => void;
  /** Toggle recording state */
  toggleListening: () => void;
}

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const { onTranscript, onError, openAIKeySet } = options;

  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const isSupported = isMediaRecorderSupported();
  const isMobile = isMobileDevice();

  // Store callbacks in refs to avoid recreating on every render
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  }, [onTranscript, onError]);

  const transcribeAudio = useCallback(async (audioBlob: Blob) => {
    setIsTranscribing(true);
    try {
      // Convert blob to base64
      const arrayBuffer = await audioBlob.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
      );

      // Call backend to transcribe
      const result = await window.api.voice.transcribe(base64);

      if (result.success) {
        if (result.data.trim()) {
          onTranscriptRef.current(result.data, true);
        }
      } else {
        onErrorRef.current?.(result.error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onErrorRef.current?.(`Transcription failed: ${message}`);
    } finally {
      setIsTranscribing(false);
    }
  }, []);

  const startListening = useCallback(async () => {
    if (!isSupported || isListening || isTranscribing || !openAIKeySet) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Use webm/opus which is well supported and works with Whisper
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];

        // Stop all tracks to release microphone
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        // Transcribe the audio
        void transcribeAudio(audioBlob);
      };

      mediaRecorder.onerror = () => {
        onErrorRef.current?.("Recording failed");
        setIsListening(false);
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsListening(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Permission denied") || message.includes("NotAllowedError")) {
        onErrorRef.current?.(
          "Microphone access denied. Please allow microphone access and try again."
        );
      } else {
        onErrorRef.current?.(`Failed to start recording: ${message}`);
      }
    }
  }, [isSupported, isListening, isTranscribing, openAIKeySet, transcribeAudio]);

  const stopListening = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    setIsListening(false);
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      void startListening();
    }
  }, [isListening, startListening, stopListening]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  return {
    isListening,
    isTranscribing,
    isSupported,
    shouldShowUI: isSupported && !isMobile && openAIKeySet,
    startListening: () => void startListening(),
    stopListening,
    toggleListening,
  };
}
