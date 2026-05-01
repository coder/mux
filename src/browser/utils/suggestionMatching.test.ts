import { describe, expect, test } from "bun:test";
import { matchesNameBySegmentPrefix } from "./suggestionMatching";

describe("matchesNameBySegmentPrefix", () => {
  test("matches empty and whitespace-only partials", () => {
    expect(matchesNameBySegmentPrefix("deep-review", "")).toBe(true);
    expect(matchesNameBySegmentPrefix("deep-review", "   ")).toBe(true);
  });

  test("matches full-name prefixes case-insensitively", () => {
    expect(matchesNameBySegmentPrefix("deep-review", "DEEP-R")).toBe(true);
  });

  test("matches hyphen-delimited segment prefixes", () => {
    expect(matchesNameBySegmentPrefix("code-simplifier", "simpl")).toBe(true);
    expect(matchesNameBySegmentPrefix("deep-review", "review")).toBe(true);
  });

  test("does not match substring-only partials", () => {
    expect(matchesNameBySegmentPrefix("deep-review", "view")).toBe(false);
  });
});
