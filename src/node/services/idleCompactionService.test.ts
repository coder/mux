import { describe, test, expect, beforeEach, mock, afterEach, spyOn } from "bun:test";
import { IdleCompactionService } from "./idleCompactionService";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { ProjectConfig, ProjectsConfig } from "@/common/types/project";
import { createMuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { createTestHistoryService } from "./testHistoryService";

async function waitForCondition(
  condition: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 1_000;
  const intervalMs = options?.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe("IdleCompactionService", () => {
  // Mock services
  let mockConfig: Config;
  let historyService: HistoryService;
  let mockExtensionMetadata: ExtensionMetadataService;
  let executeIdleCompactionMock: ReturnType<typeof mock<(workspaceId: string) => Promise<void>>>;
  let service: IdleCompactionService;
  let cleanup: () => Promise<void>;

  // Test data
  const testWorkspaceId = "test-workspace-id";
  const testProjectPath = "/test/project";
  const now = Date.now();
  const oneHourMs = 60 * 60 * 1000;

  beforeEach(async () => {
    // Create mock config
    mockConfig = {
      loadConfigOrDefault: mock(() => ({
        projects: new Map<string, ProjectConfig>([
          [
            testProjectPath,
            {
              workspaces: [{ id: testWorkspaceId, path: "/test/path", name: "test" }],
              idleCompactionHours: 24,
            },
          ],
        ]),
      })),
    } as unknown as Config;

    // Create real history service and seed default idle messages (25 hours ago)
    ({ historyService, cleanup } = await createTestHistoryService());
    const idleTimestamp = now - 25 * oneHourMs;
    await historyService.appendToHistory(
      testWorkspaceId,
      createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp })
    );
    await historyService.appendToHistory(
      testWorkspaceId,
      createMuxMessage("2", "assistant", "Hi there!", { timestamp: idleTimestamp })
    );

    // Create mock extension metadata service
    mockExtensionMetadata = {
      getMetadata: mock(() =>
        Promise.resolve({
          workspaceId: testWorkspaceId,
          recency: now - 25 * oneHourMs, // 25 hours ago
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          updatedAt: now - 25 * oneHourMs,
        })
      ),
    } as unknown as ExtensionMetadataService;

    executeIdleCompactionMock = mock(async () => {
      // noop mock
    });

    service = new IdleCompactionService(
      mockConfig,
      historyService,
      mockExtensionMetadata,
      executeIdleCompactionMock
    );
  });

  afterEach(async () => {
    service.stop();
    await cleanup();
  });

  describe("checkEligibility", () => {
    const threshold24h = 24 * oneHourMs;

    test("returns eligible for idle workspace with messages", async () => {
      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(true);
    });

    test("returns ineligible when workspace is currently streaming", async () => {
      // Idle messages already seeded in beforeEach; workspace is streaming
      const idleTimestamp = now - 25 * oneHourMs;
      (mockExtensionMetadata.getMetadata as ReturnType<typeof mock>).mockResolvedValueOnce({
        workspaceId: testWorkspaceId,
        recency: idleTimestamp,
        streaming: true, // Currently streaming
        lastModel: null,
        lastThinkingLevel: null,
        updatedAt: idleTimestamp,
      });

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("currently_streaming");
    });

    test("returns ineligible when workspace has no messages", async () => {
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(Ok([]));

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("no_messages");
    });

    test("returns ineligible when last message is already compacted", async () => {
      const idleTimestamp = now - 25 * oneHourMs;
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "assistant", "Summary", {
            compacted: true,
            timestamp: idleTimestamp,
          }),
        ])
      );

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("already_compacted");
    });

    test("returns ineligible when not idle long enough", async () => {
      // Messages with recent timestamps (only 1 hour ago)
      const recentTimestamp = now - oneHourMs;
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: recentTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: recentTimestamp }),
        ])
      );

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("not_idle_enough");
    });

    test("returns ineligible when last message is from user (awaiting response)", async () => {
      const idleTimestamp = now - 25 * oneHourMs;
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
          createMuxMessage("3", "user", "Another question?", { timestamp: idleTimestamp }), // Last message is user
        ])
      );

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("awaiting_response");
    });

    test("returns ineligible when messages have no timestamps", async () => {
      // Messages without timestamps - can't determine recency
      spyOn(historyService, "getLastMessages").mockResolvedValueOnce(
        Ok([createMuxMessage("1", "user", "Hello"), createMuxMessage("2", "assistant", "Hi!")])
      );

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("no_recency_data");
    });
  });

  describe("checkAllWorkspaces", () => {
    test("skips projects without idleCompactionHours set", async () => {
      (mockConfig.loadConfigOrDefault as ReturnType<typeof mock>).mockReturnValueOnce({
        projects: new Map([
          [
            testProjectPath,
            {
              workspaces: [{ id: testWorkspaceId, path: "/test/path", name: "test" }],
              // idleCompactionHours not set
            },
          ],
        ]),
      } as ProjectsConfig);

      await service.checkAllWorkspaces();

      expect(executeIdleCompactionMock).not.toHaveBeenCalled();
    });

    test("executes idle compaction when eligible", async () => {
      await service.checkAllWorkspaces();

      await waitForCondition(() => executeIdleCompactionMock.mock.calls.length === 1);
      expect(executeIdleCompactionMock).toHaveBeenCalledWith(testWorkspaceId);
    });

    test("continues checking other workspaces if one fails", async () => {
      // Setup two workspaces in different projects
      const workspace2Id = "workspace-2";
      const idleTimestamp = now - 25 * oneHourMs;
      (mockConfig.loadConfigOrDefault as ReturnType<typeof mock>).mockReturnValueOnce({
        projects: new Map([
          [
            testProjectPath,
            {
              workspaces: [{ id: testWorkspaceId, path: "/test/path", name: "test" }],
              idleCompactionHours: 24,
            },
          ],
          [
            "/another/project",
            {
              workspaces: [{ id: workspace2Id, path: "/another/path", name: "test2" }],
              idleCompactionHours: 24,
            },
          ],
        ]),
      } as ProjectsConfig);

      // Make first workspace fail eligibility check (history throws)
      let callCount = 0;
      spyOn(historyService, "getLastMessages").mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error("History fetch failed");
        }
        return Promise.resolve(
          Ok([
            createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
            createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
          ])
        );
      });

      await service.checkAllWorkspaces();

      // Should still have tried to process the second workspace.
      // Queue processing re-checks eligibility before execution, so callCount can exceed 2.
      expect(callCount).toBeGreaterThanOrEqual(2);
      await waitForCondition(() => executeIdleCompactionMock.mock.calls.length === 1);
      expect(executeIdleCompactionMock).toHaveBeenCalledWith(workspace2Id);
    });

    test("serializes idle compactions across workspaces", async () => {
      const workspace2Id = "workspace-2";
      const idleTimestamp = now - 25 * oneHourMs;

      (mockConfig.loadConfigOrDefault as ReturnType<typeof mock>).mockReturnValueOnce({
        projects: new Map([
          [
            testProjectPath,
            {
              workspaces: [
                { id: testWorkspaceId, path: "/test/path", name: "test" },
                { id: workspace2Id, path: "/another/path", name: "test2" },
              ],
              idleCompactionHours: 24,
            },
          ],
        ]),
      } as ProjectsConfig);

      spyOn(historyService, "getLastMessages").mockResolvedValue(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
        ])
      );

      let releaseFirstCompaction: (() => void) | undefined;
      const firstCompactionGate = new Promise<void>((resolve) => {
        releaseFirstCompaction = resolve;
      });

      const executionOrder: string[] = [];
      executeIdleCompactionMock.mockImplementation(async (workspaceId: string) => {
        executionOrder.push(`start:${workspaceId}`);
        if (workspaceId === testWorkspaceId) {
          await firstCompactionGate;
        }
        executionOrder.push(`end:${workspaceId}`);
      });

      await service.checkAllWorkspaces();

      await waitForCondition(() => executionOrder.includes(`start:${testWorkspaceId}`));
      expect(executionOrder).toEqual([`start:${testWorkspaceId}`]);

      releaseFirstCompaction?.();
      await waitForCondition(() => executionOrder.includes(`end:${workspace2Id}`));

      expect(executionOrder).toEqual([
        `start:${testWorkspaceId}`,
        `end:${testWorkspaceId}`,
        `start:${workspace2Id}`,
        `end:${workspace2Id}`,
      ]);
    });

    test("deduplicates queued idle compaction for same workspace", async () => {
      let releaseCompaction: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseCompaction = resolve;
      });

      executeIdleCompactionMock.mockImplementation(async () => {
        await gate;
      });

      await service.checkAllWorkspaces();
      await service.checkAllWorkspaces();

      await waitForCondition(() => executeIdleCompactionMock.mock.calls.length === 1);
      releaseCompaction?.();

      // Ensure the queue drains without running a duplicate.
      await waitForCondition(() => executeIdleCompactionMock.mock.calls.length === 1);
    });
  });

  describe("workspace ID resolution", () => {
    test("falls back to workspace name when id is not set", async () => {
      const workspaceName = "test-workspace-name";
      const idleTimestamp = now - 25 * oneHourMs;
      (mockConfig.loadConfigOrDefault as ReturnType<typeof mock>).mockReturnValueOnce({
        projects: new Map([
          [
            testProjectPath,
            {
              workspaces: [{ name: workspaceName, path: "/test/path" }], // No id field
              idleCompactionHours: 24,
            },
          ],
        ]),
      });

      // Spy on history to return idle messages for the name-based ID.
      // Queue processing re-checks eligibility before execution, so return the
      // same data for both checks.
      spyOn(historyService, "getLastMessages").mockResolvedValue(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
        ])
      );

      await service.checkAllWorkspaces();

      await waitForCondition(() => executeIdleCompactionMock.mock.calls.length === 1);
      expect(executeIdleCompactionMock).toHaveBeenCalledWith(workspaceName);
    });

    test("skips workspace when neither id nor name is set", async () => {
      (mockConfig.loadConfigOrDefault as ReturnType<typeof mock>).mockReturnValueOnce({
        projects: new Map([
          [
            testProjectPath,
            {
              workspaces: [{ path: "/test/path" }], // No id or name
              idleCompactionHours: 24,
            },
          ],
        ]),
      });

      await service.checkAllWorkspaces();

      expect(executeIdleCompactionMock).not.toHaveBeenCalled();
    });
  });
});
