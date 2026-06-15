import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import type { ProjectConfig, ProjectsConfig, Workspace } from "@/common/types/project";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { createMuxMessage } from "@/common/types/message";
import { WorkspaceService } from "./workspaceService";

// setWorkflowSchedule persistence semantics (modeled on workspaceService.tags.test.ts):
//   - set persists the schedule; null clears it
//   - re-setting drops scheduler-owned lastRunStartedAt (schedule becomes due)
//   - unknown workspaces fail without persisting

const TEST_WORKSPACE_ID = "test-ws";
const TEST_PROJECT_PATH = "/test/project";

describe("WorkspaceService.setWorkflowSchedule", () => {
  let currentProjectsConfig: ProjectsConfig;
  let historyServiceMock: { getHistoryFromLatestBoundary: ReturnType<typeof mock> };
  let service: WorkspaceService;

  beforeEach(() => {
    const workspace: Workspace = { id: TEST_WORKSPACE_ID, path: "/test/path", name: "test" };
    const projectConfig: ProjectConfig = { workspaces: [workspace] };
    currentProjectsConfig = { projects: new Map([[TEST_PROJECT_PATH, projectConfig]]) };

    const mockConfig = {
      loadConfigOrDefault: mock(() => currentProjectsConfig),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        currentProjectsConfig = fn(currentProjectsConfig);
        return Promise.resolve();
      }),
    } as unknown as Config;

    historyServiceMock = {
      getHistoryFromLatestBoundary: mock(() => Promise.resolve({ success: true, data: [] })),
    };
    service = new WorkspaceService(
      mockConfig,
      historyServiceMock as unknown as HistoryService,
      new EventEmitter() as unknown as AIService,
      new EventEmitter() as unknown as InitStateManager,
      {} as ExtensionMetadataService,
      {} as BackgroundProcessManager
    );
    (
      service as unknown as { emitCurrentWorkspaceMetadata: () => Promise<void> }
    ).emitCurrentWorkspaceMetadata = mock(() => Promise.resolve());
  });

  afterEach(() => {
    mock.restore();
  });

  function storedSchedule(): Workspace["workflowSchedule"] {
    return currentProjectsConfig.projects.get(TEST_PROJECT_PATH)?.workspaces.at(0)
      ?.workflowSchedule;
  }

  test("persists a schedule and clears it with null", async () => {
    const result = await service.setWorkflowSchedule(TEST_WORKSPACE_ID, {
      enabled: true,
      workflowName: "reconcile",
      args: { dryRun: true },
      intervalMs: 60_000,
    });
    expect(result.success).toBe(true);
    expect(storedSchedule()).toEqual({
      enabled: true,
      workflowName: "reconcile",
      args: { dryRun: true },
      intervalMs: 60_000,
    });

    const cleared = await service.setWorkflowSchedule(TEST_WORKSPACE_ID, null);
    expect(cleared.success).toBe(true);
    expect(storedSchedule()).toBeUndefined();
  });

  test("persists new-workspace target and context mode while trimming optional fields", async () => {
    const result = await service.setWorkflowSchedule(TEST_WORKSPACE_ID, {
      enabled: true,
      workflowName: " reconcile ",
      intervalMs: 60_000,
      contextMode: "compact",
      target: {
        type: "new-workspace",
        branchName: " scheduled-triage ",
        trunkBranch: " main ",
        title: " Scheduled triage ",
      },
    });

    expect(result.success).toBe(true);
    expect(storedSchedule()).toEqual({
      enabled: true,
      workflowName: "reconcile",
      intervalMs: 60_000,
      contextMode: "compact",
      target: {
        type: "new-workspace",
        branchName: "scheduled-triage",
        trunkBranch: "main",
        title: "Scheduled triage",
      },
    });
  });

  test("rejects invalid new-workspace branch names at save time", async () => {
    const result = await service.setWorkflowSchedule(TEST_WORKSPACE_ID, {
      enabled: true,
      workflowName: "reconcile",
      intervalMs: 60_000,
      target: {
        type: "new-workspace",
        branchName: "Invalid Branch",
        trunkBranch: "main",
      },
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected invalid branch name to be rejected");
    expect(result.error).toContain(
      "Workspace names can only contain lowercase letters, numbers, hyphens, and underscores"
    );
    expect(storedSchedule()).toBeUndefined();
  });

  test("rejects unsupported fresh target source workspaces", async () => {
    const workspace = currentProjectsConfig.projects.get(TEST_PROJECT_PATH)?.workspaces.at(0);
    if (workspace == null) throw new Error("workspace missing");

    workspace.projects = [
      { projectPath: "/test/project-a", projectName: "project-a" },
      { projectPath: "/test/project-b", projectName: "project-b" },
    ];
    const multiProject = await service.setWorkflowSchedule(TEST_WORKSPACE_ID, {
      enabled: true,
      workflowName: "reconcile",
      intervalMs: 60_000,
      target: { type: "new-workspace", trunkBranch: "main" },
    });
    expect(multiProject.success).toBe(false);
    if (multiProject.success) throw new Error("expected multi-project schedule to be rejected");
    expect(multiProject.error).toContain("multi-project workspaces");

    delete workspace.projects;
    workspace.runtimeConfig = { type: "local" };
    const localProjectDir = await service.setWorkflowSchedule(TEST_WORKSPACE_ID, {
      enabled: true,
      workflowName: "reconcile",
      intervalMs: 60_000,
      target: { type: "new-workspace", trunkBranch: "main" },
    });
    expect(localProjectDir.success).toBe(false);
    if (localProjectDir.success) throw new Error("expected local schedule to be rejected");
    expect(localProjectDir.error).toContain("project-dir local workspaces");

    workspace.runtimeConfig = {
      type: "ssh",
      host: "coder://",
      srcBaseDir: "/home/coder/.mux/src",
      coder: { workspaceName: "existing-vm", existingWorkspace: true },
    };
    const existingCoder = await service.setWorkflowSchedule(TEST_WORKSPACE_ID, {
      enabled: true,
      workflowName: "reconcile",
      intervalMs: 60_000,
      target: { type: "new-workspace", trunkBranch: "main" },
    });
    expect(existingCoder.success).toBe(false);
    if (existingCoder.success) throw new Error("expected existing Coder schedule to be rejected");
    expect(existingCoder.error).toContain("existing Coder workspaces");
    expect(storedSchedule()).toBeUndefined();
  });

  test("re-setting drops scheduler-owned lastRunStartedAt so the schedule is due", async () => {
    await service.setWorkflowSchedule(TEST_WORKSPACE_ID, {
      enabled: true,
      workflowName: "reconcile",
      intervalMs: 60_000,
    });
    const entry = currentProjectsConfig.projects.get(TEST_PROJECT_PATH)?.workspaces.at(0);
    if (entry?.workflowSchedule == null) throw new Error("schedule missing");
    entry.workflowSchedule.lastRunStartedAt = new Date().toISOString();

    await service.setWorkflowSchedule(TEST_WORKSPACE_ID, {
      enabled: true,
      workflowName: "reconcile",
      intervalMs: 120_000,
    });
    expect(storedSchedule()?.lastRunStartedAt).toBeUndefined();
    expect(storedSchedule()?.intervalMs).toBe(120_000);
  });

  test("compact context preparation waits for a new durable boundary", async () => {
    const beforeMessages = [createMuxMessage("u1", "user", "before compaction")];
    const afterMessages = [
      createMuxMessage("summary", "assistant", "compacted summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
    ];
    historyServiceMock.getHistoryFromLatestBoundary
      .mockResolvedValueOnce({ success: true, data: beforeMessages })
      .mockResolvedValueOnce({ success: true, data: afterMessages });
    const serviceInternals = service as unknown as {
      executeIdleCompaction: (workspaceId: string) => Promise<void>;
      waitForWorkspaceIdle: (
        workspaceId: string,
        options: { signal?: AbortSignal }
      ) => Promise<void>;
    };
    const executeIdleCompaction = mock((_workspaceId: string) => Promise.resolve());
    const waitForWorkspaceIdle = mock((_workspaceId: string, _options: { signal?: AbortSignal }) =>
      Promise.resolve()
    );
    serviceInternals.executeIdleCompaction = executeIdleCompaction;
    serviceInternals.waitForWorkspaceIdle = waitForWorkspaceIdle;

    const result = await service.prepareScheduledWorkflowContext(TEST_WORKSPACE_ID, "compact");

    expect(result).toEqual({ success: true, data: "compact" });
    expect(executeIdleCompaction).toHaveBeenCalledWith(TEST_WORKSPACE_ID);
    expect(waitForWorkspaceIdle.mock.calls[0]?.[0]).toBe(TEST_WORKSPACE_ID);
    expect(waitForWorkspaceIdle.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("compact context preparation fails when compaction writes no new boundary", async () => {
    const activeMessages = [createMuxMessage("u1", "user", "before compaction")];
    historyServiceMock.getHistoryFromLatestBoundary
      .mockResolvedValueOnce({ success: true, data: activeMessages })
      .mockResolvedValueOnce({ success: true, data: activeMessages });
    const serviceInternals = service as unknown as {
      executeIdleCompaction: (workspaceId: string) => Promise<void>;
      waitForWorkspaceIdle: (
        workspaceId: string,
        options: { signal?: AbortSignal }
      ) => Promise<void>;
    };
    serviceInternals.executeIdleCompaction = mock(() => Promise.resolve());
    serviceInternals.waitForWorkspaceIdle = mock(() => Promise.resolve());

    const result = await service.prepareScheduledWorkflowContext(TEST_WORKSPACE_ID, "compact");

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected compact preparation to fail");
    expect(result.error).toContain("without writing a new context boundary");
  });

  test("fails for unknown workspaces without persisting", async () => {
    const result = await service.setWorkflowSchedule("missing", {
      enabled: true,
      workflowName: "reconcile",
      intervalMs: 60_000,
    });
    expect(result.success).toBe(false);
    expect(storedSchedule()).toBeUndefined();
  });
});
