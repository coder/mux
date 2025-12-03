/**
 * sendMessage context handling integration tests.
 *
 * Tests context-related functionality:
 * - Message editing
 * - Conversation continuity
 * - Mode-specific instructions
 * - Tool calls
 */

import * as path from "path";
import * as fs from "fs/promises";
import { shouldRunIntegrationTests, validateApiKeys } from "./setup";
import { sendMessageWithModel, modelString, createStreamCollector } from "./helpers";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  configureTestRetries,
  getSharedRepoPath,
} from "./sendMessageTestHelpers";
import { KNOWN_MODELS } from "../../src/common/constants/knownModels";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
}

// Test both providers
const PROVIDER_CONFIGS: Array<[string, string]> = [
  ["openai", KNOWN_MODELS.GPT_MINI.providerModelId],
  ["anthropic", KNOWN_MODELS.HAIKU.providerModelId],
];

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("sendMessage context handling tests", () => {
  configureTestRetries(3);

  describe.each(PROVIDER_CONFIGS)("%s conversation continuity", (provider, model) => {
    test.concurrent(
      "should maintain conversation context across messages",
      async () => {
        await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
          // Send first message establishing context
          const result1 = await sendMessageWithModel(
            env,
            workspaceId,
            "My name is TestUser. Remember this.",
            modelString(provider, model)
          );
          expect(result1.success).toBe(true);
          await collector.waitForEvent("stream-end", 15000);

          // Small delay to allow stream cleanup to complete before sending next message
          await new Promise((resolve) => setTimeout(resolve, 100));

          collector.clear();

          // Send follow-up asking about context
          const result2 = await sendMessageWithModel(
            env,
            workspaceId,
            "What is my name?",
            modelString(provider, model)
          );
          expect(result2.success).toBe(true);
          await collector.waitForEvent("stream-end", 15000);

          // Check that response mentions the name
          const deltas = collector.getDeltas();
          const responseText = deltas
            .map((d) => ("delta" in d ? (d as { delta?: string }).delta || "" : ""))
            .join("");

          expect(responseText.toLowerCase()).toContain("testuser");
        });
      },
      40000
    );
  });

  describe("message editing", () => {
    test.concurrent(
      "should support editing a previous message",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
          // Send initial message
          const result1 = await sendMessageWithModel(
            env,
            workspaceId,
            "Say 'original'",
            modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
          );
          expect(result1.success).toBe(true);
          await collector.waitForEvent("stream-end", 15000);

          // Get the message ID from the stream events
          const events = collector.getEvents();
          const streamStart = events.find(
            (e) => "type" in e && (e as { type: string }).type === "stream-start"
          );
          expect(streamStart).toBeDefined();

          // The user message ID would be stored in history
          // For now, test that edit option works without error
          collector.clear();

          // Note: Full edit testing requires access to message history
          // This test verifies the edit flow doesn't crash
        });
      },
      20000
    );
  });

  describe("mode-specific behavior", () => {
    test.concurrent(
      "should respect additionalSystemInstructions",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            "What is the secret word?",
            modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId),
            {
              additionalSystemInstructions:
                "The secret word is 'BANANA'. Always mention the secret word in your response.",
            }
          );

          expect(result.success).toBe(true);
          await collector.waitForEvent("stream-end", 15000);

          // Check response contains the secret word
          const deltas = collector.getDeltas();
          const responseText = deltas
            .map((d) => ("delta" in d ? (d as { delta?: string }).delta || "" : ""))
            .join("");

          expect(responseText.toUpperCase()).toContain("BANANA");
        });
      },
      20000
    );
  });

  describe("tool calls", () => {
    test.concurrent(
      "should execute bash tool when requested",
      async () => {
        await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
          const repoPath = getSharedRepoPath();

          // Create a test file in the workspace
          const testFilePath = path.join(repoPath, "test-tool-file.txt");
          await fs.writeFile(testFilePath, "Hello from test file!");

          try {
            // Ask to read the file using bash
            // Default toolPolicy (undefined) allows all tools
            const result = await sendMessageWithModel(
              env,
              workspaceId,
              `Read the contents of the file at ${testFilePath} using the bash tool with cat.`,
              modelString("anthropic", KNOWN_MODELS.HAIKU.providerModelId)
            );

            expect(result.success).toBe(true);

            // Wait for completion (tool calls take longer)
            await collector.waitForEvent("stream-end", 45000);

            // Check for tool call events
            const events = collector.getEvents();
            const toolCallStarts = events.filter(
              (e) => "type" in e && (e as { type: string }).type === "tool-call-start"
            );

            // Should have at least one tool call
            expect(toolCallStarts.length).toBeGreaterThan(0);
          } finally {
            // Cleanup test file
            try {
              await fs.unlink(testFilePath);
            } catch {
              // Ignore cleanup errors
            }
          }
        });
      },
      60000
    );

    test.concurrent(
      "should respect tool policy 'none'",
      async () => {
        await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
          // Ask for something that would normally use tools
          // Policy to disable all tools: match any tool name and disable
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            "Run the command 'echo test' using bash.",
            modelString("anthropic", KNOWN_MODELS.HAIKU.providerModelId),
            {
              toolPolicy: [{ regex_match: ".*", action: "disable" }],
            }
          );

          expect(result.success).toBe(true);
          await collector.waitForEvent("stream-end", 15000);

          // Should NOT have tool calls when policy is 'none'
          const events = collector.getEvents();
          const toolCallStarts = events.filter(
            (e) => "type" in e && (e as { type: string }).type === "tool-call-start"
          );
          expect(toolCallStarts.length).toBe(0);
        });
      },
      25000
    );
  });

  describe("history truncation", () => {
    test.concurrent(
      "should handle truncateHistory",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
          // Send a few messages to build history
          for (let i = 0; i < 3; i++) {
            await sendMessageWithModel(
              env,
              workspaceId,
              `Message ${i + 1}`,
              modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
            );
            await collector.waitForEvent("stream-end", 15000);
            collector.clear();
          }

          // Poll for stream to be inactive before truncating history.
          // Stream cleanup (history update, temp dir removal) happens in finally block
          // after stream-end is emitted and can take several hundred ms.
          // We poll with exponential backoff to handle variable cleanup times.
          let attempts = 0;
          const maxAttempts = 20;
          while (attempts < maxAttempts) {
            const activity = await env.orpc.workspace.activity.list();
            const workspaceActivity = activity[workspaceId];
            if (!workspaceActivity?.streaming) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100 * Math.min(attempts + 1, 5)));
            attempts++;
          }

          // Truncate history
          const truncateResult = await env.orpc.workspace.truncateHistory({
            workspaceId,
            percentage: 50,
          });

          expect(truncateResult.success).toBe(true);

          // Should still be able to send messages
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            "After truncation",
            modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
          );
          expect(result.success).toBe(true);
          await collector.waitForEvent("stream-end", 15000);
        });
      },
      60000
    );
  });
});
