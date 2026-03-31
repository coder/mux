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

const TEST_WORKSPACE_ID = "test-ws";
const TEST_WORKSPACE_PATH = "/test/path";
const TEST_PROJECT_PATH = "/test/project";

function createProjectsConfig(workspace: Workspace): ProjectsConfig {
  const projectConfig: ProjectConfig = {
    workspaces: [workspace],
  };

  return {
    projects: new Map([[TEST_PROJECT_PATH, projectConfig]]),
  };
}

function createWorkspace(heartbeat: {
  enabled: boolean;
  intervalMs: number;
  message?: string;
}): Workspace {
  return {
    id: TEST_WORKSPACE_ID,
    path: TEST_WORKSPACE_PATH,
    name: "test",
    heartbeat,
  } as unknown as Workspace;
}

describe("WorkspaceService heartbeat settings", () => {
  let currentProjectsConfig: ProjectsConfig;
  let mockConfig: Config;
  let service: WorkspaceService;

  beforeEach(() => {
    currentProjectsConfig = createProjectsConfig(
      createWorkspace({
        enabled: true,
        intervalMs: 30 * 60 * 1000,
        message: "Keep this custom heartbeat message.",
      })
    );

    mockConfig = {
      loadConfigOrDefault: mock(() => currentProjectsConfig),
      findWorkspace: mock(() => ({
        workspacePath: TEST_WORKSPACE_PATH,
        projectPath: TEST_PROJECT_PATH,
      })),
      saveConfig: mock((nextConfig: ProjectsConfig) => {
        currentProjectsConfig = nextConfig;
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

  test("preserves the existing message when a write omits the message field", async () => {
    const result = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
    });

    expect(result.success).toBe(true);
    const persistedHeartbeat = currentProjectsConfig.projects
      .get(TEST_PROJECT_PATH)
      ?.workspaces.at(0)?.heartbeat;
    expect(persistedHeartbeat).toEqual({
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      message: "Keep this custom heartbeat message.",
    });
  });

  test("clears the existing message when a write explicitly sends an empty message", async () => {
    const result = await service.setHeartbeatSettings(TEST_WORKSPACE_ID, {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
      message: "",
    });

    expect(result.success).toBe(true);
    const persistedHeartbeat = currentProjectsConfig.projects
      .get(TEST_PROJECT_PATH)
      ?.workspaces.at(0)?.heartbeat;
    expect(persistedHeartbeat).toEqual({
      enabled: true,
      intervalMs: 45 * 60 * 1000,
    });
  });
});
