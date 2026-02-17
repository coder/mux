import assert from "node:assert/strict";
import type { LoadSessionRequest, LoadSessionResponse } from "@agentclientprotocol/sdk";
import { isWorktreeRuntime, type RuntimeMode } from "@/common/types/runtime";
import type { NegotiatedCapabilities } from "../capabilities";
import { buildConfigOptions } from "../configOptions";
import { resolveAgentAiSettings, type ResolvedAiSettings } from "../resolveAgentAiSettings";
import type { ServerConnection } from "../serverConnection";
import type { SessionManager } from "../sessionManager";
import type { ToolRouter } from "../toolRouter";

type WorkspaceInfo = NonNullable<
  Awaited<ReturnType<ServerConnection["client"]["workspace"]["getInfo"]>>
>;

export interface ResumedSessionContext {
  sessionId: string;
  workspaceId: string;
  runtimeMode: RuntimeMode;
  agentId: string;
  aiSettings: ResolvedAiSettings;
  response: LoadSessionResponse;
}

export interface SessionResumeDependencies {
  server: ServerConnection;
  sessionManager: SessionManager;
  toolRouter: ToolRouter;
  negotiatedCapabilities: NegotiatedCapabilities | null;
  defaultAgentId: string;
}

function resolveRuntimeMode(workspace: WorkspaceInfo): RuntimeMode {
  if (isWorktreeRuntime(workspace.runtimeConfig)) {
    return "worktree";
  }

  return workspace.runtimeConfig.type;
}

export async function loadSessionFromWorkspace(
  params: LoadSessionRequest,
  deps: SessionResumeDependencies
): Promise<ResumedSessionContext> {
  const requestedSessionId = params.sessionId.trim();
  assert(requestedSessionId.length > 0, "loadSessionFromWorkspace: sessionId must be non-empty");

  const workspace = await deps.server.client.workspace.getInfo({ workspaceId: requestedSessionId });
  if (!workspace) {
    throw new Error(`loadSessionFromWorkspace: workspace '${requestedSessionId}' was not found`);
  }

  const workspaceId = workspace.id;
  const runtimeMode = resolveRuntimeMode(workspace);

  deps.sessionManager.registerSession(
    requestedSessionId,
    workspaceId,
    runtimeMode,
    deps.negotiatedCapabilities ?? undefined
  );
  deps.toolRouter.registerSession(requestedSessionId, runtimeMode);

  const agentId = workspace.agentId ?? deps.defaultAgentId;
  const aiSettings =
    workspace.aiSettingsByAgent?.[agentId] ??
    workspace.aiSettings ??
    (await resolveAgentAiSettings(deps.server.client, agentId, workspaceId));

  const configOptions = await buildConfigOptions(deps.server.client, workspaceId);

  return {
    sessionId: requestedSessionId,
    workspaceId,
    runtimeMode,
    agentId,
    aiSettings,
    response: {
      configOptions,
    },
  };
}
