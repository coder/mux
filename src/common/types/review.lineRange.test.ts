import { describe, expect, test } from "bun:test";

import { parseReviewLineRange } from "./review";

describe("parseReviewLineRange", () => {
  test("parses combined old/new ranges", () => {
    expect(parseReviewLineRange("-10-12 +14-16")).toEqual({
      old: { start: 10, end: 12 },
      new: { start: 14, end: 16 },
    });
  });

  test("parses single-line ranges", () => {
    expect(parseReviewLineRange("-10 +14")).toEqual({
      old: { start: 10, end: 10 },
      new: { start: 14, end: 14 },
    });
  });

  test("parses old-only and new-only ranges", () => {
    expect(parseReviewLineRange("-3-5")).toEqual({
      old: { start: 3, end: 5 },
      new: undefined,
    });

    expect(parseReviewLineRange("+7")).toEqual({
      old: undefined,
      new: { start: 7, end: 7 },
    });
  });

  test("treats legacy ranges as matching either old or new", () => {
    expect(parseReviewLineRange("42")).toEqual({
      old: { start: 42, end: 42 },
      new: { start: 42, end: 42 },
    });

    expect(parseReviewLineRange("42-45")).toEqual({
      old: { start: 42, end: 45 },
      new: { start: 42, end: 45 },
    });
  });

  test("returns null for empty/invalid ranges", () => {
    expect(parseReviewLineRange("")).toBeNull();
    expect(parseReviewLineRange(" ")).toBeNull();
    expect(parseReviewLineRange("nope")).toBeNull();
  });
});
