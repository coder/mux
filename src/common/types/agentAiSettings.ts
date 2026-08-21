/**
 * Shared contract for the unified agent AI-settings resolver.
 *
 * One field-wise precedence order (implemented in
 * src/common/utils/ai/resolveAgentAiSettings.ts) covers every execution
 * surface: interactive turns, delegated tasks, goals, heartbeats, compaction,
 * startup recovery, ACP, and CLI. Adapters gather these inputs from their
 * environment; the pure resolver only chooses values.
 */

import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { AgentAiDefaults } from "./agentAiDefaults";
import type { OpenAIReasoningMode, ParsedThinkingInput, ThinkingLevel } from "./thinking";

/**
 * Which configured profile applies: "subagent" (delegated task runs) reads an
 * agent's sparse `subagent` override profile before its base fields;
 * "interactive" ignores the delegated profile entirely.
 */
export type AgentAiProfile = "interactive" | "subagent";

/** One candidate layer's field values, already gathered by an adapter. */
export interface AgentAiSettingsLayerValues {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  reasoningMode?: OpenAIReasoningMode;
}

/** Agent-definition frontmatter `ai` block defaults. */
export interface AgentAiDefinitionDefaults {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export type AiSettingTier =
  | "explicit"
  | "workspace"
  | "config-subagent"
  | "config"
  | "definition"
  | "parent-runtime"
  | "fallback"
  | "default";

export interface AiSettingSource {
  tier: AiSettingTier;
  /** For config/definition tiers: the agent whose entry supplied the value. */
  agentId?: string;
}

export interface AgentAiAncestorLayer {
  agentId: string;
  /**
   * Implicit ancestors (the plan->plan / exec fallback appended when a declared
   * chain ends without a base) contribute reasoningMode only, so switching to
   * an unconfigured agent inherits pro/standard without yanking model or
   * thinking to the fallback agent's configured defaults.
   */
  declared: boolean;
  definitionAiDefaults?: AgentAiDefinitionDefaults;
}

export interface ResolveAgentAiSettingsInput {
  targetAgentId: string;
  profile: AgentAiProfile;
  /** Tier 1: explicit invocation overrides (tool args, CLI flags, slash commands). */
  explicit?: {
    model?: string;
    thinkingLevel?: ParsedThinkingInput;
    reasoningMode?: OpenAIReasoningMode;
  };
  /** Tier 2: the target workspace's per-agent bucket (existing target workspaces only). */
  targetWorkspaceSettings?: AgentAiSettingsLayerValues;
  /** Tiers 3 and 5: canonical configured defaults map. */
  agentAiDefaults?: AgentAiDefaults;
  /** Tier 4: the target agent's definition frontmatter `ai` block. */
  targetDefinitionAiDefaults?: AgentAiDefinitionDefaults;
  /** Tier 5: ancestors ordered child to root, excluding the target itself. */
  ancestors?: readonly AgentAiAncestorLayer[];
  /** Tier 6: ephemeral parent runtime settings for a newly spawned task or continuation. */
  parentRuntime?: AgentAiSettingsLayerValues;
  /** Tier 7: root workspace or activity fallbacks, highest priority first. */
  fallbacks?: readonly AgentAiSettingsLayerValues[];
  /** Tier 8: system fallback model; DEFAULT_MODEL when omitted. */
  defaultModel?: string;
  providersConfig?: ProvidersConfigMap | null;
  /** Per-model minimum thinking floors (config.minThinkingLevelByModel). */
  minThinkingLevelByModel?: Record<string, ThinkingLevel>;
  /**
   * Route-aware pro-mode availability computed by the adapter. When omitted the
   * resolver falls back to providersConfig-based capability gating.
   */
  proModeAvailable?: boolean;
}

export interface ResolvedAgentAiSettings {
  /** The user's or inherited preference; what persistence stores. */
  selected: {
    model: string;
    thinkingLevel: ThinkingLevel;
    reasoningMode?: OpenAIReasoningMode;
  };
  /** Provider-safe values after normalization, clamping, and capability gating. */
  effective: {
    model: string;
    thinkingLevel: ThinkingLevel;
    reasoningMode?: OpenAIReasoningMode;
  };
  sources: {
    model: AiSettingSource;
    thinkingLevel: AiSettingSource;
    reasoningMode?: AiSettingSource;
  };
  adjustments: {
    thinkingClamped: boolean;
    reasoningUnavailable: boolean;
  };
  /** Skipped-candidate notes for adapters to log; never logged here. */
  diagnostics: string[];
}
