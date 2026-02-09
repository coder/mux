import { describe, expect, test, mock, beforeEach, spyOn } from "bun:test";
import { WorkspaceService } from "./workspaceService";
import type { AgentSession } from "./agentSession";
import { WorkspaceLifecycleHooks } from "./workspaceLifecycleHooks";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import type { ProjectsConfig } from "@/common/types/project";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import type { SessionTimingService } from "./sessionTimingService";
import type { AIService } from "./aiService";
import type { InitStateManager, InitStatus } from "./initStateManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { BashToolResult } from "@/common/types/tools";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";

// Helper to access private renamingWorkspaces set
function addToRenamingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).renamingWorkspaces.add(workspaceId);
}

// Helper to access private archivingWorkspaces set
function addToArchivingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).archivingWorkspaces.add(workspaceId);
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
      getHistoryFromLatestBoundary: mock(() =>
        Promise.resolve({ success: true as const, data: [] })
      ),
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

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
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
      agentId: "exec",
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
      agentId: "exec",
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

describe("WorkspaceService executeBash archive guards", () => {
  let workspaceService: WorkspaceService;
  let waitForInitMock: ReturnType<typeof mock>;
  let getWorkspaceMetadataMock: ReturnType<typeof mock>;

  beforeEach(() => {
    waitForInitMock = mock(() => Promise.resolve());

    getWorkspaceMetadataMock = mock(() =>
      Promise.resolve({ success: false as const, error: "not found" })
    );

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockHistoryService: Partial<HistoryService> = {
      getHistoryFromLatestBoundary: mock(() =>
        Promise.resolve({ success: true as const, data: [] })
      ),
      appendToHistory: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
      getProjectSecrets: mock(() => []),
    };

    const mockPartialService: Partial<PartialService> = {
      commitToHistory: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      waitForInit: waitForInitMock,
    };

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

  test("archived workspace => executeBash returns error mentioning archived", async () => {
    const workspaceId = "ws-archived";

    const archivedMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      archivedAt: "2026-01-01T00:00:00.000Z",
    };

    getWorkspaceMetadataMock.mockReturnValue(Promise.resolve(Ok(archivedMetadata)));

    const result = await workspaceService.executeBash(workspaceId, "echo hello");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("archived");
    }

    // This must happen before init/runtime operations.
    expect(waitForInitMock).toHaveBeenCalledTimes(0);
  });

  test("archiving workspace => executeBash returns error mentioning being archived", async () => {
    const workspaceId = "ws-archiving";

    addToArchivingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.executeBash(workspaceId, "echo hello");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }

    expect(waitForInitMock).toHaveBeenCalledTimes(0);
    expect(getWorkspaceMetadataMock).toHaveBeenCalledTimes(0);
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
      getHistoryFromLatestBoundary: mock(() =>
        Promise.resolve({ success: true as const, data: [] })
      ),
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

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
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
      getHistoryFromLatestBoundary: mock(() =>
        Promise.resolve({ success: true as const, data: [] })
      ),
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

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
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

  test("persists agent AI settings for custom agent", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (
        workspaceId: string,
        options: unknown,
        context: "send" | "resume"
      ) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    await svc.maybePersistAISettingsFromOptions(
      "ws",
      {
        agentId: "reviewer",
        model: "openai:gpt-4o-mini",
        thinkingLevel: "off",
      },
      "send"
    );

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists agent AI settings when agentId matches", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (
        workspaceId: string,
        options: unknown,
        context: "send" | "resume"
      ) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    await svc.maybePersistAISettingsFromOptions(
      "ws",
      {
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
      const mockInitStateManager: Partial<InitStateManager> = {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        clearInMemoryState: mock(() => undefined),
      };
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

      const timingService: Partial<SessionTimingService> = {
        waitForIdle: mock(() => Promise.resolve()),
        rollUpTimingIntoParent: mock(() => {
          rollUpSawAbort = abortEmitted;
          return Promise.resolve({ didRollUp: true });
        }),
      };

      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        mockHistoryService as HistoryService,
        mockPartialService as PartialService,
        aiService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager,
        undefined, // sessionUsageService
        undefined, // policyService
        undefined, // telemetryService
        undefined, // experimentsService
        timingService as SessionTimingService
      );

      const removeResult = await workspaceService.remove(workspaceId, true);
      expect(removeResult.success).toBe(true);
      expect(mockInitStateManager.clearInMemoryState).toHaveBeenCalledWith(workspaceId);
      expect(rollUpSawAbort).toBe(true);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceService archive lifecycle hooks", () => {
  const workspaceId = "ws-archive";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-archive";

  let workspaceService: WorkspaceService;
  let mockAIService: AIService;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-archive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
  };

  beforeEach(() => {
    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
              },
            ],
          },
        ],
      ]),
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
    };

    const mockHistoryService: Partial<HistoryService> = {};
    const mockPartialService: Partial<PartialService> = {};
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

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

  test("returns Err and does not persist archivedAt when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("hook failed");
    }

    expect(editConfigSpy).toHaveBeenCalledTimes(0);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();
  });

  test("does not interrupt an active stream when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    (mockAIService.isStreaming as ReturnType<typeof mock>).mockReturnValue(true);

    const interruptStreamSpy = mock(() => Promise.resolve(Ok(undefined)));
    workspaceService.interruptStream =
      interruptStreamSpy as unknown as typeof workspaceService.interruptStream;

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(interruptStreamSpy).toHaveBeenCalledTimes(0);
  });

  test("persists archivedAt when beforeArchive hooks succeed", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Ok(undefined)));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(editConfigSpy).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("WorkspaceService archive init cancellation", () => {
  test("emits metadata when it cancels init but beforeArchive hook fails", async () => {
    const workspaceId = "ws-archive-init-cancel";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/project/ws-archive-init-cancel";

    const initStates = new Map<string, InitStatus>([
      [
        workspaceId,
        {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        },
      ],
    ]);

    const clearInMemoryStateMock = mock((id: string) => {
      initStates.delete(id);
    });

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: clearInMemoryStateMock,
    };

    let configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
              },
            ],
          },
        ],
      ]),
    };

    const editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const frontendMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws-archive-init-cancel",
      projectName: "proj",
      projectPath,
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      namedWorkspacePath: workspacePath,
    };

    const workspaceMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "ws-archive-init-cancel",
      projectName: "proj",
      projectPath,
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([frontendMetadata])),
    };

    const mockAIService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      {} as HistoryService,
      {} as PartialService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      {} as ExtensionMetadataService,
      { cleanup: mock(() => Promise.resolve()) } as unknown as BackgroundProcessManager
    );

    // Seed abort controller so archive() can cancel init.
    const abortController = new AbortController();
    const initAbortControllers = (
      workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
    ).initAbortControllers;
    initAbortControllers.set(workspaceId, abortController);

    const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
    workspaceService.on("metadata", (event: unknown) => {
      if (!event || typeof event !== "object") {
        return;
      }
      const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
      if (parsed.workspaceId === workspaceId) {
        metadataEvents.push(parsed.metadata);
      }
    });

    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("hook failed");
    }

    // Ensure we didn't persist archivedAt on hook failure.
    expect(editConfigSpy).toHaveBeenCalledTimes(0);
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();

    expect(abortController.signal.aborted).toBe(true);
    expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

    expect(metadataEvents.length).toBeGreaterThanOrEqual(1);
    expect(metadataEvents.at(-1)?.isInitializing).toBe(undefined);
  });
});

