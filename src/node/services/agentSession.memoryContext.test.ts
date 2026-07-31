import { describe, expect, test, mock, afterEach } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Config } from "@/node/config";

import type { AIService } from "./aiService";
import type { MemorySessionContext } from "./memoryService";
import { AgentSession } from "./agentSession";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { DisposableTempDir } from "./tempDir";
import { createTestHistoryService } from "./testHistoryService";

/**
 * Behavior under test: the memory session context (index snapshot +
 * hot-memories block) is computed once per model in a session segment and
 * recomputed at compaction boundaries — never per repeated model turn — so the
 * injected bytes stay prompt-cache-stable.
 */

function createSession(args: {
  historyService: HistoryService;
  sessionDir: string;
  buildMemorySessionContext: AIService["buildMemorySessionContext"];
}): AgentSession {
  const aiEmitter = new EventEmitter();
  const aiService: AIService = {
    on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
      aiEmitter.on(String(eventName), listener);
      return this;
    },
    off(eventName: string | symbol, listener: (...args: unknown[]) => void) {
      aiEmitter.off(String(eventName), listener);
      return this;
    },
    getWorkspaceMetadata: mock(() =>
      Promise.resolve({ success: false as const, error: "metadata unavailable" })
    ),
    stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    buildMemorySessionContext: args.buildMemorySessionContext,
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
    getSessionDir: mock(() => args.sessionDir),
  } as unknown as Config;

  return new AgentSession({
    workspaceId: "workspace-hot-memories-test",
    config,
    historyService: args.historyService,
    aiService,
    initStateManager,
    backgroundProcessManager,
  });
}

interface PrivateSessionAccess {
  resolveMemoryContext: (
    modelString: string,
    options?: { includeHotMemories?: boolean }
  ) => Promise<MemorySessionContext | undefined>;
  getPostCompactionAttachmentsIfNeeded: () => Promise<unknown>;
}

async function writePendingPostCompactionState(sessionDir: string): Promise<void> {
  await fs.writeFile(
    path.join(sessionDir, "post-compaction.json"),
    JSON.stringify({ version: 1, createdAt: Date.now(), diffs: [], loadedSkills: [] })
  );
}

