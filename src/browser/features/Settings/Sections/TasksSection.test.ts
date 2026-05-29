import { describe, expect, test } from "bun:test";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { FALLBACK_AGENTS, deriveTasksSectionAgentGroups } from "./TasksSection.agents";

describe("FALLBACK_AGENTS", () => {
  test("keeps hidden built-ins in the fallback inventory", () => {
    const fallbackAgentIds = FALLBACK_AGENTS.map((agent) => agent.id);

    expect(fallbackAgentIds).toContain("desktop");
    expect(fallbackAgentIds).toContain("name_workspace");
  });
});

describe("deriveTasksSectionAgentGroups", () => {
  test("hides Desktop from Settings while keeping its overrides known when Portable Desktop is off", () => {
    const agentAiDefaults: AgentAiDefaults = {
      desktop: { enabled: false },
      mystery: { enabled: true },
    };

    const groups = deriveTasksSectionAgentGroups({
      listedAgents: FALLBACK_AGENTS,
      agentAiDefaults,
      portableDesktopEnabled: false,
    });

    expect(groups.subagents.map((agent) => agent.id)).toEqual(["explore"]);
    expect(groups.unknownAgentIds).toEqual(["mystery"]);
  });

  test("shows Desktop before Explore in Sub-agents when Portable Desktop is on", () => {
    const groups = deriveTasksSectionAgentGroups({
      listedAgents: FALLBACK_AGENTS,
      agentAiDefaults: {},
      portableDesktopEnabled: true,
    });

    expect(groups.subagents.map((agent) => agent.id)).toEqual(["desktop", "explore"]);
  });
});
