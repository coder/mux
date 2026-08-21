/**
 * Node adapter for the unified agent AI-settings resolver: reads agent
 * definitions, assembles the declared base chain, gathers configured defaults,
 * and delegates all precedence to the pure resolver. Owns missing-definition
 * and cycle logging so the pure layer stays side-effect free.
 */

import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type {
  AgentAiAncestorLayer,
  AgentAiDefinitionDefaults,
  AgentAiProfile,
  AgentAiSettingsLayerValues,
  ResolvedAgentAiSettings,
} from "@/common/types/agentAiSettings";
import type {
  OpenAIReasoningMode,
  ParsedThinkingInput,
  ThinkingLevel,
} from "@/common/types/thinking";
import { resolveAgentAiSettings } from "@/common/utils/ai/resolveAgentAiSettings";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";

import { readAgentDefinition } from "./agentDefinitionsService";
import { resolveAgentInheritanceChain } from "./resolveAgentInheritanceChain";

/** Checkout context for reading agent definitions; omit when unavailable. */
export interface NodeAgentDefinitionContext {
  runtime: Runtime;
  workspacePath: string;
  workspaceId: string;
}

export interface ResolveNodeAgentAiSettingsParams {
  agentId: string;
  profile: AgentAiProfile;
  cfg: {
    agentAiDefaults?: AgentAiDefaults;
    minThinkingLevelByModel?: Record<string, ThinkingLevel>;
  };
  providersConfig?: ProvidersConfigMap | null;
  explicit?: {
    model?: string;
    thinkingLevel?: ParsedThinkingInput;
    reasoningMode?: OpenAIReasoningMode;
  };
  targetWorkspaceSettings?: AgentAiSettingsLayerValues;
  parentRuntime?: AgentAiSettingsLayerValues;
  fallbacks?: readonly AgentAiSettingsLayerValues[];
  defaultModel?: string;
  /**
   * When present, target/ancestor definition `ai` defaults and the declared
   * base chain are read from the checkout. When absent (e.g. recovery paths
   * without a live runtime), resolution uses the implicit fallback ancestor
   * only.
   */
  definitionContext?: NodeAgentDefinitionContext;
}

function toDefinitionDefaults(
  ai: { model?: string; thinkingLevel?: ThinkingLevel } | undefined
): AgentAiDefinitionDefaults | undefined {
  if (!ai || (ai.model === undefined && ai.thinkingLevel === undefined)) {
    return undefined;
  }
  return { model: ai.model, thinkingLevel: ai.thinkingLevel };
}

async function loadDefinitionLayers(
  agentId: string,
  context: NodeAgentDefinitionContext | undefined
): Promise<{
  targetDefinitionAiDefaults?: AgentAiDefinitionDefaults;
  ancestors: AgentAiAncestorLayer[];
}> {
  if (!context) {
    return { ancestors: [] };
  }

  try {
    const agentDefinition = await readAgentDefinition(
      context.runtime,
      context.workspacePath,
      agentId
    );
    const chain = await resolveAgentInheritanceChain({
      runtime: context.runtime,
      workspacePath: context.workspacePath,
      agentId: agentDefinition.id,
      agentDefinition,
      workspaceId: context.workspaceId,
    });

    const targetDefinitionAiDefaults = toDefinitionDefaults(chain[0]?.ai);
    const ancestors: AgentAiAncestorLayer[] = [];
    const seen = new Set<string>([agentId, chain[0]?.id ?? agentId]);
    for (const entry of chain.slice(1)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      ancestors.push({
        agentId: entry.id,
        definitionAiDefaults: toDefinitionDefaults(entry.ai),
      });
    }

    return { targetDefinitionAiDefaults, ancestors };
  } catch (error) {
    // A missing or unreadable definition must not break resolution: fall back
    // to the implicit base the resolver appends on its own.
    log.debug("resolveNodeAgentAiSettings: definition chain unavailable", {
      agentId,
      workspaceId: context.workspaceId,
      error: getErrorMessage(error),
    });
    return { ancestors: [] };
  }
}

export async function resolveNodeAgentAiSettings(
  params: ResolveNodeAgentAiSettingsParams
): Promise<ResolvedAgentAiSettings> {
  const { targetDefinitionAiDefaults, ancestors } = await loadDefinitionLayers(
    params.agentId,
    params.definitionContext
  );

  const result = resolveAgentAiSettings({
    targetAgentId: params.agentId,
    profile: params.profile,
    explicit: params.explicit,
    targetWorkspaceSettings: params.targetWorkspaceSettings,
    agentAiDefaults: params.cfg.agentAiDefaults,
    targetDefinitionAiDefaults,
    ancestors,
    parentRuntime: params.parentRuntime,
    fallbacks: params.fallbacks,
    defaultModel: params.defaultModel,
    providersConfig: params.providersConfig,
    minThinkingLevelByModel: params.cfg.minThinkingLevelByModel,
  });

  for (const diagnostic of result.diagnostics) {
    log.debug("resolveNodeAgentAiSettings: " + diagnostic, { agentId: params.agentId });
  }

  return result;
}
