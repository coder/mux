import { describe, it, expect } from "bun:test";
import { STREAM_SMOOTHING } from "@/constants/streaming";
import { SmoothTextEngine } from "./SmoothTextEngine";

function makeText(length: number): string {
  return "x".repeat(length);
}

describe("SmoothTextEngine", () => {
  it("reveals text steadily and reaches full length", () => {
    const engine = new SmoothTextEngine();
    const fullText = makeText(200);

    engine.update(fullText, true, false);

    let previousLength = engine.visibleLength;
    let reachedFullLength = false;

    for (let i = 0; i < 600; i++) {
      const nextLength = engine.tick(16);
      expect(nextLength).toBeGreaterThanOrEqual(previousLength);
      previousLength = nextLength;

      if (nextLength === fullText.length) {
        reachedFullLength = true;
        break;
      }
    }

    expect(reachedFullLength).toBe(true);
    expect(engine.visibleLength).toBe(fullText.length);
    expect(engine.isCaughtUp).toBe(true);
  });

  it("accelerates reveal speed when backlog is large", () => {
    const engine = new SmoothTextEngine();
    const fullText = makeText(500);

    engine.update(fullText, true, false);

    let previousLength = engine.visibleLength;
    let revealedCharsInFirst20Ticks = 0;

    for (let i = 0; i < 20; i++) {
      const nextLength = engine.tick(16);
      revealedCharsInFirst20Ticks += nextLength - previousLength;
      previousLength = nextLength;
    }

    // Baseline low-backlog behavior reveals ~1 char/frame with MIN_FRAME_CHARS.
    // A large backlog should reveal multiple chars/frame on average.
    expect(revealedCharsInFirst20Ticks).toBeGreaterThan(20);
  });

  it("caps visual lag when incoming text jumps ahead", () => {
    const engine = new SmoothTextEngine();

    engine.update(makeText(40), true, false);

    while (!engine.isCaughtUp) {
      engine.tick(16);
    }

    engine.update(makeText(420), true, false);

    expect(420 - engine.visibleLength).toBeLessThanOrEqual(STREAM_SMOOTHING.MAX_VISUAL_LAG_CHARS);
  });

  it("flushes immediately when streaming ends", () => {
    const engine = new SmoothTextEngine();
    const fullText = makeText(120);

    engine.update(fullText, true, false);

    for (let i = 0; i < 15; i++) {
      engine.tick(16);
    }

    expect(engine.visibleLength).toBeLessThan(fullText.length);

    engine.update(fullText, false, false);

    expect(engine.visibleLength).toBe(fullText.length);
    expect(engine.isCaughtUp).toBe(true);
  });

  it("bypasses smoothing and returns full length immediately", () => {
    const engine = new SmoothTextEngine();
    const fullText = makeText(80);

    engine.update(fullText, true, true);

    expect(engine.visibleLength).toBe(fullText.length);
    expect(engine.isCaughtUp).toBe(true);
  });

  it("clamps visible length when content shrinks", () => {
    const engine = new SmoothTextEngine();

    engine.update(makeText(100), true, false);

    while (engine.visibleLength < 50) {
      engine.tick(16);
    }

    engine.update(makeText(30), true, false);

    expect(engine.visibleLength).toBe(30);
  });
});
