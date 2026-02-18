import { afterEach, describe, expect, mock, test } from "bun:test";

import { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import type { InitStateManager } from "./initStateManager";
import type { WorkspaceChatMessage, SendMessageOptions } from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { Ok } from "@/common/types/result";

interface SessionBundle {
  session: AgentSession;
  historyService: HistoryService;
  events: WorkspaceChatMessage[];
  cleanup: () => Promise<void>;
}

async function createSessionBundle(workspaceId: string): Promise<SessionBundle> {
  const { historyService, cleanup } = await createTestHistoryService();

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: workspaceId,
    projectName: "project",
    projectPath: "/tmp/project",
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    aiSettingsByAgent: {
      exec: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" },
    },
  };

  const aiService: AIService = {
    on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
      return this;
    },
    off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
      return this;
    },
    stopStream: mock(() => Promise.resolve(Ok(undefined))),
    isStreaming: mock(() => false),
    streamMessage: mock(() => Promise.resolve(Ok(undefined))),
    getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
  } as unknown as AIService;

  const initStateManager: InitStateManager = {
    on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
      return this;
    },
    off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
      return this;
    },
  } as unknown as InitStateManager;

  const backgroundProcessManager: BackgroundProcessManager = {
    cleanup: mock(() => Promise.resolve()),
    setMessageQueued: mock(() => undefined),
  } as unknown as BackgroundProcessManager;

  const config: Config = {
    srcDir: "/tmp",
    getSessionDir: mock(() => "/tmp"),
  } as unknown as Config;

  const session = new AgentSession({
    workspaceId,
    config,
    historyService,
    aiService,
    initStateManager,
    backgroundProcessManager,
  });

  const events: WorkspaceChatMessage[] = [];
  session.onChatEvent(({ message }) => {
    events.push(message);
  });

  return { session, historyService, events, cleanup };
}

describe("AgentSession startup auto-retry recovery", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  test("schedules startup auto-retry for interrupted user tail", async () => {
    const workspaceId = "startup-retry-user-tail";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Hello from interrupted turn", {
        timestamp: Date.now(),
        toolPolicy: [{ regex_match: ".*", action: "disable" }],
      })
    );
    expect(appendResult.success).toBe(true);

    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    const scheduledEvent = events.find((event) => event.type === "auto-retry-scheduled");
    expect(scheduledEvent).toBeDefined();

    const retryOptions = (session as unknown as { lastAutoRetryOptions?: SendMessageOptions })
      .lastAutoRetryOptions;
    expect(retryOptions).toBeDefined();
    if (!retryOptions) {
      throw new Error("Expected startup auto-retry options to be captured");
    }
    expect(retryOptions.model).toBe("anthropic:claude-sonnet-4-5");
    expect(retryOptions.agentId).toBe("exec");
    expect(retryOptions.toolPolicy).toEqual([{ regex_match: ".*", action: "disable" }]);

    session.dispose();
  });

  test("does not schedule startup auto-retry while ask_user_question is waiting", async () => {
    const workspaceId = "startup-retry-ask-user";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const writePartialResult = await historyService.writePartial(
      workspaceId,
      createMuxMessage(
        "assistant-1",
        "assistant",
        "",
        {
          timestamp: Date.now(),
          model: "anthropic:claude-sonnet-4-5",
          partial: true,
          agentId: "exec",
        },
        [
          {
            type: "dynamic-tool",
            state: "input-available",
            toolCallId: "tool-1",
            toolName: "ask_user_question",
            input: { question: "Name?" },
          },
        ]
      )
    );
    expect(writePartialResult.success).toBe(true);

    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    session.dispose();
  });
});
