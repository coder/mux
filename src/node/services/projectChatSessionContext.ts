import type { Config } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import type { ProjectChatInfo } from "@/common/types/project";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { PROJECT_CHAT_AGENT_ID } from "@/common/constants/projectChat";
import { isProjectTrusted } from "@/node/utils/projectTrust";

/** Backend-only execution context for a Project Chat virtual session. */
export interface ProjectChatSessionContext {
  info: ProjectChatInfo;
  metadata: FrontendWorkspaceMetadata;
  runtime: Runtime;
  workspacePath: string;
  trusted: boolean;
  fixedBuiltInAgentId: typeof PROJECT_CHAT_AGENT_ID;
}

export function resolveProjectChatSessionContext(
  config: Config,
  sessionId: string
): ProjectChatSessionContext | null {
  const info = config.findProjectChatBySessionId(sessionId);
  if (info == null) {
    return null;
  }

  return {
    info,
    metadata: info.metadata,
    runtime: new LocalRuntime(info.projectPath),
    workspacePath: info.projectPath,
    trusted: isProjectTrusted(config, info.projectPath),
    fixedBuiltInAgentId: PROJECT_CHAT_AGENT_ID,
  };
}
