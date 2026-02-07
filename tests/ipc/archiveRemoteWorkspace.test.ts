/**
 * Regression test: archiving/unarchiving a remote workspace via an encoded workspaceId should
 * proxy the request to the remote mux server instead of failing with "Workspace not found".
 */

import { encodeRemoteWorkspaceId } from "@/common/utils/remoteMuxIds";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { createOrpcServer, type OrpcServer } from "@/node/orpc/server";
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
} from "./helpers";

const TEST_TIMEOUT_MS = 40_000;

test(
  "workspace.archive + workspace.unarchive proxy remote workspaceIds",
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

      const branchName = generateBranchName("remote-archive");
      const remoteCreate = await createWorkspace(remoteEnv, repoPath, branchName);
      if (!remoteCreate.success) {
        throw new Error(remoteCreate.error);
      }

      const encodedWorkspaceId = encodeRemoteWorkspaceId(serverId, remoteCreate.metadata.id);

      const listBefore = await localEnv.orpc.workspace.list();
      expect(listBefore.some((w) => w.id === encodedWorkspaceId)).toBe(true);

      const archiveResult = await localEnv.orpc.workspace.archive({
        workspaceId: encodedWorkspaceId,
      });
      if (!archiveResult.success) {
        throw new Error(archiveResult.error);
      }

      const listUnarchived = await localEnv.orpc.workspace.list({ archived: false });
      expect(listUnarchived.some((w) => w.id === encodedWorkspaceId)).toBe(false);

      const listArchived = await localEnv.orpc.workspace.list({ archived: true });
      expect(listArchived.some((w) => w.id === encodedWorkspaceId)).toBe(true);

      const unarchiveResult = await localEnv.orpc.workspace.unarchive({
        workspaceId: encodedWorkspaceId,
      });
      if (!unarchiveResult.success) {
        throw new Error(unarchiveResult.error);
      }

      const listAfter = await localEnv.orpc.workspace.list({ archived: false });
      expect(listAfter.some((w) => w.id === encodedWorkspaceId)).toBe(true);
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
