import { describe, expect, test } from "bun:test";
import {
  fuzzySubsequenceMatch,
  matchesAllTerms,
  normalizeFuzzyText,
  scoreAllTerms,
  splitQueryIntoTerms,
} from "./fuzzySearch";

describe("fuzzySearch", () => {
  test("normalizeFuzzyText lowercases and replaces common separators", () => {
    expect(normalizeFuzzyText("Ask: check plan→orchestrator")).toBe("ask check plan orchestrator");
  });

  test("splitQueryIntoTerms splits on spaces and common punctuation", () => {
    expect(splitQueryIntoTerms("ask check")).toEqual(["ask", "check"]);
    expect(splitQueryIntoTerms("ask:check")).toEqual(["ask", "check"]);
    expect(splitQueryIntoTerms("ask/check")).toEqual(["ask", "check"]);
    expect(splitQueryIntoTerms("ask→check")).toEqual(["ask", "check"]);
  });

  test("fuzzySubsequenceMatch matches in-order characters with gaps", () => {
    expect(fuzzySubsequenceMatch("Workspace Switch", "ws")).toBe(true);
    expect(fuzzySubsequenceMatch("Workspace Switch", "sw")).toBe(true);
    expect(fuzzySubsequenceMatch("Workspace Switch", "zz")).toBe(false);
  });

  test("matchesAllTerms ANDs terms and tolerates formatting punctuation", () => {
    const text = "Ask: check plan→orchestrator switch behavior";

    // Regression: `ask check` should match `Ask: check …`
    expect(matchesAllTerms(text, "ask check")).toBe(true);

    // Terms can appear in any order.
    expect(matchesAllTerms(text, "orchestrator ask")).toBe(true);

    // Query punctuation is treated as a separator.
    expect(matchesAllTerms(text, "ask:check")).toBe(true);
    expect(matchesAllTerms(text, "ask/check")).toBe(true);
    expect(matchesAllTerms(text, "ask→check")).toBe(true);

    expect(matchesAllTerms(text, "ask missing")).toBe(false);
  });
});

describe("scoreAllTerms", () => {
  test("exact substring match scores higher than scattered subsequence", () => {
    // "Show Output" contains "output" as a contiguous substring.
    // "Layout: Capture current to Slot 1" matches "output" only as a scattered subsequence.
    const exactScore = scoreAllTerms("Show Output", "output");
    const scatteredScore = scoreAllTerms("Layout: Capture current to Slot 1", "output");

    expect(exactScore).toBeGreaterThan(0);
    expect(scatteredScore).toBeGreaterThan(0);
    expect(exactScore).toBeGreaterThan(scatteredScore);
  });

  test("returns 0 when any term does not match (AND semantics)", () => {
    expect(scoreAllTerms("Show Output", "output missing")).toBe(0);
  });

  test("returns 1 for empty query", () => {
    expect(scoreAllTerms("anything", "")).toBe(1);
  });

  test("multi-term query averages scores", () => {
    const score = scoreAllTerms("Show Output Panel", "show output");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test("no match returns 0", () => {
    expect(scoreAllTerms("Show Output", "zzz")).toBe(0);
  });

  test("word-boundary matches score higher than mid-word", () => {
    const atBoundary = scoreAllTerms("Output Panel", "output");
    const notAtBoundary = scoreAllTerms("Foutputter", "output");
    expect(atBoundary).toBeGreaterThan(notAtBoundary);
  });
});