describe("WorkspaceService unarchive lifecycle hooks", () => {
  const workspaceId = "ws-unarchive";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-unarchive";

  let workspaceService: WorkspaceService;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;

  const workspaceMetadata: FrontendWorkspaceMetadata = {
    id: workspaceId,
    name: "ws-unarchive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    archivedAt: "2020-01-01T00:00:00.000Z",
    namedWorkspacePath: workspacePath,
  };

  beforeEach(() => {
    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                archivedAt: "2020-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      ]),
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([workspaceMetadata])),
    };

    const mockHistoryService: Partial<HistoryService> = {};
    const mockPartialService: Partial<PartialService> = {};
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

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

  test("persists unarchivedAt and runs afterUnarchive hooks (best-effort)", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    const afterHook = mock(() => {
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.unarchivedAt).toBeTruthy();
      return Promise.resolve(Err("hook failed"));
    });
    hooks.registerAfterUnarchive(afterHook);

    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.unarchivedAt).toBeTruthy();
    expect(entry?.unarchivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("does not run afterUnarchive hooks when workspace is not archived", async () => {
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    if (!entry) {
      throw new Error("Missing workspace entry");
    }
    entry.archivedAt = undefined;

    const hooks = new WorkspaceLifecycleHooks();
    const afterHook = mock(() => Promise.resolve(Ok(undefined)));
    hooks.registerAfterUnarchive(afterHook);
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(0);
  });
});

