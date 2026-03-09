// Event keys for the sound system — expand this union as new events are added.
export const EVENT_SOUND_KEYS = ["agent_review_ready"] as const;
export type EventSoundKey = (typeof EVENT_SOUND_KEYS)[number];

// Human-readable labels for settings UI.
export const EVENT_SOUND_LABELS: Record<EventSoundKey, string> = {
  agent_review_ready: "Agent finished (waiting for review)",
};
