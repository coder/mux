import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  createWorkspace,
  resolveOrpcClient,
} from "./helpers";
import type { WorkspaceMetadata } from "../../src/common/types/workspace";

type WorkspaceCreationResult = Awaited<ReturnType<typeof createWorkspace>>;

function expectWorkspaceCreationSuccess(result: WorkspaceCreationResult): WorkspaceMetadata {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected workspace creation to succeed, but it failed: ${result.error}`);
  }
  return result.metadata;
}

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("terminal PTY", () => {
  test.concurrent(
    "should create terminal session, send command, receive output, and close",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace (uses worktree runtime by default)
        const createResult = await createWorkspace(env, tempGitRepo, "test-terminal");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Create terminal session
        const session = await client.terminal.create({
          workspaceId,
          cols: 80,
          rows: 24,
        });

        expect(session.sessionId).toBeTruthy();
        expect(session.workspaceId).toBe(workspaceId);

        // Collect output
        const outputChunks: string[] = [];
        const outputPromise = (async () => {
          const iterator = await client.terminal.onOutput({ sessionId: session.sessionId });
          for await (const chunk of iterator) {
            outputChunks.push(chunk);
            // Stop collecting after we see our expected output
            const fullOutput = outputChunks.join("");
            if (fullOutput.includes("TERMINAL_TEST_SUCCESS")) {
              break;
            }
          }
        })();

        // Give the terminal time to initialize and show prompt
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Send a command that echoes a unique marker
        client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "echo TERMINAL_TEST_SUCCESS\n",
        });

        // Wait for output with timeout
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("Timeout waiting for terminal output")), 10000);
        });

        await Promise.race([outputPromise, timeoutPromise]);

        // Verify we received the expected output
        const fullOutput = outputChunks.join("");
        expect(fullOutput).toContain("TERMINAL_TEST_SUCCESS");

        // Close the terminal session
        await client.terminal.close({ sessionId: session.sessionId });

        // Clean up workspace
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    20000
  );

  test.concurrent(
    "should handle exit event when terminal closes",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-terminal-exit");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Create terminal session
        const session = await client.terminal.create({
          workspaceId,
          cols: 80,
          rows: 24,
        });

        // Subscribe to exit event
        let exitCode: number | null = null;
        const exitPromise = (async () => {
          const iterator = await client.terminal.onExit({ sessionId: session.sessionId });
          for await (const code of iterator) {
            exitCode = code;
            break;
          }
        })();

        // Give terminal time to initialize
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Send exit command to cleanly close the shell
        client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "exit 0\n",
        });

        // Wait for exit with timeout
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("Timeout waiting for terminal exit")), 10000);
        });

        await Promise.race([exitPromise, timeoutPromise]);

        // Verify we got an exit code (typically 0 for clean exit)
        expect(exitCode).toBe(0);

        // Clean up workspace
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    20000
  );

  test.concurrent(
    "should handle terminal resize",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-terminal-resize");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Create terminal session with initial size
        const session = await client.terminal.create({
          workspaceId,
          cols: 80,
          rows: 24,
        });

        // Resize should not throw
        await client.terminal.resize({
          sessionId: session.sessionId,
          cols: 120,
          rows: 40,
        });

        // Verify terminal is still functional after resize
        const outputChunks: string[] = [];
        const outputPromise = (async () => {
          const iterator = await client.terminal.onOutput({ sessionId: session.sessionId });
          for await (const chunk of iterator) {
            outputChunks.push(chunk);
            if (outputChunks.join("").includes("RESIZE_TEST_OK")) {
              break;
            }
          }
        })();

        await new Promise((resolve) => setTimeout(resolve, 300));

        client.terminal.sendInput({
          sessionId: session.sessionId,
          data: "echo RESIZE_TEST_OK\n",
        });

        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("Timeout after resize")), 10000);
        });

        await Promise.race([outputPromise, timeoutPromise]);

        expect(outputChunks.join("")).toContain("RESIZE_TEST_OK");

        // Clean up
        await client.terminal.close({ sessionId: session.sessionId });
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    20000
  );
});
