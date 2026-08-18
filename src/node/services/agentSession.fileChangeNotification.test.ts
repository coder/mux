import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, stat, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { createMuxMessage } from "@/common/types/message";
import type { MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { Config } from "@/node/config";
import { AgentSession } from "./agentSession";
import type { AIService, StreamMessageOptions } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { InitStateManager } from "./initStateManager";
import { createTestHistoryService } from "./testHistoryService";

/**
 * Log purity: externally-edited files must produce a durable <system-file-update>
 * row in chat.jsonl BEFORE the provider request is built. The request itself is a
 * pure function of history — there is no request-time injection path.
 */
describe("AgentSession file-change notification (turn start)", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  let tmpDir: string | undefined;
  const sessions: AgentSession[] = [];

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      session.dispose();
    }
    await historyCleanup?.();
    historyCleanup = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("changed files append a durable history row before the request is built", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mux-file-change-notification-"));

    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    await historyService.appendToHistory(
      "ws",
      createMuxMessage("user-1", "user", "hello", { timestamp: Date.now() })
    );

    const capturedRequests: MuxMessage[][] = [];
    const streamMessage = mock((opts: StreamMessageOptions) => {
      capturedRequests.push(opts.messages);
      return Promise.resolve(Ok(undefined));
    });
    const aiService: AIService = {
      on: mock(() => aiService),
      off: mock(() => aiService),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage,
    } as unknown as AIService;

    const initStateManager: InitStateManager = {
      on: mock(() => initStateManager),
      off: mock(() => initStateManager),
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId: "ws",
      config: config as unknown as Config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });
    sessions.push(session);

    // Track a file, then edit it externally (content + future mtime).
    const trackedFile = join(tmpDir, "plan.md");
    await writeFile(trackedFile, "original content");
    const originalMtime = (await stat(trackedFile)).mtimeMs;
    await session.recordFileState(trackedFile, {
      content: "original content",
      timestamp: originalMtime,
    });
    await writeFile(trackedFile, "modified content");
    const futureMtime = Date.now() + 1000;
    await utimes(trackedFile, futureMtime / 1000, futureMtime / 1000);

    const result = await session.resumeStream({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    // The request contains the notification…
    const requestMessages = capturedRequests[0];
    const requestNotification = requestMessages.find((m) =>
      m.parts.some((p) => p.type === "text" && p.text.includes("<system-file-update>"))
    );
    expect(requestNotification).toBeDefined();
    const requestText = requestNotification?.parts.find((p) => p.type === "text")?.text ?? "";
    expect(requestText).toContain("plan.md was modified");
    expect(requestText).toContain("+modified content");

    // …and that exact row (same id, same content) is durable in chat.jsonl:
    // the request was built purely from history.
    const historyResult = await historyService.getHistoryFromLatestBoundary("ws");
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) return;
    const persistedNotification = historyResult.data.find((m) => m.id === requestNotification?.id);
    expect(persistedNotification).toBeDefined();
    expect(persistedNotification?.metadata?.synthetic).toBe(true);
    expect(persistedNotification?.parts).toEqual(requestNotification?.parts ?? []);

    // A second stream without further edits appends no duplicate notification
    // (tracker state was updated on detection).
    const secondResult = await session.resumeStream({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(secondResult.success).toBe(true);
    const secondHistory = await historyService.getHistoryFromLatestBoundary("ws");
    expect(secondHistory.success).toBe(true);
    if (!secondHistory.success) return;
    const notificationRows = secondHistory.data.filter((m) => m.id.startsWith("file-change-"));
    expect(notificationRows).toHaveLength(1);
  });
});
