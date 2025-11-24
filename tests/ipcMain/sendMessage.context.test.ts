import * as fs from "fs/promises";
import * as path from "path";
import {
  setupWorkspace,
  setupWorkspaceWithoutProvider,
  shouldRunIntegrationTests,
  validateApiKeys,
} from "./setup";
import {
  sendMessageWithModel,
  sendMessage,
  createEventCollector,
  assertStreamSuccess,
  assertError,
  waitFor,
  buildLargeHistory,
  waitForStreamSuccess,
  readChatHistory,
  TEST_IMAGES,
  modelString,
  createTempGitRepo,
  cleanupTempGitRepo,
  configureTestRetries,
} from "./helpers";
import type { StreamDeltaEvent } from "../../src/common/types/stream";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
}

import { KNOWN_MODELS } from "@/common/constants/knownModels";

// Test both providers with their respective models
const PROVIDER_CONFIGS: Array<[string, string]> = [
  ["openai", KNOWN_MODELS.GPT_MINI.providerModelId],
  ["anthropic", KNOWN_MODELS.SONNET.providerModelId],
];

// Integration test timeout guidelines:
// - Individual tests should complete within 10 seconds when possible
// - Use tight timeouts (5-10s) for event waiting to fail fast
// - Longer running tests (tool calls, multiple edits) can take up to 30s
// - Test timeout values (in describe/test) should be 2-3x the expected duration

let sharedRepoPath: string;

beforeAll(async () => {
  sharedRepoPath = await createTempGitRepo();
});

