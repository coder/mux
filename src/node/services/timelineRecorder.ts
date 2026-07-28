import type { TimelineEventDraft } from "@/common/orpc/schemas/timeline";

export interface TimelineRecorder {
  record(workspaceId: string, draft: TimelineEventDraft): void;
  // Call before deleting a session directory. Rejecting later records is as important as draining
  // the queue: an append recreates the directory, so a straggler would resurrect a deleted
  // workspace even after a successful flush.
  closeWorkspace(workspaceId: string): Promise<void>;
}

export const NOOP_TIMELINE_RECORDER: TimelineRecorder = {
  record: () => undefined,
  closeWorkspace: () => Promise.resolve(),
};
