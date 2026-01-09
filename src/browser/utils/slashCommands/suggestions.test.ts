import { describe, it, expect } from "bun:test";
import { getSlashCommandSuggestions } from "./suggestions";

describe("getSlashCommandSuggestions", () => {
  it("returns empty suggestions for non-commands", () => {
    expect(getSlashCommandSuggestions("hello")).toEqual([]);
    expect(getSlashCommandSuggestions("")).toEqual([]);
  });

  it("suggests top level commands when starting with slash", () => {
    const suggestions = getSlashCommandSuggestions("/");
    const labels = suggestions.map((s) => s.display);

    expect(labels).toContain("/clear");
    expect(labels).toContain("/model");
    expect(labels).toContain("/providers");
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

  describe("custom slash commands", () => {
    const customCommands = [{ name: "my-custom" }, { name: "another-cmd" }, { name: "test-tool" }];

    it("includes custom commands in top-level suggestions", () => {
      const suggestions = getSlashCommandSuggestions("/", {}, customCommands);
      const displays = suggestions.map((s) => s.display);

      expect(displays).toContain("/my-custom");
      expect(displays).toContain("/another-cmd");
      expect(displays).toContain("/test-tool");
    });

    it("filters custom commands by partial input", () => {
      const suggestions = getSlashCommandSuggestions("/my", {}, customCommands);
      const displays = suggestions.map((s) => s.display);

      expect(displays).toContain("/my-custom");
      expect(displays).not.toContain("/another-cmd");
      expect(displays).not.toContain("/test-tool");
    });

    it("excludes custom commands that collide with built-ins", () => {
      const collidingCommands = [{ name: "clear" }, { name: "custom-cmd" }];
      const suggestions = getSlashCommandSuggestions("/", {}, collidingCommands);
      const displays = suggestions.map((s) => s.display);

      // /clear should appear only once (the built-in)
      const clearCount = displays.filter((d) => d === "/clear").length;
      expect(clearCount).toBe(1);

      // custom-cmd should appear (no collision)
      expect(displays).toContain("/custom-cmd");
    });

    it("custom commands have correct suggestion format", () => {
      const suggestions = getSlashCommandSuggestions("/my", {}, customCommands);
      const mySuggestion = suggestions.find((s) => s.display === "/my-custom");

      expect(mySuggestion).toBeDefined();
      expect(mySuggestion?.id).toBe("custom-command:my-custom");
      expect(mySuggestion?.replacement).toBe("/my-custom ");
      expect(mySuggestion?.description).toBe("Custom command");
    });

    it("does not include custom commands in creation variant", () => {
      const suggestions = getSlashCommandSuggestions("/", { variant: "creation" }, customCommands);
      const displays = suggestions.map((s) => s.display);

      expect(displays).not.toContain("/my-custom");
      expect(displays).not.toContain("/another-cmd");
    });

    it("custom commands appear after built-in commands", () => {
      const suggestions = getSlashCommandSuggestions("/", {}, customCommands);

      // Find indices of a known built-in and a custom command
      const clearIndex = suggestions.findIndex((s) => s.display === "/clear");
      const customIndex = suggestions.findIndex((s) => s.display === "/my-custom");

      expect(clearIndex).toBeGreaterThanOrEqual(0);
      expect(customIndex).toBeGreaterThan(clearIndex);
    });
  });
});
