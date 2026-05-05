import { STREAM_SMOOTHING } from "@/constants/streaming";
import { clamp } from "@/common/utils/clamp";

/**
 * Module-level regex (compiled once, reused across ticks) for whitespace-
 * boundary detection in word-paced reveal. `\s` covers all Unicode whitespace
 * (per ECMA-262): ASCII space/tab/LF/CR/FF/VT, NBSP, line/paragraph
 * separators, thin/em/ideographic spaces, etc. — so non-English text paces
 * at proper word boundaries.
 */
const WHITESPACE_REGEX = /\s/;

/**
 * Compute target reveal rate (chars/sec) given current backlog and a hint of how
 * fast the source is producing characters.
 *
 * Two ramps combine, then we take the max:
 * - **Steady-state floor**: tracks the live model rate (BASE if unknown). This
 *   keeps the visible cursor moving at roughly the model's emit rate so the
 *   stream doesn't constantly fall further behind.
 * - **Catch-up ramp**: when backlog exceeds SOFT_CATCHUP_LAG_CHARS, scale rate
 *   so the lag drains within SOFT_CATCHUP_DRAIN_MS — this replaces the legacy
 *   hard-snap with a smooth ramp that's invisible to the eye.
 */
function getAdaptiveRate(backlog: number, liveCharsPerSec: number): number {
  const steadyState = Math.max(STREAM_SMOOTHING.BASE_CHARS_PER_SEC, liveCharsPerSec);

  // Soft catch-up: above the threshold, scale the steady-state rate so the
  // lag drains over SOFT_CATCHUP_DRAIN_MS at the *current* draw rate.
  const lagOverThreshold = Math.max(0, backlog - STREAM_SMOOTHING.SOFT_CATCHUP_LAG_CHARS);
  const catchupRate =
    lagOverThreshold > 0
      ? steadyState + (lagOverThreshold * 1000) / STREAM_SMOOTHING.SOFT_CATCHUP_DRAIN_MS
      : 0;

  // Legacy backlog-pressure ramp kept as an upper bound for very large
  // backlogs — guarantees we approach MAX_CHARS_PER_SEC long before hitting
  // the hard-snap safety net.
  const backlogPressure = clamp(backlog / STREAM_SMOOTHING.CATCHUP_BACKLOG_CHARS, 0, 1);
  const pressureRate =
    STREAM_SMOOTHING.BASE_CHARS_PER_SEC +
    backlogPressure * (STREAM_SMOOTHING.MAX_CHARS_PER_SEC - STREAM_SMOOTHING.BASE_CHARS_PER_SEC);

  const targetRate = Math.max(steadyState, catchupRate, pressureRate);

  return clamp(targetRate, STREAM_SMOOTHING.MIN_CHARS_PER_SEC, STREAM_SMOOTHING.MAX_CHARS_PER_SEC);
}

/**
 * Deterministic text reveal engine for smoothing streamed output.
 *
 * The ingestion clock (incoming full text) is external; this class manages only
 * the presentation clock (visible prefix length) using a character budget model.
 *
 * **Reveal granularity is word-sized AND temporally paced.** Each tick reveals
 * AT MOST ONE atom (a word + trailing whitespace, capped at
 * {@link STREAM_SMOOTHING.WORD_PACE_MAX_CHARS}). Multi-atom bursts are
 * impossible by construction — even when budget is large (catch-up after a
 * long RAF gap, high adaptive rate during burst), reveals are spread across
 * frames so the user sees one word per animation frame at the maximum tempo.
 * Combined with the dt clamp ({@link STREAM_SMOOTHING.MAX_TICK_MS}), this
 * caps cadence at ~60 words/sec on a 60Hz display.
 *
 * Why word-sized AND time-paced:
 *  - Word-sized: humans parse text in word units. Character-paced reveal
 *    triggers an extra decoding step the eye registers as choppy.
 *  - Time-paced: even at word granularity, dumping 3 atoms in one frame
 *    reads as bursty. One atom per frame is the smoothest possible cadence
 *    the display can express.
 *  - Production chat UIs (ChatGPT, Claude.ai) feel smooth precisely because
 *    they emit at word boundaries at a steady tempo.
 *
 * The engine is model-aware: callers should pass {@link update}'s
 * `liveCharsPerSec` if they know the source's emission rate. Without it the
 * engine targets {@link STREAM_SMOOTHING.BASE_CHARS_PER_SEC}, which can lag
 * behind fast models and make the user wait through a backlog drain after the
 * stream ends.
 */
export class SmoothTextEngine {
  private fullText = "";
  private fullLength = 0;
  private visibleLengthValue = 0;
  private charBudget = 0;
  private isStreaming = false;
  private bypassSmoothing = false;
  private liveCharsPerSec = 0;

  private enforceMaxVisualLag(): void {
    if (!this.isStreaming || this.bypassSmoothing) {
      return;
    }

    // Hard safety net for pathological bursts (paused tab, slow renderer).
    // Normal streams never reach this — the soft catch-up ramp in getAdaptiveRate
    // keeps backlog far below MAX_VISUAL_LAG_CHARS for any model rate that fits
    // within MAX_CHARS_PER_SEC. If we ever do hit it, snapping forward is
    // strictly better than leaving the user staring at a hidden tail.
    const minVisibleLength = Math.max(0, this.fullLength - STREAM_SMOOTHING.MAX_VISUAL_LAG_CHARS);
    if (this.visibleLengthValue < minVisibleLength) {
      this.visibleLengthValue = minVisibleLength;
      this.charBudget = 0;
    }
  }

