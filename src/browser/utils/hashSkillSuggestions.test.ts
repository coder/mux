import { describe, it, expect } from "bun:test";
import { getHashSkillSuggestions } from "./hashSkillSuggestions";

describe("getHashSkillSuggestions", () => {
  const mockSkills = [
    { name: "react-effects", description: "React effects guidance", scope: "project" as const },
    { name: "tests", description: "Testing patterns", scope: "global" as const },
    { name: "init", description: "Initialize agent", scope: "built-in" as const },
  ];

  it("should return suggestions when cursor is after #", () => {
    const result = getHashSkillSuggestions("#", 1, { agentSkills: mockSkills });
    expect(result.suggestions.length).toBe(3);
    expect(result.match).toEqual({ startIndex: 0, endIndex: 1 });
  });

  it("should filter suggestions based on partial query", () => {
    const result = getHashSkillSuggestions("#re", 3, { agentSkills: mockSkills });
    expect(result.suggestions.length).toBe(1);
    expect(result.suggestions[0].display).toBe("#react-effects");
    expect(result.match).toEqual({ startIndex: 0, endIndex: 3 });
  });

  it("should return empty when cursor is not in a hash skill", () => {
    const result = getHashSkillSuggestions("hello world", 5, { agentSkills: mockSkills });
    expect(result.suggestions).toEqual([]);
    expect(result.match).toBeNull();
  });

  it("should return empty when no matching skills", () => {
    const result = getHashSkillSuggestions("#xyz", 4, { agentSkills: mockSkills });
    expect(result.suggestions).toEqual([]);
    expect(result.match).toEqual({ startIndex: 0, endIndex: 4 });
  });

  it("should include scope in description", () => {
    const result = getHashSkillSuggestions("#t", 2, { agentSkills: mockSkills });
    const testsSuggestion = result.suggestions.find((s) => s.display === "#tests");
    expect(testsSuggestion?.description).toContain("(user)"); // "global" shows as "user"
  });

  it("should handle hash skill in middle of text", () => {
    const result = getHashSkillSuggestions("use #te", 7, { agentSkills: mockSkills });
    expect(result.suggestions.length).toBe(1);
    expect(result.suggestions[0].display).toBe("#tests");
    expect(result.match).toEqual({ startIndex: 4, endIndex: 7 });
  });
});
