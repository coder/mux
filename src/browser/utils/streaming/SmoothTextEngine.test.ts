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
    // Use a long text so 5 ticks aren't enough to fully reveal even at the
    // catch-up rate ceiling — the test cares about the snap-to-full behavior
    // when streaming stops, not the steady-state cadence.
    const fullText = makeText(2000);

    engine.update(fullText, true, false);

    for (let i = 0; i < 5; i++) {
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

  it("does not force reveal when budget is below one char", () => {
    const engine = new SmoothTextEngine();
    // With a 1-char backlog, adaptive rate is at floor (~24 cps).
    // At 4ms per tick: 24 * 0.004 = 0.096 budget per tick.
    // The required-char gate is min(MIN_FRAME_CHARS, backlog) = min(2, 1) = 1
    // for this 1-char stream, so it reveals once budget reaches 1.0.
    engine.update("x", true, false);

    // First tick at 4ms should not reveal (budget ~0.10).
    const afterFirstTick = engine.tick(4);
    expect(afterFirstTick).toBe(0);

    // Several more small ticks should still not reveal.
    engine.tick(4);
    engine.tick(4);
    expect(engine.visibleLength).toBe(0);

    // After enough ticks to accumulate >= 1 char, it should reveal.
    for (let i = 0; i < 20; i++) {
      engine.tick(4);
    }
    expect(engine.visibleLength).toBeGreaterThan(0);
  });

  it("targets the live model rate when provided", () => {
    // With a model rate of 200 cps the engine should reveal materially faster
    // than at the BASE rate of 72 cps for the same backlog.
    const baseEngine = new SmoothTextEngine();
    const modelAwareEngine = new SmoothTextEngine();

    baseEngine.update(makeText(50), true, false);
    modelAwareEngine.update(makeText(50), true, false, 200);

    for (let i = 0; i < 10; i++) {
      baseEngine.tick(16);
      modelAwareEngine.tick(16);
    }

    expect(modelAwareEngine.visibleLength).toBeGreaterThan(baseEngine.visibleLength);
  });

  it("soft-catches-up large lag without a hard snap", () => {
    const engine = new SmoothTextEngine();

    // Catch up on a small initial chunk first.
    engine.update(makeText(40), true, false);
    while (!engine.isCaughtUp) {
      engine.tick(16);
    }

    // Now jump the ingested length by 200 chars — well above SOFT_CATCHUP_LAG_CHARS
    // (60) but well below the hard snap threshold (1024). The engine should NOT
    // snap forward; it should keep visibleLength at the previous position so the
    // soft catch-up ramp can drain the lag over the next few ticks.
    const prevVisible = engine.visibleLength;
    engine.update(makeText(240), true, false);
    expect(engine.visibleLength).toBe(prevVisible);

    // After enough ticks the soft ramp should drain the lag fully.
    for (let i = 0; i < 60; i++) {
      engine.tick(16);
    }
    expect(engine.isCaughtUp).toBe(true);
  });

  it("hard-snaps when lag exceeds the safety threshold", () => {
    const engine = new SmoothTextEngine();
    // A pathological burst — well above MAX_VISUAL_LAG_CHARS — must snap
    // forward to keep the user from staring at a hidden tail.
    const burstSize = STREAM_SMOOTHING.MAX_VISUAL_LAG_CHARS + 500;
    engine.update(makeText(burstSize), true, false);

    expect(burstSize - engine.visibleLength).toBeLessThanOrEqual(
      STREAM_SMOOTHING.MAX_VISUAL_LAG_CHARS
    );
  });

  it("keeps reveal near frame-rate invariant over equal wall time", () => {
    const run = (frameMs: number) => {
      const engine = new SmoothTextEngine();
      engine.update(makeText(400), true, false);
      for (let t = 0; t < 1000; t += frameMs) {
        engine.tick(frameMs);
      }
      return engine.visibleLength;
    };

    const at60Hz = run(16);
    const at240Hz = run(4);

    // Over 1 second of wall time, both refresh rates should reveal
    // approximately the same number of characters.
    expect(Math.abs(at60Hz - at240Hz)).toBeLessThanOrEqual(2);
  });
});
