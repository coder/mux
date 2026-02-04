/**
 * Regression test: archiving/unarchiving a remote workspace via an encoded workspaceId should
 * proxy the request to the remote mux server instead of failing with "Workspace not found".
 */

import { encodeRemoteWorkspaceId } from "@/common/utils/remoteMuxIds";
import type { ORPCContext } from "@/node/orpc/context";
import { createOrpcServer, type OrpcServer } from "@/node/orpc/server";
import type { TestEnvironment } from "./setup";
import { cleanupTestEnvironment, createTestEnvironment } from "./setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  createWorkspace,
  generateBranchName,
} from "./helpers";

const TEST_TIMEOUT_MS = 40_000;

function buildOrpcContext(env: TestEnvironment): ORPCContext {
  return {
    config: env.services.config,
    aiService: env.services.aiService,
    projectService: env.services.projectService,
    workspaceService: env.services.workspaceService,
    muxGatewayOauthService: env.services.muxGatewayOauthService,
    muxGovernorOauthService: env.services.muxGovernorOauthService,
    taskService: env.services.taskService,
    providerService: env.services.providerService,
    terminalService: env.services.terminalService,
    editorService: env.services.editorService,
    windowService: env.services.windowService,
    updateService: env.services.updateService,
    tokenizerService: env.services.tokenizerService,
    serverService: env.services.serverService,
    remoteServersService: env.services.remoteServersService,
    featureFlagService: env.services.featureFlagService,
    workspaceMcpOverridesService: env.services.workspaceMcpOverridesService,
    sessionTimingService: env.services.sessionTimingService,
    mcpConfigService: env.services.mcpConfigService,
    mcpOauthService: env.services.mcpOauthService,
    mcpServerManager: env.services.mcpServerManager,
    menuEventService: env.services.menuEventService,
    voiceService: env.services.voiceService,
    experimentsService: env.services.experimentsService,
    telemetryService: env.services.telemetryService,
    sessionUsageService: env.services.sessionUsageService,
    signingService: env.services.signingService,
    coderService: env.services.coderService,
    policyService: env.services.policyService,
  };
}

test(
  "workspace.archive + workspace.unarchive proxy remote workspaceIds",
  async () => {
    const localEnv = await createTestEnvironment();
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
