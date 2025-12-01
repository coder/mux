/**
 * Detects repetitive text patterns in streaming output.
 *
 * This is specifically designed to catch the Gemini token exhaustion bug where
 * the model gets stuck in a loop emitting variations of "I am done. I am done. I am done..."
 * until it exhausts all output tokens.
 *
 * The detector uses a sliding window approach to identify when the model is repeating
 * short phrases, which is a clear signal of the bug. Normal text may occasionally
 * repeat phrases, but not the same phrase 10+ times in a short window.
 *
 * @see https://github.com/google-gemini/gemini-cli/issues/13322
 */

/**
 * Configuration for repetition detection
 */
export interface RepetitionDetectorConfig {
  /** Minimum phrase length to track (shorter phrases are too common) */
  minPhraseLength: number;
  /** Maximum phrase length to track (longer phrases are unlikely to repeat exactly) */
  maxPhraseLength: number;
  /** Number of repetitions required to trigger detection */
  repetitionThreshold: number;
  /** Size of the sliding window in characters */
  windowSize: number;
}

const DEFAULT_CONFIG: RepetitionDetectorConfig = {
  minPhraseLength: 8, // "I am done" is 9 chars
  maxPhraseLength: 50, // Long enough to catch varied repetitions
  repetitionThreshold: 10, // 10 repetitions is clearly a bug
  windowSize: 2000, // ~500 tokens worth of text
};

/**
 * Stateful repetition detector for streaming text.
 *
 * Call `addText()` with each text chunk as it streams in.
 * Call `isRepetitive()` to check if repetitive patterns have been detected.
 */
export class RepetitionDetector {
  private buffer = "";
  private readonly config: RepetitionDetectorConfig;
  private detected = false;
  private detectedPhrase: string | null = null;

  constructor(config: Partial<RepetitionDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a chunk of text to the detector.
   * @param text - The text chunk to analyze
   */
  addText(text: string): void {
    if (this.detected) {
      // Already detected, no need to continue analyzing
      return;
    }

    this.buffer += text;

    // Trim buffer to window size
    if (this.buffer.length > this.config.windowSize) {
      this.buffer = this.buffer.slice(-this.config.windowSize);
    }

    // Check for repetition after accumulating enough text
    if (this.buffer.length >= this.config.minPhraseLength * this.config.repetitionThreshold) {
      this.checkForRepetition();
    }
  }

  /**
   * Check if repetitive patterns have been detected.
   */
  isRepetitive(): boolean {
    return this.detected;
  }

  /**
   * Get the detected repetitive phrase, if any.
   */
  getDetectedPhrase(): string | null {
    return this.detectedPhrase;
  }

  /**
   * Reset the detector state.
   */
  reset(): void {
    this.buffer = "";
    this.detected = false;
    this.detectedPhrase = null;
  }

  /**
   * Analyze the buffer for repetitive patterns.
   *
   * Strategy: Look for short phrases that appear multiple times.
   * Split on common sentence boundaries and count phrase occurrences.
   */
  private checkForRepetition(): void {
    // First check line-by-line (before normalizing newlines away)
    // This handles "I am done\nI am done\nI am done"
    const lines = this.buffer.split(/\n+/).map((l) => l.trim());
    const lineCounts = new Map<string, number>();
    for (const line of lines) {
      if (
        line.length >= this.config.minPhraseLength &&
        line.length <= this.config.maxPhraseLength
      ) {
        const count = (lineCounts.get(line) ?? 0) + 1;
        lineCounts.set(line, count);

        if (count >= this.config.repetitionThreshold) {
          this.detected = true;
          this.detectedPhrase = line;
          return;
        }
      }
    }

    // Normalize whitespace to make matching easier
    const normalized = this.buffer.replace(/\s+/g, " ").trim();

    // Split into sentences/phrases on common boundaries
    // This handles patterns like "I am done. I am done. I am done."
    const phrases = normalized.split(/[.!?\n]+/).map((p) => p.trim());

    // Count phrase occurrences
    const phraseCounts = new Map<string, number>();
    for (const phrase of phrases) {
      if (
        phrase.length >= this.config.minPhraseLength &&
        phrase.length <= this.config.maxPhraseLength
      ) {
        const count = (phraseCounts.get(phrase) ?? 0) + 1;
        phraseCounts.set(phrase, count);

        if (count >= this.config.repetitionThreshold) {
          this.detected = true;
          this.detectedPhrase = phrase;
          return;
        }
      }
    }
  }
}
