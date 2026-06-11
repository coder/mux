import { z } from "zod";

import { AgentIdSchema, RuntimeEnablementIdSchema } from "../../schemas/ids";
import { ProjectConfigSchema } from "../../schemas/project";
import { RuntimeEnablementOverridesSchema } from "../../schemas/runtimeEnablement";
import { ThinkingLevelSchema } from "../../types/thinking";
import { CODER_ARCHIVE_BEHAVIORS } from "../coderArchiveBehavior";
import { WORKTREE_ARCHIVE_BEHAVIORS } from "../worktreeArchiveBehavior";
import { UserPreferencesSchema } from "./userPreferences";
import { TaskSettingsSchema } from "./taskSettings";
import { HEARTBEAT_MAX_INTERVAL_MS, HEARTBEAT_MIN_INTERVAL_MS } from "@/constants/heartbeat";
import { DEFAULT_GOAL_DEFAULTS } from "@/constants/goals";

export { RuntimeEnablementOverridesSchema } from "../../schemas/runtimeEnablement";
export type { RuntimeEnablementOverrides } from "../../schemas/runtimeEnablement";
export { UserPreferencesSchema } from "./userPreferences";
export type { UserPreferences } from "./userPreferences";
export { TaskSettingsSchema } from "./taskSettings";
export type { TaskSettings } from "./taskSettings";

export const AgentAiDefaultsEntrySchema = z.object({
  modelString: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  enabled: z.boolean().optional(),
  advisorEnabled: z.boolean().optional(),
});

export const AgentAiDefaultsSchema = z.record(AgentIdSchema, AgentAiDefaultsEntrySchema);

export const SubagentAiDefaultsEntrySchema = z.object({
  modelString: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});

export const SubagentAiDefaultsSchema = z.record(AgentIdSchema, SubagentAiDefaultsEntrySchema);

export const GoalDefaultsSchema = z.object({
  defaultBudgetCents: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_GOAL_DEFAULTS.defaultBudgetCents),
  defaultTurnCap: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(DEFAULT_GOAL_DEFAULTS.defaultTurnCap),
  alwaysRequireExplicitBudget: z
    .boolean()
    .default(DEFAULT_GOAL_DEFAULTS.alwaysRequireExplicitBudget),
});

/**
 * Refusal-only at launch: silent fallback on quota/auth/context/rate-limit errors
 * would cost money or hide configuration problems. Future opt-in triggers (e.g.
 * model_not_found) can extend this union.
 */
export const ModelFallbackTriggerSchema = z.literal("model_refusal");

export const ModelFallbackEntrySchema = z.object({
  /** Default true when the entry exists. */
  enabled: z.boolean().optional(),
  /** Defaults to ["model_refusal"] (the only supported trigger today). */
  triggers: z.array(ModelFallbackTriggerSchema).optional(),
  /** Ordered fallback chain (canonical model strings); one attempt per model. */
  models: z.array(z.string()),
});

/** Per-model fallback chains, keyed by canonical source model. */
export const ModelFallbacksSchema = z.record(z.string(), ModelFallbackEntrySchema);

export const AppConfigMigrationsSchema = z
  .object({
    execSubagentDefaultsSplit: z.boolean().optional(),
    userPreferencesInitialized: z.boolean().optional(),
    /** One-time seed of DEFAULT_MODEL_FALLBACKS; not re-applied while true. */
    defaultModelFallbacksSeeded: z.boolean().optional(),
  })
  // Preserve flags introduced by newer app versions: without the catchall a
  // downgrade to this version would strip unknown flags on save, re-running
  // their one-time migrations after re-upgrade (see normalizeConfigMigrations).
  .catchall(z.boolean());

export const FeatureFlagOverrideSchema = z.enum(["default", "on", "off"]);

export const UpdateChannelSchema = z.enum(["stable", "nightly"]);

