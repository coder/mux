/**
 * Regression test: terminal.listSessions, terminal.create, terminal.sendInput, and
 * terminal.close should proxy requests through federation when the workspaceId or
 * sessionId is a remote-encoded ID.
 *
 * The federation middleware rewrites both workspaceId and sessionId (both are in
 * FEDERATION_ID_KEYS) so that the remote server receives bare IDs and the local
 * caller receives re-encoded IDs.
 *
 * Tests that spawn real PTY processes (create/sendInput/close) are gated behind
 * TEST_INTEGRATION=1 because node-pty throws async ESPIPE errors in bun's
 * non-integration test runner environment.
 */

import { encodeRemoteWorkspaceId } from "@/common/utils/remoteMuxIds";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { createOrpcServer, type OrpcServer } from "@/node/orpc/server";
import {
  buildOrpcContext,
  cleanupTestEnvironment,
  createTestEnvironment,
  enableExperimentForTesting,
  shouldRunIntegrationTests,
} from "./setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  createWorkspace,
  generateBranchName,
} from "./helpers";

const TEST_TIMEOUT_MS = 40_000;

// terminal.listSessions does NOT spawn PTY processes, so it works in all environments.
test(
  "terminal.listSessions proxies remote workspaceIds",
  async () => {
    const localEnv = await createTestEnvironment();
    enableExperimentForTesting(localEnv, EXPERIMENT_IDS.REMOTE_MUX_SERVERS);
    const remoteEnv = await createTestEnvironment();
    const repoPath = await createTempGitRepo();

    let remoteServer: OrpcServer | null = null;

    try {
      remoteServer = await createOrpcServer({
        context: buildOrpcContext(remoteEnv),
        host: "127.0.0.1",
        port: 0,
      });

      const serverId = "remote-test";

      const upsertResult = await localEnv.orpc.remoteServers.upsert({
        config: {
          id: serverId,
          label: "Remote test",
          baseUrl: remoteServer.baseUrl,
          projectMappings: [{ localProjectPath: repoPath, remoteProjectPath: repoPath }],
        },
      });

      if (!upsertResult.success) {
        throw new Error(upsertResult.error);
      }

      const branchName = generateBranchName("remote-terminal-list");
      const remoteCreate = await createWorkspace(remoteEnv, repoPath, branchName);
      if (!remoteCreate.success) {
        throw new Error(remoteCreate.error);
      }

      const encodedWorkspaceId = encodeRemoteWorkspaceId(serverId, remoteCreate.metadata.id);

      // Verify workspace is visible through the local env
      const listBefore = await localEnv.orpc.workspace.list();
      expect(listBefore.some((w) => w.id === encodedWorkspaceId)).toBe(true);

      // listSessions on a workspace with no active terminals should return an empty
      // array. The key assertion is that the call is proxied through federation to
      // the remote (not failing with "workspace not found" locally).
      const sessions = await localEnv.orpc.terminal.listSessions({
        workspaceId: encodedWorkspaceId,
      });
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBe(0);
    } finally {
      if (remoteServer) {
        await remoteServer.close();
      }

      await cleanupTestEnvironment(remoteEnv);
      await cleanupTestEnvironment(localEnv);
      await cleanupTempGitRepo(repoPath);
    }
  },
  TEST_TIMEOUT_MS
);

