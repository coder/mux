import { describe, expect, test } from "bun:test";
import {
  TIMELINE_EVENT_KINDS,
  TimelineEventDraftSchema,
  TimelineEventSchema,
  TimelinePageSchema,
  TimelinePreviewSchema,
} from "./timeline";

const baseEvent = {
  v: 1 as const,
  seq: 1,
  id: "event-1",
  ts: 1_700_000_000_000,
  kind: "turn.completed",
  source: { system: "chat" as const },
};

describe("timeline schemas", () => {
  test("keeps known kinds exhaustive while accepting unknown persisted kinds", () => {
    expect(TIMELINE_EVENT_KINDS).toContain("agent.mark");
    expect(TimelineEventSchema.parse({ ...baseEvent, kind: "future.event" }).kind).toBe(
      "future.event"
    );
  });

  test("accepts typed flat event data and rejects untyped fields", () => {
    const parsed = TimelineEventSchema.parse({
      ...baseEvent,
      data: { toolName: "bash", durationMs: 42, digest: "git status" },
    });

    expect(parsed.data).toEqual({ toolName: "bash", durationMs: 42, digest: "git status" });
    expect(() =>
      TimelineEventSchema.parse({ ...baseEvent, data: { arbitraryPayload: { nested: true } } })
    ).toThrow();
  });

  test("defines drafts, pages, and bounded previews for the backend API", () => {
    const draft = TimelineEventDraftSchema.parse({
      ts: baseEvent.ts,
      kind: baseEvent.kind,
      source: baseEvent.source,
      anchor: { historySequence: 7, messageId: "message-1" },
    });
    const page = TimelinePageSchema.parse({
      events: [baseEvent],
      nextCursor: 1,
      hasOlder: true,
    });
    const preview = TimelinePreviewSchema.parse({
      role: "assistant",
      timestamp: baseEvent.ts,
      textExcerpt: "Finished the change",
      toolName: "bash",
      status: "completed",
    });

    expect(draft.anchor?.historySequence).toBe(7);
    expect(page.events).toHaveLength(1);
    expect(preview.textExcerpt).toBe("Finished the change");
  });
});