describe("AgentSession memory context", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  test("computes the context once for a model and reuses it across turns", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const context: MemorySessionContext = {
      indexEntries: [{ path: "/memories/global/a.md", description: "desc a" }],
      hotMemoriesBlock: "<hot_memories>v1</hot_memories>",
    };
    const buildMemorySessionContext = mock(() => Promise.resolve(context));
    const session = createSession({
      historyService,
      sessionDir: sessionDir.path,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(await priv.resolveMemoryContext("test-model")).toEqual(context);
      expect(await priv.resolveMemoryContext("test-model")).toEqual(context);
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
    } finally {
      session.dispose();
    }
  });

  test("upgrades an index-only memory context when hot memories are requested", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-upgrade");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock(
      (_workspaceId: string, modelString: string, options?: { includeHotMemories?: boolean }) =>
        Promise.resolve({
          indexEntries: [],
          hotMemoriesBlock:
            options?.includeHotMemories === false
              ? null
              : `<hot_memories>${modelString}</hot_memories>`,
        })
    );
    const session = createSession({
      historyService,
      sessionDir: sessionDir.path,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(
        (await priv.resolveMemoryContext("model-a", { includeHotMemories: false }))
          ?.hotMemoriesBlock
      ).toBeNull();
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      session.dispose();
    }
  });

  test("caches memory context separately per model", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-model");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock((_workspaceId: string, modelString: string) =>
      Promise.resolve({
        indexEntries: [],
        hotMemoriesBlock: `<hot_memories>${modelString}</hot_memories>`,
      })
    );
    const session = createSession({
      historyService,
      sessionDir: sessionDir.path,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect((await priv.resolveMemoryContext("model-b"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-b</hot_memories>"
      );
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      session.dispose();
    }
  });

  test("caches the absence of memory context without re-querying per turn", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-null");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock(() => Promise.resolve(null));
    const session = createSession({
      historyService,
      sessionDir: sessionDir.path,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(await priv.resolveMemoryContext("test-model")).toBeUndefined();
      expect(await priv.resolveMemoryContext("test-model")).toBeUndefined();
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
    } finally {
      session.dispose();
    }
  });

  test("recomputes the context after invalidateMemoryContext (memory change / context reset)", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-invalidate");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let indexEntries = [{ path: "/memories/global/deleted.md", description: "stale" }];
    const buildMemorySessionContext = mock(() =>
      Promise.resolve({ indexEntries, hotMemoriesBlock: null })
    );
    const session = createSession({
      historyService,
      sessionDir: sessionDir.path,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect((await priv.resolveMemoryContext("test-model"))?.indexEntries).toHaveLength(1);

      indexEntries = [];
      session.invalidateMemoryContext();

      expect((await priv.resolveMemoryContext("test-model"))?.indexEntries).toHaveLength(0);
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      session.dispose();
    }
  });

  test("rebuilds mid-request when invalidation arrives during an in-flight build", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-race");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let indexEntries = [{ path: "/memories/global/deleted.md", description: "stale" }];
    const pendingReleases: Array<() => void> = [];
    const buildMemorySessionContext = mock(async () => {
      const entries = indexEntries;
      await new Promise<void>((resolve) => {
        pendingReleases.push(resolve);
      });
      return { indexEntries: entries, hotMemoriesBlock: null };
    });
    const session = createSession({
      historyService,
      sessionDir: sessionDir.path,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      const firstResolve = priv.resolveMemoryContext("test-model");
      // The memory change lands while the first build is still awaited.
      indexEntries = [];
      session.invalidateMemoryContext();
      pendingReleases.shift()?.();
      // The stale build result triggers a rebuild; release it once it starts.
      while (pendingReleases.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      pendingReleases.shift()?.();

      // The current request already sees the post-invalidation state.
      expect((await firstResolve)?.indexEntries).toHaveLength(0);
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);

      // The clean rebuild was cached: no further build on the next resolve.
      const secondResolve = priv.resolveMemoryContext("test-model");
      expect((await secondResolve)?.indexEntries).toHaveLength(0);
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      session.dispose();
    }
  });

  test("persistent invalidation churn stops rebuilding at the attempt bound and stays uncached", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-churn");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 0;
    // Every build observes a concurrent invalidation before it completes.
    const buildMemorySessionContext = mock(() => {
      version++;
      session.invalidateMemoryContext();
      return Promise.resolve({
        indexEntries: [{ path: `/memories/global/v${version}.md`, description: `v${version}` }],
        hotMemoriesBlock: null,
      });
    });
    const session = createSession({
      historyService,
      sessionDir: sessionDir.path,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      // Three attempts (the bound), then the freshest snapshot is served.
      const first = await priv.resolveMemoryContext("test-model");
      expect(first?.indexEntries[0]?.path).toBe("/memories/global/v3.md");
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(3);

      // Nothing was cached, so the next request rebuilds.
      await priv.resolveMemoryContext("test-model");
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(6);
    } finally {
      session.dispose();
    }
  });

  test("recomputes the context after a compaction boundary is consumed", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-compaction");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 1;
    const buildMemorySessionContext = mock(() =>
      Promise.resolve({
        indexEntries: [],
        hotMemoriesBlock: `<hot_memories>v${version}</hot_memories>`,
      })
    );
    const session = createSession({
      historyService,
      sessionDir: sessionDir.path,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect((await priv.resolveMemoryContext("test-model"))?.hotMemoriesBlock).toBe(
        "<hot_memories>v1</hot_memories>"
      );

      // Consume a pending compaction boundary (first stream after compaction).
      version = 2;
      await writePendingPostCompactionState(sessionDir.path);
      await priv.getPostCompactionAttachmentsIfNeeded();

      expect((await priv.resolveMemoryContext("test-model"))?.hotMemoriesBlock).toBe(
        "<hot_memories>v2</hot_memories>"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      session.dispose();
    }
  });
});