export const AppConfigOnDiskSchema = z
  .object({
    projects: z.array(z.tuple([z.string(), ProjectConfigSchema])).optional(),
    apiServerBindHost: z.string().optional(),
    apiServerPort: z.number().optional(),
    apiServerServeWebUi: z.boolean().optional(),
    mdnsAdvertisementEnabled: z.boolean().optional(),
    mdnsServiceName: z.string().optional(),
    serverSshHost: z.string().optional(),
    serverAuthGithubOwner: z.string().optional(),
    defaultProjectDir: z.string().optional(),
    viewedSplashScreens: z.array(z.string()).optional(),
    featureFlagOverrides: z.record(z.string(), FeatureFlagOverrideSchema).optional(),
    layoutPresets: z.unknown().optional(),
    userPreferences: UserPreferencesSchema.optional(),
    taskSettings: TaskSettingsSchema.optional(),
    chatTranscriptFullWidth: z.boolean().optional(),
    muxGatewayEnabled: z.boolean().optional(),
    llmDebugLogs: z.boolean().optional(),
    heartbeatDefaultPrompt: z.string().optional(),
    heartbeatDefaultIntervalMs: z
      .number()
      .int()
      .min(HEARTBEAT_MIN_INTERVAL_MS)
      .max(HEARTBEAT_MAX_INTERVAL_MS)
      .optional(),
    goalDefaults: GoalDefaultsSchema.optional(),
    muxGatewayModels: z.array(z.string()).optional(),
    routePriority: z.array(z.string()).optional(),
    routeOverrides: z.record(z.string(), z.string()).optional(),
    /**
     * Per-model minimum thinking level (keyed by canonical model id). Hides thinking
     * levels below the floor in the thinking slider so cycling is more efficient.
     * Omitted entries fall back to the built-in default (medium for reasoning-capable
     * models). See getDefaultMinimumThinkingLevel / getAvailableThinkingLevels.
     */
    minThinkingLevelByModel: z.record(z.string(), ThinkingLevelSchema).optional(),
    /**
     * Per-model refusal-fallback chains (keyed by canonical source model). When a
     * model refuses, the turn retries or continues on the next chain model
     * instead of failing terminally. See resolveModelFallbackChain for the
     * runtime sanitization rules (drop self, de-dupe, cap length).
     */
    modelFallbacks: ModelFallbacksSchema.optional(),
    defaultModel: z.string().optional(),
    advisorModelString: z.string().optional(),
    advisorThinkingLevel: ThinkingLevelSchema.optional(),
    advisorMaxUsesPerTurn: z.number().int().positive().nullable().optional(),
    advisorMaxOutputTokens: z.number().int().positive().nullable().optional(),
    hiddenModels: z.array(z.string()).optional(),
    preferredCompactionModel: z.string().optional(),
    agentAiDefaults: AgentAiDefaultsSchema.optional(),
    /**
     * Sparse per-agent override that wins over agentAiDefaults when an agent runs as a
     * sub-agent. The exec key is canonical storage for the sub-agent Exec slot.
     * Other keys are kept for legacy mirror compatibility, but new code should write
     * to agentAiDefaults instead.
     */
    subagentAiDefaults: SubagentAiDefaultsSchema.optional(),
    migrations: AppConfigMigrationsSchema.optional(),
    useSSH2Transport: z.boolean().optional(),
    muxGovernorUrl: z.string().optional(),
    muxGovernorToken: z.string().optional(),
    coderWorkspaceArchiveBehavior: z.enum(CODER_ARCHIVE_BEHAVIORS).optional(),
    worktreeArchiveBehavior: z.enum(WORKTREE_ARCHIVE_BEHAVIORS).optional(),
    deleteWorktreeOnArchive: z.boolean().optional(),
    stopCoderWorkspaceOnArchive: z.boolean().optional(),
    terminalDefaultShell: z.string().optional(),
    updateChannel: UpdateChannelSchema.optional(),
    runtimeEnablement: RuntimeEnablementOverridesSchema.optional(),
    defaultRuntime: RuntimeEnablementIdSchema.optional(),
    onePasswordAccountName: z.string().optional(),
  })
  .passthrough();

export type AppConfigMigrations = z.infer<typeof AppConfigMigrationsSchema>;
export type AgentAiDefaultsEntry = z.infer<typeof AgentAiDefaultsEntrySchema>;
export type AgentAiDefaults = z.infer<typeof AgentAiDefaultsSchema>;
export type SubagentAiDefaultsEntry = z.infer<typeof SubagentAiDefaultsEntrySchema>;
export type SubagentAiDefaults = z.infer<typeof SubagentAiDefaultsSchema>;
export type GoalDefaultsConfig = z.infer<typeof GoalDefaultsSchema>;
export type ModelFallbackTrigger = z.infer<typeof ModelFallbackTriggerSchema>;
export type ModelFallbackEntry = z.infer<typeof ModelFallbackEntrySchema>;
export type ModelFallbacks = z.infer<typeof ModelFallbacksSchema>;
export type FeatureFlagOverride = z.infer<typeof FeatureFlagOverrideSchema>;
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

export type AppConfigOnDisk = z.infer<typeof AppConfigOnDiskSchema>;
