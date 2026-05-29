import { describe, expect, it, mock } from "bun:test";
import { CODER_ARCHIVE_BEHAVIORS } from "@/common/config/coderArchiveBehavior";
import { Err, Ok, type Result } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { CoderService, WorkspaceStatusResult } from "@/node/services/coderService";
import { createCoderArchiveHook, createCoderUnarchiveHook } from "./coderLifecycleHooks";

function createSshCoderMetadata(overrides?: Partial<WorkspaceMetadata>): WorkspaceMetadata {
  return {
    id: "ws",
    name: "ws",
    projectName: "proj",
    projectPath: "/tmp/proj",
    runtimeConfig: {
      type: "ssh",
      host: "coder://",
      srcBaseDir: "~/mux",
      coder: {
        workspaceName: "mux-ws",
      },
    },
    ...overrides,
  };
}

type GetWorkspaceStatusMock = ReturnType<
  typeof mock<
    (workspaceName: string, options?: { timeoutMs?: number }) => Promise<WorkspaceStatusResult>
  >
>;
type StopWorkspaceMock = ReturnType<
  typeof mock<(workspaceName: string, options?: { timeoutMs?: number }) => Promise<Result<void>>>
>;
type StartWorkspaceMock = ReturnType<
  typeof mock<(workspaceName: string, options?: { timeoutMs?: number }) => Promise<Result<void>>>
>;
type DeleteWorkspaceMock = ReturnType<typeof mock<(workspaceName: string) => Promise<void>>>;

function createCoderServiceMocks(overrides?: {
  getWorkspaceStatus?: GetWorkspaceStatusMock;
  stopWorkspace?: StopWorkspaceMock;
  startWorkspace?: StartWorkspaceMock;
  deleteWorkspace?: DeleteWorkspaceMock;
}): {
  coderService: CoderService;
  getWorkspaceStatus: GetWorkspaceStatusMock;
  stopWorkspace: StopWorkspaceMock;
  startWorkspace: StartWorkspaceMock;
  deleteWorkspace: DeleteWorkspaceMock;
} {
  const getWorkspaceStatus =
    overrides?.getWorkspaceStatus ??
    mock<
      (workspaceName: string, options?: { timeoutMs?: number }) => Promise<WorkspaceStatusResult>
    >(() => Promise.resolve({ kind: "ok", status: "running" }));
  const stopWorkspace =
    overrides?.stopWorkspace ??
    mock<(workspaceName: string, options?: { timeoutMs?: number }) => Promise<Result<void>>>(() =>
      Promise.resolve(Ok(undefined))
    );
  const startWorkspace =
    overrides?.startWorkspace ??
    mock<(workspaceName: string, options?: { timeoutMs?: number }) => Promise<Result<void>>>(() =>
      Promise.resolve(Ok(undefined))
    );
  const deleteWorkspace =
    overrides?.deleteWorkspace ??
    mock<(workspaceName: string) => Promise<void>>(() => Promise.resolve());

  return {
    coderService: {
      getWorkspaceStatus,
      stopWorkspace,
      startWorkspace,
      deleteWorkspace,
    } as unknown as CoderService,
    getWorkspaceStatus,
    stopWorkspace,
    startWorkspace,
    deleteWorkspace,
  };
}

function expectError(result: Result<void>): string {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("Expected lifecycle hook to fail");
  }
  return result.error;
}

