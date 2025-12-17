import { describe, it, expect } from "@jest/globals";
import { AGENT_PRESETS, getAgentPreset, getAgentToolPolicy } from "./agentPresets";
import { applyToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { Tool } from "ai";

// Helper to create a minimal mock Tool for testing
function createMockTools(toolNames: string[]): Record<string, Tool> {
  const result: Record<string, Tool> = {};
  for (const name of toolNames) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Tool has many required properties we don't need for policy filtering tests
    result[name] = { description: `Mock ${name}` } as Tool;
  }
  return result;
}

describe("agentPresets", () => {
  describe("AGENT_PRESETS", () => {
    it("should have research and explore presets", () => {
      expect(AGENT_PRESETS.research).toBeDefined();
      expect(AGENT_PRESETS.explore).toBeDefined();
    });

    it("should have required fields in each preset", () => {
      for (const preset of Object.values(AGENT_PRESETS)) {
        expect(preset.name).toBeTruthy();
        expect(preset.description).toBeTruthy();
        expect(preset.toolPolicy).toBeInstanceOf(Array);
        expect(preset.systemPrompt).toBeTruthy();
      }
    });
  });

  describe("getAgentPreset", () => {
    it("should return preset for valid agent type", () => {
      const research = getAgentPreset("research");
      expect(research.name).toBe("Research");

      const explore = getAgentPreset("explore");
      expect(explore.name).toBe("Explore");
    });

    it("should throw for unknown agent type", () => {
      expect(() => getAgentPreset("unknown" as "research")).toThrow("Unknown agent type: unknown");
    });
  });

  describe("getAgentToolPolicy", () => {
    it("should append preset policy after caller policy", () => {
      // Caller tries to enable file_edit_replace_string
      const callerPolicy = [{ regex_match: "file_edit_replace_string", action: "enable" as const }];
      const resultPolicy = getAgentToolPolicy("research", callerPolicy);

      // Caller's policy should be first
      expect(resultPolicy[0]).toEqual(callerPolicy[0]);

      // Preset policy should come after
      const presetPolicy = getAgentPreset("research").toolPolicy;
      expect(resultPolicy.slice(1)).toEqual(presetPolicy);
    });

    it("should return only preset policy when no caller policy", () => {
      const resultPolicy = getAgentToolPolicy("explore");
      const presetPolicy = getAgentPreset("explore").toolPolicy;
      expect(resultPolicy).toEqual(presetPolicy);
    });

    it("should ensure preset disables cannot be overridden by caller enables", () => {
      // Caller tries to enable file_edit_replace_string
      const callerPolicy = [{ regex_match: "file_edit_replace_string", action: "enable" as const }];
      const resultPolicy = getAgentToolPolicy("research", callerPolicy);

      // When applied to a tool list, the preset's "disable all then enable specific"
      // pattern should override the caller's enable
      const allTools = createMockTools([
        "file_read",
        "file_edit_replace_string",
        "bash",
        "web_search",
        "agent_report",
        "task",
      ]);
      const filteredTools = applyToolPolicy(allTools, resultPolicy);

      // file_edit_replace_string should NOT be available (preset disables it)
      expect(Object.keys(filteredTools)).not.toContain("file_edit_replace_string");
      // But allowed tools should be available
      expect(Object.keys(filteredTools)).toContain("web_search");
      expect(Object.keys(filteredTools)).toContain("file_read");
      expect(Object.keys(filteredTools)).toContain("agent_report");
      expect(Object.keys(filteredTools)).toContain("task");
    });
  });

  describe("preset tool policies", () => {
    it("research preset should enable required tools", () => {
      const preset = getAgentPreset("research");
      const allTools = createMockTools([
        "file_read",
        "file_edit_replace_string",
        "bash",
        "web_search",
        "web_fetch",
        "agent_report",
        "task",
        "todo_write",
        "todo_read",
      ]);
      const filteredTools = applyToolPolicy(allTools, preset.toolPolicy);

      // Should have: web_search, web_fetch, file_read, task, agent_report, todo_*
      expect(Object.keys(filteredTools)).toContain("web_search");
      expect(Object.keys(filteredTools)).toContain("web_fetch");
      expect(Object.keys(filteredTools)).toContain("file_read");
      expect(Object.keys(filteredTools)).toContain("task");
      expect(Object.keys(filteredTools)).toContain("agent_report");
      expect(Object.keys(filteredTools)).toContain("todo_write");
      expect(Object.keys(filteredTools)).toContain("todo_read");

      // Should NOT have: file_edit_*, bash
      expect(Object.keys(filteredTools)).not.toContain("file_edit_replace_string");
      expect(Object.keys(filteredTools)).not.toContain("bash");
    });

    it("explore preset should enable required tools", () => {
      const preset = getAgentPreset("explore");
      const allTools = createMockTools([
        "file_read",
        "file_edit_replace_string",
        "bash",
        "bash_output",
        "bash_background_list",
        "bash_background_terminate",
        "web_search",
        "agent_report",
        "task",
        "todo_write",
      ]);
      const filteredTools = applyToolPolicy(allTools, preset.toolPolicy);

      // Should have: file_read, bash*, task, agent_report, todo_*
      expect(Object.keys(filteredTools)).toContain("file_read");
      expect(Object.keys(filteredTools)).toContain("bash");
      expect(Object.keys(filteredTools)).toContain("bash_output");
      expect(Object.keys(filteredTools)).toContain("bash_background_list");
      expect(Object.keys(filteredTools)).toContain("bash_background_terminate");
      expect(Object.keys(filteredTools)).toContain("task");
      expect(Object.keys(filteredTools)).toContain("agent_report");
      expect(Object.keys(filteredTools)).toContain("todo_write");

      // Should NOT have: file_edit_*, web_search
      expect(Object.keys(filteredTools)).not.toContain("file_edit_replace_string");
      expect(Object.keys(filteredTools)).not.toContain("web_search");
    });

    it("all presets should include task and agent_report tools", () => {
      for (const preset of Object.values(AGENT_PRESETS)) {
        const allTools = createMockTools(["task", "agent_report", "other_tool"]);
        const filteredTools = applyToolPolicy(allTools, preset.toolPolicy);

        expect(Object.keys(filteredTools)).toContain("task");
        expect(Object.keys(filteredTools)).toContain("agent_report");
      }
    });
  });
});
