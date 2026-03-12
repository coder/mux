// Event keys for the sound system — expand this union as new events are added.
export const EVENT_SOUND_KEYS = ["agent_review_ready"] as const;
export type EventSoundKey = (typeof EVENT_SOUND_KEYS)[number];

// Human-readable labels for settings UI.
export const EVENT_SOUND_LABELS: Record<EventSoundKey, string> = {
  agent_review_ready: "Agent finished (waiting for review)",
};

export const ALLOWED_AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/ogg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/flac",
  "audio/x-flac",
  "audio/webm",
] as const;

export const ALLOWED_AUDIO_EXTENSIONS = [
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "aac",
  "flac",
  "webm",
] as const;

export const MAX_AUDIO_FILE_SIZE_BYTES = 5 * 1024 * 1024;
