import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import type { ProjectConfig, ProjectsConfig, Workspace } from "@/common/types/project";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { WorkspaceService } from "./workspaceService";

// setWorkflowSchedule persistence semantics (modeled on workspaceService.tags.test.ts):
//   - set persists the schedule; null clears it
//   - re-setting drops scheduler-owned lastRunStartedAt (schedule becomes due)
//   - unknown workspaces fail without persisting

const TEST_WORKSPACE_ID = "test-ws";
const TEST_PROJECT_PATH = "/test/project";

describe("WorkspaceService.setWorkflowSchedule", () => {
  let currentProjectsConfig: ProjectsConfig;
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

    service = new WorkspaceService(
      mockConfig,
      {} as HistoryService,
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
