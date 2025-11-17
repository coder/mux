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

describeIntegration("IpcMain sendMessage integration tests", () => {
  // Enable retries in CI for flaky API tests (only works with Jest, not Bun test runner)
  if (process.env.CI && typeof jest !== "undefined" && jest.retryTimes) {
    jest.retryTimes(3, { logErrorsBeforeRetry: true });
  }

  // Run tests for each provider concurrently
  describe.each(PROVIDER_CONFIGS)("%s:%s provider tests", (provider, model) => {
    test.concurrent(
      "should successfully send message and receive response",
      async () => {
        // Setup test environment
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
        try {
          // Send a simple message
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Say 'hello' and nothing else",
            modelString(provider, model)
          );

          // Verify the IPC call succeeded
          expect(result.success).toBe(true);

          // Collect and verify stream events
          const collector = createEventCollector(env.sentEvents, workspaceId);
          const streamEnd = await collector.waitForEvent("stream-end");

          expect(streamEnd).toBeDefined();
          assertStreamSuccess(collector);

          // Verify we received deltas
          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);
        } finally {
          await cleanup();
        }
      },
      15000
    );

    test.concurrent(
      "should interrupt streaming with interruptStream()",
      async () => {
        // Setup test environment
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
        try {
          // Start a long-running stream with a bash command that takes time
          const longMessage = "Run this bash command: while true; do sleep 1; done";
          void sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            longMessage,
            modelString(provider, model)
          );

          // Wait for stream to start
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await collector.waitForEvent("stream-start", 5000);

          // Use interruptStream() to interrupt
          const interruptResult = await env.mockIpcRenderer.invoke(
            IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM,
            workspaceId
          );

          // Should succeed (interrupt is not an error)
          expect(interruptResult.success).toBe(true);

          // Wait for abort or end event
          const abortOrEndReceived = await waitFor(() => {
            collector.collect();
            const hasAbort = collector
              .getEvents()
              .some((e) => "type" in e && e.type === "stream-abort");
            const hasEnd = collector.hasStreamEnd();
            return hasAbort || hasEnd;
          }, 5000);

          expect(abortOrEndReceived).toBe(true);
        } finally {
          await cleanup();
        }
      },
      15000
    );

    test.concurrent(
      "should interrupt stream with pending bash tool call near-instantly",
      async () => {
        // Setup test environment
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
        try {
          // Ask the model to run a long-running bash command
          // Use explicit instruction to ensure tool call happens
          const message = "Use the bash tool to run: sleep 60";
          void sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            message,
            modelString(provider, model)
          );

          // Wait for stream to start (more reliable than waiting for tool-call-start)
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await collector.waitForEvent("stream-start", 10000);

          // Give model time to start calling the tool (sleep command should be in progress)
          // This ensures we're actually interrupting a running command
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Record interrupt time
          const interruptStartTime = performance.now();

          // Interrupt the stream
          const interruptResult = await env.mockIpcRenderer.invoke(
            IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM,
            workspaceId
          );

          const interruptDuration = performance.now() - interruptStartTime;

          // Should succeed
          expect(interruptResult.success).toBe(true);

          // Interrupt should complete near-instantly (< 2 seconds)
          // This validates that we don't wait for the sleep 60 command to finish
          expect(interruptDuration).toBeLessThan(2000);

          // Wait for abort event
          const abortOrEndReceived = await waitFor(() => {
            collector.collect();
            const hasAbort = collector
              .getEvents()
              .some((e) => "type" in e && e.type === "stream-abort");
            const hasEnd = collector.hasStreamEnd();
            return hasAbort || hasEnd;
          }, 5000);

          expect(abortOrEndReceived).toBe(true);
        } finally {
          await cleanup();
        }
      },
      25000
    );

    test.concurrent(
      "should include tokens and timestamp in delta events",
      async () => {
        // Setup test environment
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
        try {
          // Send a message that will generate text deltas
          // Disable reasoning for this test to avoid flakiness and encrypted content issues in CI
          void sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Write a short paragraph about TypeScript",
            modelString(provider, model),
            { thinkingLevel: "off" }
          );

          // Wait for stream to start
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await collector.waitForEvent("stream-start", 5000);

          // Wait for first delta event
          const deltaEvent = await collector.waitForEvent("stream-delta", 5000);
          expect(deltaEvent).toBeDefined();

          // Verify delta event has tokens and timestamp
          if (deltaEvent && "type" in deltaEvent && deltaEvent.type === "stream-delta") {
            expect("tokens" in deltaEvent).toBe(true);
            expect("timestamp" in deltaEvent).toBe(true);
            expect("delta" in deltaEvent).toBe(true);

            // Verify types
            if ("tokens" in deltaEvent) {
              expect(typeof deltaEvent.tokens).toBe("number");
              expect(deltaEvent.tokens).toBeGreaterThanOrEqual(0);
            }
            if ("timestamp" in deltaEvent) {
              expect(typeof deltaEvent.timestamp).toBe("number");
              expect(deltaEvent.timestamp).toBeGreaterThan(0);
            }
          }

          // Collect all events and sum tokens
          await collector.waitForEvent("stream-end", 10000);
          const allEvents = collector.getEvents();
          const deltaEvents = allEvents.filter(
            (e) =>
              "type" in e &&
              (e.type === "stream-delta" ||
                e.type === "reasoning-delta" ||
                e.type === "tool-call-delta")
          );

          // Should have received multiple delta events
          expect(deltaEvents.length).toBeGreaterThan(0);

          // Calculate total tokens from deltas
          let totalTokens = 0;
          for (const event of deltaEvents) {
            if ("tokens" in event && typeof event.tokens === "number") {
              totalTokens += event.tokens;
            }
          }

          // Total should be greater than 0
          expect(totalTokens).toBeGreaterThan(0);

          // Verify stream completed successfully
          assertStreamSuccess(collector);
        } finally {
          await cleanup();
        }
      },
      30000 // Increased timeout for OpenAI models which can be slower in CI
    );

    test.concurrent(
      "should include usage data in stream-abort events",
      async () => {
        // Setup test environment
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
        try {
          // Start a stream that will generate some tokens
          const message = "Write a haiku about coding";
          void sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            message,
            modelString(provider, model)
          );

          // Wait for stream to start and get some deltas
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await collector.waitForEvent("stream-start", 5000);

          // Wait a bit for some content to be generated
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Interrupt the stream with interruptStream()
          const interruptResult = await env.mockIpcRenderer.invoke(
            IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM,
            workspaceId
          );

          expect(interruptResult.success).toBe(true);

          // Collect all events and find abort event
          await waitFor(() => {
            collector.collect();
            return collector.getEvents().some((e) => "type" in e && e.type === "stream-abort");
          }, 5000);

          const abortEvent = collector
            .getEvents()
            .find((e) => "type" in e && e.type === "stream-abort");
          expect(abortEvent).toBeDefined();

          // Verify abort event structure
          if (abortEvent && "metadata" in abortEvent) {
            // Metadata should exist with duration
            expect(abortEvent.metadata).toBeDefined();
            expect(abortEvent.metadata?.duration).toBeGreaterThan(0);

            // Usage MAY be present depending on abort timing:
            // - Early abort: usage is undefined (stream didn't complete)
            // - Late abort: usage available (stream finished before UI processed it)
            if (abortEvent.metadata?.usage) {
              expect(abortEvent.metadata.usage.inputTokens).toBeGreaterThan(0);
              expect(abortEvent.metadata.usage.outputTokens).toBeGreaterThanOrEqual(0);
            }
          }
        } finally {
          await cleanup();
        }
      },
      15000
    );

    test.concurrent(
      "should handle reconnection during active stream",
      async () => {
        // Only test with Anthropic (faster and more reliable for this test)
        if (provider === "openai") {
          return;
        }

        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
        try {
          // Start a stream with tool call that takes a long time
          void sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Run this bash command: while true; do sleep 0.1; done",
            modelString(provider, model)
          );

          // Wait for tool-call-start (which means model is executing bash)
          const collector1 = createEventCollector(env.sentEvents, workspaceId);
          const streamStartEvent = await collector1.waitForEvent("stream-start", 5000);
          expect(streamStartEvent).toBeDefined();

          await collector1.waitForEvent("tool-call-start", 10000);

          // At this point, bash loop is running (will run forever if abort doesn't work)
          // Get message ID for verification
          collector1.collect();
          const messageId =
            streamStartEvent && "messageId" in streamStartEvent
              ? streamStartEvent.messageId
              : undefined;
          expect(messageId).toBeDefined();

          // Simulate reconnection by clearing events and re-subscribing
          env.sentEvents.length = 0;

          // Use ipcRenderer.send() to trigger ipcMain.on() handler (correct way for electron-mock-ipc)
          env.mockIpcRenderer.send("workspace:chat:subscribe", workspaceId);

          // Wait for async subscription handler to complete by polling for caught-up
          const collector2 = createEventCollector(env.sentEvents, workspaceId);
          const caughtUpMessage = await collector2.waitForEvent("caught-up", 5000);
          expect(caughtUpMessage).toBeDefined();

          // Collect all reconnection events
          collector2.collect();
          const reconnectionEvents = collector2.getEvents();

          // Verify we received stream-start event (not a partial message with INTERRUPTED)
          const reconnectStreamStart = reconnectionEvents.find(
            (e) => "type" in e && e.type === "stream-start"
          );

          // If stream completed before reconnection, we'll get a regular message instead
          // This is expected behavior - only active streams get replayed
          const hasStreamStart = !!reconnectStreamStart;
          const hasRegularMessage = reconnectionEvents.some(
            (e) => "role" in e && e.role === "assistant"
          );

          // Either we got stream replay (active stream) OR regular message (completed stream)
          expect(hasStreamStart || hasRegularMessage).toBe(true);

          // If we did get stream replay, verify it
          if (hasStreamStart) {
            expect(reconnectStreamStart).toBeDefined();
            expect(
              reconnectStreamStart && "messageId" in reconnectStreamStart
                ? reconnectStreamStart.messageId
                : undefined
            ).toBe(messageId);

            // Verify we received tool-call-start (replay of accumulated tool event)
            const reconnectToolStart = reconnectionEvents.filter(
              (e) => "type" in e && e.type === "tool-call-start"
            );
            expect(reconnectToolStart.length).toBeGreaterThan(0);

            // Verify we did NOT receive a partial message (which would show INTERRUPTED)
            const partialMessages = reconnectionEvents.filter(
              (e) =>
                "role" in e &&
                e.role === "assistant" &&
                "metadata" in e &&
                (e as { metadata?: { partial?: boolean } }).metadata?.partial === true
            );
            expect(partialMessages.length).toBe(0);
          }

          // Note: If test completes quickly (~5s), abort signal worked and killed the loop
          // If test takes much longer, abort signal didn't work
        } finally {
          await cleanup();
        }
      },
      15000
    );

    test.concurrent(
      "should reject empty message (use interruptStream instead)",
      async () => {
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
        try {
          // Send empty message without any active stream
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "",
            modelString(provider, model)
          );

          // Should fail - empty messages not allowed
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error.type).toBe("unknown");
            if (result.error.type === "unknown") {
              expect(result.error.raw).toContain("Empty message not allowed");
            }
          }

          // Should not have created any stream events
          const collector = createEventCollector(env.sentEvents, workspaceId);
          collector.collect();

          const streamEvents = collector
            .getEvents()
            .filter((e) => "type" in e && e.type?.startsWith("stream-"));
          expect(streamEvents.length).toBe(0);
        } finally {
          await cleanup();
        }
      },
      15000
    );

    test.concurrent(
      "should handle message editing with history truncation",
      async () => {
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
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
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
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
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
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

    test.concurrent("should return error when model is not provided", async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace(provider);
      try {
        // Send message without model
        const result = await sendMessage(
          env.mockIpcRenderer,
          workspaceId,
          "Hello",
          {} as { model: string }
        );

        // Should fail with appropriate error
        assertError(result, "unknown");
        if (!result.success && result.error.type === "unknown") {
          expect(result.error.raw).toContain("No model specified");
        }
      } finally {
        await cleanup();
      }
    });

    test.concurrent("should return error for invalid model string", async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace(provider);
      try {
        // Send message with invalid model format
        const result = await sendMessage(env.mockIpcRenderer, workspaceId, "Hello", {
          model: "invalid-format",
        });

        // Should fail with invalid_model_string error
        assertError(result, "invalid_model_string");
      } finally {
        await cleanup();
      }
    });

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
          const { env, workspaceId, cleanup } = await setupWorkspace(provider);

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
      "%s should return stream error when model does not exist",
      async (provider) => {
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
        try {
          // Use a clearly non-existent model name
          const nonExistentModel = "definitely-not-a-real-model-12345";
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Hello, world!",
            modelString(provider, nonExistentModel)
          );

          // IPC call should succeed (errors come through stream events)
          expect(result.success).toBe(true);

          // Wait for stream-error event
          const collector = createEventCollector(env.sentEvents, workspaceId);
          const errorEvent = await collector.waitForEvent("stream-error", 10000);

          // Should have received a stream-error event
          expect(errorEvent).toBeDefined();
          expect(collector.hasError()).toBe(true);

          // Verify error message is the enhanced user-friendly version
          if (errorEvent && "error" in errorEvent) {
            const errorMsg = String(errorEvent.error);
            // Should have the enhanced error message format
            expect(errorMsg).toContain("definitely-not-a-real-model-12345");
            expect(errorMsg).toContain("does not exist or is not available");
          }

          // Verify error type is properly categorized
          if (errorEvent && "errorType" in errorEvent) {
            expect(errorEvent.errorType).toBe("model_not_found");
          }
        } finally {
          await cleanup();
        }
      }
    );
  });

  // Token limit error handling tests
  describe("token limit error handling", () => {
    test.each(PROVIDER_CONFIGS)(
      "%s should return error when accumulated history exceeds token limit",
      async (provider, model) => {
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
        try {
          // Build up large conversation history to exceed context limits
          // Different providers have different limits:
          // - Anthropic: 200k tokens → need ~40 messages of 50k chars (2M chars total)
          // - OpenAI: varies by model, use ~80 messages (4M chars total) to ensure we hit the limit
          await buildLargeHistory(workspaceId, env.config, {
            messageSize: 50_000,
            messageCount: provider === "anthropic" ? 40 : 80,
          });

          // Now try to send a new message - should trigger token limit error
          // due to accumulated history
          // Disable auto-truncation to force context error
          const sendOptions =
            provider === "openai"
              ? {
                  providerOptions: {
                    openai: {
                      disableAutoTruncation: true,
                      forceContextLimitError: true,
                    },
                  },
                }
              : undefined;
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "What is the weather?",
            modelString(provider, model),
            sendOptions
          );

          // IPC call itself should succeed (errors come through stream events)
          expect(result.success).toBe(true);

          // Wait for either stream-end or stream-error
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await Promise.race([
            collector.waitForEvent("stream-end", 10000),
            collector.waitForEvent("stream-error", 10000),
          ]);

          // Should have received error event with token limit error
          expect(collector.hasError()).toBe(true);

          // Verify error is properly categorized as context_exceeded
          const errorEvents = collector
            .getEvents()
            .filter((e) => "type" in e && e.type === "stream-error");
          expect(errorEvents.length).toBeGreaterThan(0);

          const errorEvent = errorEvents[0];

          // Verify error type is context_exceeded
          if (errorEvent && "errorType" in errorEvent) {
            expect(errorEvent.errorType).toBe("context_exceeded");
          }

          // NEW: Verify error handling improvements
          // 1. Verify error event includes messageId
          if (errorEvent && "messageId" in errorEvent) {
            expect(errorEvent.messageId).toBeDefined();
            expect(typeof errorEvent.messageId).toBe("string");
          }

          // 2. Verify error persists across "reload" by simulating page reload via IPC
          // Clear sentEvents and trigger subscription (simulates what happens on page reload)
          env.sentEvents.length = 0;

          // Trigger the subscription using ipcRenderer.send() (correct way to trigger ipcMain.on())
          env.mockIpcRenderer.send(`workspace:chat:subscribe`, workspaceId);

          // Wait for the async subscription handler to complete by polling for caught-up
          const reloadCollector = createEventCollector(env.sentEvents, workspaceId);
          const caughtUpMessage = await reloadCollector.waitForEvent("caught-up", 10000);
          expect(caughtUpMessage).toBeDefined();

          // 3. Find the partial message with error metadata in reloaded messages
          const reloadedMessages = reloadCollector.getEvents();
          const partialMessage = reloadedMessages.find(
            (msg) =>
              msg &&
              typeof msg === "object" &&
              "metadata" in msg &&
              msg.metadata &&
              typeof msg.metadata === "object" &&
              "error" in msg.metadata
          );

          // 4. Verify partial message has error metadata
          expect(partialMessage).toBeDefined();
          if (
            partialMessage &&
            typeof partialMessage === "object" &&
            "metadata" in partialMessage &&
            partialMessage.metadata &&
            typeof partialMessage.metadata === "object"
          ) {
            expect("error" in partialMessage.metadata).toBe(true);
            expect("errorType" in partialMessage.metadata).toBe(true);
            expect("partial" in partialMessage.metadata).toBe(true);
            if ("partial" in partialMessage.metadata) {
              expect(partialMessage.metadata.partial).toBe(true);
            }

            // Verify error type is context_exceeded
            if ("errorType" in partialMessage.metadata) {
              expect(partialMessage.metadata.errorType).toBe("context_exceeded");
            }
          }
        } finally {
          await cleanup();
        }
      },
      30000
    );
  });

  // Tool policy tests
  describe("tool policy", () => {
    // Retry tool policy tests in CI (they depend on external API behavior)
    if (process.env.CI && typeof jest !== "undefined" && jest.retryTimes) {
      jest.retryTimes(2, { logErrorsBeforeRetry: true });
    }

    test.each(PROVIDER_CONFIGS)(
      "%s should respect tool policy that disables bash",
      async (provider, model) => {
        const { env, workspaceId, workspacePath, cleanup } = await setupWorkspace(provider);
        try {
          // Create a test file in the workspace
          const testFilePath = path.join(workspacePath, "bash-test-file.txt");
          await fs.writeFile(testFilePath, "original content", "utf-8");

          // Verify file exists
          expect(
            await fs.access(testFilePath).then(
              () => true,
              () => false
            )
          ).toBe(true);

          // Ask AI to delete the file using bash (which should be disabled)
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Delete the file bash-test-file.txt using bash rm command",
            modelString(provider, model),
            {
              toolPolicy: [{ regex_match: "bash", action: "disable" }],
              ...(provider === "openai"
                ? { providerOptions: { openai: { simulateToolPolicyNoop: true } } }
                : {}),
            }
          );

          // IPC call should succeed
          expect(result.success).toBe(true);

          // Wait for stream to complete (longer timeout for tool policy tests)
          const collector = createEventCollector(env.sentEvents, workspaceId);

          // Wait for either stream-end or stream-error
          // (helpers will log diagnostic info on failure)
          const streamTimeout = provider === "openai" ? 90000 : 30000;
          await Promise.race([
            collector.waitForEvent("stream-end", streamTimeout),
            collector.waitForEvent("stream-error", streamTimeout),
          ]);

          // This will throw with detailed error info if stream didn't complete successfully
          assertStreamSuccess(collector);

          if (provider === "openai") {
            const deltas = collector.getDeltas();
            const noopDelta = deltas.find(
              (event): event is StreamDeltaEvent =>
                "type" in event &&
                event.type === "stream-delta" &&
                typeof (event as StreamDeltaEvent).delta === "string"
            );
            expect(noopDelta?.delta).toContain(
              "Tool execution skipped because the requested tool is disabled by policy."
            );
          }

          // Verify file still exists (bash tool was disabled, so deletion shouldn't have happened)
          const fileStillExists = await fs.access(testFilePath).then(
            () => true,
            () => false
          );
          expect(fileStillExists).toBe(true);

          // Verify content unchanged
          const content = await fs.readFile(testFilePath, "utf-8");
          expect(content).toBe("original content");
        } finally {
          await cleanup();
        }
      },
      90000
    );

    test.each(PROVIDER_CONFIGS)(
      "%s should respect tool policy that disables file_edit tools",
      async (provider, model) => {
        const { env, workspaceId, workspacePath, cleanup } = await setupWorkspace(provider);
        try {
          // Create a test file with known content
          const testFilePath = path.join(workspacePath, "edit-test-file.txt");
          const originalContent = "original content line 1\noriginal content line 2";
          await fs.writeFile(testFilePath, originalContent, "utf-8");

          // Ask AI to edit the file (which should be disabled)
          // Disable both file_edit tools AND bash to prevent workarounds
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "Edit the file edit-test-file.txt and replace 'original' with 'modified'",
            modelString(provider, model),
            {
              toolPolicy: [
                { regex_match: "file_edit_.*", action: "disable" },
                { regex_match: "bash", action: "disable" },
              ],
              ...(provider === "openai"
                ? { providerOptions: { openai: { simulateToolPolicyNoop: true } } }
                : {}),
            }
          );

          // IPC call should succeed
          expect(result.success).toBe(true);

          // Wait for stream to complete (longer timeout for tool policy tests)
          const collector = createEventCollector(env.sentEvents, workspaceId);

          // Wait for either stream-end or stream-error
          // (helpers will log diagnostic info on failure)
          const streamTimeout = provider === "openai" ? 90000 : 30000;
          await Promise.race([
            collector.waitForEvent("stream-end", streamTimeout),
            collector.waitForEvent("stream-error", streamTimeout),
          ]);

          // This will throw with detailed error info if stream didn't complete successfully
          assertStreamSuccess(collector);

          if (provider === "openai") {
            const deltas = collector.getDeltas();
            const noopDelta = deltas.find(
              (event): event is StreamDeltaEvent =>
                "type" in event &&
                event.type === "stream-delta" &&
                typeof (event as StreamDeltaEvent).delta === "string"
            );
            expect(noopDelta?.delta).toContain(
              "Tool execution skipped because the requested tool is disabled by policy."
            );
          }

          // Verify file content unchanged (file_edit tools and bash were disabled)
          const content = await fs.readFile(testFilePath, "utf-8");
          expect(content).toBe(originalContent);
        } finally {
          await cleanup();
        }
      },
      90000
    );
  });

  // Additional system instructions tests
  describe("additional system instructions", () => {
    test.each(PROVIDER_CONFIGS)(
      "%s should pass additionalSystemInstructions through to system message",
      async (provider, model) => {
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);
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

    test.concurrent(
      "respects disableAutoTruncation flag",
      async () => {
        const { env, workspaceId, cleanup } = await setupWorkspace(provider);

        try {
          // Phase 1: Build up large conversation history to exceed context limit
          // Use ~80 messages (4M chars total) to ensure we hit the limit
          await buildLargeHistory(workspaceId, env.config, {
            messageSize: 50_000,
            messageCount: 80,
          });

          // Now send a new message with auto-truncation disabled - should trigger error
          const result = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "This should trigger a context error",
            modelString(provider, model),
            {
              providerOptions: {
                openai: {
                  disableAutoTruncation: true,
                  forceContextLimitError: true,
                },
              },
            }
          );

          // IPC call itself should succeed (errors come through stream events)
          expect(result.success).toBe(true);

          // Wait for either stream-end or stream-error
          const collector = createEventCollector(env.sentEvents, workspaceId);
          await Promise.race([
            collector.waitForEvent("stream-end", 10000),
            collector.waitForEvent("stream-error", 10000),
          ]);

          // Should have received error event with context exceeded error
          expect(collector.hasError()).toBe(true);

          // Check that error message contains context-related keywords
          const errorEvents = collector
            .getEvents()
            .filter((e) => "type" in e && e.type === "stream-error");
          expect(errorEvents.length).toBeGreaterThan(0);

          const errorEvent = errorEvents[0];
          if (errorEvent && "error" in errorEvent) {
            const errorStr = String(errorEvent.error).toLowerCase();
            expect(
              errorStr.includes("context") ||
                errorStr.includes("length") ||
                errorStr.includes("exceed") ||
                errorStr.includes("token")
            ).toBe(true);
          }

          // Phase 2: Send message with auto-truncation enabled (should succeed)
          env.sentEvents.length = 0;
          const successResult = await sendMessageWithModel(
            env.mockIpcRenderer,
            workspaceId,
            "This should succeed with auto-truncation",
            modelString(provider, model)
            // disableAutoTruncation defaults to false (auto-truncation enabled)
          );

          expect(successResult.success).toBe(true);
          const successCollector = createEventCollector(env.sentEvents, workspaceId);
          await successCollector.waitForEvent("stream-end", 30000);
          assertStreamSuccess(successCollector);
        } finally {
          await cleanup();
        }
      },
      60000 // 1 minute timeout (much faster since we don't make many API calls)
    );

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
          await collector1.waitForEvent("stream-end", 30000);
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
    "should send images to AI model and get response",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace(provider);
      try {
        // Send message with image attachment
        const result = await sendMessage(env.mockIpcRenderer, workspaceId, "What color is this?", {
          model: modelString(provider, model),
          imageParts: [TEST_IMAGES.RED_PIXEL],
        });

        expect(result.success).toBe(true);

        // Wait for stream to complete
        const collector = await waitForStreamSuccess(env.sentEvents, workspaceId, 30000);

        // Verify we got a response about the image
        const deltas = collector.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);

        // Combine all text deltas
        const fullResponse = deltas
          .map((d) => (d as StreamDeltaEvent).delta)
          .join("")
          .toLowerCase();

        // Should mention red color in some form
        expect(fullResponse.length).toBeGreaterThan(0);
        // Red pixel should be detected (flexible matching as different models may phrase differently)
        expect(fullResponse).toMatch(/red|color/i);
      } finally {
        await cleanup();
      }
    },
    40000 // Vision models can be slower
  );

  test.concurrent(
    "should preserve image parts through history",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace(provider);
      try {
        // Send message with image
        const result = await sendMessage(env.mockIpcRenderer, workspaceId, "Describe this", {
          model: modelString(provider, model),
          imageParts: [TEST_IMAGES.BLUE_PIXEL],
        });

        expect(result.success).toBe(true);

        // Wait for stream to complete
        await waitForStreamSuccess(env.sentEvents, workspaceId, 30000);

        // Read history from disk
        const messages = await readChatHistory(env.tempDir, workspaceId);

        // Find the user message
        const userMessage = messages.find((m: { role: string }) => m.role === "user");
        expect(userMessage).toBeDefined();

        // Verify image part is preserved with correct format
        if (userMessage) {
          const imagePart = userMessage.parts.find((p: { type: string }) => p.type === "file");
          expect(imagePart).toBeDefined();
          if (imagePart) {
            expect(imagePart.url).toBe(TEST_IMAGES.BLUE_PIXEL.url);
            expect(imagePart.mediaType).toBe("image/png");
          }
        }
      } finally {
        await cleanup();
      }
    },
    40000
  );

  // Test multi-turn conversation specifically for reasoning models (codex mini)
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
