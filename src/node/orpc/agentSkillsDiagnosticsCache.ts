import {
  AgentSkillTransientDiscoveryError,
  type DiscoverAgentSkillsDiagnosticsResult,
} from "@/node/services/agentSkills/agentSkillsService";
import { log } from "@/node/services/log";

export interface AgentSkillsDiscoveryCacheInput {
  projectPath?: string;
  workspaceId?: string;
  disableWorkspaceAgents?: boolean;
}

export function getAgentSkillsDiscoveryCacheKey(input: AgentSkillsDiscoveryCacheInput): string {
  const disableWorkspaceAgents = input.disableWorkspaceAgents === true ? "1" : "0";

  if (input.workspaceId) {
    return `workspace:${input.workspaceId}:disableWorkspaceAgents:${disableWorkspaceAgents}`;
  }

  if (input.projectPath) {
    return `project:${input.projectPath}:disableWorkspaceAgents:${disableWorkspaceAgents}`;
  }

  throw new Error("Either projectPath or workspaceId must be provided");
}

export async function loadAgentSkillsDiagnosticsWithFallback(args: {
  cache: Map<string, DiscoverAgentSkillsDiagnosticsResult>;
  cacheKey: string;
  discover: () => Promise<DiscoverAgentSkillsDiagnosticsResult>;
}): Promise<DiscoverAgentSkillsDiagnosticsResult> {
  try {
    const diagnostics = await args.discover();
    args.cache.set(args.cacheKey, diagnostics);
    return diagnostics;
  } catch (error) {
    if (error instanceof AgentSkillTransientDiscoveryError) {
      const cached = args.cache.get(args.cacheKey);
      // During SSH hiccups we prefer a stale-but-correct snapshot over surfacing false invalid-skill diagnostics.
      if (cached) {
        log.warn(
          `Agent skill diagnostics discovery transiently failed for ${args.cacheKey}; using cached result: ${error.message}`
        );
        return cached;
      }
    }

    throw error;
  }
}
