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
      getHistoryFromLatestBoundary: mock(() =>
        Promise.resolve({ success: true as const, data: history })
      ),
      getLastMessages: mock((_: string, n: number) =>
        Promise.resolve({ success: true as const, data: history.slice(-n) })
      ),
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

    // With the options bag, arg[0] is the StreamMessageOptions object.
    const firstOpts = (streamMessage as ReturnType<typeof mock>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(Array.isArray(firstOpts.postCompactionAttachments)).toBe(true);

    const secondOpts = (streamMessage as ReturnType<typeof mock>).mock.calls[1][0] as Record<
      string,
      unknown
    >;
    expect(secondOpts.postCompactionAttachments).toBeNull();

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

describe("AgentSession execSubagentHardRestart", () => {
  test("hard-restarts exec-like subagent history on context_exceeded and retries once", async () => {
    const workspaceId = "ws-hard";
    const sessionDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-agentSession-"));

    let history: MuxMessage[] = [
      {
        id: "snapshot-1",
        role: "user",
        parts: [{ type: "text", text: "<snapshot>" }],
        metadata: {
          timestamp: 1000,
          synthetic: true,
          fileAtMentionSnapshot: ["@foo"],
        },
      },
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Do the thing" }],
        metadata: {
          timestamp: 1100,
        },
      },
    ];

    const historyService: HistoryService = {
      getHistoryFromLatestBoundary: mock(() =>
        Promise.resolve({ success: true as const, data: history })
      ),
      getLastMessages: mock((_: string, n: number) =>
        Promise.resolve({ success: true as const, data: history.slice(-n) })
      ),
      clearHistory: mock(() => {
        history = [];
        return Promise.resolve({ success: true as const, data: [] });
      }),
      appendToHistory: mock((_workspaceId: string, message: MuxMessage) => {
        history = [...history, message];
        return Promise.resolve({ success: true as const, data: undefined });
      }),
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
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-ctx-exceeded-1",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });
        return Promise.resolve({ success: true as const, data: undefined });
      }

      if (callCount === 2) {
        // Second context_exceeded should NOT trigger an additional hard restart.
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-ctx-exceeded-2",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });
        resolveSecondCall?.();
        return Promise.resolve({ success: true as const, data: undefined });
      }

      throw new Error("unexpected third streamMessage call");
    });

    const parentWorkspaceId = "parent";

    const childWorkspaceMetadata = {
      id: workspaceId,
      name: "child",
      projectName: "proj",
      projectPath: "/tmp/proj",
      namedWorkspacePath: "/tmp/proj/child",
      runtimeConfig: { type: "local" },
      parentWorkspaceId,
      agentId: "exec",
    };

    const parentWorkspaceMetadata = {
      ...childWorkspaceMetadata,
      id: parentWorkspaceId,
      name: "parent",
      parentWorkspaceId: undefined,
    };

    const getWorkspaceMetadata = mock((id: string) => {
      if (id === workspaceId) {
        return Promise.resolve({
          success: true as const,
          data: childWorkspaceMetadata as never,
        });
      }

      if (id === parentWorkspaceId) {
        return Promise.resolve({
          success: true as const,
          data: parentWorkspaceMetadata as never,
        });
      }

      return Promise.resolve({ success: false as const, error: "unknown" });
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
      getWorkspaceMetadata,
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
      experiments: {
        execSubagentHardRestart: true,
      },
    } as unknown as SendMessageOptions;

    await (
      session as unknown as {
        streamWithHistory: (m: string, o: SendMessageOptions) => Promise<unknown>;
      }
    ).streamWithHistory(options.model, options);

    await Promise.race([
      secondCall,
      new Promise((_, reject) => setTimeout(() => reject(new Error("retry timeout")), 1000)),
    ]);

    expect(streamMessage).toHaveBeenCalledTimes(2);
    expect((historyService.clearHistory as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

    // Continuation notice + seed prompt (and snapshots) should be appended after clear.
    expect((historyService.appendToHistory as ReturnType<typeof mock>).mock.calls).toHaveLength(3);

    const appendedNotice = (historyService.appendToHistory as ReturnType<typeof mock>).mock
      .calls[0][1] as MuxMessage | undefined;
    expect(appendedNotice?.metadata?.synthetic).toBe(true);
    expect(appendedNotice?.metadata?.uiVisible).toBe(true);
    const noticeText = appendedNotice?.parts.find((p) => p.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(noticeText?.text).toContain("restarted");

    expect(
      ((historyService.appendToHistory as ReturnType<typeof mock>).mock.calls[1][1] as MuxMessage)
        .id
    ).toBe("snapshot-1");
    expect(
      ((historyService.appendToHistory as ReturnType<typeof mock>).mock.calls[2][1] as MuxMessage)
        .id
    ).toBe("user-1");

    // Retry should include the continuation notice in additionalSystemInstructions.
    const retryOpts = (streamMessage as ReturnType<typeof mock>).mock.calls[1][0] as Record<
      string,
      unknown
    >;
    expect(String(retryOpts.additionalSystemInstructions)).toContain("restarted");

    session.dispose();
  });

  test("resolves exec-like predicate from parent workspace when child agents are missing", async () => {
    const workspaceId = "ws-hard-custom-agent";
    const sessionDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-agentSession-"));

    let history: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Do the thing" }],
        metadata: {
          timestamp: 1100,
        },
      },
    ];

    const historyService: HistoryService = {
      getHistoryFromLatestBoundary: mock(() =>
        Promise.resolve({ success: true as const, data: history })
      ),
      getLastMessages: mock((_: string, n: number) =>
        Promise.resolve({ success: true as const, data: history.slice(-n) })
      ),
      clearHistory: mock(() => {
        history = [];
        return Promise.resolve({ success: true as const, data: [] });
      }),
      appendToHistory: mock((_workspaceId: string, message: MuxMessage) => {
        history = [...history, message];
        return Promise.resolve({ success: true as const, data: undefined });
      }),
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
          messageId: "assistant-ctx-exceeded-1",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });

        return Promise.resolve({ success: true as const, data: undefined });
      }

      resolveSecondCall?.();
      return Promise.resolve({ success: true as const, data: undefined });
    });

    const customAgentId = "custom_hard_restart_agent";

    const srcBaseDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "mux-agentSession-worktrees-")
    );
    const projectPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-agentSession-proj-"));

    // Create a custom agent definition ONLY in the parent workspace path.
    // This simulates untracked .mux/agents that are present in the parent worktree but absent
    // from the child task worktree.
    const parentWorkspaceName = "parent";
    const parentAgentsDir = path.join(
      srcBaseDir,
      path.basename(projectPath),
      parentWorkspaceName,
      ".mux",
      "agents"
    );
    await fsPromises.mkdir(parentAgentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(parentAgentsDir, `${customAgentId}.md`),
      [
        "---",
        "name: Custom Hard Restart Agent",
        "description: Test agent inheriting exec",
        "base: exec",
        "---",
        "",
        "Body",
        "",
      ].join("\n")
    );

    const parentWorkspaceId = "parent-custom";

    const childWorkspaceMetadata = {
      id: workspaceId,
      name: "child",
      projectName: "proj",
      projectPath,
      runtimeConfig: { type: "worktree", srcBaseDir },
      parentWorkspaceId,
      agentId: customAgentId,
    };

    const parentWorkspaceMetadata = {
      ...childWorkspaceMetadata,
      id: parentWorkspaceId,
      name: parentWorkspaceName,
      parentWorkspaceId: undefined,
      agentId: "exec",
    };

    const getWorkspaceMetadata = mock((id: string) => {
      if (id === workspaceId) {
        return Promise.resolve({
          success: true as const,
          data: childWorkspaceMetadata as never,
        });
      }

      if (id === parentWorkspaceId) {
        return Promise.resolve({
          success: true as const,
          data: parentWorkspaceMetadata as never,
        });
      }

      return Promise.resolve({ success: false as const, error: "unknown" });
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
      getWorkspaceMetadata,
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
      agentId: customAgentId,
      experiments: {
        execSubagentHardRestart: true,
      },
    } as unknown as SendMessageOptions;

    await (
      session as unknown as {
        streamWithHistory: (m: string, o: SendMessageOptions) => Promise<unknown>;
      }
    ).streamWithHistory(options.model, options);

    await Promise.race([
      secondCall,
      new Promise((_, reject) => setTimeout(() => reject(new Error("retry timeout")), 1000)),
    ]);

    expect(streamMessage).toHaveBeenCalledTimes(2);
    expect((historyService.clearHistory as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

    session.dispose();
  });

  test("does not hard-restart when workspace is not a subagent", async () => {
    const workspaceId = "ws-hard-no-parent";
    const sessionDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-agentSession-"));

    const history: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Do the thing" }],
        metadata: { timestamp: 1100 },
      },
    ];

    const historyService: HistoryService = {
      getHistoryFromLatestBoundary: mock(() =>
        Promise.resolve({ success: true as const, data: history })
      ),
      getLastMessages: mock((_: string, n: number) =>
        Promise.resolve({ success: true as const, data: history.slice(-n) })
      ),
      clearHistory: mock(() => Promise.resolve({ success: true as const, data: [] })),
      appendToHistory: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    } as unknown as HistoryService;

    const partialService: PartialService = {
      commitToHistory: mock(() => Promise.resolve({ success: true as const, data: undefined })),
      deletePartial: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    } as unknown as PartialService;

    const aiEmitter = new EventEmitter();

    const streamMessage = mock((..._args: unknown[]) => {
      aiEmitter.emit("error", {
        workspaceId,
        messageId: "assistant-ctx-exceeded",
        error: "Context length exceeded",
        errorType: "context_exceeded",
      });
      return Promise.resolve({ success: true as const, data: undefined });
    });

    const workspaceMetadata = {
      id: workspaceId,
      name: "child",
      projectName: "proj",
      projectPath: "/tmp/proj",
      namedWorkspacePath: "/tmp/proj/child",
      runtimeConfig: { type: "local" },
      agentId: "exec",
    };

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
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: true as const, data: workspaceMetadata as never })
      ),
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
      experiments: {
        execSubagentHardRestart: true,
      },
    } as unknown as SendMessageOptions;

    await (
      session as unknown as {
        streamWithHistory: (m: string, o: SendMessageOptions) => Promise<unknown>;
      }
    ).streamWithHistory(options.model, options);

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(streamMessage).toHaveBeenCalledTimes(1);
    expect((historyService.clearHistory as ReturnType<typeof mock>).mock.calls).toHaveLength(0);

    session.dispose();
  });
});
