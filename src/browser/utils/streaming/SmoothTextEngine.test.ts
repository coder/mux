import { describe, it, expect } from "bun:test";
import { STREAM_SMOOTHING } from "@/constants/streaming";
import { SmoothTextEngine } from "./SmoothTextEngine";

function makeText(length: number): string {
  return "x".repeat(length);
}

/**
 * Realistic whitespace-bearing text for tests that exercise word-paced reveal
 * cadence. Uses fixed 5-char "words" + 1 space = 6 chars per atom — short
 * enough to fit comfortably under WORD_PACE_MAX_CHARS=12 so the cap doesn't
 * dominate behavior.
 */
function makeWords(length: number): string {
  const words: string[] = [];
  let total = 0;
  while (total < length) {
    words.push("abcde");
    total += 6; // 5 chars + 1 space
  }
  return words.join(" ").slice(0, length);
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
    // For a 1-char string with no whitespace, the next reveal atom is the
    // entire string (cost=1). With ~74 cps adaptive rate at 4ms per tick:
    // ~0.30 budget per tick. The engine waits until floor(charBudget) >= 1
    // before revealing — frame-rate invariance means partial budget rolls over.
    engine.update("x", true, false);

    // First tick at 4ms should not reveal (budget ~0.30 < 1).
    const afterFirstTick = engine.tick(4);
    expect(afterFirstTick).toBe(0);

    // Several more small ticks should still not reveal (budget < 1).
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
    // than at the BASE rate of 72 cps for the same backlog. Uses realistic
    // word-bearing text so the rate differential maps onto distinct word
    // counts revealed in the same wall-time window.
    const baseEngine = new SmoothTextEngine();
    const modelAwareEngine = new SmoothTextEngine();

    baseEngine.update(makeWords(50), true, false);
    modelAwareEngine.update(makeWords(50), true, false, 200);

    for (let i = 0; i < 10; i++) {
      baseEngine.tick(16);
      modelAwareEngine.tick(16);
    }

    expect(modelAwareEngine.visibleLength).toBeGreaterThan(baseEngine.visibleLength);
  });

  it("reveals at most one atom per tick even with huge budget", () => {
    // Time-smoothing: even when budget covers many atoms (catch-up burst,
    // very high adaptive rate), reveals must be spread across ticks so the
    // user sees one word per animation frame. Multi-atom reveals would
    // bypass the temporal cadence and read as bursty.
    const engine = new SmoothTextEngine();
    // 5-char words + space = 6-char atoms. 100 chars = ~17 atoms.
    engine.update(makeWords(100), true, false, 1000); // very high model rate

    // Even one tick at the dt clamp ceiling shouldn't reveal more than the
    // largest possible atom (WORD_PACE_MAX_CHARS=12).
    const before = engine.visibleLength;
    engine.tick(33);
    const revealed = engine.visibleLength - before;

    // ≤ 12 chars (one atom max). With 6-char atoms it's exactly 6.
    expect(revealed).toBeLessThanOrEqual(STREAM_SMOOTHING.WORD_PACE_MAX_CHARS);
  });

  it("clamps dt so a long pause doesn't burst on resume", () => {
    // RAF gaps (tab visibility, debugger pauses) can produce multi-second
    // dt values. Without clamping, budget = adaptiveRate * dt would balloon
    // and feed downstream into multi-atom reveals (or in earlier engine
    // designs, a 10s pause would dump the entire backlog in one frame).
    const engine = new SmoothTextEngine();
    engine.update(makeWords(200), true, false, 200);

    const before = engine.visibleLength;
    engine.tick(10_000); // 10-second "pause"
    const revealed = engine.visibleLength - before;

    // Same single-atom cap as a normal tick — the clamp ensures budget
    // accumulated from a 10s gap is no larger than from a 33ms gap.
    expect(revealed).toBeLessThanOrEqual(STREAM_SMOOTHING.WORD_PACE_MAX_CHARS);
  });

  it("treats Unicode whitespace as word boundaries", () => {
    // Non-English content uses NBSP \u00A0, ideographic space \u3000, etc.
    // The boundary scanner must recognize them or the entire stream is treated
    // as one no-whitespace run capped at WORD_PACE_MAX_CHARS chunks. Each of
    // these strings has a single Unicode whitespace separator at index 5.
    const cases = [
      "Hello\u00a0world", // NBSP
      "Hello\u2003world", // em space
      "Hello\u2009world", // thin space
      "Hello\u3000world", // ideographic space
      "Hello\u2028world", // line separator
    ];

    for (const text of cases) {
      const engine = new SmoothTextEngine();
      engine.update(text, true, false);
      // Tick until "Hello<sep>" is revealed (cost = 6) — boundary scan must
      // land at index 6, not at the WORD_PACE_MAX_CHARS cap of 12.
      let observed = engine.visibleLength;
      for (let i = 0; i < 50 && engine.visibleLength < 6; i++) {
        engine.tick(16);
        observed = engine.visibleLength;
        if (observed >= 6 && observed < text.length) break;
      }
      expect(observed).toBe(6);
    }
  });

  it("reveals only at whitespace boundaries", () => {
    // Word-paced reveal: visibleLength must always land just after a
    // whitespace character (or at 0 / fullLength). Prevents mid-word reveals
    // that the eye registers as character-by-character chop.
    const engine = new SmoothTextEngine();
    const text = "Hello world. How are you doing today?";
    engine.update(text, true, false);

    const seenLengths = new Set<number>([engine.visibleLength]);
    for (let i = 0; i < 200 && !engine.isCaughtUp; i++) {
      engine.tick(16);
      seenLengths.add(engine.visibleLength);
    }

    expect(engine.isCaughtUp).toBe(true);
    for (const len of seenLengths) {
      if (len === 0 || len === text.length) continue;
      // The character immediately before the reveal cursor must be whitespace.
      const charBefore = text[len - 1];
      expect(/\s/.test(charBefore)).toBe(true);
    }
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
