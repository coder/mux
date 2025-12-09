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
    "MCP image content is correctly transformed to AI SDK format",
    async () => {
      console.log("[MCP Image Test] Setting up workspace...");
      // Setup workspace with Anthropic provider
      const { env, workspaceId, tempGitRepo, cleanup } = await setupWorkspace(
        "anthropic",
        "mcp-chrome"
      );
      const client = resolveOrpcClient(env);
      console.log("[MCP Image Test] Workspace created:", { workspaceId, tempGitRepo });

      try {
        // Add the Chrome DevTools MCP server to the project
        // Use --headless and --no-sandbox for CI/root environments
        console.log("[MCP Image Test] Adding Chrome DevTools MCP server...");
        const addResult = await client.projects.mcp.add({
          projectPath: tempGitRepo,
          name: "chrome",
          command:
            "npx -y chrome-devtools-mcp@latest --headless --isolated --chromeArg='--no-sandbox'",
        });
        expect(addResult.success).toBe(true);
        console.log("[MCP Image Test] MCP server added");

        // Create stream collector to capture events
        console.log("[MCP Image Test] Creating stream collector...");
        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        await collector.waitForSubscription();
        console.log("[MCP Image Test] Stream collector ready");

        // Send a message that should trigger screenshot
        // First navigate to a simple page, then take a screenshot
        console.log("[MCP Image Test] Sending message...");
        const result = await sendMessageWithModel(
          env,
          workspaceId,
          "Navigate to https://example.com and take a screenshot. Describe what you see in the screenshot.",
          HAIKU_MODEL
        );
        console.log("[MCP Image Test] Message sent, result:", result.success);

        expect(result.success).toBe(true);

        // Wait for stream to complete (this may take a while with Chrome)
        console.log("[MCP Image Test] Waiting for stream-end...");
        await collector.waitForEvent("stream-end", 120000); // 2 minutes for Chrome operations
        console.log("[MCP Image Test] Stream ended");
        assertStreamSuccess(collector);

        // Find the screenshot tool call and its result
        const events = collector.getEvents();
        const toolCallEnds = events.filter(
          (e): e is Extract<typeof e, { type: "tool-call-end" }> => e.type === "tool-call-end"
        );
        console.log(
          "[MCP Image Test] Tool call ends:",
          toolCallEnds.map((e) => ({ toolName: e.toolName, resultType: typeof e.result }))
        );

        // Find the screenshot tool result (namespaced as chrome_take_screenshot)
        const screenshotResult = toolCallEnds.find((e) => e.toolName === "chrome_take_screenshot");
        expect(screenshotResult).toBeDefined();

        // Verify the result has correct AI SDK format with mediaType
        const result_output = screenshotResult!.result as
          | { type: string; value: unknown[] }
          | unknown;
        // Log media items to verify mediaType presence
        if (
          typeof result_output === "object" &&
          result_output !== null &&
          "value" in result_output
        ) {
          const value = (result_output as { value: unknown[] }).value;
          const mediaPreview = value
            .filter(
              (v): v is object =>
                typeof v === "object" &&
                v !== null &&
                "type" in v &&
                (v as { type: string }).type === "media"
            )
            .map((m) => ({
              type: (m as { type: string }).type,
              mediaType: (m as { mediaType?: string }).mediaType,
              dataLen: ((m as { data?: string }).data || "").length,
            }));
          console.log("[MCP Image Test] Media items:", JSON.stringify(mediaPreview));
        }

        // If it's properly transformed, it should have { type: "content", value: [...] }
        if (
          typeof result_output === "object" &&
          result_output !== null &&
          "type" in result_output
        ) {
          const typedResult = result_output as { type: string; value: unknown[] };
          expect(typedResult.type).toBe("content");
          expect(Array.isArray(typedResult.value)).toBe(true);

          // Check for media content with mediaType
          const mediaItems = typedResult.value.filter(
            (item): item is { type: "media"; data: string; mediaType: string } =>
              typeof item === "object" &&
              item !== null &&
              "type" in item &&
              (item as { type: string }).type === "media"
          );

          const textItems = typedResult.value.filter(
            (item): item is { type: "text"; text: string } =>
              typeof item === "object" &&
              item !== null &&
              "type" in item &&
              (item as { type: string }).type === "text"
          );

          const hasOmittedImageText = textItems.some((t) => t.text.includes("Image omitted"));

          expect(hasOmittedImageText).toBe(false);
          expect(mediaItems.length).toBeGreaterThan(0);

          // Ensure no text part contains a data URI or a large base64 blob
          const longBase64Pattern = /[A-Za-z0-9+/]{10000,}/;
          textItems.forEach((t) => {
            expect(t.text.startsWith("data:image")).toBe(false);
            expect(longBase64Pattern.test(t.text)).toBe(false);
          });

          // Verify media format and size
          for (const media of mediaItems) {
            expect(media.mediaType).toBeDefined();
            expect(media.mediaType).toMatch(/^image\//);
            expect(media.data).toBeDefined();
            expect(media.data.length).toBeGreaterThan(1000); // Should have actual image data
          }

          // Log which path we took for debugging
          console.log("[MCP Image Test] Result:", {
            mediaCount: mediaItems.length,
            textCount: textItems.length,
          });
        }

        // Verify model's response - should describe the screenshot content
        const deltas = collector.getDeltas();
        const responseText = extractTextFromEvents(deltas).toLowerCase();
        console.log("[MCP Image Test] Response text preview:", responseText.slice(0, 200));
        const expectedKeywords = ["example domain"];
        const matchedKeyword = expectedKeywords.some((k) => responseText.includes(k));
        expect(matchedKeyword).toBe(true);
        expect(responseText.length).toBeGreaterThan(20); // Model should say something non-trivial

        collector.stop();
      } finally {
        console.log("[MCP Image Test] Cleaning up...");
        await cleanup();
        console.log("[MCP Image Test] Done");
      }
    },
    180000
  );

  test.concurrent(
    "MCP JPEG image content is correctly transformed to AI SDK format",
    async () => {
      console.log("[MCP JPEG Image Test] Setting up workspace...");
      // Setup workspace with Anthropic provider
      const { env, workspaceId, tempGitRepo, cleanup } = await setupWorkspace(
        "anthropic",
        "mcp-chrome-jpeg"
      );
      const client = resolveOrpcClient(env);
      console.log("[MCP JPEG Image Test] Workspace created:", { workspaceId, tempGitRepo });

      try {
        // Add the Chrome DevTools MCP server to the project with same settings
        console.log("[MCP JPEG Image Test] Adding Chrome DevTools MCP server...");
        const addResult = await client.projects.mcp.add({
          projectPath: tempGitRepo,
          name: "chrome",
          command:
            "npx -y chrome-devtools-mcp@latest --headless --isolated --chromeArg='--no-sandbox'",
        });
        expect(addResult.success).toBe(true);
        console.log("[MCP JPEG Image Test] MCP server added");

        // Create stream collector to capture events
        console.log("[MCP JPEG Image Test] Creating stream collector...");
        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        await collector.waitForSubscription();
        console.log("[MCP JPEG Image Test] Stream collector ready");

        // Send a message that should trigger JPEG screenshot
        console.log("[MCP JPEG Image Test] Sending message...");
        const result = await sendMessageWithModel(
          env,
          workspaceId,
          'Navigate to https://example.com and take a screenshot in JPEG format (use format: "jpeg"). Describe what you see in the screenshot.',
          HAIKU_MODEL
        );
        console.log("[MCP JPEG Image Test] Message sent, result:", result.success);

        expect(result.success).toBe(true);

        // Wait for stream to complete (Chrome may take time)
        console.log("[MCP JPEG Image Test] Waiting for stream-end...");
        await collector.waitForEvent("stream-end", 120000);
        console.log("[MCP JPEG Image Test] Stream ended");
        assertStreamSuccess(collector);

        // Find the screenshot tool call and its result
        const events = collector.getEvents();
        const toolCallEnds = events.filter(
          (e): e is Extract<typeof e, { type: "tool-call-end" }> => e.type === "tool-call-end"
        );
        console.log(
          "[MCP JPEG Image Test] Tool call ends:",
          toolCallEnds.map((e) => ({ toolName: e.toolName, resultType: typeof e.result }))
        );

        const screenshotResult = toolCallEnds.find((e) => e.toolName === "chrome_take_screenshot");
        expect(screenshotResult).toBeDefined();

        const result_output = screenshotResult!.result as
          | { type: string; value: unknown[] }
          | unknown;

        if (
          typeof result_output === "object" &&
          result_output !== null &&
          "value" in result_output
        ) {
          const value = (result_output as { value: unknown[] }).value;
          const mediaItems = value.filter(
            (item): item is { type: "media"; data: string; mediaType: string } =>
              typeof item === "object" &&
              item !== null &&
              "type" in item &&
              (item as { type: string }).type === "media"
          );

          const textItems = value.filter(
            (item): item is { type: "text"; text: string } =>
              typeof item === "object" &&
              item !== null &&
              "type" in item &&
              (item as { type: string }).type === "text"
          );

          const hasOmittedImageText = textItems.some((t) => t.text.includes("Image omitted"));
          expect(hasOmittedImageText).toBe(false);
          expect(mediaItems.length).toBeGreaterThan(0);

          // Ensure no text part contains a data URI or a large base64 blob
          const longBase64Pattern = /[A-Za-z0-9+/]{10000,}/;
          textItems.forEach((t) => {
            expect(t.text.startsWith("data:image")).toBe(false);
            expect(longBase64Pattern.test(t.text)).toBe(false);
          });

          for (const media of mediaItems) {
            expect(media.mediaType).toBeDefined();
            expect(media.mediaType).toMatch(/^image\//);
            // Prefer JPEG, but allow WebP if the server re-encodes; still verify presence
            expect(["image/jpeg", "image/jpg", "image/webp"]).toContain(media.mediaType);
            expect(media.data).toBeDefined();
            expect(media.data.length).toBeGreaterThan(1000);
          }

          console.log("[MCP JPEG Image Test] Result:", {
            mediaCount: mediaItems.length,
            textCount: textItems.length,
            mediaTypes: mediaItems.map((m) => m.mediaType),
          });
        }

        // Verify model response is non-trivial and reflects the screenshot
        const deltas = collector.getDeltas();
        const responseText = extractTextFromEvents(deltas).toLowerCase();
        console.log("[MCP JPEG Image Test] Response text preview:", responseText.slice(0, 200));
        const expectedKeywords = ["example domain"];
        const matchedKeyword = expectedKeywords.some((k) => responseText.includes(k));
        expect(matchedKeyword).toBe(true);
        expect(responseText.length).toBeGreaterThan(20);

        collector.stop();
      } finally {
        console.log("[MCP JPEG Image Test] Cleaning up...");
        await cleanup();
        console.log("[MCP JPEG Image Test] Done");
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