describe("createCoderArchiveHook", () => {
  it("does nothing when archive behavior is keep", async () => {
    const service = createCoderServiceMocks();
    const hook = createCoderArchiveHook({
      coderService: service.coderService,
      getArchiveBehavior: () => "keep",
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(result.success).toBe(true);
    expect(service.getWorkspaceStatus).toHaveBeenCalledTimes(0);
    expect(service.stopWorkspace).toHaveBeenCalledTimes(0);
    expect(service.deleteWorkspace).toHaveBeenCalledTimes(0);
  });

  for (const archiveBehavior of CODER_ARCHIVE_BEHAVIORS) {
    it(`skips existing Coder workspaces when archive behavior is ${archiveBehavior}`, async () => {
      const service = createCoderServiceMocks();
      const hook = createCoderArchiveHook({
        coderService: service.coderService,
        getArchiveBehavior: () => archiveBehavior,
      });

      const result = await hook({
        workspaceId: "ws",
        workspaceMetadata: createSshCoderMetadata({
          runtimeConfig: {
            type: "ssh",
            host: "coder://",
            srcBaseDir: "~/mux",
            coder: { workspaceName: "mux-ws", existingWorkspace: true },
          },
        }),
      });

      expect(result.success).toBe(true);
      expect(service.getWorkspaceStatus).toHaveBeenCalledTimes(0);
      expect(service.stopWorkspace).toHaveBeenCalledTimes(0);
      expect(service.deleteWorkspace).toHaveBeenCalledTimes(0);
    });
  }

  it("stops a running dedicated Coder workspace when archive behavior is stop", async () => {
    const service = createCoderServiceMocks({
      getWorkspaceStatus: mock<
        (workspaceName: string, options?: { timeoutMs?: number }) => Promise<WorkspaceStatusResult>
      >(() => Promise.resolve({ kind: "ok", status: "running" })),
    });
    const hook = createCoderArchiveHook({
      coderService: service.coderService,
      getArchiveBehavior: () => "stop",
      timeoutMs: 1234,
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(result.success).toBe(true);
    expect(service.getWorkspaceStatus).toHaveBeenCalledTimes(1);
    expect(service.getWorkspaceStatus).toHaveBeenCalledWith("mux-ws", expect.any(Object));

    const statusOptions = service.getWorkspaceStatus.mock.calls[0]?.[1] as {
      timeoutMs?: number;
    };
    expect(typeof statusOptions.timeoutMs).toBe("number");
    expect(statusOptions.timeoutMs).toBeGreaterThan(0);

    expect(service.stopWorkspace).toHaveBeenCalledTimes(1);
    expect(service.stopWorkspace).toHaveBeenCalledWith("mux-ws", { timeoutMs: 1234 });
    expect(service.deleteWorkspace).toHaveBeenCalledTimes(0);
  });

  it("deletes a dedicated Coder workspace when archive behavior is delete", async () => {
    const service = createCoderServiceMocks();
    const hook = createCoderArchiveHook({
      coderService: service.coderService,
      getArchiveBehavior: () => "delete",
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(result.success).toBe(true);
    expect(service.getWorkspaceStatus).toHaveBeenCalledTimes(0);
    expect(service.stopWorkspace).toHaveBeenCalledTimes(0);
    expect(service.deleteWorkspace).toHaveBeenCalledTimes(1);
    expect(service.deleteWorkspace).toHaveBeenCalledWith("mux-ws");
  });

  it("returns Err when stopping a dedicated Coder workspace fails", async () => {
    const service = createCoderServiceMocks({
      getWorkspaceStatus: mock<
        (workspaceName: string, options?: { timeoutMs?: number }) => Promise<WorkspaceStatusResult>
      >(() => Promise.resolve({ kind: "ok", status: "running" })),
      stopWorkspace: mock<
        (workspaceName: string, options?: { timeoutMs?: number }) => Promise<Result<void>>
      >(() => Promise.resolve(Err("boom"))),
    });
    const hook = createCoderArchiveHook({
      coderService: service.coderService,
      getArchiveBehavior: () => "stop",
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(expectError(result)).toContain('Failed to stop Coder workspace "mux-ws": boom');
    expect(service.stopWorkspace).toHaveBeenCalledTimes(1);
  });

  it("returns Err when deleting a dedicated Coder workspace fails", async () => {
    const service = createCoderServiceMocks({
      deleteWorkspace: mock<(workspaceName: string) => Promise<void>>(() =>
        Promise.reject(new Error("boom"))
      ),
    });
    const hook = createCoderArchiveHook({
      coderService: service.coderService,
      getArchiveBehavior: () => "delete",
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(expectError(result)).toContain('Failed to delete Coder workspace "mux-ws": boom');
    expect(service.deleteWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("createCoderUnarchiveHook", () => {
  it("does nothing when archive behavior is keep", async () => {
    const service = createCoderServiceMocks({
      getWorkspaceStatus: mock<
        (workspaceName: string, options?: { timeoutMs?: number }) => Promise<WorkspaceStatusResult>
      >(() => Promise.resolve({ kind: "ok", status: "stopped" })),
    });
    const hook = createCoderUnarchiveHook({
      coderService: service.coderService,
      getArchiveBehavior: () => "keep",
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(result.success).toBe(true);
    expect(service.getWorkspaceStatus).toHaveBeenCalledTimes(0);
    expect(service.startWorkspace).toHaveBeenCalledTimes(0);
  });

  for (const archiveBehavior of CODER_ARCHIVE_BEHAVIORS) {
    it(`skips existing Coder workspaces when unarchive behavior is ${archiveBehavior}`, async () => {
      const service = createCoderServiceMocks({
        getWorkspaceStatus: mock<
          (
            workspaceName: string,
            options?: { timeoutMs?: number }
          ) => Promise<WorkspaceStatusResult>
        >(() => Promise.resolve({ kind: "ok", status: "stopped" })),
      });
      const hook = createCoderUnarchiveHook({
        coderService: service.coderService,
        getArchiveBehavior: () => archiveBehavior,
      });

      const result = await hook({
        workspaceId: "ws",
        workspaceMetadata: createSshCoderMetadata({
          runtimeConfig: {
            type: "ssh",
            host: "coder://",
            srcBaseDir: "~/mux",
            coder: { workspaceName: "mux-ws", existingWorkspace: true },
          },
        }),
      });

      expect(result.success).toBe(true);
      expect(service.getWorkspaceStatus).toHaveBeenCalledTimes(0);
      expect(service.startWorkspace).toHaveBeenCalledTimes(0);
    });
  }

  it("starts a stopped dedicated Coder workspace when archive behavior is stop", async () => {
    const service = createCoderServiceMocks({
      getWorkspaceStatus: mock<
        (workspaceName: string, options?: { timeoutMs?: number }) => Promise<WorkspaceStatusResult>
      >(() => Promise.resolve({ kind: "ok", status: "stopped" })),
    });
    const hook = createCoderUnarchiveHook({
      coderService: service.coderService,
      getArchiveBehavior: () => "stop",
      timeoutMs: 1234,
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(result.success).toBe(true);
    expect(service.getWorkspaceStatus).toHaveBeenCalledTimes(1);
    expect(service.getWorkspaceStatus).toHaveBeenCalledWith("mux-ws", expect.any(Object));

    const statusOptions = service.getWorkspaceStatus.mock.calls[0]?.[1] as {
      timeoutMs?: number;
    };
    expect(typeof statusOptions.timeoutMs).toBe("number");
    expect(statusOptions.timeoutMs).toBeGreaterThan(0);

    expect(service.startWorkspace).toHaveBeenCalledTimes(1);
    expect(service.startWorkspace).toHaveBeenCalledWith("mux-ws", { timeoutMs: 1234 });
  });

  it("does nothing when archive behavior is delete", async () => {
    const service = createCoderServiceMocks({
      getWorkspaceStatus: mock<
        (workspaceName: string, options?: { timeoutMs?: number }) => Promise<WorkspaceStatusResult>
      >(() => Promise.resolve({ kind: "not_found" })),
    });
    const hook = createCoderUnarchiveHook({
      coderService: service.coderService,
      getArchiveBehavior: () => "delete",
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(result.success).toBe(true);
    expect(service.getWorkspaceStatus).toHaveBeenCalledTimes(0);
    expect(service.startWorkspace).toHaveBeenCalledTimes(0);
  });

  it("waits for stopping workspace to become stopped before starting", async () => {
    let pollCount = 0;
    const service = createCoderServiceMocks({
      getWorkspaceStatus: mock<
        (workspaceName: string, options?: { timeoutMs?: number }) => Promise<WorkspaceStatusResult>
      >(() => {
        pollCount++;
        if (pollCount === 1) {
          return Promise.resolve({ kind: "ok", status: "stopping" });
        }
        return Promise.resolve({ kind: "ok", status: "stopped" });
      }),
    });
    const hook = createCoderUnarchiveHook({
      coderService: service.coderService,
      getArchiveBehavior: () => "stop",
      timeoutMs: 1234,
      stoppingPollIntervalMs: 0,
      stoppingWaitTimeoutMs: 1000,
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(result.success).toBe(true);
    expect(service.getWorkspaceStatus).toHaveBeenCalledTimes(2);
    expect(service.startWorkspace).toHaveBeenCalledTimes(1);
    expect(service.startWorkspace).toHaveBeenCalledWith("mux-ws", { timeoutMs: 1234 });
  });

  it("does nothing when workspace is already running or starting", async () => {
    const service = createCoderServiceMocks({
      getWorkspaceStatus: mock<
        (workspaceName: string, options?: { timeoutMs?: number }) => Promise<WorkspaceStatusResult>
      >(() => Promise.resolve({ kind: "ok", status: "running" })),
    });
    const hook = createCoderUnarchiveHook({
      coderService: service.coderService,
      getArchiveBehavior: () => "stop",
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(result.success).toBe(true);
    expect(service.getWorkspaceStatus).toHaveBeenCalledTimes(1);
    expect(service.startWorkspace).toHaveBeenCalledTimes(0);
  });

  it("treats not_found status as success when archive behavior is stop", async () => {
    const service = createCoderServiceMocks({
      getWorkspaceStatus: mock<
        (workspaceName: string, options?: { timeoutMs?: number }) => Promise<WorkspaceStatusResult>
      >(() => Promise.resolve({ kind: "not_found" })),
    });
    const hook = createCoderUnarchiveHook({
      coderService: service.coderService,
      getArchiveBehavior: () => "stop",
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(result.success).toBe(true);
    expect(service.getWorkspaceStatus).toHaveBeenCalledTimes(1);
    expect(service.startWorkspace).toHaveBeenCalledTimes(0);
  });
});
