import { describe, expect, test, mock } from "bun:test";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import { AgentSession } from "./agentSession";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { BackgroundProcessManager } from "./backgroundProcessManager";

import type { MuxMessage } from "@/common/types/message";
import type { SendMessageOptions } from "@/common/orpc/types";

function createPersistedPostCompactionState(options: {
  filePath: string;
  diffs: Array<{ path: string; diff: string; truncated: boolean }>;
}): Promise<void> {
  const payload = {
    version: 1 as const,
    createdAt: Date.now(),
    diffs: options.diffs,
  };

  return fsPromises.writeFile(options.filePath, JSON.stringify(payload));
}

describe("AgentSession post-compaction context retry", () => {
  test("retries once without post-compaction injection on context_exceeded", async () => {
    const workspaceId = "ws";
    const sessionDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-agentSession-"));
    const postCompactionPath = path.join(sessionDir, "post-compaction.json");

    await createPersistedPostCompactionState({
      filePath: postCompactionPath,
      diffs: [
        {
          path: "/tmp/foo.ts",
          diff: "@@ -1 +1 @@\n-foo\n+bar\n",
          truncated: false,
        },
      ],
    });

    const history: MuxMessage[] = [
      {
        id: "compaction-summary",
        role: "assistant",
        parts: [{ type: "text", text: "Summary" }],
        metadata: { timestamp: 1000, compacted: "user" },
      },
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { timestamp: 1100 },
      },
    ];

    const historyService: HistoryService = {
      getHistory: mock(() => Promise.resolve({ success: true as const, data: history })),
      deleteMessage: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    } as unknown as HistoryService;

    const partialService: PartialService = {
      commitToHistory: mock(() => Promise.resolve({ success: true as const, data: undefined })),
      deletePartial: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    } as unknown as PartialService;

    const aiEmitter = new EventEmitter();

    let resolveSecondCall: (() => void) | undefined;
    const secondCall = new Promise<void>((resolve) => {
      resolveSecondCall = resolve;
    });

    let callCount = 0;
    const streamMessage = mock((..._args: unknown[]) => {
      callCount += 1;

      if (callCount === 1) {
        // Simulate a provider context limit error before any deltas.
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-ctx-exceeded",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });

        return Promise.resolve({ success: true as const, data: undefined });
      }

      resolveSecondCall?.();
      return Promise.resolve({ success: true as const, data: undefined });
    });

    const aiService: AIService = {
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiEmitter.on(String(eventName), listener);
        return this;
      },
      off(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiEmitter.off(String(eventName), listener);
        return this;
      },
      streamMessage,
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "nope" })),
      stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    } as unknown as AIService;

    const initStateManager: InitStateManager = {
      on() {
        return this;
      },
      off() {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      setMessageQueued: mock(() => undefined),
      cleanup: mock(() => Promise.resolve()),
    } as unknown as BackgroundProcessManager;

    const config: Config = {
      srcDir: "/tmp",
      getSessionDir: mock(() => sessionDir),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const options: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions;

    // Call streamWithHistory directly (private) to avoid needing a full user send pipeline.
    await (
      session as unknown as {
        streamWithHistory: (m: string, o: SendMessageOptions) => Promise<unknown>;
      }
    ).streamWithHistory(options.model, options);

    // Wait for the retry call to happen.
    await Promise.race([
      secondCall,
      new Promise((_, reject) => setTimeout(() => reject(new Error("retry timeout")), 1000)),
    ]);

    expect(streamMessage).toHaveBeenCalledTimes(2);

    const firstAttachments = (streamMessage as ReturnType<typeof mock>).mock
      .calls[0][12] as unknown;
    expect(Array.isArray(firstAttachments)).toBe(true);

    const secondAttachments = (streamMessage as ReturnType<typeof mock>).mock
      .calls[1][12] as unknown;
    expect(secondAttachments).toBeNull();

    expect((historyService.deleteMessage as ReturnType<typeof mock>).mock.calls[0][1]).toBe(
      "assistant-ctx-exceeded"
    );

    // Pending post-compaction state should be discarded.
    let exists = true;
    try {
      await fsPromises.stat(postCompactionPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    session.dispose();
  });
});
