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

// Individual event payload schemas
const AppStartedPropertiesSchema = z.object({
  isFirstLaunch: z.boolean(),
});

const WorkspaceCreatedPropertiesSchema = z.object({
  workspaceId: z.string(),
});

const WorkspaceSwitchedPropertiesSchema = z.object({
  fromWorkspaceId: z.string(),
  toWorkspaceId: z.string(),
});

const MessageSentPropertiesSchema = z.object({
  model: z.string(),
  mode: z.string(),
  message_length_b2: z.number(),
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
