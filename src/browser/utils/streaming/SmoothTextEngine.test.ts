import { describe, it, expect } from "bun:test";
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

  it("reset clears the visible state", () => {
    const engine = new SmoothTextEngine();

    engine.update(makeText(60), true, false);
    engine.tick(48);

    expect(engine.visibleLength).toBeGreaterThan(0);

    engine.reset();

    expect(engine.visibleLength).toBe(0);
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

  it("does not accumulate budget when the buffer is empty", () => {
    const engine = new SmoothTextEngine();

    engine.update(makeText(120), true, false);

    while (!engine.isCaughtUp) {
      engine.tick(16);
    }

    const caughtUpLength = engine.visibleLength;

    expect(engine.tick(5000)).toBe(caughtUpLength);
    expect(engine.visibleLength).toBe(caughtUpLength);

    engine.update(makeText(220), true, false);

    const firstTickLength = engine.tick(16);

    expect(firstTickLength - caughtUpLength).toBeLessThanOrEqual(2);
  });
});