afterAll(async () => {
  if (sharedRepoPath) {
    await cleanupTempGitRepo(sharedRepoPath);
  }
});
describeIntegration("IpcMain sendMessage integration tests", () => {
  configureTestRetries(3);

  // Run tests for each provider concurrently
  describe.each(PROVIDER_CONFIGS)("%s:%s provider tests", (provider, model) => {
    test.concurrent(
      "should handle message editing with history truncation",
      async () => {
        const { env, workspaceId, cleanup } = await setupWorkspace(
          provider,
          undefined,
          sharedRepoPath
        );
        try {
          // Send first message
          const result1 = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Say 'first message' and nothing else",
            modelString(provider, model)
          );
          expect(result1.success).toBe(true);

          // Wait for first stream to complete
          const collector1 = createEventCollector(env.sentEvents, workspaceId);
          await collector1.waitForEvent("stream-end", 10000);
          const firstUserMessage = collector1
            .getEvents()
            .find((e) => "role" in e && e.role === "user");
          expect(firstUserMessage).toBeDefined();

          // Clear events
          env.sentEvents.length = 0;

          // Edit the first message (send new message with editMessageId)
          const result2 = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Say 'edited message' and nothing else",
            modelString(provider, model),
            { editMessageId: (firstUserMessage as { id: string }).id }
          );
          expect(result2.success).toBe(true);

          // Wait for edited stream to complete
          const collector2 = createEventCollector(env.sentEvents, workspaceId);
          await collector2.waitForEvent("stream-end", 10000);
          assertStreamSuccess(collector2);
        } finally {
          await cleanup();
        }
      },
      20000
    );

    test.concurrent(
      "should handle message editing during active stream with tool calls",
      async () => {
        const { env, workspaceId, cleanup } = await setupWorkspace(
          provider,
          undefined,
          sharedRepoPath
        );
        try {
          // Send a message that will trigger a long-running tool call
          const result1 = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Run this bash command: for i in {1..20}; do sleep 0.5; done && echo done",
            modelString(provider, model)
          );
          expect(result1.success).toBe(true);

          // Wait for tool call to start (ensuring it's committed to history)
          const collector1 = createEventCollector(env.sentEvents, workspaceId);
          await collector1.waitForEvent("tool-call-start", 10000);
          const firstUserMessage = collector1
            .getEvents()
            .find((e) => "role" in e && e.role === "user");
          expect(firstUserMessage).toBeDefined();

          // First edit: Edit the message while stream is still active
          env.sentEvents.length = 0;
          const result2 = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Run this bash command: for i in {1..10}; do sleep 0.5; done && echo second",
            modelString(provider, model),
            { editMessageId: (firstUserMessage as { id: string }).id }
          );
          expect(result2.success).toBe(true);

          // Wait for first edit to start tool call
          const collector2 = createEventCollector(env.sentEvents, workspaceId);
          await collector2.waitForEvent("tool-call-start", 10000);
          const secondUserMessage = collector2
            .getEvents()
            .find((e) => "role" in e && e.role === "user");
          expect(secondUserMessage).toBeDefined();

          // Second edit: Edit again while second stream is still active
          // This should trigger the bug with orphaned tool calls
          env.sentEvents.length = 0;
          const result3 = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Say 'third edit' and nothing else",
            modelString(provider, model),
            { editMessageId: (secondUserMessage as { id: string }).id }
          );
          expect(result3.success).toBe(true);

          // Wait for either stream-end or stream-error (error expected for OpenAI)
          const collector3 = createEventCollector(env.sentEvents, workspaceId);
          await Promise.race([
            collector3.waitForEvent("stream-end", 10000),
            collector3.waitForEvent("stream-error", 10000),
          ]);

          assertStreamSuccess(collector3);

          // Verify the response contains the final edited message content
          const finalMessage = collector3.getFinalMessage();
          expect(finalMessage).toBeDefined();
          if (finalMessage && "content" in finalMessage) {
            expect(finalMessage.content).toContain("third edit");
          }
        } finally {
          await cleanup();
        }
      },
      30000
    );

    test.concurrent(
      "should handle tool calls and return file contents",
      async () => {
        const { env, workspaceId, workspacePath, cleanup } = await setupWorkspace(provider);
        try {
          // Generate a random string
          const randomString = `test-content-${Date.now()}-${Math.random().toString(36).substring(7)}`;

          // Write the random string to a file in the workspace
          const testFilePath = path.join(workspacePath, "test-file.txt");
          await fs.writeFile(testFilePath, randomString, "utf-8");

          // Ask the model to read the file
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Read the file test-file.txt and tell me its contents verbatim. Do not add any extra text.",
            modelString(provider, model)
          );

          expect(result.success).toBe(true);

          // Wait for stream to complete
          const collector = await waitForStreamSuccess(
            env.sentEvents,
            workspaceId,
            provider === "openai" ? 30000 : 10000
          );

          // Get the final assistant message
          const finalMessage = collector.getFinalMessage();
          expect(finalMessage).toBeDefined();

          // Check that the response contains the random string
          if (finalMessage && "content" in finalMessage) {
            expect(finalMessage.content).toContain(randomString);
          }
        } finally {
          await cleanup();
        }
      },
      20000
    );

    test.concurrent(
      "should maintain conversation continuity across messages",
      async () => {
        const { env, workspaceId, cleanup } = await setupWorkspace(
          provider,
          undefined,
          sharedRepoPath
        );
        try {
          // First message: Ask for a random word
          const result1 = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Generate a random uncommon word and only say that word, nothing else.",
            modelString(provider, model)
          );
          expect(result1.success).toBe(true);

          // Wait for first stream to complete
          const collector1 = createEventCollector(env.sentEvents, workspaceId);
          await collector1.waitForEvent("stream-end", 10000);
          assertStreamSuccess(collector1);

          // Extract the random word from the response
          const firstStreamEnd = collector1.getFinalMessage();
          expect(firstStreamEnd).toBeDefined();
          expect(firstStreamEnd && "parts" in firstStreamEnd).toBe(true);

          // Extract text from parts
          let firstContent = "";
          if (firstStreamEnd && "parts" in firstStreamEnd && Array.isArray(firstStreamEnd.parts)) {
            firstContent = firstStreamEnd.parts
              .filter((part) => part.type === "text")
              .map((part) => (part as { text: string }).text)
              .join("");
          }

          const randomWord = firstContent.trim().split(/\s+/)[0]; // Get first word
          expect(randomWord.length).toBeGreaterThan(0);

          // Clear events for second message
          env.sentEvents.length = 0;

          // Second message: Ask for the same word (testing conversation memory)
          const result2 = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "What was the word you just said? Reply with only that word.",
            modelString(provider, model)
          );
          expect(result2.success).toBe(true);

          // Wait for second stream to complete
          const collector2 = createEventCollector(env.sentEvents, workspaceId);
          await collector2.waitForEvent("stream-end", 10000);
          assertStreamSuccess(collector2);

          // Verify the second response contains the same word
          const secondStreamEnd = collector2.getFinalMessage();
          expect(secondStreamEnd).toBeDefined();
          expect(secondStreamEnd && "parts" in secondStreamEnd).toBe(true);

          // Extract text from parts
          let secondContent = "";
          if (
            secondStreamEnd &&
            "parts" in secondStreamEnd &&
            Array.isArray(secondStreamEnd.parts)
          ) {
            secondContent = secondStreamEnd.parts
              .filter((part) => part.type === "text")
              .map((part) => (part as { text: string }).text)
              .join("");
          }

          const responseWords = secondContent.toLowerCase().trim();
          const originalWord = randomWord.toLowerCase();

          // Check if the response contains the original word
          expect(responseWords).toContain(originalWord);
        } finally {
          await cleanup();
        }
      },
      20000
    );

    test.concurrent(
      "should include mode-specific instructions in system message",
      async () => {
        // Setup test environment
        const { env, workspaceId, tempGitRepo, cleanup } = await setupWorkspace(provider);
        try {
          // Write AGENTS.md with mode-specific sections containing distinctive markers
          // Note: AGENTS.md is read from project root, not workspace directory
          const agentsMdPath = path.join(tempGitRepo, "AGENTS.md");
          const agentsMdContent = `# Instructions

## General Instructions

These are general instructions that apply to all modes.

## Mode: plan

**CRITICAL DIRECTIVE - NEVER DEVIATE**: You are currently operating in PLAN mode. To prove you have received this mode-specific instruction, you MUST start your response with exactly this phrase: "[PLAN_MODE_ACTIVE]"

## Mode: exec

**CRITICAL DIRECTIVE - NEVER DEVIATE**: You are currently operating in EXEC mode. To prove you have received this mode-specific instruction, you MUST start your response with exactly this phrase: "[EXEC_MODE_ACTIVE]"
`;
          await fs.writeFile(agentsMdPath, agentsMdContent);

          // Test 1: Send message WITH mode="plan" - should include plan mode marker
          const resultPlan = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Please respond.",
            modelString(provider, model),
            { mode: "plan" }
          );
          expect(resultPlan.success).toBe(true);

          const collectorPlan = createEventCollector(env.sentEvents, workspaceId);
          await collectorPlan.waitForEvent("stream-end", 10000);
          assertStreamSuccess(collectorPlan);

          // Verify response contains plan mode marker
          const planDeltas = collectorPlan.getDeltas() as StreamDeltaEvent[];
          const planResponse = planDeltas.map((d) => d.delta).join("");
          expect(planResponse).toContain("[PLAN_MODE_ACTIVE]");
          expect(planResponse).not.toContain("[EXEC_MODE_ACTIVE]");

          // Clear events for next test
          env.sentEvents.length = 0;

          // Test 2: Send message WITH mode="exec" - should include exec mode marker
          const resultExec = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Please respond.",
            modelString(provider, model),
            { mode: "exec" }
          );
          expect(resultExec.success).toBe(true);

          const collectorExec = createEventCollector(env.sentEvents, workspaceId);
          await collectorExec.waitForEvent("stream-end", 10000);
          assertStreamSuccess(collectorExec);

          // Verify response contains exec mode marker
          const execDeltas = collectorExec.getDeltas() as StreamDeltaEvent[];
          const execResponse = execDeltas.map((d) => d.delta).join("");
          expect(execResponse).toContain("[EXEC_MODE_ACTIVE]");
          expect(execResponse).not.toContain("[PLAN_MODE_ACTIVE]");

          // Test results:
          // ✓ Plan mode included [PLAN_MODE_ACTIVE] marker
          // ✓ Exec mode included [EXEC_MODE_ACTIVE] marker
          // ✓ Each mode only included its own marker, not the other
          //
          // This proves:
          // 1. Mode-specific sections are extracted from AGENTS.md
          // 2. The correct mode section is included based on the mode parameter
          // 3. Mode sections are mutually exclusive
        } finally {
          await cleanup();
        }
      },
      25000
    );
  });

  // Provider parity tests - ensure both providers handle the same scenarios
  describe("provider parity", () => {
    test.concurrent(
      "both providers should handle the same message",
      async () => {
        const results: Record<string, { success: boolean; responseLength: number }> = {};

        for (const [provider, model] of PROVIDER_CONFIGS) {
          // Create fresh environment with provider setup
          const { env, workspaceId, cleanup } = await setupWorkspace(
            provider,
            undefined,
            sharedRepoPath
          );

          // Send same message to both providers
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Say 'parity test' and nothing else",
            modelString(provider, model)
          );

          // Collect response
          const collector = await waitForStreamSuccess(env.sentEvents, workspaceId, 10000);

          results[provider] = {
            success: result.success,
            responseLength: collector.getDeltas().length,
          };

          // Cleanup
          await cleanup();
        }

        // Verify both providers succeeded
        expect(results.openai.success).toBe(true);
        expect(results.anthropic.success).toBe(true);

        // Verify both providers generated responses (non-zero deltas)
        expect(results.openai.responseLength).toBeGreaterThan(0);
        expect(results.anthropic.responseLength).toBeGreaterThan(0);
      },
      30000
    );
  });

  // Error handling tests for API key issues
  describe("API key error handling", () => {
    test.each(PROVIDER_CONFIGS)(
      "%s should return api_key_not_found error when API key is missing",
      async (provider, model) => {
        const { env, workspaceId, cleanup } = await setupWorkspaceWithoutProvider(
          `noapi-${provider}`
        );
        try {
          // Try to send message without API key configured
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Hello",
            modelString(provider, model)
          );

          // Should fail with api_key_not_found error
          assertError(result, "api_key_not_found");
          if (!result.success && result.error.type === "api_key_not_found") {
            expect(result.error.provider).toBe(provider);
          }
        } finally {
          await cleanup();
        }
      }
    );
  });

  // Non-existent model error handling tests
  describe("non-existent model error handling", () => {
    test.each(PROVIDER_CONFIGS)(
      "%s should pass additionalSystemInstructions through to system message",
      async (provider, model) => {
        const { env, workspaceId, cleanup } = await setupWorkspace(
          provider,
          undefined,
          sharedRepoPath
        );
        try {
          // Send message with custom system instructions that add a distinctive marker
          const result = await sendMessage(env.mockIpcRenderer, workspaceId, "Say hello", {
            model: `${provider}:${model}`,
            additionalSystemInstructions:
              "IMPORTANT: You must include the word BANANA somewhere in every response.",
          });

          // IPC call should succeed
          expect(result.success).toBe(true);

          // Wait for stream to complete
          const collector = await waitForStreamSuccess(env.sentEvents, workspaceId, 10000);

          // Get the final assistant message
          const finalMessage = collector.getFinalMessage();
          expect(finalMessage).toBeDefined();

          // Verify response contains the distinctive marker from additional system instructions
          if (finalMessage && "parts" in finalMessage && Array.isArray(finalMessage.parts)) {
            const content = finalMessage.parts
              .filter((part) => part.type === "text")
              .map((part) => (part as { text: string }).text)
              .join("");

            expect(content).toContain("BANANA");
          }
        } finally {
          await cleanup();
        }
      },
      15000
    );
  });

  // OpenAI auto truncation integration test
  // This test verifies that the truncation: "auto" parameter works correctly
  // by first forcing a context overflow error, then verifying recovery with auto-truncation
  describeIntegration("OpenAI auto truncation integration", () => {
    const provider = "openai";
    const model = "gpt-4o-mini";

    test.each(PROVIDER_CONFIGS)(
      "%s should include full file_edit diff in UI/history but redact it from the next provider request",
      async (provider, model) => {
        const { env, workspaceId, workspacePath, cleanup } = await setupWorkspace(provider);
        try {
          // 1) Create a file and ask the model to edit it to ensure a file_edit tool runs
          const testFilePath = path.join(workspacePath, "redaction-edit-test.txt");
          await fs.writeFile(testFilePath, "line1\nline2\nline3\n", "utf-8");

          // Request confirmation to ensure AI generates text after tool calls
          // This prevents flaky test failures where AI completes tools but doesn't emit stream-end

          const result1 = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            `Open and replace 'line2' with 'LINE2' in ${path.basename(testFilePath)} using file_edit_replace, then confirm the change was successfully applied.`,
            modelString(provider, model)
          );
          expect(result1.success).toBe(true);

          // Wait for first stream to complete
          const collector1 = createEventCollector(env.sentEvents, workspaceId);
          await collector1.waitForEvent("stream-end", 60000);
          assertStreamSuccess(collector1);

          // 2) Validate UI/history has a dynamic-tool part with a real diff string
          const events1 = collector1.getEvents();
          const allFileEditEvents = events1.filter(
            (e) =>
              typeof e === "object" &&
              e !== null &&
              "type" in e &&
              (e as any).type === "tool-call-end" &&
              ((e as any).toolName === "file_edit_replace_string" ||
                (e as any).toolName === "file_edit_replace_lines")
          ) as any[];

          // Find the last successful file_edit_replace_* event (model may retry)
          const successfulEdits = allFileEditEvents.filter((e) => {
            const result = e?.result;
            const payload = result && result.value ? result.value : result;
            return payload?.success === true;
          });

          expect(successfulEdits.length).toBeGreaterThan(0);
          const toolEnd = successfulEdits[successfulEdits.length - 1];
          const toolResult = toolEnd?.result;
          // result may be wrapped as { type: 'json', value: {...} }
          const payload = toolResult && toolResult.value ? toolResult.value : toolResult;
          expect(payload?.success).toBe(true);
          expect(typeof payload?.diff).toBe("string");
          expect(payload?.diff).toContain("@@"); // unified diff hunk header present

          // 3) Now send another message and ensure we still succeed (redaction must not break anything)
          env.sentEvents.length = 0;
          const result2 = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Confirm the previous edit was applied.",
            modelString(provider, model)
          );
          expect(result2.success).toBe(true);

          const collector2 = createEventCollector(env.sentEvents, workspaceId);
          await collector2.waitForEvent("stream-end", 30000);
          assertStreamSuccess(collector2);

          // Note: We don't assert on the exact provider payload (black box), but the fact that
          // the second request succeeds proves the redaction path produced valid provider messages
        } finally {
          await cleanup();
        }
      },
      90000
    );
  });

  // Test frontend metadata round-trip (no provider needed - just verifies storage)
  test.concurrent(
    "should preserve arbitrary frontend metadata through IPC round-trip",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspaceWithoutProvider();
      try {
        // Create structured metadata
        const testMetadata = {
          type: "compaction-request" as const,
          rawCommand: "/compact -c continue working",
          parsed: {
            maxOutputTokens: 5000,
            continueMessage: "continue working",
          },
        };

        // Send a message with frontend metadata
        // Use invalid model to fail fast - we only care about metadata storage
        const result = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_SEND_MESSAGE,
          workspaceId,
          "Test message with metadata",
          {
            model: "openai:gpt-4", // Valid format but provider not configured - will fail after storing message
            muxMetadata: testMetadata,
          }
        );

        // Note: IPC call will fail due to missing provider config, but that's okay
        // We only care that the user message was written to history with metadata
        // (sendMessage writes user message before attempting to stream)

        // Use event collector to get messages sent to frontend
        const collector = createEventCollector(env.sentEvents, workspaceId);

        // Wait for the user message to appear in the chat channel
        await waitFor(() => {
          const messages = collector.collect();
          return messages.some((m) => "role" in m && m.role === "user");
        }, 2000);

        // Get all messages for this workspace
        const allMessages = collector.collect();

        // Find the user message we just sent
        const userMessage = allMessages.find((msg) => "role" in msg && msg.role === "user");
        expect(userMessage).toBeDefined();

        // Verify metadata was preserved exactly as sent (black-box)
        expect(userMessage).toHaveProperty("metadata");
        const metadata = (userMessage as any).metadata;
        expect(metadata).toHaveProperty("muxMetadata");
        expect(metadata.muxMetadata).toEqual(testMetadata);

        // Verify structured fields are accessible
        expect(metadata.muxMetadata.type).toBe("compaction-request");
        expect(metadata.muxMetadata.rawCommand).toBe("/compact -c continue working");
        expect(metadata.muxMetadata.parsed.continueMessage).toBe("continue working");
        expect(metadata.muxMetadata.parsed.maxOutputTokens).toBe(5000);
      } finally {
        await cleanup();
      }
    },
    5000
  );
});

