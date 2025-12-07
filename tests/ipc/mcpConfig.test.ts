import * as fs from "fs/promises";
import * as path from "path";
import {
  shouldRunIntegrationTests,
  cleanupTestEnvironment,
  createTestEnvironment,
  setupWorkspace,
  validateApiKeys,
} from "./setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  resolveOrpcClient,
  sendMessageWithModel,
  createStreamCollector,
  assertStreamSuccess,
  extractTextFromEvents,
  HAIKU_MODEL,
} from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

describeIntegration("MCP project configuration", () => {
  test.concurrent("add, list, and remove MCP servers", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    const client = resolveOrpcClient(env);

    try {
      // Register project
      const createResult = await client.projects.create({ projectPath: repoPath });
      expect(createResult.success).toBe(true);

      // Initially empty
      const initial = await client.projects.mcp.list({ projectPath: repoPath });
      expect(initial).toEqual({});

      // Add server
      const addResult = await client.projects.mcp.add({
        projectPath: repoPath,
        name: "chrome-devtools",
        command: "npx chrome-devtools-mcp@latest",
      });
      expect(addResult.success).toBe(true);

      // Should list the added server
      const listed = await client.projects.mcp.list({ projectPath: repoPath });
      expect(listed).toEqual({ "chrome-devtools": "npx chrome-devtools-mcp@latest" });

      // Config file should be written
      const configPath = path.join(repoPath, ".mux", "mcp.jsonc");
      const file = await fs.readFile(configPath, "utf-8");
      expect(JSON.parse(file)).toEqual({
        servers: { "chrome-devtools": "npx chrome-devtools-mcp@latest" },
      });

      // Remove server
      const removeResult = await client.projects.mcp.remove({
        projectPath: repoPath,
        name: "chrome-devtools",
      });
      expect(removeResult.success).toBe(true);

      const finalList = await client.projects.mcp.list({ projectPath: repoPath });
      expect(finalList).toEqual({});
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  });
});

describeIntegration("MCP server integration with model", () => {
  test.concurrent(
    "MCP tools are available to the model",
    async () => {
      console.log("[MCP Test] Setting up workspace...");
      // Setup workspace with Anthropic provider
      const { env, workspaceId, tempGitRepo, cleanup } = await setupWorkspace(
        "anthropic",
        "mcp-memory"
      );
      const client = resolveOrpcClient(env);
      console.log("[MCP Test] Workspace created:", { workspaceId, tempGitRepo });

      try {
        // Add the memory MCP server to the project
        console.log("[MCP Test] Adding MCP server...");
        const addResult = await client.projects.mcp.add({
          projectPath: tempGitRepo,
          name: "memory",
          command: "npx -y @modelcontextprotocol/server-memory",
        });
        expect(addResult.success).toBe(true);
        console.log("[MCP Test] MCP server added");

        // Create stream collector to capture events
        console.log("[MCP Test] Creating stream collector...");
        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        await collector.waitForSubscription();
        console.log("[MCP Test] Stream collector ready");

        // Send a message that should trigger the memory tool
        // The memory server provides: create_entities, create_relations, read_graph, etc.
        console.log("[MCP Test] Sending message...");
        const result = await sendMessageWithModel(
          env,
          workspaceId,
          'Use the create_entities tool from MCP to create an entity with name "TestEntity" and entityType "test" and observations ["integration test"]. Then confirm you did it.',
          HAIKU_MODEL
        );
        console.log("[MCP Test] Message sent, result:", result.success);

        expect(result.success).toBe(true);

        // Wait for stream to complete
        console.log("[MCP Test] Waiting for stream-end...");
        await collector.waitForEvent("stream-end", 60000);
        console.log("[MCP Test] Stream ended");
        assertStreamSuccess(collector);

        // Verify MCP tool was called
        const events = collector.getEvents();
        const toolCallStarts = events.filter(
          (e): e is Extract<typeof e, { type: "tool-call-start" }> => e.type === "tool-call-start"
        );
        console.log(
          "[MCP Test] Tool calls:",
          toolCallStarts.map((e) => e.toolName)
        );

        // Should have at least one tool call
        expect(toolCallStarts.length).toBeGreaterThan(0);

        // Should have called the MCP memory tool (create_entities)
        const mcpToolCall = toolCallStarts.find((e) => e.toolName === "create_entities");
        expect(mcpToolCall).toBeDefined();

        // Verify response mentions the entity was created
        const deltas = collector.getDeltas();
        const responseText = extractTextFromEvents(deltas).toLowerCase();
        expect(responseText).toMatch(/entity|created|testentity/i);

        collector.stop();
      } finally {
        console.log("[MCP Test] Cleaning up...");
        await cleanup();
        console.log("[MCP Test] Done");
      }
    },
    90000
  ); // MCP server startup + tool call can take time
});
