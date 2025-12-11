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
import type { StreamCollector } from "./streamCollector";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Shared types for MCP content parsing
type MediaItem = { type: "media"; data: string; mediaType: string };
type TextItem = { type: "text"; text: string };

function isMediaItem(item: unknown): item is MediaItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    (item as { type: string }).type === "media"
  );
}

function isTextItem(item: unknown): item is TextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    (item as { type: string }).type === "text"
  );
}

/**
 * Assert that a screenshot result has valid media content.
 * Verifies: proper structure, no omitted images, no base64 in text, valid mediaType.
 */
function assertValidScreenshotResult(
  result: unknown,
  allowedMediaTypes?: RegExp
): { mediaItems: MediaItem[]; textItems: TextItem[] } {
  expect(typeof result).toBe("object");
  expect(result).not.toBeNull();
  expect(result).toHaveProperty("type", "content");
  expect(result).toHaveProperty("value");

  const value = (result as { value: unknown[] }).value;
  expect(Array.isArray(value)).toBe(true);

  const mediaItems = value.filter(isMediaItem);
  const textItems = value.filter(isTextItem);

  // No "Image omitted" text
  const hasOmittedImageText = textItems.some((t) => t.text.includes("Image omitted"));
  expect(hasOmittedImageText).toBe(false);

  // Must have at least one media item
  expect(mediaItems.length).toBeGreaterThan(0);

  // Text parts must not contain base64 blobs (would indicate serialization as text)
  const longBase64Pattern = /[A-Za-z0-9+/]{10000,}/;
  for (const t of textItems) {
    expect(t.text.startsWith("data:image")).toBe(false);
    expect(longBase64Pattern.test(t.text)).toBe(false);
  }

  // Validate media items
  const typePattern = allowedMediaTypes ?? /^image\//;
  for (const media of mediaItems) {
    expect(media.mediaType).toBeDefined();
    expect(media.mediaType).toMatch(typePattern);
    expect(media.data).toBeDefined();
    expect(media.data.length).toBeGreaterThan(1000);
  }

  return { mediaItems, textItems };
}

/**
 * Assert that the model response describes example.com content.
 */
function assertModelDescribesScreenshot(collector: StreamCollector): void {
  const deltas = collector.getDeltas();
  const responseText = extractTextFromEvents(deltas).toLowerCase();
  expect(responseText).toContain("example domain");
  expect(responseText.length).toBeGreaterThan(20);
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
      expect(listed).toEqual({
        "chrome-devtools": { command: "npx chrome-devtools-mcp@latest", disabled: false },
      });

      // Config file should be written
      const configPath = path.join(repoPath, ".mux", "mcp.jsonc");
      const file = await fs.readFile(configPath, "utf-8");
      expect(JSON.parse(file)).toEqual({
        servers: { "chrome-devtools": "npx chrome-devtools-mcp@latest" },
      });

      // Disable server
      const disableResult = await client.projects.mcp.setEnabled({
        projectPath: repoPath,
        name: "chrome-devtools",
        enabled: false,
      });
      expect(disableResult.success).toBe(true);

      // Should still be listed but disabled
      const disabledList = await client.projects.mcp.list({ projectPath: repoPath });
      expect(disabledList).toEqual({
        "chrome-devtools": { command: "npx chrome-devtools-mcp@latest", disabled: true },
      });

      // Config file should have disabled format
      const disabledConfig = await fs.readFile(configPath, "utf-8");
      expect(JSON.parse(disabledConfig)).toEqual({
        servers: {
          "chrome-devtools": { command: "npx chrome-devtools-mcp@latest", disabled: true },
        },
      });

      // Re-enable server
      const enableResult = await client.projects.mcp.setEnabled({
        projectPath: repoPath,
        name: "chrome-devtools",
        enabled: true,
      });
      expect(enableResult.success).toBe(true);

      // Should be enabled again, config file back to string format
      const enabledList = await client.projects.mcp.list({ projectPath: repoPath });
      expect(enabledList).toEqual({
        "chrome-devtools": { command: "npx chrome-devtools-mcp@latest", disabled: false },
      });
      const enabledConfig = await fs.readFile(configPath, "utf-8");
      expect(JSON.parse(enabledConfig)).toEqual({
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
  // Test matrix for image format handling
  const imageFormatCases = [
    {
      name: "PNG",
      prompt:
        "You MUST use chrome_navigate_page to go to https://example.com, then MUST use chrome_take_screenshot to capture the page. After taking the screenshot, describe what you see in the image.",
      mediaTypePattern: /^image\//,
    },
    {
      name: "JPEG",
      prompt:
        'You MUST use chrome_navigate_page to go to https://example.com, then MUST use chrome_take_screenshot with format "jpeg" to capture the page. After taking the screenshot, describe what you see in the image.',
      mediaTypePattern: /^image\/(jpeg|jpg|webp)$/,
    },
  ] as const;

  test.concurrent.each(imageFormatCases)(
    "MCP $name image content is correctly transformed to AI SDK format",
    async ({ name, prompt, mediaTypePattern }) => {
      const { env, workspaceId, tempGitRepo, cleanup } = await setupWorkspace(
        "anthropic",
        `mcp-chrome-${name.toLowerCase()}`
      );
      const client = resolveOrpcClient(env);

      try {
        // Add Chrome DevTools MCP server (headless + no-sandbox for CI)
        const addResult = await client.projects.mcp.add({
          projectPath: tempGitRepo,
          name: "chrome",
          command:
            "npx -y chrome-devtools-mcp@latest --headless --isolated --chromeArg='--no-sandbox'",
        });
        expect(addResult.success).toBe(true);

        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        await collector.waitForSubscription();

        const result = await sendMessageWithModel(env, workspaceId, prompt, HAIKU_MODEL);
        expect(result.success).toBe(true);

        await collector.waitForEvent("stream-end", 120000);
        assertStreamSuccess(collector);

        // Find screenshot tool result
        const events = collector.getEvents();
        const toolCallEnds = events.filter(
          (e): e is Extract<typeof e, { type: "tool-call-end" }> => e.type === "tool-call-end"
        );
        const screenshotResult = toolCallEnds.find((e) => e.toolName === "chrome_take_screenshot");

        // Debug: log tool calls if screenshot not found
        if (!screenshotResult) {
          const toolNames = toolCallEnds.map((e) => e.toolName);
          const deltas = collector.getDeltas();
          const responseText = extractTextFromEvents(deltas);
          console.log(`[MCP ${name} Test] Tool calls made:`, toolNames);
          console.log(`[MCP ${name} Test] Model response:`, responseText.slice(0, 500));
        }
        expect(screenshotResult).toBeDefined();

        // Validate result structure and media content
        assertValidScreenshotResult(screenshotResult!.result, mediaTypePattern);
        assertModelDescribesScreenshot(collector);

        collector.stop();
      } finally {
        await cleanup();
      }
    },
    180000
  );

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

        // Should have called the MCP memory tool (namespaced as memory_create_entities)
        const mcpToolCall = toolCallStarts.find((e) => e.toolName === "memory_create_entities");
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