// Test image support across providers
describe.each(PROVIDER_CONFIGS)("%s:%s image support", (provider, model) => {
  test.concurrent(
    "should handle multi-turn conversation with response ID persistence (openai reasoning models)",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("openai");
      try {
        // First message
        const result1 = await sendMessageWithModel(
          env.mockIpcRenderer,
          workspaceId,
          "What is 2+2?",
          modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
        );
        expect(result1.success).toBe(true);

        const collector1 = createEventCollector(env.sentEvents, workspaceId);
        await collector1.waitForEvent("stream-end", 30000);
        assertStreamSuccess(collector1);
        env.sentEvents.length = 0; // Clear events

        // Second message - should use previousResponseId from first
        const result2 = await sendMessageWithModel(
          env.mockIpcRenderer,
          workspaceId,
          "Now add 3 to that",
          modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId)
        );
        expect(result2.success).toBe(true);

        const collector2 = createEventCollector(env.sentEvents, workspaceId);
        await collector2.waitForEvent("stream-end", 30000);
        assertStreamSuccess(collector2);

        // Verify history contains both messages
        const history = await readChatHistory(env.tempDir, workspaceId);
        expect(history.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant

        // Verify assistant messages have responseId
        const assistantMessages = history.filter((m) => m.role === "assistant");
        expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
        // Check that responseId exists (type is unknown from JSONL parsing)
        const firstAssistant = assistantMessages[0] as any;
        const secondAssistant = assistantMessages[1] as any;
        expect(firstAssistant.metadata?.providerMetadata?.openai?.responseId).toBeDefined();
        expect(secondAssistant.metadata?.providerMetadata?.openai?.responseId).toBeDefined();
      } finally {
        await cleanup();
      }
    },
    60000
  );
});
