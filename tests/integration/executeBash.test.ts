import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import { createTempGitRepo, cleanupTempGitRepo, createWorkspace } from "./helpers";
import { resolveOrpcClient } from "./helpers";
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

describeIntegration("executeBash", () => {
  test.concurrent(
    "should execute bash command in workspace context",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepo();

      try {
        // Create a workspace
        const createResult = await createWorkspace(env, tempGitRepo, "test-bash");
        const metadata = expectWorkspaceCreationSuccess(createResult);
        const workspaceId = metadata.id;
        const client = resolveOrpcClient(env);

        // Execute a simple bash command (pwd should return workspace path)
        const pwdResult = await client.workspace.executeBash({ workspaceId, script: "pwd" });

        expect(pwdResult.success).toBe(true);
        if (!pwdResult.success) return;
        expect(pwdResult.data.success).toBe(true);
        // Verify pwd output contains the workspace name (directories are named with workspace names)
        expect(pwdResult.data.output).toContain(metadata.name);
        expect(pwdResult.data.exitCode).toBe(0);

        // Clean up
        await client.workspace.remove({ workspaceId });
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
        const createResult = await createWorkspace(env, tempGitRepo, "test-git-status");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Execute git status
        const gitStatusResult = await client.workspace.executeBash({
          workspaceId,
          script: "git status",
        });

        expect(gitStatusResult.success).toBe(true);
        if (!gitStatusResult.success) return;
        expect(gitStatusResult.data.success).toBe(true);
        expect(gitStatusResult.data.output).toContain("On branch");
        expect(gitStatusResult.data.exitCode).toBe(0);

        // Clean up
        await client.workspace.remove({ workspaceId });
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
        const createResult = await createWorkspace(env, tempGitRepo, "test-failure");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Execute a command that will fail
        const failResult = await client.workspace.executeBash({
          workspaceId,
          script: "exit 42",
        });

        expect(failResult.success).toBe(true);
        if (!failResult.success) return;
        expect(failResult.data.success).toBe(false);
        if (!failResult.data.success) {
          expect(failResult.data.exitCode).toBe(42);
          expect(failResult.data.error).toContain("exited with code 42");
        }

        // Clean up
        await client.workspace.remove({ workspaceId });
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
        const createResult = await createWorkspace(env, tempGitRepo, "test-timeout");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Execute a command that takes longer than the timeout
        const timeoutResult = await client.workspace.executeBash({
          workspaceId,
          script: "while true; do sleep 0.1; done",
          options: { timeout_secs: 1 },
        });

        expect(timeoutResult.success).toBe(true);
        if (!timeoutResult.success) return;
        expect(timeoutResult.data.success).toBe(false);
        if (!timeoutResult.data.success) {
          expect(timeoutResult.data.error).toContain("timeout");
        }

        // Clean up
        await client.workspace.remove({ workspaceId });
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
        const createResult = await createWorkspace(env, tempGitRepo, "test-large-output");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Execute a command that generates 400 lines (well under 10K limit for IPC truncate policy)
        const result = await client.workspace.executeBash({
          workspaceId,
          script: "for i in {1..400}; do echo line$i; done",
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.success).toBe(true);
        expect(result.data.exitCode).toBe(0);
        // Should return all 400 lines without truncation
        const lineCount = result.data.output?.split("\n").length ?? 0;
        expect(lineCount).toBe(400);
        // Should not be truncated since 400 << 10,000
        expect(result.data.truncated).toBeUndefined();

        // Clean up
        await client.workspace.remove({ workspaceId });
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
        const client = resolveOrpcClient(env);
        const result = await client.workspace.executeBash({
          workspaceId: "nonexistent-workspace",
          script: "echo test",
        });

        expect(result.success).toBe(false);
        if (result.success) return;
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
        const createResult = await createWorkspace(env, tempGitRepo, "test-secrets");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Set secrets for the project
        await client.projects.secrets.update({
          projectPath: tempGitRepo,
          secrets: [
            { key: "TEST_SECRET_KEY", value: "secret_value_123" },
            { key: "ANOTHER_SECRET", value: "another_value_456" },
          ],
        });

        // Execute bash command that reads the environment variables
        const echoResult = await client.workspace.executeBash({
          workspaceId,
          script: 'echo "KEY=$TEST_SECRET_KEY ANOTHER=$ANOTHER_SECRET"',
        });

        expect(echoResult.success).toBe(true);
        if (!echoResult.success) return;
        expect(echoResult.data.success).toBe(true);
        expect(echoResult.data.output).toContain("KEY=secret_value_123");
        expect(echoResult.data.output).toContain("ANOTHER=another_value_456");
        expect(echoResult.data.exitCode).toBe(0);

        // Clean up
        await client.workspace.remove({ workspaceId });
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
        const createResult = await createWorkspace(env, tempGitRepo, "test-git-env");
        const workspaceId = expectWorkspaceCreationSuccess(createResult).id;
        const client = resolveOrpcClient(env);

        // Verify GIT_TERMINAL_PROMPT is set to 0
        const gitEnvResult = await client.workspace.executeBash({
          workspaceId,
          script: 'echo "GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT"',
        });

        expect(gitEnvResult.success).toBe(true);
        if (!gitEnvResult.success) return;
        expect(gitEnvResult.data.success).toBe(true);
        if (gitEnvResult.data.success) {
          expect(gitEnvResult.data.output).toContain("GIT_TERMINAL_PROMPT=0");
          expect(gitEnvResult.data.exitCode).toBe(0);
        }

        // Test 1: Verify that git fetch with invalid remote doesn't hang (should fail quickly)
        const invalidFetchResult = await client.workspace.executeBash({
          workspaceId,
          script:
            "git fetch https://invalid-remote-that-does-not-exist-12345.com/repo.git 2>&1 || true",
          options: { timeout_secs: 5 },
        });

        expect(invalidFetchResult.success).toBe(true);
        if (!invalidFetchResult.success) return;
        expect(invalidFetchResult.data.success).toBe(true);

        // Test 2: Verify git fetch to real GitHub org repo doesn't hang
        // Uses OpenAI org - will fail if no auth configured, but should fail quickly without prompting
        const githubFetchResult = await client.workspace.executeBash({
          workspaceId,
          script: "git fetch https://github.com/openai/private-test-repo-nonexistent 2>&1 || true",
          options: { timeout_secs: 5 },
        });

        // Should complete quickly (not hang waiting for credentials)
        expect(githubFetchResult.success).toBe(true);
        if (!githubFetchResult.success) return;
        // Command should complete within timeout - the "|| true" ensures success even if fetch fails
        expect(githubFetchResult.data.success).toBe(true);
        // Output should contain error message, not hang
        expect(githubFetchResult.data.output).toContain("fatal");

        // Clean up
        await client.workspace.remove({ workspaceId });
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );
});
