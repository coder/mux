/**
 * Telemetry ORPC schemas
 *
 * Defines input/output schemas for backend telemetry endpoints.
 * Telemetry is controlled by MUX_DISABLE_TELEMETRY env var on the backend.
 */

import { z } from "zod";

// Error context enum (matches payload.ts)
const ErrorContextSchema = z.enum([
  "workspace-creation",
  "workspace-deletion",
  "workspace-switch",
  "message-send",
  "message-stream",
  "project-add",
  "project-remove",
  "git-operation",
]);

// Runtime type enum (matches payload.ts TelemetryRuntimeType)
const TelemetryRuntimeTypeSchema = z.enum(["local", "worktree", "ssh"]);

// Frontend platform info (matches payload.ts FrontendPlatformInfo)
const FrontendPlatformInfoSchema = z.object({
  userAgent: z.string(),
  platform: z.string(),
});

// Thinking level enum (matches payload.ts TelemetryThinkingLevel)
const TelemetryThinkingLevelSchema = z.enum(["off", "low", "medium", "high", "xhigh"]);

// Command type enum (matches payload.ts TelemetryCommandType)
const TelemetryCommandTypeSchema = z.enum([
  "clear",
  "compact",
  "new",
  "fork",
  "vim",
  "model",
  "mode",
  "plan",
  "providers",
]);

// Individual event payload schemas
const AppStartedPropertiesSchema = z.object({
  isFirstLaunch: z.boolean(),
  vimModeEnabled: z.boolean(),
});

const WorkspaceCreatedPropertiesSchema = z.object({
  workspaceId: z.string(),
  runtimeType: TelemetryRuntimeTypeSchema,
  frontendPlatform: FrontendPlatformInfoSchema,
});

const WorkspaceSwitchedPropertiesSchema = z.object({
  fromWorkspaceId: z.string(),
  toWorkspaceId: z.string(),
});

const MessageSentPropertiesSchema = z.object({
  workspaceId: z.string(),
  model: z.string(),
  mode: z.string(),
  message_length_b2: z.number(),
  runtimeType: TelemetryRuntimeTypeSchema,
  frontendPlatform: FrontendPlatformInfoSchema,
  thinkingLevel: TelemetryThinkingLevelSchema,
});

const StreamCompletedPropertiesSchema = z.object({
  model: z.string(),
  wasInterrupted: z.boolean(),
  duration_b2: z.number(),
  output_tokens_b2: z.number(),
});

const ProviderConfiguredPropertiesSchema = z.object({
  provider: z.string(),
  keyType: z.string(),
});

const CommandUsedPropertiesSchema = z.object({
  command: TelemetryCommandTypeSchema,
});

const VoiceTranscriptionPropertiesSchema = z.object({
  audio_duration_b2: z.number(),
  success: z.boolean(),
});

const ErrorOccurredPropertiesSchema = z.object({
  errorType: z.string(),
  context: ErrorContextSchema,
});

// Union of all telemetry events
export const TelemetryEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("app_started"),
    properties: AppStartedPropertiesSchema,
  }),
  z.object({
    event: z.literal("workspace_created"),
    properties: WorkspaceCreatedPropertiesSchema,
  }),
  z.object({
    event: z.literal("workspace_switched"),
    properties: WorkspaceSwitchedPropertiesSchema,
  }),
  z.object({
    event: z.literal("message_sent"),
    properties: MessageSentPropertiesSchema,
  }),
  z.object({
    event: z.literal("stream_completed"),
    properties: StreamCompletedPropertiesSchema,
  }),
  z.object({
    event: z.literal("provider_configured"),
    properties: ProviderConfiguredPropertiesSchema,
  }),
  z.object({
    event: z.literal("command_used"),
    properties: CommandUsedPropertiesSchema,
  }),
  z.object({
    event: z.literal("voice_transcription"),
    properties: VoiceTranscriptionPropertiesSchema,
  }),
  z.object({
    event: z.literal("error_occurred"),
    properties: ErrorOccurredPropertiesSchema,
  }),
]);

// API schemas - only track endpoint, enabled state controlled by env var
export const telemetry = {
  track: {
    input: TelemetryEventSchema,
    output: z.void(),
  },
};
