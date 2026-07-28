import type { TimelineEventDraft } from "@/common/orpc/schemas/timeline";

export interface TimelineRecorder {
  record(workspaceId: string, draft: TimelineEventDraft): void;
  // Appends are queued, so a caller about to delete the session directory must await this first:
  // an append that lands afterwards recreates the directory for a workspace the user deleted.
  flush(workspaceId?: string): Promise<void>;
}

export const NOOP_TIMELINE_RECORDER: TimelineRecorder = {
  record: () => undefined,
  flush: () => Promise.resolve(),
};
