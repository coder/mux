import { z } from "zod";

import { AgentIdSchema, RuntimeEnablementIdSchema } from "../../schemas/ids";
import { ProjectConfigSchema } from "../../schemas/project";
import { RuntimeEnablementOverridesSchema } from "../../schemas/runtimeEnablement";
import { ThinkingLevelSchema } from "../../types/thinking";
import { TaskSettingsSchema } from "./taskSettings";

export { RuntimeEnablementOverridesSchema } from "../../schemas/runtimeEnablement";
export type { RuntimeEnablementOverrides } from "../../schemas/runtimeEnablement";
export { PlanSubagentExecutorRoutingSchema, TaskSettingsSchema } from "./taskSettings";
export type { PlanSubagentExecutorRouting, TaskSettings } from "./taskSettings";

export const AgentAiDefaultsEntrySchema = z.object({
  modelString: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  enabled: z.boolean().optional(),
});

export const AgentAiDefaultsSchema = z.record(AgentIdSchema, AgentAiDefaultsEntrySchema);

export const SubagentAiDefaultsEntrySchema = z.object({
  modelString: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});

export const SubagentAiDefaultsSchema = z.record(AgentIdSchema, SubagentAiDefaultsEntrySchema);

export const FeatureFlagOverrideSchema = z.enum(["default", "on", "off"]);

export const UpdateChannelSchema = z.enum(["stable", "nightly"]);

export const EventSoundSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("managed"),
    assetId: z.string().min(1),
  }),
]);

export const EventSoundConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    source: EventSoundSourceSchema.nullable().default(null),
  })
  .strict();

export const EventSoundSettingsSchema = z.record(z.string(), EventSoundConfigSchema).optional();

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
    taskSettings: TaskSettingsSchema.optional(),
    muxGatewayEnabled: z.boolean().optional(),
    llmDebugLogs: z.boolean().optional(),
    muxGatewayModels: z.array(z.string()).optional(),
    defaultModel: z.string().optional(),
    hiddenModels: z.array(z.string()).optional(),
    preferredCompactionModel: z.string().optional(),
    agentAiDefaults: AgentAiDefaultsSchema.optional(),
    subagentAiDefaults: SubagentAiDefaultsSchema.optional(),
    useSSH2Transport: z.boolean().optional(),
    muxGovernorUrl: z.string().optional(),
    muxGovernorToken: z.string().optional(),
    stopCoderWorkspaceOnArchive: z.boolean().optional(),
    terminalDefaultShell: z.string().optional(),
    updateChannel: UpdateChannelSchema.optional(),
    runtimeEnablement: RuntimeEnablementOverridesSchema.optional(),
    defaultRuntime: RuntimeEnablementIdSchema.optional(),
    eventSoundSettings: EventSoundSettingsSchema,
    onePasswordAccountName: z.string().optional(),
  })
  .passthrough();

export type AgentAiDefaultsEntry = z.infer<typeof AgentAiDefaultsEntrySchema>;
export type AgentAiDefaults = z.infer<typeof AgentAiDefaultsSchema>;
export type SubagentAiDefaultsEntry = z.infer<typeof SubagentAiDefaultsEntrySchema>;
export type SubagentAiDefaults = z.infer<typeof SubagentAiDefaultsSchema>;
export type FeatureFlagOverride = z.infer<typeof FeatureFlagOverrideSchema>;
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

export type EventSoundConfig = z.infer<typeof EventSoundConfigSchema>;
export type EventSoundSource = z.infer<typeof EventSoundSourceSchema>;
export type EventSoundSettings = z.infer<typeof EventSoundSettingsSchema>;

export type AppConfigOnDisk = z.infer<typeof AppConfigOnDiskSchema>;
