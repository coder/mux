import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { SessionUsageService, type SessionUsageTokenStatsCacheV1 } from "./sessionUsageService";
import type { HistoryService } from "./historyService";
import { Config } from "@/node/config";
import { createMuxMessage } from "@/common/types/message";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { Ok } from "@/common/types/result";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

function createMockHistoryService(
  messages: Array<ReturnType<typeof createMuxMessage>> = []
): HistoryService {
  return {
    // sessionUsageService calls iterateFullHistory to collect all messages for rebuild
    iterateFullHistory: mock(
      (_workspaceId: string, _direction: string, visitor: (chunk: unknown[]) => void) => {
        if (messages.length > 0) visitor(messages);
        return Promise.resolve(Ok(undefined));
      }
    ),
    appendToHistory: mock(() => Promise.resolve(Ok(undefined))),
    updateHistory: mock(() => Promise.resolve(Ok(undefined))),
    truncateAfterMessage: mock(() => Promise.resolve(Ok(undefined))),
    clearHistory: mock(() => Promise.resolve(Ok([]))),
  } as unknown as HistoryService;
}

function createUsage(input: number, output: number): ChatUsageDisplay {
  return {
    input: { tokens: input },
    output: { tokens: output },
    cached: { tokens: 0 },
    cacheCreate: { tokens: 0 },
    reasoning: { tokens: 0 },
  };
}

