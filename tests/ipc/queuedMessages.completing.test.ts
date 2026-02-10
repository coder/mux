import { createTestEnvironment, cleanupTestEnvironment, type TestEnvironment } from "./setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  createWorkspace,
  generateBranchName,
  sendMessageWithModel,
  HAIKU_MODEL,
  createStreamCollector,
} from "./helpers";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe("Queued messages during stream completion", () => {
  let env: TestEnvironment | null = null;
  let repoPath: string | null = null;

  beforeEach(async () => {
    env = await createTestEnvironment();
    env.services.aiService.enableMockMode();

    repoPath = await createTempGitRepo();
  });

  afterEach(async () => {
    if (repoPath) {
      await cleanupTempGitRepo(repoPath);
      repoPath = null;
    }
    if (env) {
      await cleanupTestEnvironment(env);
      env = null;
    }
  });

  test("isBusy returns true during COMPLETING phase", async () => {
    if (!env || !repoPath) {
      throw new Error("Test environment not initialized");
    }

    const branchName = generateBranchName("test-completing-busy");
    const result = await createWorkspace(env, repoPath, branchName);
    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }

    const workspaceId = result.metadata.id;
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    const session = env.services.workspaceService.getOrCreateSession(workspaceId);
    const aiService = env.services.aiService;

    // Create a deterministic COMPLETING window by gating the async stream-end handler
    // (AgentSession awaits CompactionHandler.handleCompletion before it can go idle).
    type SessionInternals = {
      compactionHandler: {
        handleCompletion: (event: unknown) => Promise<boolean>;
      };
    };
    const compactionHandler = (session as unknown as SessionInternals).compactionHandler;

    const enteredCompletion = createDeferred<void>();
    const releaseCompletion = createDeferred<void>();

    const originalHandleCompletion = compactionHandler.handleCompletion.bind(compactionHandler);
    const handleCompletionSpy = jest
      .spyOn(compactionHandler, "handleCompletion")
      .mockImplementation(async (event) => {
        enteredCompletion.resolve();
        await releaseCompletion.promise;
        return originalHandleCompletion(event);
      });

    try {
      await collector.waitForSubscription(5000);

      const firstSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "First message",
        HAIKU_MODEL
      );
      expect(firstSendResult.success).toBe(true);

      await collector.waitForEvent("stream-start", 5000);

      // Wait until the session is inside the stream-end cleanup window.
      await enteredCompletion.promise;

      // Regression: session should still be busy (COMPLETING) even though the AI service
      // is no longer streaming.
      expect(aiService.isStreaming(workspaceId)).toBe(false);
      expect(session.isBusy()).toBe(true);
      expect(session.isPreparingTurn()).toBe(false);

      releaseCompletion.resolve();
      await session.waitForIdle();
      expect(session.isBusy()).toBe(false);
    } finally {
      // Ensure we never leave the completion handler blocked (otherwise workspace.remove can hang).
      releaseCompletion.resolve();
      handleCompletionSpy.mockRestore();

      collector.stop();
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 25000);

  test("waitForIdle blocks while in COMPLETING phase", async () => {
    if (!env || !repoPath) {
      throw new Error("Test environment not initialized");
    }

    const branchName = generateBranchName("test-completing-idle");
    const result = await createWorkspace(env, repoPath, branchName);
    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }

    const workspaceId = result.metadata.id;
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    const session = env.services.workspaceService.getOrCreateSession(workspaceId);

    type SessionInternals = {
      compactionHandler: {
        handleCompletion: (event: unknown) => Promise<boolean>;
      };
    };
    const compactionHandler = (session as unknown as SessionInternals).compactionHandler;

    const enteredCompletion = createDeferred<void>();
    const releaseCompletion = createDeferred<void>();

    const originalHandleCompletion = compactionHandler.handleCompletion.bind(compactionHandler);
    const handleCompletionSpy = jest
      .spyOn(compactionHandler, "handleCompletion")
      .mockImplementation(async (event) => {
        enteredCompletion.resolve();
        await releaseCompletion.promise;
        return originalHandleCompletion(event);
      });

    try {
      await collector.waitForSubscription(5000);

      const firstSendResult = await sendMessageWithModel(
        env,
        workspaceId,
        "First message",
        HAIKU_MODEL
      );
      expect(firstSendResult.success).toBe(true);

      await collector.waitForEvent("stream-start", 5000);

      await enteredCompletion.promise;

      expect(session.isBusy()).toBe(true);

      const waitForIdlePromise = session.waitForIdle();

      const winner = await Promise.race([
        waitForIdlePromise.then(() => "idle" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
      ]);

      expect(winner).toBe("timeout");

      releaseCompletion.resolve();
      await waitForIdlePromise;
      expect(session.isBusy()).toBe(false);
    } finally {
      releaseCompletion.resolve();
      handleCompletionSpy.mockRestore();

      collector.stop();
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 25000);
});
