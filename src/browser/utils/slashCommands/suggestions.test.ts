import { describe, it, expect } from "bun:test";
import { getSlashCommandSuggestions } from "./suggestions";

describe("getSlashCommandSuggestions", () => {
  it("returns empty suggestions for non-commands", () => {
    expect(getSlashCommandSuggestions("hello")).toEqual([]);
    expect(getSlashCommandSuggestions("")).toEqual([]);
  });

  it("filters workspace-only commands in creation mode", () => {
    const suggestions = getSlashCommandSuggestions("/", { variant: "creation" });
    const labels = suggestions.map((s) => s.display);

    expect(labels).not.toContain("/clear");
    expect(labels).not.toContain("/plan");
  });

  it("omits workspace-only subcommands in creation mode", () => {
    const suggestions = getSlashCommandSuggestions("/plan ", { variant: "creation" });
    expect(suggestions).toEqual([]);
  });
  it("suggests top level commands when starting with slash", () => {
    const suggestions = getSlashCommandSuggestions("/");
    const labels = suggestions.map((s) => s.display);

    expect(labels).toContain("/clear");
    expect(labels).toContain("/model");
  });

  it("includes agent skills when provided in context", () => {
    const suggestions = getSlashCommandSuggestions("/", {
      agentSkills: [
        {
          name: "test-skill",
          description: "Test skill description",
          scope: "project",
        },
      ],
    });

    const skillSuggestion = suggestions.find((s) => s.display === "/test-skill");
    expect(skillSuggestion).toBeTruthy();
    expect(skillSuggestion?.replacement).toBe("/test-skill ");
    expect(skillSuggestion?.description).toContain("(project)");
  });

  it("matches hyphenated skill segments", () => {
    const suggestions = getSlashCommandSuggestions("/r", {
      agentSkills: [
        {
          name: "deep-review",
          description: "Test",
          scope: "project",
        },
      ],
    });

    const labels = suggestions.map((s) => s.display);
    expect(labels).toContain("/deep-review");
  });

  it("matches full prefixes that cross hyphen boundaries", () => {
    const suggestions = getSlashCommandSuggestions("/deep-r", {
      agentSkills: [
        {
          name: "deep-review",
          description: "Test",
          scope: "project",
        },
      ],
    });

    expect(suggestions.map((s) => s.display)).toContain("/deep-review");
  });

  it("filters top level commands by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/cl");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].replacement).toBe("/clear");
  });

  it("suggests model abbreviations after /model", () => {
    const suggestions = getSlashCommandSuggestions("/model ");
    const displays = suggestions.map((s) => s.display);

    expect(displays).toContain("opus");
    expect(displays).toContain("sonnet");
  });

  it("filters model suggestions by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/model op");
    // Both "opus" (opus-4-6) and "opus-4.5" match the "op" prefix
    expect(suggestions).toHaveLength(2);
    const displays = suggestions.map((s) => s.display);
    expect(displays).toContain("opus");
    expect(displays).toContain("opus-4.5");
  });

  it("suggests model aliases as one-shot commands", () => {
    const suggestions = getSlashCommandSuggestions("/");
    const displays = suggestions.map((s) => s.display);

    expect(displays).toContain("/haiku");
    expect(displays).toContain("/sonnet");
    expect(displays).toContain("/opus");
  });

  it("filters model alias suggestions by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/ha");
    const displays = suggestions.map((s) => s.display);

    expect(displays).toContain("/haiku");
    expect(displays).not.toContain("/sonnet");
  });

  it("includes description for model alias suggestions", () => {
    const suggestions = getSlashCommandSuggestions("/haiku");
    const haiku = suggestions.find((s) => s.display === "/haiku");

    expect(haiku).toBeTruthy();
    expect(haiku?.description).toContain("(one message)");
    expect(haiku?.replacement).toBe("/haiku ");
  });
});
