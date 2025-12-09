/**
 * Event types emitted by AIService
 */

import type { z } from "zod";
import type { MuxReasoningPart, MuxTextPart, MuxToolPart } from "./message";
import type {
  ErrorEventSchema,
  ReasoningDeltaEventSchema,
  ReasoningEndEventSchema,
  StreamAbortEventSchema,
  StreamDeltaEventSchema,
  StreamEndEventSchema,
  StreamStartEventSchema,
  ToolCallDeltaEventSchema,
  ToolCallEndEventSchema,
  ToolCallStartEventSchema,
  UsageDeltaEventSchema,
} from "../orpc/schemas";

/**
 * Completed message part (reasoning, text, or tool) suitable for serialization
 * Used in StreamEndEvent and partial message storage
 */
export type CompletedMessagePart = MuxReasoningPart | MuxTextPart | MuxToolPart;

export type StreamStartEvent = z.infer<typeof StreamStartEventSchema>;
export type StreamDeltaEvent = z.infer<typeof StreamDeltaEventSchema>;
export type StreamEndEvent = z.infer<typeof StreamEndEventSchema>;
export type StreamAbortEvent = z.infer<typeof StreamAbortEventSchema>;

export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

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

export type AIServiceEvent =
  | StreamStartEvent
  | StreamDeltaEvent
  | StreamEndEvent
  | StreamAbortEvent
  | ErrorEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | UsageDeltaEvent;
