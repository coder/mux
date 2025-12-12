import { describe, expect, test, mock } from "bun:test";
import { AgentSession } from "./agentSession";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { BackgroundProcessManager } from "./backgroundProcessManager";

// NOTE: These tests focus on the event wiring (tool-call-end -> callback).
// The actual post-compaction state computation is covered elsewhere.

describe("AgentSession post-compaction refresh trigger", () => {
  test("triggers callback on file_edit_* tool-call-end when experiment enabled", () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();

    const aiService: AIService = {
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        handlers.set(String(eventName), listener);
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    } as unknown as AIService;

    const historyService: HistoryService = {
      getHistory: mock(() => Promise.resolve({ success: true as const, data: [] })),
    } as unknown as HistoryService;

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      setMessageQueued: mock(() => undefined),
      cleanup: mock(() => Promise.resolve()),
    } as unknown as BackgroundProcessManager;

    const config: Config = { srcDir: "/tmp" } as unknown as Config;
    const partialService: PartialService = {} as unknown as PartialService;

    const onPostCompactionStateChange = mock(() => undefined);

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      onPostCompactionStateChange,
    });

    // Enable the experiment gate (normally set during sendMessage()).
    (session as unknown as { postCompactionContextEnabled: boolean }).postCompactionContextEnabled =
      true;

    const toolEnd = handlers.get("tool-call-end");
    expect(toolEnd).toBeDefined();

    toolEnd!({
      type: "tool-call-end",
      workspaceId: "ws",
      messageId: "m1",
      toolCallId: "t1",
      toolName: "file_edit_insert",
      result: {},
      timestamp: Date.now(),
    });

    toolEnd!({
      type: "tool-call-end",
      workspaceId: "ws",
      messageId: "m1",
      toolCallId: "t2",
      toolName: "bash",
      result: {},
      timestamp: Date.now(),
    });

    expect(onPostCompactionStateChange).toHaveBeenCalledTimes(1);

    session.dispose();
  });

  test("does not trigger callback when experiment disabled", () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();

    const aiService: AIService = {
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        handlers.set(String(eventName), listener);
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
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
      setMessageQueued: mock(() => undefined),
      cleanup: mock(() => Promise.resolve()),
    } as unknown as BackgroundProcessManager;

    const config: Config = { srcDir: "/tmp" } as unknown as Config;
    const historyService: HistoryService = {
      getHistory: mock(() => Promise.resolve({ success: true as const, data: [] })),
    } as unknown as HistoryService;
    const partialService: PartialService = {} as unknown as PartialService;

    const onPostCompactionStateChange = mock(() => undefined);

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      onPostCompactionStateChange,
    });

    const toolEnd = handlers.get("tool-call-end");
    expect(toolEnd).toBeDefined();

    toolEnd!({
      type: "tool-call-end",
      workspaceId: "ws",
      messageId: "m1",
      toolCallId: "t1",
      toolName: "file_edit_replace_string",
      result: {},
      timestamp: Date.now(),
    });

    expect(onPostCompactionStateChange).toHaveBeenCalledTimes(0);

    session.dispose();
  });
});