// Tests below require real PTY processes (node-pty), which throw async ESPIPE errors
// in bun's non-integration test runner. Gate on TEST_INTEGRATION=1.
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("terminal federation (PTY)", () => {
  test(
    "terminal.create returns remote-encoded sessionId for remote workspaceIds",
    async () => {
      const localEnv = await createTestEnvironment();
      enableExperimentForTesting(localEnv, EXPERIMENT_IDS.REMOTE_MUX_SERVERS);
      const remoteEnv = await createTestEnvironment();
      const repoPath = await createTempGitRepo();

      let remoteServer: OrpcServer | null = null;

      try {
        remoteServer = await createOrpcServer({
          context: buildOrpcContext(remoteEnv),
          host: "127.0.0.1",
          port: 0,
        });

        const serverId = "remote-test";

        const upsertResult = await localEnv.orpc.remoteServers.upsert({
          config: {
            id: serverId,
            label: "Remote test",
            baseUrl: remoteServer.baseUrl,
            projectMappings: [{ localProjectPath: repoPath, remoteProjectPath: repoPath }],
          },
        });

        if (!upsertResult.success) {
          throw new Error(upsertResult.error);
        }

        const branchName = generateBranchName("remote-terminal-create");
        const remoteCreate = await createWorkspace(remoteEnv, repoPath, branchName);
        if (!remoteCreate.success) {
          throw new Error(remoteCreate.error);
        }

        const encodedWorkspaceId = encodeRemoteWorkspaceId(serverId, remoteCreate.metadata.id);

        // Create terminal session through local env — should be proxied to remote
        const session = await localEnv.orpc.terminal.create({
          workspaceId: encodedWorkspaceId,
          cols: 80,
          rows: 24,
        });

        // The returned sessionId should be remote-encoded (starts with "remote.")
        // because the federation middleware re-encodes all FEDERATION_ID_KEYS in the output.
        expect(session.sessionId).toBeDefined();
        expect(session.sessionId.startsWith("remote.")).toBe(true);

        // The returned workspaceId should also be remote-encoded
        expect(session.workspaceId).toBeDefined();
        expect(session.workspaceId.startsWith("remote.")).toBe(true);

        // listSessions should include the newly created session (remote-encoded)
        const sessions = await localEnv.orpc.terminal.listSessions({
          workspaceId: encodedWorkspaceId,
        });
        expect(sessions.length).toBeGreaterThan(0);
        expect(sessions.every((id: string) => id.startsWith("remote."))).toBe(true);
        expect(sessions).toContain(session.sessionId);

        // Clean up the terminal session
        await localEnv.orpc.terminal.close({ sessionId: session.sessionId });
      } finally {
        if (remoteServer) {
          await remoteServer.close();
        }

        await cleanupTestEnvironment(remoteEnv);
        await cleanupTestEnvironment(localEnv);
        await cleanupTempGitRepo(repoPath);
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "terminal.sendInput and terminal.close proxy remote-encoded sessionIds",
    async () => {
      const localEnv = await createTestEnvironment();
      enableExperimentForTesting(localEnv, EXPERIMENT_IDS.REMOTE_MUX_SERVERS);
      const remoteEnv = await createTestEnvironment();
      const repoPath = await createTempGitRepo();

      let remoteServer: OrpcServer | null = null;

      try {
        remoteServer = await createOrpcServer({
          context: buildOrpcContext(remoteEnv),
          host: "127.0.0.1",
          port: 0,
        });

        const serverId = "remote-test";

        const upsertResult = await localEnv.orpc.remoteServers.upsert({
          config: {
            id: serverId,
            label: "Remote test",
            baseUrl: remoteServer.baseUrl,
            projectMappings: [{ localProjectPath: repoPath, remoteProjectPath: repoPath }],
          },
        });

        if (!upsertResult.success) {
          throw new Error(upsertResult.error);
        }

        const branchName = generateBranchName("remote-terminal-io");
        const remoteCreate = await createWorkspace(remoteEnv, repoPath, branchName);
        if (!remoteCreate.success) {
          throw new Error(remoteCreate.error);
        }

        const encodedWorkspaceId = encodeRemoteWorkspaceId(serverId, remoteCreate.metadata.id);

        // Create terminal session
        const session = await localEnv.orpc.terminal.create({
          workspaceId: encodedWorkspaceId,
          cols: 80,
          rows: 24,
        });

        expect(session.sessionId.startsWith("remote.")).toBe(true);

        // sendInput with the remote-encoded sessionId should not throw.
        // The federation middleware decodes the sessionId before proxying.
        await expect(
          localEnv.orpc.terminal.sendInput({
            sessionId: session.sessionId,
            data: "echo hello\n",
          })
        ).resolves.toBeUndefined();

        // close with the remote-encoded sessionId should not throw
        await expect(
          localEnv.orpc.terminal.close({ sessionId: session.sessionId })
        ).resolves.toBeUndefined();

        // After close, listSessions should not contain the closed session
        const sessionsAfterClose = await localEnv.orpc.terminal.listSessions({
          workspaceId: encodedWorkspaceId,
        });
        expect(sessionsAfterClose).not.toContain(session.sessionId);
      } finally {
        if (remoteServer) {
          await remoteServer.close();
        }

        await cleanupTestEnvironment(remoteEnv);
        await cleanupTestEnvironment(localEnv);
        await cleanupTempGitRepo(repoPath);
      }
    },
    TEST_TIMEOUT_MS
  );
});
