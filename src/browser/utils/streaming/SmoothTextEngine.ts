import { STREAM_SMOOTHING } from "@/constants/streaming";

const ADAPTIVE_BACKLOG_RATE = 0.25;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

  constructor() {}

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
    }
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
    const adaptiveRate = clamp(
      STREAM_SMOOTHING.BASE_CHARS_PER_SEC + backlog * ADAPTIVE_BACKLOG_RATE,
      STREAM_SMOOTHING.MIN_CHARS_PER_SEC,
      STREAM_SMOOTHING.MAX_CHARS_PER_SEC
    );

    this.charBudget += adaptiveRate * (dtMs / 1000);

    const reveal = clamp(
      Math.floor(this.charBudget),
      STREAM_SMOOTHING.MIN_FRAME_CHARS,
      STREAM_SMOOTHING.MAX_FRAME_CHARS
    );

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
