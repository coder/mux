import { describe, expect, test } from "bun:test";

import { createMuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import { buildDisplayedMessagesForMessage } from "./displayedMessageBuilder";

const wakePrompt = `Background sub-agent task(s) have completed.

Call task_await only if more output is needed.`;

function buildUserRow(muxMetadata: MuxMessageMetadata) {
  const message = createMuxMessage("wake-1", "user", wakePrompt, {
    historySequence: 1,
    synthetic: true,
    uiVisible: true,
    muxMetadata,
  });
  const displayed = buildDisplayedMessagesForMessage({
    message,
    hasActiveStream: false,
    isContextBoundaryMessage: () => false,
  });
  expect(displayed).toHaveLength(1);
  const row = displayed[0];
  if (row?.type !== "user") throw new Error(`expected user row, got ${row?.type}`);
  return row;
}

describe("buildDisplayedMessagesForMessage background work wake metadata", () => {
  test("surfaces well-formed coalesced wake records while preserving the full prompt", () => {
    const row = buildUserRow({
      type: "background-work-wake",
      records: [
        {
          sourceKind: "agent_task",
          sourceId: "task-123",
          outcome: "completed",
          title: "Repository audit",
          workspaceId: "task-123",
        },
        {
          sourceKind: "workflow_run",
          sourceId: "wfr_123",
          outcome: "failed",
          title: "coalesced-research",
          workspaceId: "workspace-1",
        },
      ],
    });

    expect(row.backgroundWorkWake?.records).toHaveLength(2);
    expect(row.backgroundWorkWake?.records[1]).toMatchObject({
      sourceKind: "workflow_run",
      outcome: "failed",
      title: "coalesced-research",
    });
    expect(row.content).toBe(wakePrompt);
  });

  test.each([
    ["missing records", { type: "background-work-wake" }],
    ["non-array records", { type: "background-work-wake", records: "oops" }],
    ["empty records", { type: "background-work-wake", records: [] }],
    [
      "unknown source kind",
      {
        type: "background-work-wake",
        records: [{ sourceKind: "bash", sourceId: "task-1", outcome: "completed", title: "Task" }],
      },
    ],
    [
      "unknown outcome",
      {
        type: "background-work-wake",
        records: [
          { sourceKind: "agent_task", sourceId: "task-1", outcome: "running", title: "Task" },
        ],
      },
    ],
    [
      "missing title",
      {
        type: "background-work-wake",
        records: [{ sourceKind: "agent_task", sourceId: "task-1", outcome: "completed" }],
      },
    ],
    [
      "invalid workspace id",
      {
        type: "background-work-wake",
        records: [
          {
            sourceKind: "agent_task",
            sourceId: "task-1",
            outcome: "completed",
            title: "Task",
            workspaceId: 42,
          },
        ],
      },
    ],
  ])("falls back to full-text rendering for %s", (_label, malformed) => {
    const row = buildUserRow(malformed as unknown as MuxMessageMetadata);
    expect(row.backgroundWorkWake).toBeUndefined();
    expect(row.content).toBe(wakePrompt);
  });
});
