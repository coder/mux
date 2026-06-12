import { describe, expect, test, mock, afterEach } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Config } from "@/node/config";

import type { AIService } from "./aiService";
import { AgentSession } from "./agentSession";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { DisposableTempDir } from "./tempDir";
import { createTestHistoryService } from "./testHistoryService";

/**
 * Behavior under test: the hot-memories block is computed once at session
 * start and recomputed only at compaction boundaries — never per turn — so
 * the injected bytes stay prompt-cache-stable within a session segment.
 */

function createSession(args: {
  historyService: HistoryService;
  sessionDir: string;
  buildHotMemoriesBlock: AIService["buildHotMemoriesBlock"];
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
    buildHotMemoriesBlock: args.buildHotMemoriesBlock,
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
  resolveHotMemoriesBlock: () => Promise<string | undefined>;
  getPostCompactionAttachmentsIfNeeded: () => Promise<unknown>;
}

async function writePendingPostCompactionState(sessionDir: string): Promise<void> {
  await fs.writeFile(
    path.join(sessionDir, "post-compaction.json"),
    JSON.stringify({ version: 1, createdAt: Date.now(), diffs: [], loadedSkills: [] })
  );
}

describe("AgentSession hot memories", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  test("computes the block once at session start and reuses it across turns", async () => {
    using sessionDir = new DisposableTempDir("agent-session-hot-memories");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildHotMemoriesBlock = mock(() => Promise.resolve("<hot_memories>v1</hot_memories>"));
    const session = createSession({
      historyService,
      sessionDir: sessionDir.path,
      buildHotMemoriesBlock,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(await priv.resolveHotMemoriesBlock()).toBe("<hot_memories>v1</hot_memories>");
      expect(await priv.resolveHotMemoriesBlock()).toBe("<hot_memories>v1</hot_memories>");
      expect(buildHotMemoriesBlock).toHaveBeenCalledTimes(1);
    } finally {
      session.dispose();
    }
  });

  test("caches the absence of hot memories without re-querying per turn", async () => {
    using sessionDir = new DisposableTempDir("agent-session-hot-memories-null");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildHotMemoriesBlock = mock(() => Promise.resolve(null));
    const session = createSession({
      historyService,
      sessionDir: sessionDir.path,
      buildHotMemoriesBlock,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(await priv.resolveHotMemoriesBlock()).toBeUndefined();
      expect(await priv.resolveHotMemoriesBlock()).toBeUndefined();
      expect(buildHotMemoriesBlock).toHaveBeenCalledTimes(1);
    } finally {
      session.dispose();
    }
  });

  test("recomputes the block after a compaction boundary is consumed", async () => {
    using sessionDir = new DisposableTempDir("agent-session-hot-memories-compaction");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 1;
    const buildHotMemoriesBlock = mock(() =>
      Promise.resolve(`<hot_memories>v${version}</hot_memories>`)
    );
    const session = createSession({
      historyService,
      sessionDir: sessionDir.path,
      buildHotMemoriesBlock,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(await priv.resolveHotMemoriesBlock()).toBe("<hot_memories>v1</hot_memories>");

      // Consume a pending compaction boundary (first stream after compaction).
      version = 2;
      await writePendingPostCompactionState(sessionDir.path);
      await priv.getPostCompactionAttachmentsIfNeeded();

      expect(await priv.resolveHotMemoriesBlock()).toBe("<hot_memories>v2</hot_memories>");
      expect(buildHotMemoriesBlock).toHaveBeenCalledTimes(2);
    } finally {
      session.dispose();
    }
  });
});
