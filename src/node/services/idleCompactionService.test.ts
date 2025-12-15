import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { IdleCompactionService } from "./idleCompactionService";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { ProjectConfig, ProjectsConfig } from "@/common/types/project";
import { createMuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";

describe("IdleCompactionService", () => {
  // Mock services
  let mockConfig: Config;
  let mockHistoryService: HistoryService;
  let mockExtensionMetadata: ExtensionMetadataService;
  let emitIdleCompactionNeededMock: ReturnType<typeof mock<(workspaceId: string) => void>>;
  let service: IdleCompactionService;

  // Test data
  const testWorkspaceId = "test-workspace-id";
  const testProjectPath = "/test/project";
  const now = Date.now();
  const oneHourMs = 60 * 60 * 1000;

  beforeEach(() => {
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

    // Create mock history service - messages with timestamps 25 hours ago (idle)
    const idleTimestamp = now - 25 * oneHourMs;
    mockHistoryService = {
      getHistory: mock(() =>
        Promise.resolve(
          Ok([
            createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
            createMuxMessage("2", "assistant", "Hi there!", { timestamp: idleTimestamp }),
          ])
        )
      ),
    } as unknown as HistoryService;

    // Create mock extension metadata service
    mockExtensionMetadata = {
      getMetadata: mock(() =>
        Promise.resolve({
          workspaceId: testWorkspaceId,
          recency: now - 25 * oneHourMs, // 25 hours ago
          streaming: false,
          lastModel: null,
          updatedAt: now - 25 * oneHourMs,
        })
      ),
    } as unknown as ExtensionMetadataService;

    // Create mock for emitIdleCompactionNeeded callback
    emitIdleCompactionNeededMock = mock(() => {
      // noop mock
    });

    // Create service with callback
    service = new IdleCompactionService(
      mockConfig,
      mockHistoryService,
      mockExtensionMetadata,
      emitIdleCompactionNeededMock
    );
  });

  afterEach(() => {
    service.stop();
  });

  describe("checkEligibility", () => {
    const threshold24h = 24 * oneHourMs;

    test("returns eligible for idle workspace with messages", async () => {
      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(true);
    });

    test("returns ineligible when workspace is currently streaming", async () => {
      // Idle messages but workspace is streaming
      const idleTimestamp = now - 25 * oneHourMs;
      (mockHistoryService.getHistory as ReturnType<typeof mock>).mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
        ])
      );
      (mockExtensionMetadata.getMetadata as ReturnType<typeof mock>).mockResolvedValueOnce({
        workspaceId: testWorkspaceId,
        recency: idleTimestamp,
        streaming: true, // Currently streaming
        lastModel: null,
        updatedAt: idleTimestamp,
      });

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("currently_streaming");
    });

    test("returns ineligible when workspace has no messages", async () => {
      (mockHistoryService.getHistory as ReturnType<typeof mock>).mockResolvedValueOnce(Ok([]));

      const result = await service.checkEligibility(testWorkspaceId, threshold24h, now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("no_messages");
    });

    test("returns ineligible when last message is already compacted", async () => {
      const idleTimestamp = now - 25 * oneHourMs;
      (mockHistoryService.getHistory as ReturnType<typeof mock>).mockResolvedValueOnce(
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
      const recentTimestamp = now - 1 * oneHourMs;
      (mockHistoryService.getHistory as ReturnType<typeof mock>).mockResolvedValueOnce(
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
      (mockHistoryService.getHistory as ReturnType<typeof mock>).mockResolvedValueOnce(
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
      (mockHistoryService.getHistory as ReturnType<typeof mock>).mockResolvedValueOnce(
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

      // Should not attempt to notify
      expect(emitIdleCompactionNeededMock).not.toHaveBeenCalled();
    });

    test("marks workspace as needing compaction when eligible", async () => {
      await service.checkAllWorkspaces();

      // Should have emitted idle compaction needed event
      expect(emitIdleCompactionNeededMock).toHaveBeenCalledTimes(1);
      expect(emitIdleCompactionNeededMock).toHaveBeenCalledWith(testWorkspaceId);
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
      (mockHistoryService.getHistory as ReturnType<typeof mock>).mockImplementation(() => {
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

      // Should still have tried to process the second workspace
      expect(callCount).toBe(2);
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

      // Update history mock to return idle messages for the name-based ID
      (mockHistoryService.getHistory as ReturnType<typeof mock>).mockResolvedValueOnce(
        Ok([
          createMuxMessage("1", "user", "Hello", { timestamp: idleTimestamp }),
          createMuxMessage("2", "assistant", "Hi!", { timestamp: idleTimestamp }),
        ])
      );

      await service.checkAllWorkspaces();

      // Should have emitted with the name as workspaceId
      expect(emitIdleCompactionNeededMock).toHaveBeenCalledWith(workspaceName);
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

      // Should not attempt any compaction
      expect(emitIdleCompactionNeededMock).not.toHaveBeenCalled();
    });
  });
});
