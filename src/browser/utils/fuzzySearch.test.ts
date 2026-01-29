import { describe, expect, test } from "bun:test";
import {
  fuzzySubsequenceMatch,
  matchesAllTerms,
  normalizeFuzzyText,
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
