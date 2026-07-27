import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { TIMELINE_FILE_NAME } from "@/common/constants/paths";
import type { TimelineEvent, TimelineEventDraft } from "@/common/orpc/schemas/timeline";
import type { MuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { setTodosForSessionDir } from "./tools/todo";
import { TimelineService } from "./timelineService";
import { WorkspaceService } from "./workspaceService";

const WORKSPACE_ID = "timeline-test-workspace";

function draft(key: string, kind = "agent.mark"): TimelineEventDraft {
  return {
    kind,
    source: { system: "agent", key },
    data: { label: key },
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  metadata: MuxMessage["metadata"] = {}
): MuxMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    metadata,
  };
}

describe("TimelineService", () => {
  let enabled: boolean;
  let service: TimelineService;
  let historyService: Awaited<ReturnType<typeof createTestHistoryService>>["historyService"];
  let config: Awaited<ReturnType<typeof createTestHistoryService>>["config"];
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    enabled = true;
    const testHistory = await createTestHistoryService();
    historyService = testHistory.historyService;
    config = testHistory.config;
    cleanup = testHistory.cleanup;
    service = new TimelineService(config, historyService, {
      isExperimentEnabled: () => enabled,
    });
  });

  afterEach(async () => {
    await service.flush();
    await cleanup();
  });

  function timelinePath(workspaceId = WORKSPACE_ID): string {
    return path.join(config.getSessionDir(workspaceId), TIMELINE_FILE_NAME);
  }

  test("continues monotonic sequences after service restart", async () => {
    service.record(WORKSPACE_ID, draft("first"));
    service.record(WORKSPACE_ID, draft("second"));
    await service.flush();

    service = new TimelineService(config, historyService, {
      isExperimentEnabled: () => enabled,
    });
    service.record(WORKSPACE_ID, draft("third"));
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => event.seq)).toEqual([3, 2, 1]);
  });

  test("paginates backward from newest events", async () => {
    for (let index = 1; index <= 5; index++) {
      service.record(WORKSPACE_ID, draft(`event-${index}`));
    }
    await service.flush();

    const first = await service.list(WORKSPACE_ID, { limit: 2 });
    expect(first.events.map((event) => event.seq)).toEqual([5, 4]);
    expect(first.nextCursor).toBe(4);
    expect(first.hasOlder).toBe(true);

    const second = await service.list(WORKSPACE_ID, {
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });
    expect(second.events.map((event) => event.seq)).toEqual([3, 2]);
    expect(second.nextCursor).toBe(2);
    expect(second.hasOlder).toBe(true);

    const last = await service.list(WORKSPACE_ID, {
      cursor: second.nextCursor ?? undefined,
      limit: 2,
    });
    expect(last.events.map((event) => event.seq)).toEqual([1]);
    expect(last.nextCursor).toBeNull();
    expect(last.hasOlder).toBe(false);
  });

  test("skips corrupt lines while reading", async () => {
    service.record(WORKSPACE_ID, draft("valid-1"));
    await service.flush();
    await fs.appendFile(timelinePath(), "{not-json\n", "utf-8");
    service.record(WORKSPACE_ID, draft("valid-2"));
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => event.data?.label)).toEqual(["valid-2", "valid-1"]);
  });

  test("preserves unknown event kinds", async () => {
    const unknownEvent: TimelineEvent = {
      v: 1,
      seq: 1,
      id: "unknown-event",
      ts: 100,
      kind: "future.event.kind",
      source: { system: "agent" },
    };
    await fs.mkdir(config.getSessionDir(WORKSPACE_ID), { recursive: true });
    await fs.writeFile(timelinePath(), `${JSON.stringify(unknownEvent)}\n`, "utf-8");

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events).toEqual([unknownEvent]);
  });

  test("does not create a file when the experiment is off", async () => {
    enabled = false;
    service.record(WORKSPACE_ID, draft("disabled"));
    await service.flush();

    await expect(fs.stat(timelinePath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("drops duplicate recent source keys", async () => {
    service.record(WORKSPACE_ID, draft("same-key"));
    service.record(WORKSPACE_ID, draft("same-key"));
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events).toHaveLength(1);
  });

  test("previews a message stored only in the sealed archive", async () => {
    await historyService.appendToHistory(
      WORKSPACE_ID,
      message("target", "user", "Archived target text", { timestamp: 123 })
    );
    await historyService.appendToHistory(
      WORKSPACE_ID,
      message("newer-user", "user", "Newer qualifying text", { timestamp: 124 })
    );
    await historyService.appendToHistory(
      WORKSPACE_ID,
      message("boundary", "assistant", "Summary", {
        compactionBoundary: true,
        compacted: "user",
        compactionEpoch: 1,
      })
    );

    const preview = await service.previewAnchor(WORKSPACE_ID, { messageId: "target" });
    expect(preview).toEqual({
      role: "user",
      timestamp: 123,
      textExcerpt: "Archived target text",
    });

    const archived = await fs.readFile(
      path.join(config.getSessionDir(WORKSPACE_ID), "chat-archive.jsonl"),
      "utf-8"
    );
    expect(archived).toContain('"id":"target"');
    const active = await fs.readFile(
      path.join(config.getSessionDir(WORKSPACE_ID), "chat.jsonl"),
      "utf-8"
    );
    expect(active).not.toContain('"id":"target"');
  });

  test("unchanged agent status appends nothing", async () => {
    const workspaceService = Object.assign(Object.create(WorkspaceService.prototype), {
      lastAgentStatusByWorkspace: new Map(),
      timelineRecorder: service,
      emitWorkspaceActivityUpdate: () => Promise.resolve(),
    }) as WorkspaceService;

    await workspaceService.updateAgentStatus(WORKSPACE_ID, {
      emoji: "working",
      message: "Running",
    });
    await workspaceService.updateAgentStatus(WORKSPACE_ID, {
      emoji: "working",
      message: "Running",
    });
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => event.kind)).toEqual(["agent.status"]);
  });

  test("todo harvest appends only newly completed items", async () => {
    const workspaceService = Object.assign(Object.create(WorkspaceService.prototype), {
      config,
      completedTodosByWorkspace: new Map(),
      todoStatusUpdateQueue: new Map(),
      timelineRecorder: service,
      emitWorkspaceActivityUpdate: () => Promise.resolve(),
    });
    const updateTodoStatusFromStorage = (
      workspaceService as unknown as {
        updateTodoStatusFromStorage: (workspaceId: string) => Promise<void>;
      }
    ).updateTodoStatusFromStorage.bind(workspaceService);
    const sessionDir = config.getSessionDir(WORKSPACE_ID);

    await setTodosForSessionDir(WORKSPACE_ID, sessionDir, [
      { content: "Already done", status: "completed" },
      { content: "Finish backend", status: "in_progress" },
    ]);
    await updateTodoStatusFromStorage(WORKSPACE_ID);
    await setTodosForSessionDir(WORKSPACE_ID, sessionDir, [
      { content: "Already done", status: "completed" },
      { content: "Finish backend", status: "completed" },
    ]);
    await updateTodoStatusFromStorage(WORKSPACE_ID);
    await service.flush();

    const page = await service.list(WORKSPACE_ID, {});
    expect(page.events.map((event) => [event.kind, event.data?.digest])).toEqual([
      ["agent.todo_completed", "Finish backend"],
    ]);
  });

  test("history compaction leaves the timeline bytes unchanged", async () => {
    service.record(WORKSPACE_ID, draft("durable"));
    await service.flush();
    const before = await fs.readFile(timelinePath());

    await historyService.appendToHistory(WORKSPACE_ID, message("user", "user", "Before boundary"));
    await historyService.appendToHistory(
      WORKSPACE_ID,
      message("boundary", "assistant", "Summary", {
        compactionBoundary: true,
        compacted: "user",
        compactionEpoch: 1,
      })
    );

    const after = await fs.readFile(timelinePath());
    expect(after.equals(before)).toBe(true);
  });
});
