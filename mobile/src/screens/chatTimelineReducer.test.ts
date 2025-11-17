import { applyChatEvent, TimelineEntry } from "./chatTimelineReducer";
import type { WorkspaceChatEvent } from "../types";
import type { DisplayedMessage } from "../types";

describe("chatTimelineReducer", () => {
  const createUserMessage = (sequence: number, id?: string): DisplayedMessage => ({
    type: "user",
    id: id ?? `msg-${sequence}`,
    historyId: id ?? `msg-${sequence}`,
    content: `message-${sequence}`,
    historySequence: sequence,
  });

  const asEntry = (message: DisplayedMessage): TimelineEntry => ({
    kind: "displayed",
    key: `displayed-${message.id}`,
    message,
  });
  const createWorkspaceInitMessage = (
    overrides?: Partial<Extract<DisplayedMessage, { type: "workspace-init" }>>
  ): DisplayedMessage => ({
    type: "workspace-init",
    id: "workspace-init",
    historySequence: -1,
    status: "running",
    hookPath: "scripts/init.sh",
    lines: [],
    exitCode: null,
    timestamp: 1,
    ...overrides,
  });
  const createAssistantChunk = (
    sequence: number,
    streamSequence: number,
    id: string
  ): DisplayedMessage => ({
    type: "assistant",
    id,
    historyId: "assistant-message",
    content: `chunk-${streamSequence}`,
    historySequence: sequence,
    streamSequence,
    isStreaming: false,
  });

  it("drops future messages when a message edit rewinds history", () => {
    const timeline: TimelineEntry[] = [
      asEntry(createUserMessage(1, "a")),
      asEntry(createUserMessage(2, "b")),
      asEntry(createUserMessage(3, "c")),
      {
        kind: "raw",
        key: "raw-1",
        payload: { type: "status", status: "ok" } as WorkspaceChatEvent,
      },
    ];

    const result = applyChatEvent(timeline, createUserMessage(2, "b-edited"));

    const displayedSequences = result
      .filter((entry) => entry.kind === "displayed")
      .map((entry) => entry.message.historySequence);

    expect(displayedSequences).toEqual([1, 2]);
    expect(result.find((entry) => entry.kind === "raw" && entry.key === "raw-1")).toBeDefined();
  });

  it("appends messages when sequences are strictly increasing", () => {
    const timeline: TimelineEntry[] = [asEntry(createUserMessage(1, "a"))];

    const result = applyChatEvent(timeline, createUserMessage(2, "b"));

    const displayedIds = result
      .filter((entry) => entry.kind === "displayed")
      .map((entry) => entry.message.id);

    expect(displayedIds).toEqual(["a", "b"]);
  });

  it("does not drop existing history when workspace-init updates", () => {
    const timeline: TimelineEntry[] = [
      asEntry(createUserMessage(1, "user-1")),
      asEntry(createWorkspaceInitMessage()),
    ];

    const result = applyChatEvent(
      timeline,
      createWorkspaceInitMessage({ status: "success", timestamp: 5 })
    );

    const displayedIds = result
      .filter(
        (entry): entry is Extract<TimelineEntry, { kind: "displayed" }> =>
          entry.kind === "displayed"
      )
      .map((entry) => entry.message.id);

    expect(displayedIds).toContain("user-1");
    expect(displayedIds).toContain("workspace-init");
  });
  it("updates workspace init message with the latest lifecycle snapshot", () => {
    const initialTimeline: TimelineEntry[] = [asEntry(createWorkspaceInitMessage())];

    const withOutput = applyChatEvent(
      initialTimeline,
      createWorkspaceInitMessage({ lines: ["Starting services"], timestamp: 2 })
    );

    const outputMessage = withOutput.find(
      (entry): entry is Extract<TimelineEntry, { kind: "displayed" }> => entry.kind === "displayed"
    )?.message;

    expect(outputMessage?.type).toBe("workspace-init");
    expect(outputMessage && "lines" in outputMessage ? outputMessage.lines : []).toEqual([
      "Starting services",
    ]);

    const completed = applyChatEvent(
      withOutput,
      createWorkspaceInitMessage({
        status: "success",
        exitCode: 0,
        lines: ["Starting services", "Done"],
        timestamp: 3,
      })
    );

    const completedMessage = completed.find(
      (entry): entry is Extract<TimelineEntry, { kind: "displayed" }> => entry.kind === "displayed"
    )?.message;

    expect(completedMessage?.type).toBe("workspace-init");
    expect(
      completedMessage && "status" in completedMessage ? completedMessage.status : undefined
    ).toBe("success");
    expect(
      completedMessage && "exitCode" in completedMessage ? completedMessage.exitCode : null
    ).toBe(0);
    expect(completedMessage && "lines" in completedMessage ? completedMessage.lines : []).toEqual([
      "Starting services",
      "Done",
    ]);
  });
  it("keeps existing parts for the same historyId", () => {
    const timeline: TimelineEntry[] = [
      asEntry(createAssistantChunk(5, 0, "chunk-0")),
      asEntry(createAssistantChunk(5, 1, "chunk-1")),
    ];

    const result = applyChatEvent(timeline, createAssistantChunk(5, 2, "chunk-2"));

    const ids = result
      .filter((entry) => entry.kind === "displayed")
      .map((entry) => entry.message.id);

    expect(ids).toEqual(["chunk-0", "chunk-1", "chunk-2"]);
  });
});
