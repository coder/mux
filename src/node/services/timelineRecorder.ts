import type { TimelineEventDraft } from "@/common/orpc/schemas/timeline";

export interface TimelineRecorder {
  record(workspaceId: string, draft: TimelineEventDraft): void;
}

export const NOOP_TIMELINE_RECORDER: TimelineRecorder = {
  record: () => undefined,
};
