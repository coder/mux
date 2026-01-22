import { describe, expect, test, mock, beforeEach } from "bun:test";
import { WorkspaceService } from "./workspaceService";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import type { SessionTimingService } from "./sessionTimingService";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { BackgroundProcessManager } from "./backgroundProcessManager";

// Helper to access private renamingWorkspaces set
function addToRenamingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).renamingWorkspaces.add(workspaceId);
}

async function withTempMuxRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const originalMuxRoot = process.env.MUX_ROOT;
  const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-plan-"));
  process.env.MUX_ROOT = tempRoot;

  try {
    return await fn(tempRoot);
  } finally {
    if (originalMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = originalMuxRoot;
    }
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
}

async function writePlanFile(
  root: string,
  projectName: string,
  workspaceName: string
): Promise<string> {
  const planDir = path.join(root, "plans", projectName);
  await fsPromises.mkdir(planDir, { recursive: true });
  const planFile = path.join(planDir, `${workspaceName}.md`);
  await fsPromises.writeFile(planFile, "# Plan\n");
  return planFile;
}

// NOTE: This test file uses bun:test mocks (not Jest).

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

describe("WorkspaceService post-compaction metadata refresh", () => {
  let workspaceService: WorkspaceService;

  beforeEach(() => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
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
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  test("returns expanded plan path for local runtimes", async () => {
    await withTempMuxRoot(async (muxRoot) => {
      const workspaceId = "ws-plan-path";
      const workspaceName = "plan-workspace";
      const projectName = "cmux";
      const planFile = await writePlanFile(muxRoot, projectName, workspaceName);

      interface WorkspaceServiceTestAccess {
        getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
      }

      const fakeMetadata: FrontendWorkspaceMetadata = {
        id: workspaceId,
        name: workspaceName,
        projectName,
        projectPath: "/tmp/proj",
        namedWorkspacePath: "/tmp/proj/plan-workspace",
        runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      };

      const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
      svc.getInfo = mock(() => Promise.resolve(fakeMetadata));

      const result = await workspaceService.getPostCompactionState(workspaceId);

      expect(result.planPath).toBe(planFile);
      expect(result.planPath?.startsWith("~")).toBe(false);
    });
  });

  test("debounces multiple refresh requests into a single metadata emit", async () => {
    const workspaceId = "ws-post-compaction";

    const emitMetadata = mock(() => undefined);

    interface WorkspaceServiceTestAccess {
      sessions: Map<string, { emitMetadata: (metadata: unknown) => void }>;
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
      getPostCompactionState: (workspaceId: string) => Promise<{
        planPath: string | null;
        trackedFilePaths: string[];
        excludedItems: string[];
      }>;
      schedulePostCompactionMetadataRefresh: (workspaceId: string) => void;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.sessions.set(workspaceId, { emitMetadata });

    const fakeMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      namedWorkspacePath: "/tmp/proj/ws",
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    };

    const getInfoMock: WorkspaceServiceTestAccess["getInfo"] = mock(() =>
      Promise.resolve(fakeMetadata)
    );

    const postCompactionState = {
      planPath: "~/.mux/plans/cmux/plan.md",
      trackedFilePaths: ["/tmp/proj/file.ts"],
      excludedItems: [],
    };

    const getPostCompactionStateMock: WorkspaceServiceTestAccess["getPostCompactionState"] = mock(
      () => Promise.resolve(postCompactionState)
    );

    svc.getInfo = getInfoMock;
    svc.getPostCompactionState = getPostCompactionStateMock;

    svc.schedulePostCompactionMetadataRefresh(workspaceId);
    svc.schedulePostCompactionMetadataRefresh(workspaceId);
    svc.schedulePostCompactionMetadataRefresh(workspaceId);

    // Debounce is short, but use a safe buffer.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(getInfoMock).toHaveBeenCalledTimes(1);
    expect(getPostCompactionStateMock).toHaveBeenCalledTimes(1);
    expect(emitMetadata).toHaveBeenCalledTimes(1);

    const enriched = (emitMetadata as ReturnType<typeof mock>).mock.calls[0][0] as {
      postCompaction?: { planPath: string | null };
    };
    expect(enriched.postCompaction?.planPath).toBe(postCompactionState.planPath);
  });
});

describe("WorkspaceService maybePersistAISettingsFromOptions", () => {
  let workspaceService: WorkspaceService;

  beforeEach(() => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "nope" })),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
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
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  });

  test("skips persisting base mode AI settings when agentId differs", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (
        workspaceId: string,
        options: unknown,
        context: "send" | "resume"
      ) => Promise<void>;
      persistWorkspaceAISettingsForMode: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForMode = persistSpy;

    await svc.maybePersistAISettingsFromOptions(
      "ws",
      {
        mode: "exec",
        agentId: "reviewer",
        model: "openai:gpt-4o-mini",
        thinkingLevel: "off",
      },
      "send"
    );

    expect(persistSpy).not.toHaveBeenCalled();
  });

  test("persists base mode AI settings when agentId matches", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (
        workspaceId: string,
        options: unknown,
        context: "send" | "resume"
      ) => Promise<void>;
      persistWorkspaceAISettingsForMode: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForMode = persistSpy;

    await svc.maybePersistAISettingsFromOptions(
      "ws",
      {
        mode: "exec",
        agentId: "exec",
        model: "openai:gpt-4o-mini",
        thinkingLevel: "off",
      },
      "send"
    );

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });
});
describe("WorkspaceService remove timing rollup", () => {
  test("waits for stream-abort before rolling up session timing", async () => {
    const workspaceId = "child-ws";
    const parentWorkspaceId = "parent-ws";

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-remove-"));
    try {
      const sessionRoot = path.join(tempRoot, "sessions");
      await fsPromises.mkdir(path.join(sessionRoot, workspaceId), { recursive: true });

      let abortEmitted = false;
      let rollUpSawAbort = false;

      class FakeAIService extends EventEmitter {
        isStreaming = mock(() => true);

        stopStream = mock(() => {
          setTimeout(() => {
            abortEmitted = true;
            this.emit("stream-abort", {
              type: "stream-abort",
              workspaceId,
              messageId: "msg",
              abortReason: "system",
              metadata: { duration: 123 },
              abandonPartial: true,
            });
          }, 0);

          return Promise.resolve({ success: true as const, data: undefined });
        });

        getWorkspaceMetadata = mock(() =>
          Promise.resolve({
            success: true as const,
            data: {
              id: workspaceId,
              name: "child",
              projectPath: "/tmp/proj",
              runtimeConfig: { type: "local" },
              parentWorkspaceId,
            },
          })
        );
      }

      const aiService = new FakeAIService() as unknown as AIService;

      const mockHistoryService: Partial<HistoryService> = {};
      const mockPartialService: Partial<PartialService> = {};
      const mockInitStateManager: Partial<InitStateManager> = {};
      const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {
        setStreaming: mock((_workspaceId: string, streaming: boolean) =>
          Promise.resolve({
            recency: Date.now(),
            streaming,
            lastModel: null,
            lastThinkingLevel: null,
          })
        ),
        updateRecency: mock((_workspaceId: string, timestamp?: number) =>
          Promise.resolve({
            recency: timestamp ?? Date.now(),
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
          })
        ),
      };
      const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
        cleanup: mock(() => Promise.resolve()),
      };

      const mockConfig: Partial<Config> = {
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(sessionRoot, id)),
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => null),
      };

      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        mockHistoryService as HistoryService,
        mockPartialService as PartialService,
        aiService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      const timingService: Partial<SessionTimingService> = {
        waitForIdle: mock(() => Promise.resolve()),
        rollUpTimingIntoParent: mock(() => {
          rollUpSawAbort = abortEmitted;
          return Promise.resolve({ didRollUp: true });
        }),
      };

      workspaceService.setSessionTimingService(timingService as SessionTimingService);

      const removeResult = await workspaceService.remove(workspaceId, true);
      expect(removeResult.success).toBe(true);
      expect(rollUpSawAbort).toBe(true);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
