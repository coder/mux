// Smooth streaming presentation constants.
// These control the jitter buffer that makes streamed text appear at a steady cadence
// instead of bursty token clumps. Internal-only; no user-facing setting.
export const STREAM_SMOOTHING = {
  /** Baseline reveal speed in characters per second. */
  BASE_CHARS_PER_SEC: 72,
  /** Floor — never slower than this even when buffer is nearly empty. */
  MIN_CHARS_PER_SEC: 24,
  /** Ceiling — hard cap to prevent overwhelming the markdown renderer. */
  MAX_CHARS_PER_SEC: 420,
  /** Backlog level where adaptive reveal runs at MAX_CHARS_PER_SEC. */
  CATCHUP_BACKLOG_CHARS: 180,
  /** Keep the rendered transcript close to live output even during bursty streams. */
  MAX_VISUAL_LAG_CHARS: 120,
  /** Max characters revealed in a single animation frame. */
  MAX_FRAME_CHARS: 48,
  /** Min characters revealed per tick once budget permits (avoids sub-character stalls). */
  MIN_FRAME_CHARS: 1,
} as const;
