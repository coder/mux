import type { z } from "zod";
import type * as schemas from "./schemas";

import type {
  StreamStartEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamAbortEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  UsageDeltaEvent,
} from "@/common/types/stream";

export type BranchListResult = z.infer<typeof schemas.BranchListResultSchema>;
export type SendMessageOptions = z.infer<typeof schemas.SendMessageOptionsSchema>;

// Provider types (single source of truth - derived from schemas)
export type AWSCredentialStatus = z.infer<typeof schemas.AWSCredentialStatusSchema>;
export type ProviderConfigInfo = z.infer<typeof schemas.ProviderConfigInfoSchema>;
export type ProvidersConfigMap = z.infer<typeof schemas.ProvidersConfigMapSchema>;
export type ImagePart = z.infer<typeof schemas.ImagePartSchema>;
export type WorkspaceChatMessage = z.infer<typeof schemas.WorkspaceChatMessageSchema>;
export type CaughtUpMessage = z.infer<typeof schemas.CaughtUpMessageSchema>;
export type StreamErrorMessage = z.infer<typeof schemas.StreamErrorMessageSchema>;
export type DeleteMessage = z.infer<typeof schemas.DeleteMessageSchema>;
export type WorkspaceInitEvent = z.infer<typeof schemas.WorkspaceInitEventSchema>;
export type UpdateStatus = z.infer<typeof schemas.UpdateStatusSchema>;
export type ChatMuxMessage = z.infer<typeof schemas.ChatMuxMessageSchema>;
export type WorkspaceStatsSnapshot = z.infer<typeof schemas.WorkspaceStatsSnapshotSchema>;
export type WorkspaceActivitySnapshot = z.infer<typeof schemas.WorkspaceActivitySnapshotSchema>;
export type FrontendWorkspaceMetadataSchemaType = z.infer<
  typeof schemas.FrontendWorkspaceMetadataSchema
>;

// Experiment types (single source of truth - derived from schemas)
export type ExperimentValue = z.infer<typeof schemas.ExperimentValueSchema>;

// Type guards for common chat message variants
export function isCaughtUpMessage(msg: WorkspaceChatMessage): msg is CaughtUpMessage {
  return (msg as { type?: string }).type === "caught-up";
}

export function isStreamError(msg: WorkspaceChatMessage): msg is StreamErrorMessage {
  return (msg as { type?: string }).type === "stream-error";
}

export function isDeleteMessage(msg: WorkspaceChatMessage): msg is DeleteMessage {
  return (msg as { type?: string }).type === "delete";
}

export function isStreamStart(msg: WorkspaceChatMessage): msg is StreamStartEvent {
  return (msg as { type?: string }).type === "stream-start";
}

export function isStreamDelta(msg: WorkspaceChatMessage): msg is StreamDeltaEvent {
  return (msg as { type?: string }).type === "stream-delta";
}

export function isStreamEnd(msg: WorkspaceChatMessage): msg is StreamEndEvent {
  return (msg as { type?: string }).type === "stream-end";
}

export function isStreamAbort(msg: WorkspaceChatMessage): msg is StreamAbortEvent {
  return (msg as { type?: string }).type === "stream-abort";
}

export function isToolCallStart(msg: WorkspaceChatMessage): msg is ToolCallStartEvent {
  return (msg as { type?: string }).type === "tool-call-start";
}

export function isToolCallDelta(msg: WorkspaceChatMessage): msg is ToolCallDeltaEvent {
  return (msg as { type?: string }).type === "tool-call-delta";
}

export function isToolCallEnd(msg: WorkspaceChatMessage): msg is ToolCallEndEvent {
  return (msg as { type?: string }).type === "tool-call-end";
}

export function isReasoningDelta(msg: WorkspaceChatMessage): msg is ReasoningDeltaEvent {
  return (msg as { type?: string }).type === "reasoning-delta";
}

export function isReasoningEnd(msg: WorkspaceChatMessage): msg is ReasoningEndEvent {
  return (msg as { type?: string }).type === "reasoning-end";
}

export function isUsageDelta(msg: WorkspaceChatMessage): msg is UsageDeltaEvent {
  return (msg as { type?: string }).type === "usage-delta";
}

export function isMuxMessage(msg: WorkspaceChatMessage): msg is ChatMuxMessage {
  return (msg as { type?: string }).type === "message";
}

export function isInitStart(
  msg: WorkspaceChatMessage
): msg is Extract<WorkspaceInitEvent, { type: "init-start" }> {
  return (msg as { type?: string }).type === "init-start";
}

export function isInitOutput(
  msg: WorkspaceChatMessage
): msg is Extract<WorkspaceInitEvent, { type: "init-output" }> {
  return (msg as { type?: string }).type === "init-output";
}

export function isInitEnd(
  msg: WorkspaceChatMessage
): msg is Extract<WorkspaceInitEvent, { type: "init-end" }> {
  return (msg as { type?: string }).type === "init-end";
}

export function isQueuedMessageChanged(
  msg: WorkspaceChatMessage
): msg is Extract<WorkspaceChatMessage, { type: "queued-message-changed" }> {
  return (msg as { type?: string }).type === "queued-message-changed";
}

export function isRestoreToInput(
  msg: WorkspaceChatMessage
): msg is Extract<WorkspaceChatMessage, { type: "restore-to-input" }> {
  return (msg as { type?: string }).type === "restore-to-input";
}
