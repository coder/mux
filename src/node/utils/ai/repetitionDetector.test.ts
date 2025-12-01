import { describe, test, expect } from "bun:test";
import { RepetitionDetector } from "./repetitionDetector";

describe("RepetitionDetector", () => {
  test("detects period-separated repetition", () => {
    const detector = new RepetitionDetector();
    const repeatedPhrase = "I am done. ".repeat(15);
    detector.addText(repeatedPhrase);
    expect(detector.isRepetitive()).toBe(true);
    expect(detector.getDetectedPhrase()).toBe("I am done");
  });

  test("detects newline-separated repetition", () => {
    const detector = new RepetitionDetector();
    const repeatedPhrase = "I am done\n".repeat(15);
    detector.addText(repeatedPhrase);
    expect(detector.isRepetitive()).toBe(true);
  });

  test("detects repetition across multiple addText calls", () => {
    const detector = new RepetitionDetector();
    for (let i = 0; i < 15; i++) {
      detector.addText("I am done. ");
    }
    expect(detector.isRepetitive()).toBe(true);
  });

  test("does not trigger on normal text", () => {
    const detector = new RepetitionDetector();
    detector.addText(
      "This is a normal response with varied content. " +
        "It talks about different things. " +
        "Each sentence is unique. " +
        "There is no repetition here. " +
        "The model is working correctly. "
    );
    expect(detector.isRepetitive()).toBe(false);
  });

  test("does not trigger on short repeated words", () => {
    const detector = new RepetitionDetector();
    // Short phrases like "OK. OK. OK." should not trigger (below minPhraseLength)
    detector.addText("OK. ".repeat(20));
    expect(detector.isRepetitive()).toBe(false);
  });

  test("handles the exact Gemini bug pattern", () => {
    const detector = new RepetitionDetector();
    // This is the actual pattern reported in the bug
    const bugPattern = `I am done.

I will stop.

I am done.

I'm done.

I am done.

I am done.

I am done.

I am done.

I am done.

I am done.

I am done.

I am done.`;
    detector.addText(bugPattern);
    expect(detector.isRepetitive()).toBe(true);
  });

  test("handles the Gemini CLI loop pattern", () => {
    const detector = new RepetitionDetector();
    // Pattern from https://github.com/google-gemini/gemini-cli/issues/13322
    // Need enough repetitions to trigger the threshold (default 10)
    const cliPattern = "I'll do it. I'll execute. ".repeat(12);
    detector.addText(cliPattern);
    expect(detector.isRepetitive()).toBe(true);
  });

  test("reset clears detection state", () => {
    const detector = new RepetitionDetector();
    detector.addText("I am done. ".repeat(15));
    expect(detector.isRepetitive()).toBe(true);

    detector.reset();

    expect(detector.isRepetitive()).toBe(false);
    expect(detector.getDetectedPhrase()).toBeNull();
  });

  test("respects custom configuration", () => {
    const detector = new RepetitionDetector({
      repetitionThreshold: 5, // Lower threshold
    });
    detector.addText("I am done. ".repeat(6));
    expect(detector.isRepetitive()).toBe(true);
  });

  test("stops processing after detection", () => {
    const detector = new RepetitionDetector();
    detector.addText("I am done. ".repeat(15));
    expect(detector.isRepetitive()).toBe(true);
    const phrase = detector.getDetectedPhrase();

    // Adding more text should not change the result
    detector.addText("Something completely different. ".repeat(10));
    expect(detector.getDetectedPhrase()).toBe(phrase);
  });
});
