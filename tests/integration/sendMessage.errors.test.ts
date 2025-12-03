/**
 * sendMessage error handling integration tests.
 *
 * Tests error scenarios:
 * - Empty messages
 * - Missing/invalid models
 * - API key errors
 * - Stream errors
 */

import {
  shouldRunIntegrationTests,
  validateApiKeys,
  createTestEnvironment,
  cleanupTestEnvironment,
} from "./setup";
import { sendMessage, sendMessageWithModel, modelString, generateBranchName } from "./helpers";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  configureTestRetries,
  getSharedRepoPath,
} from "./sendMessageTestHelpers";
import { KNOWN_MODELS } from "../../src/common/constants/knownModels";
import { detectDefaultTrunkBranch } from "../../src/node/git";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
}

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("sendMessage error handling tests", () => {
  configureTestRetries(3);

  describe("validation errors", () => {
    test.concurrent(
      "should reject empty message",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId }) => {
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            "", // Empty message
            modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
          );

          // Should fail with validation error
          expect(result.success).toBe(false);
        });
      },
      15000
    );

    test.concurrent(
      "should reject whitespace-only message",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId }) => {
          const result = await sendMessageWithModel(
            env,
            workspaceId,
            "   \n\t  ", // Whitespace only
            modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
          );

          // Should fail with validation error
          expect(result.success).toBe(false);
        });
      },
      15000
    );
  });

  describe("model errors", () => {
    test.concurrent(
      "should fail with invalid model format",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId }) => {
          const result = await sendMessage(env, workspaceId, "Hello", {
            model: "invalid-model-without-provider",
          });

          expect(result.success).toBe(false);
          if (!result.success) {
            // Should indicate invalid model
            expect(result.error.type).toBeDefined();
          }
        });
      },
      15000
    );

    test.concurrent(
      "should fail with non-existent model",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
          // sendMessage always returns success (errors come through stream events)
          const result = await sendMessage(env, workspaceId, "Hello", {
            model: "openai:gpt-does-not-exist-12345",
          });

          expect(result.success).toBe(true);

          // Wait for stream-error event (API error for invalid model)
          const errorEvent = await collector.waitForEvent("stream-error", 10000);
          expect(errorEvent).toBeDefined();
          if (errorEvent?.type === "stream-error") {
            expect(errorEvent.error).toBeDefined();
            // OpenAI returns error containing model name when model doesn't exist
            expect(errorEvent.error.toLowerCase()).toMatch(/model|does not exist|not found/);
          }
        });
      },
      15000
    );

    test.concurrent(
      "should fail with non-existent provider",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId }) => {
          const result = await sendMessage(env, workspaceId, "Hello", {
            model: "fakeprovider:some-model",
          });

          expect(result.success).toBe(false);
        });
      },
      15000
    );
  });

  describe("API key errors", () => {
    // Not using test.concurrent - this test needs a fresh environment to avoid
    // provider config pollution from other tests that called setupProviders
    test("should fail when provider API key is not configured", async () => {
      // Temporarily unset OPENAI_API_KEY to test missing API key behavior
      const savedApiKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      // Use a FRESH environment (not shared) to avoid pollution from other tests
      // that configured providers via setupProviders(). The shared env would have
      // the OpenAI API key stored in provider config, bypassing the env var check.
      const env = await createTestEnvironment();
      const projectPath = getSharedRepoPath();
      const branchName = generateBranchName("test-no-api-key");
      const trunkBranch = await detectDefaultTrunkBranch(projectPath);

      const createResult = await env.orpc.workspace.create({
        projectPath,
        branchName,
        trunkBranch,
      });

      if (!createResult.success) {
        throw new Error(`Failed to create workspace: ${createResult.error}`);
      }

      const workspaceId = createResult.metadata.id;

      try {
        const result = await sendMessage(env, workspaceId, "Hello", {
          model: modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId),
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.type).toBe("api_key_not_found");
        }
      } finally {
        // Cleanup
        await env.orpc.workspace.remove({ workspaceId });
        await cleanupTestEnvironment(env);

        // Restore the API key
        if (savedApiKey !== undefined) {
          process.env.OPENAI_API_KEY = savedApiKey;
        }
      }
    }, 15000);
  });

  describe("stream error recovery", () => {
    test.concurrent(
      "should handle stream interruption gracefully",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
          // Start a long-running request
          void sendMessageWithModel(
            env,
            workspaceId,
            "Write a 500 word essay about technology.",
            modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
          );

          // Wait for stream to start
          await collector.waitForEvent("stream-start", 10000);

          // Interrupt
          await env.orpc.workspace.interruptStream({ workspaceId });

          // Should get stream-abort, not an error
          const abortEvent = await collector.waitForEvent("stream-abort", 5000);
          expect(abortEvent).toBeDefined();

          // Should be able to send another message after interruption
          collector.clear();

          const result = await sendMessageWithModel(
            env,
            workspaceId,
            "Say 'recovered'",
            modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
          );
          expect(result.success).toBe(true);

          await collector.waitForEvent("stream-end", 15000);
        });
      },
      30000
    );
  });

  describe("concurrent message handling", () => {
    test.concurrent(
      "should queue messages sent while streaming",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
          // Start first message
          void sendMessageWithModel(
            env,
            workspaceId,
            "Count from 1 to 10 slowly.",
            modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
          );

          // Wait for stream to start
          await collector.waitForEvent("stream-start", 10000);

          // Send second message while first is streaming (should be queued)
          const result2 = await sendMessageWithModel(
            env,
            workspaceId,
            "Say 'queued'",
            modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
          );

          // Second message should succeed (be queued)
          expect(result2.success).toBe(true);

          // Interrupt first to let queue process
          await env.orpc.workspace.interruptStream({ workspaceId });
          await collector.waitForEvent("stream-abort", 5000);

          // Clear queue so we can test fresh
          await env.orpc.workspace.clearQueue({ workspaceId });
        });
      },
      30000
    );
  });
});
