import { STREAM_SMOOTHING } from "@/constants/streaming";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getAdaptiveRate(backlog: number): number {
  const backlogPressure = clamp(backlog / STREAM_SMOOTHING.CATCHUP_BACKLOG_CHARS, 0, 1);

  const targetRate =
    STREAM_SMOOTHING.BASE_CHARS_PER_SEC +
    backlogPressure * (STREAM_SMOOTHING.MAX_CHARS_PER_SEC - STREAM_SMOOTHING.BASE_CHARS_PER_SEC);

  return clamp(targetRate, STREAM_SMOOTHING.MIN_CHARS_PER_SEC, STREAM_SMOOTHING.MAX_CHARS_PER_SEC);
}

/**
 * Deterministic text reveal engine for smoothing streamed output.
 *
 * The ingestion clock (incoming full text) is external; this class manages only
 * the presentation clock (visible prefix length) using a character budget model.
 */
export class SmoothTextEngine {
  private fullLength = 0;
  private visibleLengthValue = 0;
  private charBudget = 0;
  private isStreaming = false;
  private bypassSmoothing = false;

  private enforceMaxVisualLag(): void {
    if (!this.isStreaming || this.bypassSmoothing) {
      return;
    }

    // Keep visible output near the ingested stream so interruption doesn't reveal
    // a large hidden tail all at once.
    const minVisibleLength = Math.max(0, this.fullLength - STREAM_SMOOTHING.MAX_VISUAL_LAG_CHARS);
    if (this.visibleLengthValue < minVisibleLength) {
      this.visibleLengthValue = minVisibleLength;
      this.charBudget = 0;
    }
  }

  /**
   * Update the ingested text and stream state.
   */
  update(fullText: string, isStreaming: boolean, bypassSmoothing: boolean): void {
    this.fullLength = fullText.length;
    this.isStreaming = isStreaming;
    this.bypassSmoothing = bypassSmoothing;

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
    const adaptiveRate = getAdaptiveRate(backlog);

    this.charBudget += adaptiveRate * (dtMs / 1000);

    // Budget-gated reveal: only reveal when at least one whole character has
    // accrued. This makes cadence frame-rate invariant — a 240Hz display
    // accumulates budget across several frames before revealing, rather than
    // forcing 1 char/frame at any refresh rate.
    const wholeCharsReady = Math.floor(this.charBudget);
    if (wholeCharsReady < STREAM_SMOOTHING.MIN_FRAME_CHARS) {
      return this.visibleLengthValue;
    }

    const reveal = Math.min(wholeCharsReady, STREAM_SMOOTHING.MAX_FRAME_CHARS);
    this.visibleLengthValue = Math.min(this.fullLength, this.visibleLengthValue + reveal);
    this.charBudget -= reveal;

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
    this.fullLength = 0;
    this.visibleLengthValue = 0;
    this.charBudget = 0;
    this.isStreaming = false;
    this.bypassSmoothing = false;
  }
}
