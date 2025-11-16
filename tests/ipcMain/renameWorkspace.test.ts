/**
 * Integration tests for WORKSPACE_RENAME IPC handler
 *
 * Tests both LocalRuntime and SSHRuntime without mocking to verify:
 * - Workspace renaming mechanics (git worktree mv, directory mv)
 * - Config updates (workspace path, name, stable IDs)
 * - Error handling (name conflicts, validation)
 * - Parity between runtime implementations
 *
 * Uses real IPC handlers, real git operations, and Docker SSH server.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import type { TestEnvironment } from "./setup";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  createWorkspaceWithInit,
  INIT_HOOK_WAIT_MS,
  SSH_INIT_WAIT_MS,
  TEST_TIMEOUT_SSH_MS,
} from "./helpers";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../runtime/ssh-fixture";
import type { RuntimeConfig } from "../../src/common/types/runtime";

const execAsync = promisify(exec);

// Test constants
const TEST_TIMEOUT_MS = TEST_TIMEOUT_SSH_MS; // Use SSH timeout for consistency

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// SSH server config (shared across all SSH tests)
let sshConfig: SSHServerConfig | undefined;

// ============================================================================
// Tests
// ============================================================================

describeIntegration("WORKSPACE_RENAME with both runtimes", () => {
  beforeAll(async () => {
    // Check if Docker is available (required for SSH tests)
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH runtime tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    // Start SSH server (shared across all tests for speed)
    console.log("Starting SSH server container for renameWorkspace tests...");
    sshConfig = await startSSHServer();
    console.log(`SSH server ready on port ${sshConfig.port}`);
  }, 60000); // 60s timeout for Docker operations

  afterAll(async () => {
    if (sshConfig) {
      console.log("Stopping SSH server container...");
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  // Test matrix: Run tests for both local and SSH runtimes
  describe.each<{ type: "local" | "ssh" }>([{ type: "local" }, { type: "ssh" }])(
    "Runtime: $type",
    ({ type }) => {
      // Helper to build runtime config
      const getRuntimeConfig = (branchName: string): RuntimeConfig | undefined => {
        if (type === "ssh" && sshConfig) {
          return {
            type: "ssh",
            host: `testuser@localhost`,
            srcBaseDir: sshConfig.workdir,
            identityFile: sshConfig.privateKeyPath,
            port: sshConfig.port,
          };
        }
        return undefined; // undefined = defaults to local
      };

      // Get runtime-specific init wait time (SSH needs more time for rsync)
      const getInitWaitTime = () => (type === "ssh" ? SSH_INIT_WAIT_MS : INIT_HOOK_WAIT_MS);

      test.concurrent(
        "should successfully rename workspace and update all paths",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            const branchName = generateBranchName("rename-test");
            const runtimeConfig = getRuntimeConfig(branchName);

            // Create workspace and wait for init
            const { workspaceId, workspacePath, cleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            const oldWorkspacePath = workspacePath;
            const oldSessionDir = env.config.getSessionDir(workspaceId);

            // Clear events before rename
            env.sentEvents.length = 0;

            // Rename the workspace
            const newName = "renamed-branch";
            const renameResult = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_RENAME,
              workspaceId,
              newName
            );

            if (!renameResult.success) {
              console.error("Rename failed:", renameResult.error);
            }
            expect(renameResult.success).toBe(true);

            // Get new workspace ID from backend (NEVER construct it in frontend)
            expect(renameResult.data?.newWorkspaceId).toBeDefined();
            const newWorkspaceId = renameResult.data.newWorkspaceId;

            // With stable IDs, workspace ID should NOT change during rename
            expect(newWorkspaceId).toBe(workspaceId);

            // Session directory should still be the same (stable IDs don't move directories)
            const sessionDir = env.config.getSessionDir(workspaceId);
            expect(sessionDir).toBe(oldSessionDir);

            // Verify metadata was updated (name changed, path changed, but ID stays the same)
            const newMetadataResult = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_GET_INFO,
              workspaceId // Use same workspace ID
            );
            expect(newMetadataResult).toBeTruthy();
            expect(newMetadataResult.id).toBe(workspaceId); // ID unchanged
            expect(newMetadataResult.name).toBe(newName); // Name updated

            // Path DOES change (directory is renamed from old name to new name)
            const newWorkspacePath = newMetadataResult.namedWorkspacePath;
            expect(newWorkspacePath).not.toBe(oldWorkspacePath);
            expect(newWorkspacePath).toContain(newName); // New path includes new name

            // Verify config was updated with new path
            const config = env.config.loadConfigOrDefault();
            let foundWorkspace = false;
            for (const [, projectConfig] of config.projects.entries()) {
              const workspace = projectConfig.workspaces.find((w) => w.path === newWorkspacePath);
              if (workspace) {
                foundWorkspace = true;
                expect(workspace.name).toBe(newName); // Name updated in config
                expect(workspace.id).toBe(workspaceId); // ID unchanged
                break;
              }
            }
            expect(foundWorkspace).toBe(true);

            // Verify metadata event was emitted (update existing workspace)
            const metadataEvents = env.sentEvents.filter(
              (e) => e.channel === IPC_CHANNELS.WORKSPACE_METADATA
            );
            expect(metadataEvents.length).toBe(1);

            await cleanup();
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        TEST_TIMEOUT_MS
      );

      test.concurrent(
        "should fail to rename if new name conflicts with existing workspace",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            const branchName = generateBranchName("first");
            const secondBranchName = generateBranchName("second");
            const runtimeConfig = getRuntimeConfig(branchName);

            // Create first workspace
            const { workspaceId: firstWorkspaceId, cleanup: firstCleanup } =
              await createWorkspaceWithInit(
                env,
                tempGitRepo,
                branchName,
                runtimeConfig,
                true, // waitForInit
                type === "ssh"
              );

            // Create second workspace
            const { cleanup: secondCleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              secondBranchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            // Try to rename first workspace to the second workspace's name
            const renameResult = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_RENAME,
              firstWorkspaceId,
              secondBranchName
            );
            expect(renameResult.success).toBe(false);
            expect(renameResult.error).toContain("already exists");

            // Verify original workspace still exists and wasn't modified
            const metadataResult = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_GET_INFO,
              firstWorkspaceId
            );
            expect(metadataResult).toBeTruthy();
            expect(metadataResult.id).toBe(firstWorkspaceId);

            await firstCleanup();
            await secondCleanup();
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        TEST_TIMEOUT_MS
      );
    }
  );
});
