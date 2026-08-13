import { describe, expect, mock, test } from "bun:test";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { createAgentSessionHarness } from "@/node/services/agentSession.testHarness";

function promptMetadata() {
  return {
    type: "normal" as const,
    rawCommand: "/mcp__coder__review src",
    commandPrefix: "/mcp__coder__review",
    mcpPromptRefs: [
      {
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
        source: "slash" as const,
        arguments: { path: "src" },
      },
    ],
  };
}

describe("AgentSession MCP prompt snapshots", () => {
  test("persists the materialized prompt before the user row", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({ text: "Expanded prompt", description: "Review code" })
    );
    const harness = await createAgentSessionHarness({
      workspaceId: "workspace",
      mcpServerManager: { getPrompt } as unknown as MCPServerManager,
    });

    try {
      const result = await harness.session.sendMessage("Using MCP prompt coder/review: src", {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
        muxMetadata: promptMetadata(),
      });
      expect(result.success).toBe(true);

      const history = await harness.historyService.getLastMessages("workspace", 10);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data).toHaveLength(2);
      expect(history.data[0]?.metadata?.mcpPromptSnapshot).toEqual({
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
        description: "Review code",
      });
      expect(history.data[0]?.parts.find((part) => part.type === "text")?.text).toBe(
        "Expanded prompt"
      );
      expect(getPrompt).toHaveBeenCalledWith("workspace", "coder", "review", { path: "src" });
    } finally {
      harness.session.dispose();
      await harness.cleanup();
    }
  });

  test("drops failed prompt refs without blocking the user message", async () => {
    const harness = await createAgentSessionHarness({
      workspaceId: "workspace",
      mcpServerManager: {
        getPrompt: mock(() => Promise.reject(new Error("server unavailable"))),
      } as unknown as MCPServerManager,
    });

    try {
      const result = await harness.session.sendMessage("Using MCP prompt coder/review: src", {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
        muxMetadata: promptMetadata(),
      });
      expect(result.success).toBe(true);

      const history = await harness.historyService.getLastMessages("workspace", 10);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data).toHaveLength(1);
      expect(history.data[0]?.metadata?.mcpPromptSnapshot).toBeUndefined();
    } finally {
      harness.session.dispose();
      await harness.cleanup();
    }
  });
});
