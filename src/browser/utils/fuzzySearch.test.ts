import { describe, expect, test } from "bun:test";
import { normalizeFuzzyText, splitQueryIntoTerms } from "./fuzzySearch";

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
});
