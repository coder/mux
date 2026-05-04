import { STREAM_SMOOTHING } from "@/constants/streaming";
import { clamp } from "@/common/utils/clamp";

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
 * **Reveal granularity is word-sized, not character-sized.** Each tick advances
 * `visibleLength` to the position immediately after the next whitespace
 * character (a "reveal atom" = one word plus its trailing whitespace). Atoms
 * are capped at {@link STREAM_SMOOTHING.WORD_PACE_MAX_CHARS} so a long
 * whitespace-free run (URL, minified identifier) still progresses incrementally.
 * Per-tick reveal is further capped at {@link STREAM_SMOOTHING.MAX_FRAME_CHARS}
 * so a sudden catch-up burst can't dump 200 chars to the renderer in one frame.
 *
 * Why word-sized: humans parse text in word units. Character-paced reveal
 * triggers an extra decoding step the eye registers as choppy; word-paced
 * reveal matches the cadence of production chat UIs (ChatGPT, Claude.ai).
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
   */
  private findNextRevealBoundary(from: number): number {
    const cap = Math.min(this.fullLength, from + STREAM_SMOOTHING.WORD_PACE_MAX_CHARS);
    for (let i = from; i < cap; i++) {
      const c = this.fullText.charCodeAt(i);
      // ASCII whitespace: space, LF, CR, tab, form-feed. Markdown source rarely
      // contains other Unicode whitespace; the ones it does (NBSP, em-space)
      // appear inside words and shouldn't be reveal boundaries anyway.
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c) {
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

    this.charBudget += adaptiveRate * (dtMs / 1000);

    // Greedy word-atom reveal: pop atoms (a word + trailing whitespace) while
    // budget covers them. Capped per-tick at MAX_FRAME_CHARS so a sudden
    // catch-up burst doesn't dump 200 chars in one frame. This makes cadence
    // frame-rate invariant — a 240Hz display accumulates budget across
    // several frames before revealing the next atom, instead of forcing
    // ~1 char/frame at any refresh rate.
    let revealedThisTick = 0;
    while (revealedThisTick < STREAM_SMOOTHING.MAX_FRAME_CHARS) {
      const nextBoundary = this.findNextRevealBoundary(this.visibleLengthValue);
      const cost = nextBoundary - this.visibleLengthValue;
      if (cost === 0) break;
      // Wait for budget to cover the next atom. With Math.floor we guarantee
      // monotone behavior across tick rates — partial budget rolls over.
      if (Math.floor(this.charBudget) < cost) break;
      // Don't overrun the per-tick reveal cap mid-atom; defer to next tick.
      if (revealedThisTick + cost > STREAM_SMOOTHING.MAX_FRAME_CHARS) break;
      this.visibleLengthValue = nextBoundary;
      this.charBudget -= cost;
      revealedThisTick += cost;
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