describe("SessionUsageService", () => {
  let service: SessionUsageService;
  let config: Config;
  let tempDir: string;
  let mockHistoryService: HistoryService;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `mux-session-usage-test-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tempDir, { recursive: true });
    config = new Config(tempDir);
    mockHistoryService = createMockHistoryService();
    service = new SessionUsageService(config, mockHistoryService);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("rollUpUsageIntoParent", () => {
    it("should roll up child usage into parent without changing parent's lastRequest", async () => {
      const projectPath = "/tmp/mux-session-usage-test-project";
      const model = "claude-sonnet-4-20250514";

      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      await config.addWorkspace(projectPath, {
        id: childWorkspaceId,
        name: "child-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
        parentWorkspaceId: parentWorkspaceId,
      });

      const parentUsage = createUsage(100, 50);
      await service.recordUsage(parentWorkspaceId, model, parentUsage);
      const before = await service.getSessionUsage(parentWorkspaceId);
      expect(before?.lastRequest).toBeDefined();

      const beforeLastRequest = before!.lastRequest!;

      const childUsageByModel = { [model]: createUsage(7, 3) };
      const rollupResult = await service.rollUpUsageIntoParent(
        parentWorkspaceId,
        childWorkspaceId,
        childUsageByModel
      );
      expect(rollupResult.didRollUp).toBe(true);

      const after = await service.getSessionUsage(parentWorkspaceId);
      expect(after).toBeDefined();
      expect(after!.byModel[model].input.tokens).toBe(107);
      expect(after!.byModel[model].output.tokens).toBe(53);

      // lastRequest is preserved
      expect(after!.lastRequest).toEqual(beforeLastRequest);
    });

    it("should be idempotent for the same child workspace", async () => {
      const projectPath = "/tmp/mux-session-usage-test-project";
      const model = "claude-sonnet-4-20250514";

      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });

      const childUsageByModel = { [model]: createUsage(10, 5) };

      const first = await service.rollUpUsageIntoParent(
        parentWorkspaceId,
        childWorkspaceId,
        childUsageByModel
      );
      expect(first.didRollUp).toBe(true);

      const second = await service.rollUpUsageIntoParent(
        parentWorkspaceId,
        childWorkspaceId,
        childUsageByModel
      );
      expect(second.didRollUp).toBe(false);

      const result = await service.getSessionUsage(parentWorkspaceId);
      expect(result).toBeDefined();
      expect(result!.byModel[model].input.tokens).toBe(10);
      expect(result!.byModel[model].output.tokens).toBe(5);
      expect(result!.rolledUpFrom?.[childWorkspaceId]).toBe(true);
    });
  });
  describe("recordUsage", () => {
    it("should accumulate usage for same model (not overwrite)", async () => {
      const workspaceId = "test-workspace";
      const model = "claude-sonnet-4-20250514";
      const usage1 = createUsage(100, 50);
      const usage2 = createUsage(200, 75);

      await service.recordUsage(workspaceId, model, usage1);
      await service.recordUsage(workspaceId, model, usage2);

      const result = await service.getSessionUsage(workspaceId);
      expect(result).toBeDefined();
      expect(result!.byModel[model].input.tokens).toBe(300); // 100 + 200
      expect(result!.byModel[model].output.tokens).toBe(125); // 50 + 75
    });

    it("should track separate usage per model", async () => {
      const workspaceId = "test-workspace";
      const sonnet = createUsage(100, 50);
      const opus = createUsage(500, 200);

      await service.recordUsage(workspaceId, "claude-sonnet-4-20250514", sonnet);
      await service.recordUsage(workspaceId, "claude-opus-4-20250514", opus);

      const result = await service.getSessionUsage(workspaceId);
      expect(result).toBeDefined();
      expect(result!.byModel["claude-sonnet-4-20250514"].input.tokens).toBe(100);
      expect(result!.byModel["claude-opus-4-20250514"].input.tokens).toBe(500);
    });

    it("should update lastRequest with each recordUsage call", async () => {
      const workspaceId = "test-workspace";
      const usage1 = createUsage(100, 50);
      const usage2 = createUsage(200, 75);

      await service.recordUsage(workspaceId, "claude-sonnet-4-20250514", usage1);
      let result = await service.getSessionUsage(workspaceId);
      expect(result?.lastRequest?.model).toBe("claude-sonnet-4-20250514");
      expect(result?.lastRequest?.usage.input.tokens).toBe(100);

      await service.recordUsage(workspaceId, "claude-opus-4-20250514", usage2);
      result = await service.getSessionUsage(workspaceId);
      expect(result?.lastRequest?.model).toBe("claude-opus-4-20250514");
      expect(result?.lastRequest?.usage.input.tokens).toBe(200);
    });
  });

  describe("setTokenStatsCache", () => {
    it("should persist tokenStatsCache and preserve existing usage fields", async () => {
      const projectPath = "/tmp/mux-session-usage-test-project";
      const model = "claude-sonnet-4-20250514";

      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      await config.addWorkspace(projectPath, {
        id: childWorkspaceId,
        name: "child-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
        parentWorkspaceId: parentWorkspaceId,
      });

      // Seed: base usage + rolledUpFrom ledger
      await service.recordUsage(parentWorkspaceId, model, createUsage(100, 50));
      await service.rollUpUsageIntoParent(parentWorkspaceId, childWorkspaceId, {
        [model]: createUsage(7, 3),
      });

      const cache: SessionUsageTokenStatsCacheV1 = {
        version: 1,
        computedAt: 123,
        model: "gpt-4",
        tokenizerName: "cl100k",
        history: { messageCount: 2, maxHistorySequence: 42 },
        consumers: [{ name: "User", tokens: 10, percentage: 100 }],
        totalTokens: 10,
        topFilePaths: [{ path: "/tmp/file.ts", tokens: 10 }],
      };

      await service.setTokenStatsCache(parentWorkspaceId, cache);

      const result = await service.getSessionUsage(parentWorkspaceId);
      expect(result).toBeDefined();
      expect(result!.tokenStatsCache).toEqual(cache);
      expect(result!.rolledUpFrom?.[childWorkspaceId]).toBe(true);

      // Existing usage fields preserved
      expect(result!.byModel[model].input.tokens).toBe(107);
      expect(result!.byModel[model].output.tokens).toBe(53);
      expect(result!.lastRequest).toBeDefined();
    });
  });

  describe("getSessionUsage", () => {
    it("should rebuild from messages when file missing (ENOENT)", async () => {
      const workspaceId = "test-workspace";
      const messages = [
        createMuxMessage("msg1", "assistant", "Hello", {
          model: "claude-sonnet-4-20250514",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        }),
        createMuxMessage("msg2", "assistant", "World", {
          model: "claude-sonnet-4-20250514",
          usage: { inputTokens: 200, outputTokens: 75, totalTokens: 275 },
        }),
      ];
      mockHistoryService = createMockHistoryService(messages);
      service = new SessionUsageService(config, mockHistoryService);

      // Create session dir but NOT the session-usage.json file
      await fs.mkdir(config.getSessionDir(workspaceId), { recursive: true });

      const result = await service.getSessionUsage(workspaceId);

      expect(result).toBeDefined();
      // Should have rebuilt and summed the usage
      expect(result!.byModel["claude-sonnet-4-20250514"]).toBeDefined();
    });
  });

  describe("rebuildFromMessages", () => {
    it("should rebuild from messages when file is corrupted JSON", async () => {
      const workspaceId = "test-workspace";
      const messages = [
        createMuxMessage("msg1", "assistant", "Hello", {
          model: "claude-sonnet-4-20250514",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        }),
      ];
      mockHistoryService = createMockHistoryService(messages);
      service = new SessionUsageService(config, mockHistoryService);

      // Create session dir with corrupted JSON
      const sessionDir = config.getSessionDir(workspaceId);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(sessionDir, "session-usage.json"), "{ invalid json");

      const result = await service.getSessionUsage(workspaceId);

      expect(result).toBeDefined();
      // Should have rebuilt from messages
      expect(result!.byModel["claude-sonnet-4-20250514"]).toBeDefined();
      expect(result!.byModel["claude-sonnet-4-20250514"].input.tokens).toBe(100);
    });

    it("should include historicalUsage from legacy compaction summaries", async () => {
      const workspaceId = "test-workspace";

      // Create a compaction summary with historicalUsage (legacy format)
      const compactionSummary = createMuxMessage("summary-1", "assistant", "Compacted summary", {
        historySequence: 1,
        compacted: true,
        model: "anthropic:claude-sonnet-4-5",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });

      // Add historicalUsage - this field was removed from MuxMetadata type
      // but may still exist in persisted data from before the change
      (compactionSummary.metadata as Record<string, unknown>).historicalUsage = createUsage(
        5000,
        1000
      );

      // Add a post-compaction message
      const postCompactionMsg = createMuxMessage("msg2", "assistant", "New response", {
        historySequence: 2,
        model: "anthropic:claude-sonnet-4-5",
        usage: { inputTokens: 200, outputTokens: 75, totalTokens: 275 },
      });

      mockHistoryService = createMockHistoryService([compactionSummary, postCompactionMsg]);
      service = new SessionUsageService(config, mockHistoryService);

      // Create session dir but NOT the session-usage.json file (triggers rebuild)
      await fs.mkdir(config.getSessionDir(workspaceId), { recursive: true });

      const result = await service.getSessionUsage(workspaceId);

      expect(result).toBeDefined();
      // Should include historical usage under "historical" key
      expect(result!.byModel.historical).toBeDefined();
      expect(result!.byModel.historical.input.tokens).toBe(5000);
      expect(result!.byModel.historical.output.tokens).toBe(1000);

      // Should also include current model usage (compaction summary + post-compaction)
      expect(result!.byModel["anthropic:claude-sonnet-4-5"]).toBeDefined();
      expect(result!.byModel["anthropic:claude-sonnet-4-5"].input.tokens).toBe(300); // 100 + 200
    });
  });
});
