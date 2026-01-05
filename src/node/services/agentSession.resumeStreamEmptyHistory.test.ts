import { describe, expect, test, mock } from "bun:test";

import { AgentSession } from "./agentSession";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";

describe("AgentSession.resumeStream", () => {
  test("returns an error when history is empty", async () => {
    const streamMessage = mock(() => Promise.resolve(Ok(undefined)));

    const aiService: AIService = {
      on: mock(() => aiService),
      off: mock(() => aiService),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage,
    } as unknown as AIService;

    const historyService: HistoryService = {
      getHistory: mock(() => Promise.resolve(Ok([]))),
    } as unknown as HistoryService;

    const partialService: PartialService = {
      commitToHistory: mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined))),
    } as unknown as PartialService;

    const initStateManager: InitStateManager = {
      on: mock(() => initStateManager),
      off: mock(() => initStateManager),
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const config: Config = { srcDir: "/tmp" } as unknown as Config;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const result = await session.resumeStream({ model: "anthropic:claude-sonnet-4-5" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("unknown");
    if (result.error.type !== "unknown") {
      throw new Error(`Expected unknown error, got ${result.error.type}`);
    }
    expect(result.error.raw).toContain("history is empty");
    expect(streamMessage).toHaveBeenCalledTimes(0);
  });
});
