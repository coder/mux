import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";
import { createTempGitRepo, cleanupTempGitRepo, createWorkspace } from "./helpers";
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

describeIntegration("IpcMain executeBash integration tests", () => {
  test.concurrent(
    "should execute bash command in workspace context",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env.mockIpcRenderer, tempGitRepo, "test-bash");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;

        // Execute a simple bash command (pwd should return workspace path)
        const pwdResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
          workspaceId,
          "pwd"
        );

        expect(pwdResult.success).toBe(true);
        expect(pwdResult.data.success).toBe(true);
        // Verify pwd output contains the workspace name (directories are named with workspace names)
        expect(pwdResult.data.output).toContain(metadata.name);
        expect(pwdResult.data.exitCode).toBe(0);

        // Clean up
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should execute git status in workspace context",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(
          env.mockIpcRenderer,
          tempGitRepo,
          "test-git-status"
        );
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;

        // Execute git status
        const gitStatusResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
          workspaceId,
          "git status"
        );

        expect(gitStatusResult.success).toBe(true);
        expect(gitStatusResult.data.success).toBe(true);
        expect(gitStatusResult.data.output).toContain("On branch");
        expect(gitStatusResult.data.exitCode).toBe(0);

        // Clean up
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should handle command failure with exit code",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(
          env.mockIpcRenderer,
          tempGitRepo,
          "test-failure"
        );
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;

        // Execute a command that will fail
        const failResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
          workspaceId,
          "exit 42"
        );

        expect(failResult.success).toBe(true);
        expect(failResult.data.success).toBe(false);
        expect(failResult.data.exitCode).toBe(42);
        expect(failResult.data.error).toContain("exited with code 42");

        // Clean up
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should respect timeout option",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(
          env.mockIpcRenderer,
          tempGitRepo,
          "test-timeout"
        );
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;

        // Execute a command that takes longer than the timeout
        const timeoutResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
          workspaceId,
          "while true; do sleep 0.1; done",
          { timeout_secs: 1 }
        );

        expect(timeoutResult.success).toBe(true);
        expect(timeoutResult.data.success).toBe(false);
        expect(timeoutResult.data.error).toContain("timeout");

        // Clean up
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should handle large output without truncation (IPC uses truncate policy with 10K line limit)",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(
          env.mockIpcRenderer,
          tempGitRepo,
          "test-large-output"
        );
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;

        // Execute a command that generates 400 lines (well under 10K limit for IPC truncate policy)
        const result = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
          workspaceId,
          "for i in {1..400}; do echo line$i; done"
        );

        expect(result.success).toBe(true);
        expect(result.data.success).toBe(true);
        expect(result.data.exitCode).toBe(0);
        // Should return all 400 lines without truncation
        const lineCount = result.data.output?.split("\n").length ?? 0;
        expect(lineCount).toBe(400);
        // Should not be truncated since 400 << 10,000
        expect(result.data.truncated).toBeUndefined();

        // Clean up
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should fail gracefully with invalid workspace ID",
    async () => {
      const env = await createTestEnvironment();

      try {
        // Execute bash command with non-existent workspace ID
        const result = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
          "nonexistent-workspace",
          "echo test"
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Failed to get workspace metadata");
      } finally {
        await cleanupTestEnvironment(env);
      }
    },
    15000
  );

  test.concurrent(
    "should inject secrets as environment variables",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(
          env.mockIpcRenderer,
          tempGitRepo,
          "test-secrets"
        );
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;

        // Set secrets for the project
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.PROJECT_SECRETS_UPDATE, tempGitRepo, [
          { key: "TEST_SECRET_KEY", value: "secret_value_123" },
          { key: "ANOTHER_SECRET", value: "another_value_456" },
        ]);

        // Execute bash command that reads the environment variables
        const echoResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
          workspaceId,
          'echo "KEY=$TEST_SECRET_KEY ANOTHER=$ANOTHER_SECRET"'
        );

        expect(echoResult.success).toBe(true);
        expect(echoResult.data.success).toBe(true);
        expect(echoResult.data.output).toContain("KEY=secret_value_123");
        expect(echoResult.data.output).toContain("ANOTHER=another_value_456");
        expect(echoResult.data.exitCode).toBe(0);

        // Clean up
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should set GIT_TERMINAL_PROMPT=0 to prevent credential prompts",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(
          env.mockIpcRenderer,
          tempGitRepo,
          "test-git-env"
        );
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;

        // Verify GIT_TERMINAL_PROMPT is set to 0
        const gitEnvResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
          workspaceId,
          'echo "GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT"'
        );

        expect(gitEnvResult.success).toBe(true);
        expect(gitEnvResult.data.success).toBe(true);
        expect(gitEnvResult.data.output).toContain("GIT_TERMINAL_PROMPT=0");
        expect(gitEnvResult.data.exitCode).toBe(0);

        // Test 1: Verify that git fetch with invalid remote doesn't hang (should fail quickly)
        const invalidFetchResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
          workspaceId,
          "git fetch https://invalid-remote-that-does-not-exist-12345.com/repo.git 2>&1 || true",
          { timeout_secs: 5 }
        );

        expect(invalidFetchResult.success).toBe(true);
        expect(invalidFetchResult.data.success).toBe(true);

        // Test 2: Verify git fetch to real GitHub org repo doesn't hang
        // Uses OpenAI org - will fail if no auth configured, but should fail quickly without prompting
        const githubFetchResult = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
          workspaceId,
          "git fetch https://github.com/openai/private-test-repo-nonexistent 2>&1 || true",
          { timeout_secs: 5 }
        );

        // Should complete quickly (not hang waiting for credentials)
        expect(githubFetchResult.success).toBe(true);
        // Command should complete within timeout - the "|| true" ensures success even if fetch fails
        expect(githubFetchResult.data.success).toBe(true);
        // Output should contain error message, not hang
        expect(githubFetchResult.data.output).toContain("fatal");

        // Clean up
        await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );
});
