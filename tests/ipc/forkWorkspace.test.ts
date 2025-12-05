import {
  shouldRunIntegrationTests,
  createTestEnvironment,
  cleanupTestEnvironment,
  setupWorkspace,
  validateApiKeys,
} from "./setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  sendMessageWithModel,
  createStreamCollector,
  assertStreamSuccess,
  modelString,
  resolveOrpcClient,
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

describeIntegration("Workspace fork", () => {
  test.concurrent(
    "should fail to fork workspace with invalid name",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create source workspace
        const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
        const client = resolveOrpcClient(env);
        const createResult = await client.workspace.create({
          projectPath: tempGitRepo,
          branchName: "source-workspace",
          trunkBranch,
        });
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
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
          const forkResult = await client.workspace.fork({
            sourceWorkspaceId,
            newName: name,
          });
          expect(forkResult.success).toBe(false);
          if (forkResult.success) continue;
          expect(forkResult.error.toLowerCase()).toContain(expectedError.toLowerCase());
        }

        // Cleanup
        await client.workspace.remove({ workspaceId: sourceWorkspaceId });
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
        const client = resolveOrpcClient(env);
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "forked-workspace",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        const forkedWorkspaceId = forkResult.metadata.id;

        // User expects: forked workspace is functional - can send messages to it
        const collector = createStreamCollector(env.orpc, forkedWorkspaceId);
        collector.start();
        const sendResult = await sendMessageWithModel(
          env,
          forkedWorkspaceId,
          "What is 2+2? Answer with just the number.",
          modelString("anthropic", "claude-sonnet-4-5")
        );
        expect(sendResult.success).toBe(true);

        // Verify stream completes successfully
        await collector.waitForEvent("stream-end", 30000);
        assertStreamSuccess(collector);

        const finalMessage = collector.getFinalMessage();
        expect(finalMessage).toBeDefined();
        collector.stop();
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
        const client = resolveOrpcClient(env);
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "forked-with-history",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        const forkedWorkspaceId = forkResult.metadata.id;

        // User expects: forked workspace has access to history
        // Send a message that requires the historical context
        const collector = createStreamCollector(env.orpc, forkedWorkspaceId);
        collector.start();
        const sendResult = await sendMessageWithModel(
          env,
          forkedWorkspaceId,
          "What word did I ask you to remember? Reply with just the word.",
          modelString("anthropic", "claude-sonnet-4-5")
        );
        expect(sendResult.success).toBe(true);

        // Verify stream completes successfully
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
        collector.stop();
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
        const client = resolveOrpcClient(env);
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "forked-independent",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        const forkedWorkspaceId = forkResult.metadata.id;

        // User expects: both workspaces work independently
        // Start collectors before sending messages
        const sourceCollector = createStreamCollector(env.orpc, sourceWorkspaceId);
        const forkedCollector = createStreamCollector(env.orpc, forkedWorkspaceId);
        sourceCollector.start();
        forkedCollector.start();

        // Send different messages to both concurrently
        const [sourceResult, forkedResult] = await Promise.all([
          sendMessageWithModel(
            env,
            sourceWorkspaceId,
            "What is 5+5? Answer with just the number.",
            modelString("anthropic", "claude-sonnet-4-5")
          ),
          sendMessageWithModel(
            env,
            forkedWorkspaceId,
            "What is 3+3? Answer with just the number.",
            modelString("anthropic", "claude-sonnet-4-5")
          ),
        ]);

        expect(sourceResult.success).toBe(true);
        expect(forkedResult.success).toBe(true);

        // Verify both streams complete successfully
        await Promise.all([
          sourceCollector.waitForEvent("stream-end", 30000),
          forkedCollector.waitForEvent("stream-end", 30000),
        ]);

        assertStreamSuccess(sourceCollector);
        assertStreamSuccess(forkedCollector);

        expect(sourceCollector.getFinalMessage()).toBeDefined();
        expect(forkedCollector.getFinalMessage()).toBeDefined();
        sourceCollector.stop();
        forkedCollector.stop();
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
        // Start collector before starting stream
        const sourceCollector = createStreamCollector(env.orpc, sourceWorkspaceId);
        sourceCollector.start();

        // Start a stream in the source workspace (don't await)
        void sendMessageWithModel(
          env,
          sourceWorkspaceId,
          "Count from 1 to 10, one number per line. Then say 'Done counting.'",
          modelString("anthropic", "claude-sonnet-4-5")
        );

        // Wait for stream to start
        await sourceCollector.waitForEvent("stream-start", 5000);

        // Wait for some deltas to ensure we have partial content
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Fork while stream is active (this should commit partial to history)
        const client = resolveOrpcClient(env);
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "forked-mid-stream",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        const forkedWorkspaceId = forkResult.metadata.id;

        // Wait for source stream to complete
        await sourceCollector.waitForEvent("stream-end", 30000);
        sourceCollector.stop();

        // User expects: forked workspace is functional despite being forked mid-stream
        // Send a message to the forked workspace
        const forkedCollector = createStreamCollector(env.orpc, forkedWorkspaceId);
        forkedCollector.start();
        const forkedSendResult = await sendMessageWithModel(
          env,
          forkedWorkspaceId,
          "What is 7+3? Answer with just the number.",
          modelString("anthropic", "claude-sonnet-4-5")
        );
        expect(forkedSendResult.success).toBe(true);

        // Verify forked workspace stream completes successfully
        await forkedCollector.waitForEvent("stream-end", 30000);
        assertStreamSuccess(forkedCollector);

        expect(forkedCollector.getFinalMessage()).toBeDefined();
        forkedCollector.stop();
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
        const client = resolveOrpcClient(env);
        const createResult = await client.workspace.create({
          projectPath: tempGitRepo,
          branchName: "source-workspace",
          trunkBranch,
        });
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
        const sourceWorkspaceId = createResult.metadata.id;

        // Fork the workspace
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "forked-workspace",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;

        // User expects: both workspaces appear in workspace list
        const workspaces = await client.workspace.list();
        const workspaceIds = workspaces.map((w: { id: string }) => w.id);
        expect(workspaceIds).toContain(sourceWorkspaceId);
        expect(workspaceIds).toContain(forkResult.metadata.id);

        // Cleanup
        await client.workspace.remove({ workspaceId: sourceWorkspaceId });
        await client.workspace.remove({ workspaceId: forkResult.metadata.id });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );
});
