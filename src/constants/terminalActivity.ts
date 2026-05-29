/**
 * When a session has not observed any OSC title/prompt signals,
 * the newline-running heuristic auto-resets to idle after this duration.
 * Prevents permanent false-running state in non-OSC shells.
 */
export const NO_OSC_IDLE_FALLBACK_MS = 10_000;
