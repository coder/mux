import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "./setup";
import { sendMessageWithModel, createEventCollector, waitFor, modelString } from "./helpers";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";
import type { Result } from "../../src/common/types/result";
import type { SendMessageError } from "../../src/common/types/errors";
import { HistoryService } from "../../src/node/services/historyService";
import { createMuxMessage } from "../../src/common/types/message";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

describeIntegration("IpcMain resumeStream integration tests", () => {
  test.concurrent(
    "should resume interrupted stream without new user message",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Start a stream with a bash command that outputs a specific word
        const expectedWord = "RESUMPTION_TEST_SUCCESS";
        void sendMessageWithModel(
          env.mockIpcRenderer,
          workspaceId,
          `Run this bash command: for i in 1 2 3; do sleep 0.5; done && echo '${expectedWord}'`,
          modelString("anthropic", "claude-sonnet-4-5")
        );

        // Wait for stream to start
        const collector1 = createEventCollector(env.sentEvents, workspaceId);
        const streamStartEvent = await collector1.waitForEvent("stream-start", 5000);
        expect(streamStartEvent).toBeDefined();

        // Wait for at least some content or tool call to start
        await waitFor(() => {
          collector1.collect();
          const hasToolCallStart = collector1
            .getEvents()
            .some((e) => "type" in e && e.type === "tool-call-start");
          const hasContent = collector1
            .getEvents()
            .some((e) => "type" in e && e.type === "stream-delta");
          return hasToolCallStart || hasContent;
        }, 10000);

        // Interrupt the stream with interruptStream()
        const interruptResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM,
          workspaceId
        );
        expect(interruptResult.success).toBe(true);

        // Wait for stream to be interrupted (abort or end event)
        const streamInterrupted = await waitFor(() => {
          collector1.collect();
          const hasAbort = collector1
            .getEvents()
            .some((e) => "type" in e && e.type === "stream-abort");
          const hasEnd = collector1.getEvents().some((e) => "type" in e && e.type === "stream-end");
          return hasAbort || hasEnd;
        }, 5000);
        expect(streamInterrupted).toBe(true);

        // Count user messages before resume (should be 1)
        collector1.collect();
        const userMessagesBefore = collector1
          .getEvents()
          .filter((e) => "role" in e && e.role === "user");
        expect(userMessagesBefore.length).toBe(1);

        // Clear events to track only resume events
        env.sentEvents.length = 0;

        // Resume the stream (no new user message)
        const resumeResult = (await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_RESUME_STREAM,
          workspaceId,
          { model: "anthropic:claude-sonnet-4-5" }
        )) as Result<void, SendMessageError>;
        expect(resumeResult.success).toBe(true);

        // Collect events after resume
        const collector2 = createEventCollector(env.sentEvents, workspaceId);

        // Wait for new stream to start
        const resumeStreamStart = await collector2.waitForEvent("stream-start", 5000);
        expect(resumeStreamStart).toBeDefined();

        // Wait for stream to complete
        const streamEnd = await collector2.waitForEvent("stream-end", 30000);
        expect(streamEnd).toBeDefined();

        // Verify no new user message was created
        collector2.collect();
        const userMessagesAfter = collector2
          .getEvents()
          .filter((e) => "role" in e && e.role === "user");
        expect(userMessagesAfter.length).toBe(0); // No new user messages

        // Verify stream completed successfully (without errors)
        const streamErrors = collector2
          .getEvents()
          .filter((e) => "type" in e && e.type === "stream-error");
        expect(streamErrors.length).toBe(0);

        // Verify we received stream deltas (actual content)
        const deltas = collector2.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);

        // Verify the stream-end event is present and well-formed
        expect(streamEnd).toBeDefined();
        if (streamEnd && "messageId" in streamEnd && "historySequence" in streamEnd) {
          expect(streamEnd.messageId).toBeTruthy();
          expect(streamEnd.historySequence).toBeGreaterThan(0);
        }

        // Verify we received the expected word in the output
        // This proves the bash command completed successfully after resume
        const allText = deltas
          .filter((d) => "delta" in d)
          .map((d) => ("delta" in d ? d.delta : ""))
          .join("");
        expect(allText).toContain(expectedWord);
      } finally {
        await cleanup();
      }
    },
    45000 // 45 second timeout for this test
  );

  test.concurrent(
    "should resume from single assistant message (post-compaction scenario)",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        // Create a history service to write directly to chat.jsonl
        const historyService = new HistoryService(env.config);

        // Simulate post-compaction state: single assistant message with summary
        // The message promises to say a specific word next, allowing deterministic verification
        const verificationWord = "ELEPHANT";
        const summaryMessage = createMuxMessage(
          "compaction-summary-msg",
          "assistant",
          `I previously helped with a task. The conversation has been compacted for token efficiency. My next message will contain the word ${verificationWord} to confirm continuation works correctly.`,
          {
            compacted: true,
          }
        );

        // Write the summary message to history
        const appendResult = await historyService.appendToHistory(workspaceId, summaryMessage);
        expect(appendResult.success).toBe(true);

        // Create event collector
        const collector = createEventCollector(env.sentEvents, workspaceId);

        // Subscribe to chat channel to receive events
        env.mockIpcRenderer.send("workspace:chat:subscribe", workspaceId);

        // Wait a moment for subscription to complete
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Resume the stream (should continue from the summary message)
        const resumeResult = (await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_RESUME_STREAM,
          workspaceId,
          { model: "anthropic:claude-sonnet-4-5" }
        )) as Result<void, SendMessageError>;
        expect(resumeResult.success).toBe(true);

        // Wait for stream to start
        const streamStart = await collector.waitForEvent("stream-start", 10000);
        expect(streamStart).toBeDefined();

        // Wait for stream to complete
        const streamEnd = await collector.waitForEvent("stream-end", 30000);
        expect(streamEnd).toBeDefined();

        // Verify no user message was created (resumeStream should not add one)
        collector.collect();
        const userMessages = collector.getEvents().filter((e) => "role" in e && e.role === "user");
        expect(userMessages.length).toBe(0);

        // Verify we got an assistant response
        const assistantMessages = collector
          .getEvents()
          .filter((e) => "role" in e && e.role === "assistant");
        expect(assistantMessages.length).toBeGreaterThan(0);

        // Verify we received content deltas
        const deltas = collector.getDeltas();
        expect(deltas.length).toBeGreaterThan(0);

        // Verify no stream errors
        const streamErrors = collector
          .getEvents()
          .filter((e) => "type" in e && e.type === "stream-error");
        expect(streamErrors.length).toBe(0);

        // Verify the assistant responded with actual content and said the verification word
        const allText = deltas
          .filter((d) => "delta" in d)
          .map((d) => ("delta" in d ? d.delta : ""))
          .join("");
        expect(allText.length).toBeGreaterThan(0);

        // Verify the assistant followed the instruction and said the verification word
        // This proves resumeStream properly loaded history and continued from it
        expect(allText).toContain(verificationWord);
      } finally {
        await cleanup();
      }
    },
    45000 // 45 second timeout for this test
  );
});
