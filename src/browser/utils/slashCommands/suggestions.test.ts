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
    expect(labels).toContain("/providers");
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

  it("filters top level commands by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/cl");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].replacement).toBe("/clear");
  });

  it("suggests provider subcommands", () => {
    const suggestions = getSlashCommandSuggestions("/providers ");
    expect(suggestions.map((s) => s.display)).toContain("set");
  });

  it("suggests provider names after /providers set", () => {
    const suggestions = getSlashCommandSuggestions("/providers set ", {
      providerNames: ["anthropic"],
    });
    const labels = suggestions.map((s) => s.display);

    expect(labels).toContain("anthropic");
  });

  it("suggests provider keys after selecting a provider", () => {
    const suggestions = getSlashCommandSuggestions("/providers set anthropic ");
    const keys = suggestions.map((s) => s.display);

    expect(keys).toContain("apiKey");
    expect(keys).toContain("baseUrl");
  });

  it("filters provider keys by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/providers set anthropic api", {
      providerNames: ["anthropic"],
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].display).toBe("apiKey");
  });

  it("suggests model abbreviations after /model", () => {
    const suggestions = getSlashCommandSuggestions("/model ");
    const displays = suggestions.map((s) => s.display);

    expect(displays).toContain("opus");
    expect(displays).toContain("sonnet");
  });

  it("filters model suggestions by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/model op");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].display).toBe("opus");
  });
});
