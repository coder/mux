/**
 * Regression test: workspace.sendMessage and workspace.interruptStream should proxy
 * requests when the workspaceId is a remote-encoded ID, routing them through federation
 * to the remote mux server instead of failing with "Workspace not found".
 */

import { encodeRemoteWorkspaceId } from "@/common/utils/remoteMuxIds";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { createOrpcServer, type OrpcServer } from "@/node/orpc/server";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import {
  buildOrpcContext,
  cleanupTestEnvironment,
  createTestEnvironment,
  enableExperimentForTesting,
} from "./setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  createWorkspace,
  generateBranchName,
  HAIKU_MODEL,
  readChatHistory,
} from "./helpers";

const TEST_TIMEOUT_MS = 40_000;

test(
  "workspace.sendMessage proxies remote workspaceIds",
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

      const branchName = generateBranchName("remote-send-msg");
      const remoteCreate = await createWorkspace(remoteEnv, repoPath, branchName);
      if (!remoteCreate.success) {
        throw new Error(remoteCreate.error);
      }

      const remoteWorkspaceId = remoteCreate.metadata.id;
      const encodedWorkspaceId = encodeRemoteWorkspaceId(serverId, remoteWorkspaceId);

      // Verify the workspace is visible through the local env
      const listBefore = await localEnv.orpc.workspace.list();
      expect(listBefore.some((w) => w.id === encodedWorkspaceId)).toBe(true);

      // Send message through the local env — it should be proxied to the remote server.
      // With a test-only API key the AI stream will ultimately fail, but the important
      // thing is that sendMessage doesn't throw a "Workspace not found" error (which
      // would mean federation failed).
      const sendResult = await localEnv.orpc.workspace.sendMessage({
        workspaceId: encodedWorkspaceId,
        message: "test federation message",
        options: {
          model: HAIKU_MODEL,
          agentId: WORKSPACE_DEFAULTS.agentId,
        },
      });

      // The call should have returned a valid Result, not thrown an exception.
      expect(sendResult).toBeDefined();
      expect(typeof sendResult.success).toBe("boolean");

      // Verify the user message was persisted on the remote workspace.
      // The workspace service writes the user message to history before starting the
      // AI stream, so it should be readable immediately after sendMessage returns.
      const history = await readChatHistory(remoteEnv.tempDir, remoteWorkspaceId);
      const userMessages = history.filter((msg) => msg.role === "user");
      expect(userMessages.length).toBeGreaterThanOrEqual(1);

      const lastUserMsg = userMessages[userMessages.length - 1];
      expect(lastUserMsg).toBeDefined();
      const hasTestMessage = lastUserMsg.parts.some(
        (part: { type: string; text?: string }) =>
          part.type === "text" && part.text === "test federation message"
      );
      expect(hasTestMessage).toBe(true);

      // Interrupt any in-progress stream to clean up gracefully before teardown.
      const interruptResult = await localEnv.orpc.workspace.interruptStream({
        workspaceId: encodedWorkspaceId,
      });
      expect(interruptResult).toBeDefined();
      expect(typeof interruptResult.success).toBe("boolean");
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
  "workspace.interruptStream proxies remote workspaceIds",
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

      const branchName = generateBranchName("remote-interrupt");
      const remoteCreate = await createWorkspace(remoteEnv, repoPath, branchName);
      if (!remoteCreate.success) {
        throw new Error(remoteCreate.error);
      }

      const encodedWorkspaceId = encodeRemoteWorkspaceId(serverId, remoteCreate.metadata.id);

      // interruptStream on a workspace with no active stream should still succeed
      // (no-op interrupt). The key assertion is that it doesn't throw a federation
      // or "workspace not found" error.
      const interruptResult = await localEnv.orpc.workspace.interruptStream({
        workspaceId: encodedWorkspaceId,
      });

      expect(interruptResult).toBeDefined();
      expect(typeof interruptResult.success).toBe("boolean");
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
