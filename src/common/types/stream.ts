/**
 * Event types emitted by AIService
 */

import type { z } from "zod";
import type { MuxReasoningPart, MuxTextPart, MuxToolPart } from "./message";
import type {
  AutoCompactionCompletedEventSchema,
  AutoCompactionTriggeredEventSchema,
  AutoRetryAbandonedEventSchema,
  AutoRetryScheduledEventSchema,
  AutoRetryStartingEventSchema,
  ErrorEventSchema,
  ReasoningDeltaEventSchema,
  ReasoningEndEventSchema,
  StreamAbortReasonSchema,
  StreamAbortEventSchema,
  StreamLifecycleEventSchema,
  StreamLifecyclePhaseSchema,
  StreamLifecycleSnapshotSchema,
  StreamDeltaEventSchema,
  StreamEndEventSchema,
  StreamStartEventSchema,
  ToolCallDeltaEventSchema,
  ToolCallEndEventSchema,
  ToolCallStartEventSchema,
  BashOutputEventSchema,
  TaskCreatedEventSchema,
  UsageDeltaEventSchema,
  RuntimeStatusEventSchema,
} from "../orpc/schemas";

/**
 * Completed message part (reasoning, text, or tool) suitable for serialization
 * Used in StreamEndEvent and partial message storage
 */
export type CompletedMessagePart = MuxReasoningPart | MuxTextPart | MuxToolPart;

export type StreamStartEvent = z.infer<typeof StreamStartEventSchema>;
export type StreamDeltaEvent = z.infer<typeof StreamDeltaEventSchema>;
export type StreamEndEvent = z.infer<typeof StreamEndEventSchema>;
export type StreamAbortReason = z.infer<typeof StreamAbortReasonSchema>;
export type StreamLifecyclePhase = z.infer<typeof StreamLifecyclePhaseSchema>;
export type StreamLifecycleSnapshot = z.infer<typeof StreamLifecycleSnapshotSchema>;
export type StreamLifecycleEvent = z.infer<typeof StreamLifecycleEventSchema>;

export function copyStreamLifecycleSnapshot(
  snapshot: Pick<StreamLifecycleSnapshot, "phase" | "hadAnyOutput" | "abortReason">
): StreamLifecycleSnapshot {
  return {
    phase: snapshot.phase,
    hadAnyOutput: snapshot.hadAnyOutput,
    ...(snapshot.abortReason != null ? { abortReason: snapshot.abortReason } : {}),
  };
}

export function areStreamLifecycleSnapshotsEqual(
  left: Pick<StreamLifecycleSnapshot, "phase" | "hadAnyOutput" | "abortReason"> | null,
  right: Pick<StreamLifecycleSnapshot, "phase" | "hadAnyOutput" | "abortReason"> | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.phase === right.phase &&
      left.hadAnyOutput === right.hadAnyOutput &&
      (left.abortReason ?? null) === (right.abortReason ?? null))
  );
}

export function isInFlightStreamLifecyclePhase(phase: StreamLifecyclePhase): boolean {
  return phase === "preparing" || phase === "streaming" || phase === "completing";
}

export function hasInFlightStreamLifecycle(
  snapshot: Pick<StreamLifecycleSnapshot, "phase"> | null | undefined
): boolean {
  return snapshot != null && isInFlightStreamLifecyclePhase(snapshot.phase);
}

export interface StreamAbortReasonSnapshot {
  reason: StreamAbortReason;
  at: number;
}
export type StreamAbortEvent = z.infer<typeof StreamAbortEventSchema>;

export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export type BashOutputEvent = z.infer<typeof BashOutputEventSchema>;
export type TaskCreatedEvent = z.infer<typeof TaskCreatedEventSchema>;
export type ToolCallStartEvent = z.infer<typeof ToolCallStartEventSchema>;
export type ToolCallDeltaEvent = z.infer<typeof ToolCallDeltaEventSchema>;
export type ToolCallEndEvent = z.infer<typeof ToolCallEndEventSchema>;

export type ReasoningDeltaEvent = z.infer<typeof ReasoningDeltaEventSchema>;
export type ReasoningEndEvent = z.infer<typeof ReasoningEndEventSchema>;

/**
 * Emitted on each AI SDK finish-step event, providing incremental usage updates.
 * Allows UI to update token display as steps complete (after each tool call or at stream end).
 */
export type UsageDeltaEvent = z.infer<typeof UsageDeltaEventSchema>;

export type AutoCompactionTriggeredEvent = z.infer<typeof AutoCompactionTriggeredEventSchema>;
export type AutoCompactionCompletedEvent = z.infer<typeof AutoCompactionCompletedEventSchema>;

export type AutoRetryScheduledEvent = z.infer<typeof AutoRetryScheduledEventSchema>;
export type AutoRetryStartingEvent = z.infer<typeof AutoRetryStartingEventSchema>;
export type AutoRetryAbandonedEvent = z.infer<typeof AutoRetryAbandonedEventSchema>;

/**
 * Progress event for pre-stream startup work.
 * Used for both runtime readiness and generic startup breadcrumbs in the barrier UI.
 */
export type RuntimeStatusEvent = z.infer<typeof RuntimeStatusEventSchema>;

/**
 * Shared runtime-status helpers used by both the backend session replay path and the
 * renderer aggregator so startup breadcrumbs follow the same lifecycle semantics.
 */
export function copyRuntimeStatusEvent(
  status: Pick<
    RuntimeStatusEvent,
    "type" | "workspaceId" | "phase" | "runtimeType" | "source" | "detail"
  >
): RuntimeStatusEvent {
  return {
    type: status.type,
    workspaceId: status.workspaceId,
    phase: status.phase,
    runtimeType: status.runtimeType,
    ...(status.source != null ? { source: status.source } : {}),
    ...(status.detail != null ? { detail: status.detail } : {}),
  };
}

export function areRuntimeStatusEventsEqual(
  left: Pick<RuntimeStatusEvent, "phase" | "runtimeType" | "source" | "detail"> | null,
  right: Pick<RuntimeStatusEvent, "phase" | "runtimeType" | "source" | "detail"> | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.phase === right.phase &&
      left.runtimeType === right.runtimeType &&
      (left.source ?? null) === (right.source ?? null) &&
      (left.detail ?? null) === (right.detail ?? null))
  );
}

export function isTerminalRuntimeStatusPhase(phase: RuntimeStatusEvent["phase"]): boolean {
  return phase === "ready" || phase === "error";
}
