import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createSwitchAgentTool } from "./switch_agent";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

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
