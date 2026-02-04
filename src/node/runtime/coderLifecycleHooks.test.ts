import { describe, expect, it, mock } from "bun:test";
import { createStopCoderOnArchiveHook } from "./coderLifecycleHooks";
import { Ok } from "@/common/types/result";
import type { CoderService, WorkspaceStatusResult } from "@/node/services/coderService";
import type { WorkspaceMetadata } from "@/common/types/workspace";

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

describe("createStopCoderOnArchiveHook", () => {
  it("does nothing when stop-on-archive is disabled", async () => {
    const getWorkspaceStatus = mock<(workspaceName: string) => Promise<WorkspaceStatusResult>>(() =>
      Promise.resolve({ kind: "ok", status: "running" })
    );

    const stopWorkspace = mock<(workspaceName: string) => Promise<ReturnType<typeof Ok>>>(() =>
      Promise.resolve(Ok(undefined))
    );

    const coderService = {
      getWorkspaceStatus,
      stopWorkspace,
    } as unknown as CoderService;

    const hook = createStopCoderOnArchiveHook({
      coderService,
      shouldStopOnArchive: () => false,
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata(),
    });

    expect(result.success).toBe(true);
    expect(getWorkspaceStatus).toHaveBeenCalledTimes(0);
    expect(stopWorkspace).toHaveBeenCalledTimes(0);
  });

  it("does nothing when connected to an existing Coder workspace", async () => {
    const getWorkspaceStatus = mock<(workspaceName: string) => Promise<WorkspaceStatusResult>>(() =>
      Promise.resolve({ kind: "ok", status: "running" })
    );

    const stopWorkspace = mock<(workspaceName: string) => Promise<ReturnType<typeof Ok>>>(() =>
      Promise.resolve(Ok(undefined))
    );

    const coderService = {
      getWorkspaceStatus,
      stopWorkspace,
    } as unknown as CoderService;

    const hook = createStopCoderOnArchiveHook({
      coderService,
      shouldStopOnArchive: () => true,
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
    expect(getWorkspaceStatus).toHaveBeenCalledTimes(0);
    expect(stopWorkspace).toHaveBeenCalledTimes(0);
  });

  it("stops a running dedicated Coder workspace", async () => {
    const getWorkspaceStatus = mock<
      (workspaceName: string, options?: { timeoutMs?: number }) => Promise<WorkspaceStatusResult>
    >(() => Promise.resolve({ kind: "ok", status: "running" }));

    const stopWorkspace = mock<
      (workspaceName: string, options?: { timeoutMs?: number }) => Promise<ReturnType<typeof Ok>>
    >(() => Promise.resolve(Ok(undefined)));

    const coderService = {
      getWorkspaceStatus,
      stopWorkspace,
    } as unknown as CoderService;

    const hook = createStopCoderOnArchiveHook({
      coderService,
      shouldStopOnArchive: () => true,
      timeoutMs: 1234,
    });

    const result = await hook({
      workspaceId: "ws",
      workspaceMetadata: createSshCoderMetadata({
        runtimeConfig: {
          type: "ssh",
          host: "coder://",
          srcBaseDir: "~/mux",
          coder: { workspaceName: "mux-ws" },
        },
      }),
    });

    expect(result.success).toBe(true);

    expect(getWorkspaceStatus).toHaveBeenCalledTimes(1);
    expect(getWorkspaceStatus).toHaveBeenCalledWith("mux-ws", expect.any(Object));

    const statusOptions = (getWorkspaceStatus as ReturnType<typeof mock>).mock.calls[0]?.[1] as {
      timeoutMs?: number;
    };
    expect(typeof statusOptions.timeoutMs).toBe("number");
    expect(statusOptions.timeoutMs).toBeGreaterThan(0);

    expect(stopWorkspace).toHaveBeenCalledTimes(1);
    expect(stopWorkspace).toHaveBeenCalledWith("mux-ws", { timeoutMs: 1234 });
  });
});
