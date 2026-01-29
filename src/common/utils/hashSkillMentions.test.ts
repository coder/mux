import { describe, it, expect } from "bun:test";
import {
  findHashSkillAtCursor,
  extractHashSkillMentions,
  formatHashSkillInvocationText,
} from "./hashSkillMentions";

describe("findHashSkillAtCursor", () => {
  it("should find hash skill at cursor position", () => {
    const result = findHashSkillAtCursor("use #react-effects", 5);
    expect(result).toEqual({
      startIndex: 4,
      endIndex: 18,
      query: "react-effects",
    });
  });

  it("should find partial hash skill at cursor", () => {
    const result = findHashSkillAtCursor("use #rea", 8);
    expect(result).toEqual({
      startIndex: 4,
      endIndex: 8,
      query: "rea",
    });
  });

  it("should find empty hash at cursor", () => {
    const result = findHashSkillAtCursor("use #", 5);
    expect(result).toEqual({
      startIndex: 4,
      endIndex: 5,
      query: "",
    });
  });

  it("should return null when cursor is not in a hash skill", () => {
    const result = findHashSkillAtCursor("use something", 5);
    expect(result).toBeNull();
  });

  it("should return null for word#word patterns", () => {
    const result = findHashSkillAtCursor("foo#bar", 5);
    expect(result).toBeNull();
  });

  it("should handle cursor at start of text", () => {
    const result = findHashSkillAtCursor("#skill", 0);
    expect(result).toBeNull();
  });

  it("should handle cursor at end of hash skill", () => {
    const result = findHashSkillAtCursor("#skill", 6);
    expect(result).toEqual({
      startIndex: 0,
      endIndex: 6,
      query: "skill",
    });
  });

  it("should handle multiple hash skills - cursor on second", () => {
    const result = findHashSkillAtCursor("#first #second", 10);
    expect(result).toEqual({
      startIndex: 7,
      endIndex: 14,
      query: "second",
    });
  });
});

describe("extractHashSkillMentions", () => {
  const validSkills = new Set(["react-effects", "tests", "init"]);

  it("should extract single valid skill mention", () => {
    const result = extractHashSkillMentions("use #react-effects", validSkills);
    expect(result).toEqual([{ name: "react-effects", startIndex: 4, endIndex: 18 }]);
  });

  it("should extract multiple valid skill mentions", () => {
    const result = extractHashSkillMentions("use #react-effects and #tests", validSkills);
    expect(result).toEqual([
      { name: "react-effects", startIndex: 4, endIndex: 18 },
      { name: "tests", startIndex: 23, endIndex: 29 },
    ]);
  });

  it("should ignore invalid skill names", () => {
    const result = extractHashSkillMentions("use #invalid-skill and #tests", validSkills);
    expect(result).toEqual([{ name: "tests", startIndex: 23, endIndex: 29 }]);
  });

  it("should return empty array when no valid skills", () => {
    const result = extractHashSkillMentions("use #unknown", validSkills);
    expect(result).toEqual([]);
  });

  it("should ignore word#word patterns", () => {
    const result = extractHashSkillMentions("foo#tests", validSkills);
    expect(result).toEqual([]);
  });

  it("should handle skills at start of text", () => {
    const result = extractHashSkillMentions("#tests are here", validSkills);
    expect(result).toEqual([{ name: "tests", startIndex: 0, endIndex: 6 }]);
  });
});

describe("formatHashSkillInvocationText", () => {
  it("should format single skill with text", () => {
    const mentions = [{ name: "tests", startIndex: 4, endIndex: 10 }];
    const result = formatHashSkillInvocationText("use #tests now", mentions);
    expect(result).toBe("Using skill tests: use now");
  });

  it("should format single skill without additional text", () => {
    const mentions = [{ name: "tests", startIndex: 0, endIndex: 6 }];
    const result = formatHashSkillInvocationText("#tests", mentions);
    expect(result).toBe("Use skill tests");
  });

  it("should format multiple skills with text", () => {
    const mentions = [
      { name: "react-effects", startIndex: 4, endIndex: 18 },
      { name: "tests", startIndex: 23, endIndex: 29 },
    ];
    const result = formatHashSkillInvocationText("use #react-effects and #tests now", mentions);
    expect(result).toBe("Using skills react-effects, tests: use and now");
  });

  it("should format multiple skills without additional text", () => {
    const mentions = [
      { name: "react-effects", startIndex: 0, endIndex: 14 },
      { name: "tests", startIndex: 15, endIndex: 21 },
    ];
    const result = formatHashSkillInvocationText("#react-effects #tests", mentions);
    expect(result).toBe("Use skills react-effects, tests");
  });

  it("should deduplicate repeated skill mentions", () => {
    const mentions = [
      { name: "tests", startIndex: 0, endIndex: 6 },
      { name: "tests", startIndex: 7, endIndex: 13 },
    ];
    const result = formatHashSkillInvocationText("#tests #tests", mentions);
    expect(result).toBe("Use skill tests");
  });

  it("should return original text when no mentions", () => {
    const result = formatHashSkillInvocationText("hello world", []);
    expect(result).toBe("hello world");
  });
});
