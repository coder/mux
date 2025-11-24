import {
  shouldRunIntegrationTests,
  createTestEnvironment,
  cleanupTestEnvironment,
  setupWorkspace,
  validateApiKeys,
} from "./setup";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  sendMessageWithModel,
  createEventCollector,
  assertStreamSuccess,
  waitFor,
  modelString,
} from "./helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";
import { HistoryService } from "../../src/node/services/historyService";
import { createMuxMessage } from "../../src/common/types/message";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys for tests that need them
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

describeIntegration("IpcMain fork workspace integration tests", () => {
  test.concurrent(
    "should fail to fork workspace with invalid name",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create source workspace
        const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
        const createResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_CREATE,
          tempGitRepo,
          "source-workspace",
          trunkBranch
        );
        expect(createResult.success).toBe(true);
        const sourceWorkspaceId = createResult.metadata.id;

        // Test various invalid names
        const invalidNames = [
          { name: "", expectedError: "empty" },
          { name: "Invalid-Name", expectedError: "lowercase" },
          { name: "name with spaces", expectedError: "lowercase" },
          { name: "name@special", expectedError: "lowercase" },
          { name: "a".repeat(65), expectedError: "64 characters" },
        ];

        for (const { name, expectedError } of invalidNames) {
          const forkResult = await env.mockIpcRenderer.invoke(
            IPC_CHANNELS.WORKSPACE_FORK,
            sourceWorkspaceId,
            name
          );
          expect(forkResult.success).toBe(false);
          expect(forkResult.error.toLowerCase()).toContain(expectedError.toLowerCase());
        }

        // Cleanup
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, sourceWorkspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should fork workspace and send message successfully",
    async () => {
      const { env, workspaceId: sourceWorkspaceId, cleanup } = await setupWorkspace("anthropic");

      try {
        // Fork the workspace
        const forkResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_FORK,
          sourceWorkspaceId,
          "forked-workspace"
        );
        expect(forkResult.success).toBe(true);
        const forkedWorkspaceId = forkResult.metadata.id;

        // User expects: forked workspace is functional - can send messages to it
        env.sentEvents.length = 0;
        const sendResult = await sendMessageWithModel(
          env.mockIpcRenderer,
          forkedWorkspaceId,
          "What is 2+2? Answer with just the number.",
          modelString("anthropic", "claude-sonnet-4-5")
        );
        expect(sendResult.success).toBe(true);

        // Verify stream completes successfully
        const collector = createEventCollector(env.sentEvents, forkedWorkspaceId);
        await collector.waitForEvent("stream-end", 30000);
        assertStreamSuccess(collector);

        const finalMessage = collector.getFinalMessage();
        expect(finalMessage).toBeDefined();
      } finally {
        await cleanup();
      }
    },
    45000
  );

  test.concurrent(
    "should preserve chat history when forking workspace",
    async () => {
      const { env, workspaceId: sourceWorkspaceId, cleanup } = await setupWorkspace("anthropic");

      try {
        // Add history to source workspace
        const historyService = new HistoryService(env.config);
        const uniqueWord = `testword-${Date.now()}`;
        const historyMessages = [
          createMuxMessage("msg-1", "user", `Remember this word: ${uniqueWord}`, {}),
          createMuxMessage("msg-2", "assistant", `I will remember the word "${uniqueWord}".`, {}),
        ];

        for (const msg of historyMessages) {
          const result = await historyService.appendToHistory(sourceWorkspaceId, msg);
          expect(result.success).toBe(true);
        }

        // Fork the workspace
        const forkResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_FORK,
          sourceWorkspaceId,
          "forked-with-history"
        );
        expect(forkResult.success).toBe(true);
        const forkedWorkspaceId = forkResult.metadata.id;

        // User expects: forked workspace has access to history
        // Send a message that requires the historical context
        env.sentEvents.length = 0;
        const sendResult = await sendMessageWithModel(
          env.mockIpcRenderer,
          forkedWorkspaceId,
          "What word did I ask you to remember? Reply with just the word.",
          modelString("anthropic", "claude-sonnet-4-5")
        );
        expect(sendResult.success).toBe(true);

        // Verify stream completes successfully
        const collector = createEventCollector(env.sentEvents, forkedWorkspaceId);
        await collector.waitForEvent("stream-end", 30000);
        assertStreamSuccess(collector);

        const finalMessage = collector.getFinalMessage();
        expect(finalMessage).toBeDefined();

        // Verify the response contains the word from history
        if (finalMessage && "parts" in finalMessage && Array.isArray(finalMessage.parts)) {
          const content = finalMessage.parts
            .filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text)
            .join("");
          expect(content.toLowerCase()).toContain(uniqueWord.toLowerCase());
        }
      } finally {
        await cleanup();
      }
    },
    45000
  );

  test.concurrent(
    "should create independent workspaces that can send messages concurrently",
    async () => {
      const { env, workspaceId: sourceWorkspaceId, cleanup } = await setupWorkspace("anthropic");

      try {
        // Fork the workspace
        const forkResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_FORK,
          sourceWorkspaceId,
          "forked-independent"
        );
        expect(forkResult.success).toBe(true);
        const forkedWorkspaceId = forkResult.metadata.id;

        // User expects: both workspaces work independently
        // Send different messages to both concurrently
        env.sentEvents.length = 0;

        const [sourceResult, forkedResult] = await Promise.all([
          sendMessageWithModel(
            env.mockIpcRenderer,
            sourceWorkspaceId,
            "What is 5+5? Answer with just the number.",
            modelString("anthropic", "claude-sonnet-4-5")
          ),
          sendMessageWithModel(
            env.mockIpcRenderer,
            forkedWorkspaceId,
            "What is 3+3? Answer with just the number.",
            modelString("anthropic", "claude-sonnet-4-5")
          ),
        ]);

        expect(sourceResult.success).toBe(true);
        expect(forkedResult.success).toBe(true);

        // Verify both streams complete successfully
        const sourceCollector = createEventCollector(env.sentEvents, sourceWorkspaceId);
        const forkedCollector = createEventCollector(env.sentEvents, forkedWorkspaceId);

        await Promise.all([
          sourceCollector.waitForEvent("stream-end", 30000),
          forkedCollector.waitForEvent("stream-end", 30000),
        ]);

        assertStreamSuccess(sourceCollector);
        assertStreamSuccess(forkedCollector);

        expect(sourceCollector.getFinalMessage()).toBeDefined();
        expect(forkedCollector.getFinalMessage()).toBeDefined();
      } finally {
        await cleanup();
      }
    },
    45000
  );

  test.concurrent(
    "should preserve partial streaming response when forking mid-stream",
    async () => {
      const { env, workspaceId: sourceWorkspaceId, cleanup } = await setupWorkspace("anthropic");

      try {
        // Start a stream in the source workspace (don't await)
        void sendMessageWithModel(
          env.mockIpcRenderer,
          sourceWorkspaceId,
          "Count from 1 to 10, one number per line. Then say 'Done counting.'",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        // Wait for stream to start and produce some content
        const sourceCollector = createEventCollector(env.sentEvents, sourceWorkspaceId);
        await sourceCollector.waitForEvent("stream-start", 5000);

        // Wait for some deltas to ensure we have partial content
        await waitFor(() => {
          sourceCollector.collect();
          return sourceCollector.getDeltas().length > 2;
        }, 10000);

        // Fork while stream is active (this should commit partial to history)
        const forkResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_FORK,
          sourceWorkspaceId,
          "forked-mid-stream"
        );
        expect(forkResult.success).toBe(true);
        const forkedWorkspaceId = forkResult.metadata.id;

        // Wait for source stream to complete
        await sourceCollector.waitForEvent("stream-end", 30000);

        // User expects: forked workspace is functional despite being forked mid-stream
        // Send a message to the forked workspace
        env.sentEvents.length = 0;
        const forkedSendResult = await sendMessageWithModel(
          env.mockIpcRenderer,
          forkedWorkspaceId,
          "What is 7+3? Answer with just the number.",
          modelString("anthropic", "claude-sonnet-4-5")
        );
        expect(forkedSendResult.success).toBe(true);

        // Verify forked workspace stream completes successfully
        const forkedCollector = createEventCollector(env.sentEvents, forkedWorkspaceId);
        await forkedCollector.waitForEvent("stream-end", 30000);
        assertStreamSuccess(forkedCollector);

        expect(forkedCollector.getFinalMessage()).toBeDefined();
      } finally {
        await cleanup();
      }
    },
    60000
  );

  test.concurrent(
    "should make forked workspace available in workspace list",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create source workspace
        const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
        const createResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_CREATE,
          tempGitRepo,
          "source-workspace",
          trunkBranch
        );
        expect(createResult.success).toBe(true);
        const sourceWorkspaceId = createResult.metadata.id;

        // Fork the workspace
        const forkResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_FORK,
          sourceWorkspaceId,
          "forked-workspace"
        );
        expect(forkResult.success).toBe(true);

        // User expects: both workspaces appear in workspace list
        const workspaces = await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST);
        const workspaceIds = workspaces.map((w: { id: string }) => w.id);
        expect(workspaceIds).toContain(sourceWorkspaceId);
        expect(workspaceIds).toContain(forkResult.metadata.id);

        // Cleanup
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, sourceWorkspaceId);
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, forkResult.metadata.id);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );
});
