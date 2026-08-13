import * as path from "node:path";
import { shouldRunIntegrationTests, setupWorkspaceWithoutProvider } from "../setup";
import { HAIKU_MODEL, readChatHistory, resolveOrpcClient, sendMessageWithModel } from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;
const MCP_SERVER_COMMAND = `node "${path.join(__dirname, "..", "fixtures", "mcp-screenshot-server.js")}"`;

describeIntegration("MCP prompts", () => {
  test("lists and materializes prompts through workspace IPC", async () => {
    const { env, workspaceId, cleanup } = await setupWorkspaceWithoutProvider("mcp-prompts");
    env.services.aiService.enableMockMode();
    const client = resolveOrpcClient(env);

    try {
      const addResult = await client.mcp.add({
        name: "prompt server",
        command: MCP_SERVER_COMMAND,
      });
      expect(addResult.success).toBe(true);

      const prompts = await client.workspace.mcp.prompts.list({ workspaceId });
      expect(prompts).toContainEqual({
        commandKey: "mcp__prompt_server__review",
        serverName: "prompt server",
        promptName: "review",
        description: "Build a deterministic review prompt for tests.",
        arguments: [
          { name: "path", description: "Path to review", required: true },
          { name: "focus", description: "Optional review focus", required: false },
        ],
      });

      const sendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "Using MCP prompt prompt server/review: src security",
        HAIKU_MODEL,
        {
          agentId: "exec",
          muxMetadata: {
            type: "normal",
            rawCommand: "/mcp__prompt_server__review src security",
            commandPrefix: "/mcp__prompt_server__review",
            mcpPromptRefs: [
              {
                serverName: "prompt server",
                promptName: "review",
                commandKey: "mcp__prompt_server__review",
                source: "slash",
                arguments: { path: "src", focus: "security" },
              },
            ],
          },
        }
      );
      expect(sendResult.success).toBe(true);

      const history = await readChatHistory(env.tempDir, workspaceId);
      const snapshot = history.find((message) => {
        const metadata = (message as { metadata?: Record<string, unknown> }).metadata;
        return metadata?.mcpPromptSnapshot !== undefined;
      });
      expect(snapshot?.parts.find((part) => part.type === "text")?.text).toBe(
        "Review src with focus on security"
      );
    } finally {
      await cleanup();
    }
  }, 60_000);
});
