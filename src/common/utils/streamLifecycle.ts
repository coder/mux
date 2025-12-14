// Stream lifecycle events are emitted during an in-flight assistant response.
//
// Keeping the event list centralized makes it harder to accidentally forget to forward/buffer a
// newly introduced lifecycle event.

export const STREAM_LIFECYCLE_EVENTS = [
  "stream-pending",
  "stream-start",
  "stream-delta",
  "stream-abort",
  "stream-end",
] as const;

export type StreamLifecycleEventName = (typeof STREAM_LIFECYCLE_EVENTS)[number];

// Events that can be forwarded 1:1 from StreamManager -> AIService.
// (`stream-abort` needs additional bookkeeping in AIService.)
export const STREAM_LIFECYCLE_EVENTS_DIRECT_FORWARD = [
  "stream-pending",
  "stream-start",
  "stream-delta",
  "stream-end",
] as const satisfies readonly StreamLifecycleEventName[];

// Events that can be forwarded 1:1 from AIService -> AgentSession -> renderer.
// (`stream-end` has additional session-side behavior.)
export const STREAM_LIFECYCLE_EVENTS_SIMPLE_FORWARD = [
  "stream-pending",
  "stream-start",
  "stream-delta",
  "stream-abort",
] as const satisfies readonly StreamLifecycleEventName[];

export function forwardStreamLifecycleEvents(params: {
  events: readonly StreamLifecycleEventName[];
  listen: (event: StreamLifecycleEventName, handler: (payload: unknown) => void) => void;
  emit: (event: StreamLifecycleEventName, payload: unknown) => void;
}): void {
  for (const event of params.events) {
    params.listen(event, (payload) => params.emit(event, payload));
  }
}
