import { describe, expect, test, mock, beforeEach } from "bun:test";
import { WorkspaceService } from "./workspaceService";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";

// Helper to access private renamingWorkspaces set
function addToRenamingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).renamingWorkspaces.add(workspaceId);
}

describe("WorkspaceService rename lock", () => {
  let workspaceService: WorkspaceService;
  let mockAIService: AIService;

  beforeEach(() => {
    // Create minimal mocks for the services
    mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false, error: "not found" })),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockHistoryService: Partial<HistoryService> = {
      getHistory: mock(() => Promise.resolve({ success: true as const, data: [] })),
      appendToHistory: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    const mockPartialService: Partial<PartialService> = {
      commitToHistory: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {};
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    workspaceService = new WorkspaceService(
      mockConfig as Config,
      mockHistoryService as HistoryService,
      mockPartialService as PartialService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  test("sendMessage returns error when workspace is being renamed", async () => {
    const workspaceId = "test-workspace";

    addToRenamingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.sendMessage(workspaceId, "test message", {
      model: "test-model",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      // Error is SendMessageError which has a discriminated union
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("being renamed");
      }
    }
  });

  test("resumeStream returns error when workspace is being renamed", async () => {
    const workspaceId = "test-workspace";

    addToRenamingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.resumeStream(workspaceId, {
      model: "test-model",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      // Error is SendMessageError which has a discriminated union
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("being renamed");
      }
    }
  });

  test("rename returns error when workspace is streaming", async () => {
    const workspaceId = "test-workspace";

    // Mock isStreaming to return true
    (mockAIService.isStreaming as ReturnType<typeof mock>).mockReturnValue(true);

    const result = await workspaceService.rename(workspaceId, "new-name");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("stream is active");
    }
  });
});
