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

function createWorkspace(snoozedUntil?: string): Workspace {
  return {
    id: TEST_WORKSPACE_ID,
    path: TEST_WORKSPACE_PATH,
    name: "test",
    snoozedUntil,
  } as unknown as Workspace;
}

describe("WorkspaceService.setSnooze", () => {
  let currentProjectsConfig: ProjectsConfig;
  let mockConfig: Config;
  let service: WorkspaceService;

  beforeEach(() => {
    currentProjectsConfig = createProjectsConfig(createWorkspace());

    mockConfig = {
      loadConfigOrDefault: mock(() => currentProjectsConfig),
      findWorkspace: mock(() => ({
        workspacePath: TEST_WORKSPACE_PATH,
        projectPath: TEST_PROJECT_PATH,
      })),
      // setSnooze uses editConfig (matches archive), so we mimic that hook.
      // Return Promise.resolve() explicitly instead of marking the mock
      // `async` — lint flags async mocks without an `await` expression.
      editConfig: mock(
        (mutate: (config: ProjectsConfig) => ProjectsConfig | undefined): Promise<void> => {
          const next = mutate(currentProjectsConfig);
          if (next) currentProjectsConfig = next;
          return Promise.resolve();
        }
      ),
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
      {
        updateRecency: mock(() =>
          Promise.resolve({
            recency: Date.now(),
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: null,
          })
        ),
      } as unknown as ExtensionMetadataService,
      {} as BackgroundProcessManager
    );
    (
      service as unknown as { emitCurrentWorkspaceMetadata: () => Promise<void> }
    ).emitCurrentWorkspaceMetadata = mock(() => Promise.resolve());
  });

  afterEach(() => {
    mock.restore();
  });

  test("persists snoozedUntil when given a future ISO timestamp", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const result = await service.setSnooze(TEST_WORKSPACE_ID, future);

    expect(result.success).toBe(true);
    const persisted = currentProjectsConfig.projects.get(TEST_PROJECT_PATH)?.workspaces.at(0);
    expect(persisted?.snoozedUntil).toBe(future);
  });

  test("clears snoozedUntil when called with null", async () => {
    currentProjectsConfig = createProjectsConfig(
      createWorkspace(new Date(Date.now() + 60 * 60_000).toISOString())
    );

    const result = await service.setSnooze(TEST_WORKSPACE_ID, null);

    expect(result.success).toBe(true);
    const persisted = currentProjectsConfig.projects.get(TEST_PROJECT_PATH)?.workspaces.at(0);
    expect(persisted?.snoozedUntil).toBeUndefined();
  });

  test("normalizes a past timestamp into an explicit unsnooze so the persisted state stays clean", async () => {
    currentProjectsConfig = createProjectsConfig(
      createWorkspace(new Date(Date.now() + 60 * 60_000).toISOString())
    );
    const past = new Date(Date.now() - 1000).toISOString();

    const result = await service.setSnooze(TEST_WORKSPACE_ID, past);

    expect(result.success).toBe(true);
    const persisted = currentProjectsConfig.projects.get(TEST_PROJECT_PATH)?.workspaces.at(0);
    expect(persisted?.snoozedUntil).toBeUndefined();
  });

  test("rejects malformed ISO timestamps", async () => {
    const result = await service.setSnooze(TEST_WORKSPACE_ID, "not-a-date");
    expect(result.success).toBe(false);
  });

  test("rejects snooze deadlines beyond the maximum horizon", async () => {
    // 53 weeks > MAX_SNOOZE_MS (52 weeks); should be refused so snooze can't
    // act as a soft-archive replacement.
    const tooFar = new Date(Date.now() + 53 * 7 * 24 * 60 * 60_000).toISOString();
    const result = await service.setSnooze(TEST_WORKSPACE_ID, tooFar);
    expect(result.success).toBe(false);
  });
});
