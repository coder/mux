import * as fs from "fs/promises";
import * as path from "path";
import { shouldRunIntegrationTests, cleanupTestEnvironment, createTestEnvironment } from "./setup";
import { createTempGitRepo, cleanupTempGitRepo, resolveOrpcClient } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

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
