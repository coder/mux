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
  configureTestRetries,
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

// Retry flaky tests in CI (API latency / rate limiting)
configureTestRetries(3);

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
        // Note: Empty string now triggers auto-generation (same as undefined), so it's not tested here
        const invalidNames = [
          { name: "Invalid-Name", expectedError: "a-z" },
          { name: "name with spaces", expectedError: "a-z" },
          { name: "name@special", expectedError: "a-z" },
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
        await collector.waitForSubscription();
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
        await collector.waitForSubscription();
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
        await Promise.all([
          sourceCollector.waitForSubscription(),
          forkedCollector.waitForSubscription(),
        ]);

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
        await sourceCollector.waitForSubscription();

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
        // Wait for subscription before sending to avoid race condition where stream-end
        // is emitted before collector is ready to receive it
        await forkedCollector.waitForSubscription();
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

  test.concurrent(
    "should fork local (project-dir) workspace successfully",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create source workspace with LocalRuntime (project-dir mode)
        // This means type: "local" without srcBaseDir
        const localRuntimeConfig = { type: "local" as const };

        const client = resolveOrpcClient(env);
        const createResult = await client.workspace.create({
          projectPath: tempGitRepo,
          branchName: "local-source",
          trunkBranch: "main", // Not used for local runtime
          runtimeConfig: localRuntimeConfig,
        });
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
        const sourceWorkspaceId = createResult.metadata.id;

        // Verify source workspace uses local runtime (project-dir mode)
        expect(createResult.metadata.runtimeConfig.type).toBe("local");
        expect("srcBaseDir" in createResult.metadata.runtimeConfig).toBe(false);

        // Fork the local workspace
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "local-forked",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        const forkedWorkspaceId = forkResult.metadata.id;

        // Forked workspace should also use local runtime (project-dir mode)
        expect(forkResult.metadata.runtimeConfig.type).toBe("local");
        expect("srcBaseDir" in forkResult.metadata.runtimeConfig).toBe(false);

        // Both workspaces should point to the same project path
        expect(forkResult.metadata.namedWorkspacePath).toBe(
          createResult.metadata.namedWorkspacePath
        );
        expect(forkResult.metadata.projectPath).toBe(createResult.metadata.projectPath);

        // User expects: both workspaces appear in workspace list
        const workspaces = await client.workspace.list();
        const workspaceIds = workspaces.map((w: { id: string }) => w.id);
        expect(workspaceIds).toContain(sourceWorkspaceId);
        expect(workspaceIds).toContain(forkedWorkspaceId);

        // Cleanup
        await client.workspace.remove({ workspaceId: sourceWorkspaceId });
        await client.workspace.remove({ workspaceId: forkedWorkspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should preserve chat history when forking local (project-dir) workspace",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create source workspace with LocalRuntime (project-dir mode)
        const localRuntimeConfig = { type: "local" as const };

        const client = resolveOrpcClient(env);
        const createResult = await client.workspace.create({
          projectPath: tempGitRepo,
          branchName: "local-source-history",
          trunkBranch: "main",
          runtimeConfig: localRuntimeConfig,
        });
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
        const sourceWorkspaceId = createResult.metadata.id;

        // Add history to source workspace
        const historyService = new HistoryService(env.config);
        const uniqueWord = `localtest-${Date.now()}`;
        const historyMessages = [
          createMuxMessage("msg-1", "user", `Remember this local word: ${uniqueWord}`, {}),
          createMuxMessage(
            "msg-2",
            "assistant",
            `I will remember the local word "${uniqueWord}".`,
            {}
          ),
        ];

        for (const msg of historyMessages) {
          const result = await historyService.appendToHistory(sourceWorkspaceId, msg);
          expect(result.success).toBe(true);
        }

        // Fork the local workspace
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "local-forked-history",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        const forkedWorkspaceId = forkResult.metadata.id;

        // Verify forked workspace has copied history
        const forkedHistoryResult = await historyService.getHistory(forkedWorkspaceId);
        expect(forkedHistoryResult.success).toBe(true);
        if (!forkedHistoryResult.success) return;

        // Check that history contains our unique word
        const historyContent = forkedHistoryResult.data
          .map((msg) => {
            if ("parts" in msg && Array.isArray(msg.parts)) {
              return msg.parts
                .filter((p) => p.type === "text")
                .map((p) => (p as { text: string }).text)
                .join("");
            }
            return "";
          })
          .join(" ");
        expect(historyContent).toContain(uniqueWord);

        // Cleanup
        await client.workspace.remove({ workspaceId: sourceWorkspaceId });
        await client.workspace.remove({ workspaceId: forkedWorkspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should persist local runtimeConfig through config reload after fork",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create source workspace with LocalRuntime (project-dir mode)
        const localRuntimeConfig = { type: "local" as const };

        const client = resolveOrpcClient(env);
        const createResult = await client.workspace.create({
          projectPath: tempGitRepo,
          branchName: "local-persist-test",
          trunkBranch: "main",
          runtimeConfig: localRuntimeConfig,
        });
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
        const sourceWorkspaceId = createResult.metadata.id;

        // Fork the local workspace
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
          newName: "local-persist-forked",
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        const forkedWorkspaceId = forkResult.metadata.id;

        // Verify forked workspace has local runtimeConfig immediately
        expect(forkResult.metadata.runtimeConfig.type).toBe("local");
        expect("srcBaseDir" in forkResult.metadata.runtimeConfig).toBe(false);

        // BUG REPRO: Reload config and verify runtimeConfig persisted correctly
        // This simulates what happens after app restart or when getAllWorkspaceMetadata is called
        const workspaces = await client.workspace.list();
        const forkedWorkspace = workspaces.find((w: { id: string }) => w.id === forkedWorkspaceId);

        // This is the critical assertion that would fail before the fix:
        // After reload, the workspace should still have type: "local" without srcBaseDir
        expect(forkedWorkspace).toBeDefined();
        expect(forkedWorkspace!.runtimeConfig.type).toBe("local");
        expect("srcBaseDir" in forkedWorkspace!.runtimeConfig).toBe(false);

        // Verify namedWorkspacePath is the project path (not ~/.mux/src/...) for local workspaces
        // This ensures Open-in-Editor and path display work correctly after reload
        expect(forkedWorkspace!.namedWorkspacePath).toBe(tempGitRepo);
        expect(forkResult.metadata.namedWorkspacePath).toBe(tempGitRepo);

        // Cleanup
        await client.workspace.remove({ workspaceId: sourceWorkspaceId });
        await client.workspace.remove({ workspaceId: forkedWorkspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should auto-generate incremented name and title when forking without arguments",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
        const client = resolveOrpcClient(env);

        // Create source workspace with a title
        const createResult = await client.workspace.create({
          projectPath: tempGitRepo,
          branchName: "bugs-asd23",
          trunkBranch,
        });
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
        const sourceWorkspaceId = createResult.metadata.id;

        // Set title on source workspace
        await client.workspace.updateTitle({
          workspaceId: sourceWorkspaceId,
          title: "Fixing bugs",
        });

        // Fork without specifying a name (auto-generate)
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;

        // Verify auto-generated name and title
        expect(forkResult.metadata.name).toBe("bugs-asd23-2");
        expect(forkResult.metadata.title).toBe("Fixing bugs 2");

        // Fork again to test increment
        const forkResult2 = await client.workspace.fork({
          sourceWorkspaceId: forkResult.metadata.id,
        });
        expect(forkResult2.success).toBe(true);
        if (!forkResult2.success) return;

        // Verify further increment
        expect(forkResult2.metadata.name).toBe("bugs-asd23-3");
        expect(forkResult2.metadata.title).toBe("Fixing bugs 3");

        // Cleanup
        await client.workspace.remove({ workspaceId: sourceWorkspaceId });
        await client.workspace.remove({ workspaceId: forkResult.metadata.id });
        await client.workspace.remove({ workspaceId: forkResult2.metadata.id });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should auto-generate name but not title when source has no title",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
        const client = resolveOrpcClient(env);

        // Create source workspace without a title
        const createResult = await client.workspace.create({
          projectPath: tempGitRepo,
          branchName: "sidebar-k3m9",
          trunkBranch,
        });
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
        const sourceWorkspaceId = createResult.metadata.id;

        // Fork without specifying a name
        const forkResult = await client.workspace.fork({
          sourceWorkspaceId,
        });
        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;

        // Verify auto-generated name, no title
        expect(forkResult.metadata.name).toBe("sidebar-k3m9-2");
        expect(forkResult.metadata.title).toBeUndefined();

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

  test.concurrent(
    "should avoid name collisions when forking same source multiple times",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
        const client = resolveOrpcClient(env);

        // Create source workspace
        const createResult = await client.workspace.create({
          projectPath: tempGitRepo,
          branchName: "collision-test",
          trunkBranch,
        });
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;
        const sourceWorkspaceId = createResult.metadata.id;

        // Fork from source - should get -2
        const fork1 = await client.workspace.fork({ sourceWorkspaceId });
        expect(fork1.success).toBe(true);
        if (!fork1.success) return;
        expect(fork1.metadata.name).toBe("collision-test-2");

        // Fork from source AGAIN - should get -3 (avoids collision with -2)
        const fork2 = await client.workspace.fork({ sourceWorkspaceId });
        expect(fork2.success).toBe(true);
        if (!fork2.success) return;
        expect(fork2.metadata.name).toBe("collision-test-3");

        // Fork from source a third time - should get -4
        const fork3 = await client.workspace.fork({ sourceWorkspaceId });
        expect(fork3.success).toBe(true);
        if (!fork3.success) return;
        expect(fork3.metadata.name).toBe("collision-test-4");

        // Cleanup
        await client.workspace.remove({ workspaceId: sourceWorkspaceId });
        await client.workspace.remove({ workspaceId: fork1.metadata.id });
        await client.workspace.remove({ workspaceId: fork2.metadata.id });
        await client.workspace.remove({ workspaceId: fork3.metadata.id });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );
});