  /**
   * Update the ingested text and stream state.
   *
   * @param liveCharsPerSec Optional hint at the source's current emission rate
   *   (chars/sec). If omitted or 0, the engine uses {@link STREAM_SMOOTHING.BASE_CHARS_PER_SEC}.
   */
  update(
    fullText: string,
    isStreaming: boolean,
    bypassSmoothing: boolean,
    liveCharsPerSec = 0
  ): void {
    // Retain the full text so tick() can locate whitespace boundaries for
    // word-paced reveal. The hook (useSmoothStreamingText) already holds it,
    // so the extra reference is "free" — JS strings are immutable and shared.
    this.fullText = fullText;
    this.fullLength = fullText.length;
    this.isStreaming = isStreaming;
    this.bypassSmoothing = bypassSmoothing;
    this.liveCharsPerSec = liveCharsPerSec > 0 ? liveCharsPerSec : 0;

    if (this.fullLength < this.visibleLengthValue) {
      this.visibleLengthValue = this.fullLength;
      this.charBudget = 0;
    }

    if (!isStreaming || bypassSmoothing) {
      this.visibleLengthValue = this.fullLength;
      this.charBudget = 0;
      return;
    }

    this.enforceMaxVisualLag();
  }

  /**
   * Find the position to advance visibleLength to from `from`. Returns the
   * index AFTER the next whitespace character so the whitespace is included
   * in the reveal (the next word stays hidden until its own boundary is
   * reached). Returns `min(from + WORD_PACE_MAX_CHARS, fullLength)` if no
   * whitespace is found within that span — guarantees long URLs / identifiers
   * still progress in bounded chunks.
   *
   * Uses `\s` (matches all Unicode whitespace: ASCII space/tab/newline/CR/FF,
   * NBSP \u00A0, line/paragraph separators \u2028/\u2029, thin space \u2009,
   * em space \u2003, ideographic space \u3000, etc.) so non-English content
   * paces at proper word boundaries. CJK text without internal whitespace
   * still falls back to the WORD_PACE_MAX_CHARS chunk cap.
   */
  private findNextRevealBoundary(from: number): number {
    const cap = Math.min(this.fullLength, from + STREAM_SMOOTHING.WORD_PACE_MAX_CHARS);
    for (let i = from; i < cap; i++) {
      if (WHITESPACE_REGEX.test(this.fullText[i] ?? "")) {
        return i + 1;
      }
    }
    return cap;
  }

  /**
   * Advance the presentation clock by a timestep.
   */
  tick(dtMs: number): number {
    if (dtMs <= 0) {
      return this.visibleLengthValue;
    }

    if (!this.isStreaming || this.bypassSmoothing) {
      return this.visibleLengthValue;
    }

    if (this.visibleLengthValue > this.fullLength) {
      this.visibleLengthValue = this.fullLength;
      this.charBudget = 0;
    }

    if (this.visibleLengthValue === this.fullLength) {
      return this.visibleLengthValue;
    }

    const backlog = this.fullLength - this.visibleLengthValue;
    const adaptiveRate = getAdaptiveRate(backlog, this.liveCharsPerSec);

    // Clamp dt to MAX_TICK_MS. A long RAF gap (tab visibility, slow frames,
    // debugger pauses) would otherwise dump huge budget that bursts on resume,
    // bypassing the per-tick atom cap. Backlog drains via subsequent ticks,
    // which arrive at frame rate once RAF resumes; the hard-snap safety net
    // (enforceMaxVisualLag) handles pathological cases beyond MAX_VISUAL_LAG_CHARS.
    const clampedDt = Math.min(dtMs, STREAM_SMOOTHING.MAX_TICK_MS);
    this.charBudget += adaptiveRate * (clampedDt / 1000);

    // Single-atom reveal per tick. Even when budget covers multiple atoms
    // (catch-up burst, high adaptive rate), defer to subsequent ticks so the
    // user sees one word per animation frame. This is the smoothest possible
    // temporal cadence the display can express; multi-atom-per-tick reveals
    // would read as bursty even at word granularity.
    const nextBoundary = this.findNextRevealBoundary(this.visibleLengthValue);
    const cost = nextBoundary - this.visibleLengthValue;
    // Math.floor guarantees monotone progress across tick rates — partial
    // budget rolls over so a 240Hz display accumulates across several frames.
    if (cost > 0 && Math.floor(this.charBudget) >= cost) {
      this.visibleLengthValue = nextBoundary;
      this.charBudget -= cost;
    }

    return this.visibleLengthValue;
  }

  get visibleLength(): number {
    return this.visibleLengthValue;
  }

  get isCaughtUp(): boolean {
    return this.visibleLengthValue === this.fullLength;
  }

  /**
   * Reset all engine state, typically when a new stream starts.
   */
  reset(): void {
    this.fullText = "";
    this.fullLength = 0;
    this.visibleLengthValue = 0;
    this.charBudget = 0;
    this.isStreaming = false;
    this.bypassSmoothing = false;
    this.liveCharsPerSec = 0;
  }
}
