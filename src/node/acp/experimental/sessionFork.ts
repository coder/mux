import assert from "node:assert/strict";
import type { ForkSessionRequest, ForkSessionResponse } from "@agentclientprotocol/sdk";
import { isWorktreeRuntime, type RuntimeMode } from "@/common/types/runtime";
import type { NegotiatedCapabilities } from "../capabilities";
import { buildConfigOptions } from "../configOptions";
import { resolveAgentAiSettings, type ResolvedAiSettings } from "../resolveAgentAiSettings";
import type { ServerConnection } from "../serverConnection";
import type { SessionManager } from "../sessionManager";

type WorkspaceInfo = NonNullable<
  Awaited<ReturnType<ServerConnection["client"]["workspace"]["getInfo"]>>
>;

export interface ForkedSessionContext {
  sessionId: string;
  workspaceId: string;
  runtimeMode: RuntimeMode;
  agentId: string;
  aiSettings: ResolvedAiSettings;
  response: ForkSessionResponse;
}

export interface SessionForkDependencies {
  server: ServerConnection;
  sessionManager: SessionManager;
  negotiatedCapabilities: NegotiatedCapabilities | null;
  defaultAgentId: string;
  /** The source ACP session's current agent selection, if available. */
  sourceSessionAgentId?: string;
}

function resolveRuntimeMode(workspace: WorkspaceInfo): RuntimeMode {
  if (isWorktreeRuntime(workspace.runtimeConfig)) {
    return "worktree";
  }

  return workspace.runtimeConfig.type;
}

export async function forkSessionFromWorkspace(
  params: ForkSessionRequest,
  deps: SessionForkDependencies,
  newName?: string
): Promise<ForkedSessionContext> {
  const sourceSessionId = params.sessionId.trim();
  assert(sourceSessionId.length > 0, "forkSessionFromWorkspace: sessionId must be non-empty");

  const sourceWorkspaceId = deps.sessionManager.getWorkspaceId(sourceSessionId);
  const sourceWorkspace = await deps.server.client.workspace.getInfo({
    workspaceId: sourceWorkspaceId,
  });
  if (!sourceWorkspace) {
    throw new Error(
      `forkSessionFromWorkspace: source workspace '${sourceWorkspaceId}' was not found`
    );
  }

  const forkResult = await deps.server.client.workspace.fork({
    sourceWorkspaceId,
    newName,
  });
  if (!forkResult.success) {
    throw new Error(`forkSessionFromWorkspace: workspace.fork failed: ${forkResult.error}`);
  }

  const workspaceId = forkResult.metadata.id;
  const sessionId = workspaceId;
  const runtimeMode = resolveRuntimeMode(forkResult.metadata);

  deps.sessionManager.registerSession(
    sessionId,
    workspaceId,
    runtimeMode,
    deps.negotiatedCapabilities ?? undefined
  );

  // Prefer the source ACP session's active agent selection over workspace
  // metadata, so forks inherit the mode the user switched to in-session.
  const agentId = deps.sourceSessionAgentId ?? sourceWorkspace.agentId ?? deps.defaultAgentId;
  const aiSettings = await resolveAgentAiSettings(deps.server.client, agentId, workspaceId);
  const configOptions = await buildConfigOptions(deps.server.client, workspaceId, {
    activeAgentId: agentId,
  });

  return {
    sessionId,
    workspaceId,
    runtimeMode,
    agentId,
    aiSettings,
    response: {
      sessionId,
      configOptions,
    },
  };
}