describe("WorkspaceService archiveMergedInProject", () => {
  const TARGET_PROJECT_PATH = "/tmp/project";

  function createMetadata(
    id: string,
    options?: { projectPath?: string; archivedAt?: string; unarchivedAt?: string }
  ): FrontendWorkspaceMetadata {
    const projectPath = options?.projectPath ?? TARGET_PROJECT_PATH;

    return {
      id,
      name: id,
      projectName: "test-project",
      projectPath,
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(projectPath, id),
      archivedAt: options?.archivedAt,
      unarchivedAt: options?.unarchivedAt,
    };
  }

  function bashOk(output: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: 0,
      },
    };
  }

  function bashToolFailure(error: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: false,
        error,
        exitCode: 1,
        wall_duration_ms: 0,
      },
    };
  }

  function executeBashFailure(error: string): Result<BashToolResult> {
    return { success: false, error };
  }

  type ExecuteBashFn = (
    workspaceId: string,
    script: string,
    options?: { timeout_secs?: number }
  ) => Promise<Result<BashToolResult>>;

  type ArchiveFn = (workspaceId: string) => Promise<Result<void>>;

  function createServiceHarness(
    allMetadata: FrontendWorkspaceMetadata[],
    executeBashImpl: ExecuteBashFn,
    archiveImpl: ArchiveFn
  ): {
    workspaceService: WorkspaceService;
    executeBashMock: ReturnType<typeof mock>;
    archiveMock: ReturnType<typeof mock>;
  } {
    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
      getAllWorkspaceMetadata: mock(() => Promise.resolve(allMetadata)),
    };

    const aiService: AIService = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    const mockHistoryService: Partial<HistoryService> = {};
    const mockPartialService: Partial<PartialService> = {};
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
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

    const executeBashMock = mock(executeBashImpl);
    const archiveMock = mock(archiveImpl);

    interface WorkspaceServiceTestAccess {
      executeBash: typeof executeBashMock;
      archive: typeof archiveMock;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.executeBash = executeBashMock;
    svc.archive = archiveMock;

    return { workspaceService, executeBashMock, archiveMock };
  }

  test("excludes MUX_HELP_CHAT_WORKSPACE_ID workspaces", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata(MUX_HELP_CHAT_WORKSPACE_ID),
      createMetadata("ws-merged"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-merged": bashOk('{"state":"MERGED"}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => Promise.resolve({ success: true, data: undefined })
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged"]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged");

    // Should only query GitHub for the eligible non-mux-chat workspace.
    expect(executeBashMock).toHaveBeenCalledTimes(1);
  });

  test("treats workspaces with later unarchivedAt as eligible", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-merged-unarchived", {
        archivedAt: "2025-01-01T00:00:00.000Z",
        unarchivedAt: "2025-02-01T00:00:00.000Z",
      }),
      createMetadata("ws-still-archived", {
        archivedAt: "2025-03-01T00:00:00.000Z",
        unarchivedAt: "2025-02-01T00:00:00.000Z",
      }),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-merged-unarchived": bashOk('{"state":"MERGED"}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => Promise.resolve({ success: true, data: undefined })
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged-unarchived"]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged-unarchived");

    // Should only query GitHub for the workspace that is considered unarchived.
    expect(executeBashMock).toHaveBeenCalledTimes(1);
  });
  test("archives only MERGED workspaces", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-open"),
      createMetadata("ws-merged"),
      createMetadata("ws-no-pr"),
      createMetadata("ws-other-project", { projectPath: "/tmp/other" }),
      createMetadata("ws-already-archived", { archivedAt: "2025-01-01T00:00:00.000Z" }),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-open": bashOk('{"state":"OPEN"}'),
      "ws-merged": bashOk('{"state":"MERGED"}'),
      "ws-no-pr": bashOk('{"no_pr":true}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId, script, options) => {
        expect(script).toContain("gh pr view --json state");
        expect(options?.timeout_secs).toBe(15);

        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => Promise.resolve({ success: true, data: undefined })
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged"]);
    expect(result.data.skippedWorkspaceIds).toEqual(["ws-no-pr", "ws-open"]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged");

    expect(executeBashMock).toHaveBeenCalledTimes(3);
  });

  test("skips no_pr and non-merged states", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-open"),
      createMetadata("ws-closed"),
      createMetadata("ws-no-pr"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-open": bashOk('{"state":"OPEN"}'),
      "ws-closed": bashOk('{"state":"CLOSED"}'),
      "ws-no-pr": bashOk('{"no_pr":true}'),
    };

    const { workspaceService, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => Promise.resolve({ success: true, data: undefined })
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual([]);
    expect(result.data.skippedWorkspaceIds).toEqual(["ws-closed", "ws-no-pr", "ws-open"]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(0);
  });

  test("records errors for malformed JSON and executeBash failures", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-bad-json"),
      createMetadata("ws-exec-failed"),
      createMetadata("ws-bash-failed"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-bad-json": bashOk("not-json"),
      "ws-exec-failed": executeBashFailure("executeBash failed"),
      "ws-bash-failed": bashToolFailure("gh failed"),
    };

    const { workspaceService, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => Promise.resolve({ success: true, data: undefined })
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual([]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toHaveLength(3);

    const badJsonError = result.data.errors.find((e) => e.workspaceId === "ws-bad-json");
    expect(badJsonError).toBeDefined();
    expect(badJsonError?.error).toContain("Failed to parse gh output");

    const execFailedError = result.data.errors.find((e) => e.workspaceId === "ws-exec-failed");
    expect(execFailedError).toBeDefined();
    expect(execFailedError?.error).toBe("executeBash failed");

    const bashFailedError = result.data.errors.find((e) => e.workspaceId === "ws-bash-failed");
    expect(bashFailedError).toBeDefined();
    expect(bashFailedError?.error).toBe("gh failed");

    expect(archiveMock).toHaveBeenCalledTimes(0);
  });
});

describe("WorkspaceService init cancellation", () => {
  test("archive() aborts init and still archives when init is running", async () => {
    const workspaceId = "ws-init-running";

    const removeMock = mock(() => Promise.resolve({ success: true as const, data: undefined }));
    const editConfigMock = mock(() => Promise.resolve());
    const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      editConfig: editConfigMock,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(
        (): InitStatus => ({
          status: "running",
          hookPath: "/tmp/proj",
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        })
      ),
      clearInMemoryState: clearInMemoryStateMock,
    };

    const mockHistoryService: Partial<HistoryService> = {};
    const mockPartialService: Partial<PartialService> = {};
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      mockHistoryService as HistoryService,
      mockPartialService as PartialService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    // Make it obvious if archive() incorrectly chooses deletion.
    workspaceService.remove = removeMock as unknown as typeof workspaceService.remove;

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(editConfigMock).toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() uses normal archive flow when init is complete", async () => {
    const workspaceId = "ws-init-complete";

    const removeMock = mock(() => Promise.resolve({ success: true as const, data: undefined }));
    const editConfigMock = mock(() => Promise.resolve());

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      editConfig: editConfigMock,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(
        (): InitStatus => ({
          status: "success",
          hookPath: "/tmp/proj",
          startTime: 0,
          lines: [],
          exitCode: 0,
          endTime: 1,
        })
      ),
      clearInMemoryState: mock((_workspaceId: string) => undefined),
    };

    const mockHistoryService: Partial<HistoryService> = {};
    const mockPartialService: Partial<PartialService> = {};
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      mockHistoryService as HistoryService,
      mockPartialService as PartialService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    // Make it obvious if archive() incorrectly chooses deletion.
    workspaceService.remove = removeMock as unknown as typeof workspaceService.remove;

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(editConfigMock).toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  test("list() includes isInitializing when init state is running", async () => {
    const workspaceId = "ws-list-initializing";

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: "/tmp/proj/ws",
      runtimeConfig: { type: "local" },
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock((id: string): InitStatus | undefined =>
        id === workspaceId
          ? {
              status: "running",
              hookPath: "/tmp/proj",
              startTime: 0,
              lines: [],
              exitCode: null,
              endTime: null,
            }
          : undefined
      ),
    };

    const mockHistoryService: Partial<HistoryService> = {};
    const mockPartialService: Partial<PartialService> = {};
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      mockHistoryService as HistoryService,
      mockPartialService as PartialService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const list = await workspaceService.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.isInitializing).toBe(true);
  });

  test("create() clears init state + emits updated metadata when skipping background init", async () => {
    const workspaceId = "ws-skip-init";
    const projectPath = "/tmp/proj";
    const branchName = "ws_branch";
    const workspacePath = "/tmp/proj/ws_branch";

    const initStates = new Map<string, InitStatus>();
    const clearInMemoryStateMock = mock((id: string) => {
      initStates.delete(id);
    });

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      startInit: mock((id: string) => {
        initStates.set(id, {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        });
      }),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: clearInMemoryStateMock,
    };

    const configState: ProjectsConfig = { projects: new Map() };

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: branchName,
      title: "title",
      projectName: "proj",
      projectPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: workspacePath,
      runtimeConfig: { type: "local" },
    };

    const mockConfig: Partial<Config> = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      generateStableId: mock(() => workspaceId),
      editConfig: mock((editFn: (config: ProjectsConfig) => ProjectsConfig) => {
        editFn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      getEffectiveSecrets: mock(() => []),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      findWorkspace: mock(() => null),
    };

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockHistoryService: Partial<HistoryService> = {};
    const mockPartialService: Partial<PartialService> = {};
    const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
    const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
      cleanup: mock(() => Promise.resolve()),
    };

    const createWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, workspacePath })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      createWorkspace: createWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const sessionEmitter = new EventEmitter();
    const fakeSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      emitMetadata: (metadata: FrontendWorkspaceMetadata | null) => {
        sessionEmitter.emit("metadata-event", { workspaceId, metadata });
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    try {
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        mockHistoryService as HistoryService,
        mockPartialService as PartialService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
      workspaceService.on("metadata", (event: unknown) => {
        if (!event || typeof event !== "object") {
          return;
        }
        const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
        if (parsed.workspaceId === workspaceId) {
          metadataEvents.push(parsed.metadata);
        }
      });

      workspaceService.registerSession(workspaceId, fakeSession);

      const removingWorkspaces = (
        workspaceService as unknown as { removingWorkspaces: Set<string> }
      ).removingWorkspaces;
      removingWorkspaces.add(workspaceId);

      const result = await workspaceService.create(projectPath, branchName, undefined, "title", {
        type: "local",
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.metadata.isInitializing).toBe(undefined);
      expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

      expect(metadataEvents).toHaveLength(2);
      expect(metadataEvents[0]?.isInitializing).toBe(true);
      expect(metadataEvents[1]?.isInitializing).toBe(undefined);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });
  test("remove() aborts init and clears state before teardown", async () => {
    const workspaceId = "ws-remove-aborts";

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-"));
    try {
      const abortController = new AbortController();
      const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);

      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "na" })),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: Partial<Config> = {
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(tempRoot, id)),
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => null),
      };

      const mockHistoryService: Partial<HistoryService> = {};
      const mockPartialService: Partial<PartialService> = {};
      const mockInitStateManager: Partial<InitStateManager> = {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        clearInMemoryState: clearInMemoryStateMock,
      };
      const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
      const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
        cleanup: mock(() => Promise.resolve()),
      };

      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        mockHistoryService as HistoryService,
        mockPartialService as PartialService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      // Inject an in-progress init AbortController.
      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      initAbortControllers.set(workspaceId, abortController);

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
      expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

      expect(initAbortControllers.has(workspaceId)).toBe(false);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("remove() does not clear init state when runtime deletion fails with force=false", async () => {
    const workspaceId = "ws-remove-runtime-delete-fails";
    const projectPath = "/tmp/proj";

    const abortController = new AbortController();
    const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);
    const removeWorkspaceMock = mock(() => Promise.resolve());

    const deleteWorkspaceMock = mock(() =>
      Promise.resolve({ success: false as const, error: "dirty" })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-fail-"));
    try {
      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: Partial<Config> = {
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(tempRoot, id)),
        removeWorkspace: removeWorkspaceMock,
        findWorkspace: mock(() => null),
      };

      const mockHistoryService: Partial<HistoryService> = {};
      const mockPartialService: Partial<PartialService> = {};
      const mockInitStateManager: Partial<InitStateManager> = {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        clearInMemoryState: clearInMemoryStateMock,
      };
      const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
      const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
        cleanup: mock(() => Promise.resolve()),
      };

      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        mockHistoryService as HistoryService,
        mockPartialService as PartialService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      // Inject an in-progress init AbortController.
      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      initAbortControllers.set(workspaceId, abortController);

      const result = await workspaceService.remove(workspaceId, false);
      expect(result.success).toBe(false);
      expect(abortController.signal.aborted).toBe(true);

      // If runtime deletion fails with force=false, removal returns early and the workspace remains.
      // Keep init state intact so init-end can refresh metadata and clear isInitializing.
      expect(clearInMemoryStateMock).not.toHaveBeenCalled();
      expect(removeWorkspaceMock).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
  test("remove() calls runtime.deleteWorkspace when force=true", async () => {
    const workspaceId = "ws-remove-runtime-delete";
    const projectPath = "/tmp/proj";

    const deleteWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-runtime-"));
    try {
      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: Partial<Config> = {
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(tempRoot, id)),
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
      };

      const mockHistoryService: Partial<HistoryService> = {};
      const mockPartialService: Partial<PartialService> = {};
      const mockInitStateManager: Partial<InitStateManager> = {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        clearInMemoryState: mock((_workspaceId: string) => undefined),
      };
      const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
      const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
        cleanup: mock(() => Promise.resolve()),
      };

      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        mockHistoryService as HistoryService,
        mockPartialService as PartialService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      expect(deleteWorkspaceMock).toHaveBeenCalledWith(projectPath, "ws", true);
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
