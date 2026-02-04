/**
 * Regression test: agent discovery endpoints should proxy remote workspaceIds.
 *
 * When a workspaceId is encoded (remote.*), local agent discovery would attempt to resolve
 * metadata via the local AIService and fail ("Workspace metadata not found...").
 *
 * The router should instead proxy agentSkills.* and agents.* requests to the remote mux server.
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

const TEST_TIMEOUT_MS = 60_000;

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
  "agentSkills.* and agents.* proxy remote workspaceIds",
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

      const branchName = generateBranchName("remote-agent-skills");
      const remoteCreate = await createWorkspace(remoteEnv, repoPath, branchName);
      if (!remoteCreate.success) {
        throw new Error(remoteCreate.error);
      }

      const encodedWorkspaceId = encodeRemoteWorkspaceId(serverId, remoteCreate.metadata.id);

      const listBefore = await localEnv.orpc.workspace.list();
      expect(listBefore.some((w) => w.id === encodedWorkspaceId)).toBe(true);

      const skills = await localEnv.orpc.agentSkills.list({ workspaceId: encodedWorkspaceId });
      expect(Array.isArray(skills)).toBe(true);
      expect(skills.length).toBeGreaterThan(0);

      const diagnostics = await localEnv.orpc.agentSkills.listDiagnostics({
        workspaceId: encodedWorkspaceId,
      });
      expect(Array.isArray(diagnostics.skills)).toBe(true);
      expect(diagnostics.skills.length).toBeGreaterThan(0);
      expect(Array.isArray(diagnostics.invalidSkills)).toBe(true);

      const firstSkill = skills[0];
      expect(firstSkill).toBeTruthy();
      expect(typeof firstSkill.name).toBe("string");

      const skillPkg = await localEnv.orpc.agentSkills.get({
        workspaceId: encodedWorkspaceId,
        skillName: firstSkill.name,
      });
      expect(skillPkg.frontmatter.name).toBe(firstSkill.name);
      expect(typeof skillPkg.body).toBe("string");

      const agents = await localEnv.orpc.agents.list({ workspaceId: encodedWorkspaceId });
      expect(Array.isArray(agents)).toBe(true);
      expect(agents.length).toBeGreaterThan(0);

      const firstAgent = agents[0];
      expect(firstAgent).toBeTruthy();
      expect(typeof firstAgent.id).toBe("string");

      const agentPkg = await localEnv.orpc.agents.get({
        workspaceId: encodedWorkspaceId,
        agentId: firstAgent.id,
      });
      expect(agentPkg.id).toBe(firstAgent.id);
      expect(typeof agentPkg.body).toBe("string");
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
