// Smooth streaming presentation constants.
// These control the jitter buffer that makes streamed text appear at a steady cadence
// instead of bursty token clumps. Internal-only; no user-facing setting.
export const STREAM_SMOOTHING = {
  /** Baseline reveal speed in characters per second. */
  BASE_CHARS_PER_SEC: 52,
  /** Floor — never slower than this even when buffer is nearly empty. */
  MIN_CHARS_PER_SEC: 24,
  /** Ceiling — hard cap to prevent overwhelming the markdown renderer. */
  MAX_CHARS_PER_SEC: 180,
  /** When backlog exceeds this many chars, the adaptive rate ramps toward MAX. */
  CATCHUP_BACKLOG_CHARS: 220,
  /** Max characters revealed in a single animation frame. */
  MAX_FRAME_CHARS: 32,
  /** Min characters revealed per frame (avoids sub-character stalls). */
  MIN_FRAME_CHARS: 1,
} as const;
