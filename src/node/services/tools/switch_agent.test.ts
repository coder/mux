import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import { buildSwitchAgentDescription, createSwitchAgentTool } from "./switch_agent";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

function createAgentDescriptor(
  id: string,
  options: { description?: string; uiSelectable: boolean; uiRoutable: boolean }
): AgentDefinitionDescriptor {
  return {
    id,
    scope: "project",
    name: id,
    description: options.description,
    uiSelectable: options.uiSelectable,
    uiRoutable: options.uiRoutable,
    subagentRunnable: false,
  };
}

function buildDescriptionWithAgents(availableSubagents: AgentDefinitionDescriptor[]): string {
  const config = {
    availableSubagents,
  } as unknown as ToolConfiguration;

  return buildSwitchAgentDescription(config);
}

describe("switch_agent tool", () => {
  test("returns ok: true with valid agentId", async () => {
    using tempDir = new TestTempDir("test-switch-agent-tool");
    const config = createTestToolConfig(tempDir.path);
    const tool = createSwitchAgentTool(config);

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          agentId: "plan",
          reason: "needs planning",
          followUp: "Create a plan.",
        },
        mockToolCallOptions
      )
    );

    expect(result).toEqual({
      ok: true,
      agentId: "plan",
    });
  });

  test("handles nullish optional fields", async () => {
    using tempDir = new TestTempDir("test-switch-agent-tool-nullish");
    const config = createTestToolConfig(tempDir.path);
    const tool = createSwitchAgentTool(config);

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          agentId: "exec",
          reason: null,
          followUp: null,
        },
        mockToolCallOptions
      )
    );

    expect(result).toEqual({
      ok: true,
      agentId: "exec",
    });
  });
});

describe("buildSwitchAgentDescription", () => {
  test("includes visible agents", () => {
    const description = buildDescriptionWithAgents([
      createAgentDescriptor("exec", {
        description: "Execution mode",
        uiSelectable: true,
        uiRoutable: false,
      }),
    ]);

    expect(description).toContain("Available agents (use `agentId` parameter):");
    expect(description).toContain("- exec: Execution mode");
  });

  test("includes hidden agents with uiRoutable: true", () => {
    const description = buildDescriptionWithAgents([
      createAgentDescriptor("secret-router", {
        description: "Hidden but routable",
        uiSelectable: false,
        uiRoutable: true,
      }),
    ]);

    expect(description).toContain("Available agents (use `agentId` parameter):");
    expect(description).toContain("- secret-router: Hidden but routable");
  });

  test("excludes hidden agents without uiRoutable", () => {
    const description = buildDescriptionWithAgents([
      createAgentDescriptor("visible", {
        description: "Visible",
        uiSelectable: true,
        uiRoutable: false,
      }),
      createAgentDescriptor("hidden", {
        description: "Hidden",
        uiSelectable: false,
        uiRoutable: false,
      }),
    ]);

    expect(description).toContain("- visible: Visible");
    expect(description).not.toContain("- hidden: Hidden");
  });

  test("returns base description when no routable agents", () => {
    const description = buildDescriptionWithAgents([]);

    expect(description).toBe(TOOL_DEFINITIONS.switch_agent.description);
    expect(description).not.toContain("Available agents (use `agentId` parameter):");
  });
});
