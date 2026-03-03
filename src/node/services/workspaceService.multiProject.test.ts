import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import type { Config } from "@/node/config";
import { ContainerManager } from "@/node/multiProject/containerManager";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import type { AIService } from "@/node/services/aiService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { Ok } from "@/common/types/result";
import type { ProjectsConfig } from "@/common/types/project";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

async function withTempMuxRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const originalMuxRoot = process.env.MUX_ROOT;
  const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-multi-project-"));
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

function createMockInitStateManager(): InitStateManager {
  return {
    on: mock(() => undefined as unknown as InitStateManager),
    getInitState: mock(() => undefined),
    startInit: mock(() => undefined),
    endInit: mock(() => Promise.resolve()),
    appendOutput: mock(() => undefined),
    enterHookPhase: mock(() => undefined),
    clearInMemoryState: mock(() => undefined),
  } as unknown as InitStateManager;
}

const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {};
const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
  cleanup: mock(() => Promise.resolve()),
};

describe("WorkspaceService multi-project lifecycle", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("createMultiProject creates per-project workspaces and persists metadata", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-create";
      const branchName = "feature-multi";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const containerPath = path.join(srcDir, "_workspaces", branchName);

      const configState: ProjectsConfig = {
        projects: new Map([
          [projectAPath, { workspaces: [], trusted: true }],
          [projectBPath, { workspaces: [], trusted: true }],
        ]),
      };

      const mockConfig: Partial<Config> = {
        rootDir,
        srcDir,
        generateStableId: mock(() => workspaceId),
        loadConfigOrDefault: mock(() => configState),
        editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
          fn(configState);
          return Promise.resolve();
        }),
        getAllWorkspaceMetadata: mock(() => {
          const workspaces = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces ?? [];
          return Promise.resolve(
            workspaces.map(
              (workspace) =>
                ({
                  id: workspace.id ?? "",
                  name: workspace.name ?? "",
                  title: workspace.title,
                  projectPath: workspace.projects?.[0]?.projectPath ?? "",
                  projectName:
                    workspace.projects?.map((project) => project.projectName).join("+") ?? "",
                  projects: workspace.projects,
                  createdAt: workspace.createdAt,
                  runtimeConfig: workspace.runtimeConfig ?? {
                    type: "worktree",
                    srcBaseDir: srcDir,
                  },
                  namedWorkspacePath: workspace.path,
                }) as FrontendWorkspaceMetadata
            )
          );
        }),
        getSessionDir: mock((workspace: string) => path.join(rootDir, "sessions", workspace)),
        findWorkspace: mock(() => null),
      };

      const mockAIService = {
        isStreaming: mock(() => false),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;

      const createWorkspaceAMock = mock(() =>
        Promise.resolve({
          success: true as const,
          workspacePath: path.join(srcDir, "project-a", branchName),
        })
      );
      const createWorkspaceBMock = mock(() =>
        Promise.resolve({
          success: true as const,
          workspacePath: path.join(srcDir, "project-b", branchName),
        })
      );
      const deleteWorkspaceMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
      );

      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              createWorkspace: createWorkspaceAMock,
              deleteWorkspace: deleteWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              createWorkspace: createWorkspaceBMock,
              deleteWorkspace: deleteWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );

      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockResolvedValue(containerPath);

      try {
        const workspaceService = new WorkspaceService(
          mockConfig as Config,
          historyService,
          mockAIService,
          createMockInitStateManager(),
          mockExtensionMetadataService as ExtensionMetadataService,
          mockBackgroundProcessManager as BackgroundProcessManager
        );

        const result = await workspaceService.createMultiProject(
          [
            { projectPath: projectAPath, projectName: "project-a" },
            { projectPath: projectBPath, projectName: "project-b" },
          ],
          branchName,
          "main",
          "Multi-project title"
        );

        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(result.data.id).toBe(workspaceId);
        expect(result.data.projectPath).toBe(projectAPath);
        expect(result.data.projectName).toBe("project-a+project-b");
        expect(result.data.projects).toEqual([
          { projectPath: projectAPath, projectName: "project-a" },
          { projectPath: projectBPath, projectName: "project-b" },
        ]);

        expect(createWorkspaceAMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectAPath, branchName })
        );
        expect(createWorkspaceBMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectBPath, branchName })
        );

        expect(createContainerSpy).toHaveBeenCalledWith(branchName, [
          {
            projectName: "project-a",
            workspacePath: path.join(srcDir, "project-a", branchName),
          },
          {
            projectName: "project-b",
            workspacePath: path.join(srcDir, "project-b", branchName),
          },
        ]);

        const storedMultiWorkspaces =
          configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces ?? [];
        expect(storedMultiWorkspaces).toHaveLength(1);
        expect(storedMultiWorkspaces[0]?.projects).toEqual([
          { projectPath: projectAPath, projectName: "project-a" },
          { projectPath: projectBPath, projectName: "project-b" },
        ]);
      } finally {
        createContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });

  test("createMultiProject rejects fewer than two projects", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const mockConfig: Partial<Config> = {
        rootDir,
        srcDir: path.join(rootDir, "src"),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
        getSessionDir: mock((workspace: string) => path.join(rootDir, "sessions", workspace)),
        findWorkspace: mock(() => null),
      };

      const mockAIService = {
        isStreaming: mock(() => false),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;

      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        createMockInitStateManager(),
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      await expect(
        workspaceService.createMultiProject(
          [{ projectPath: path.join(rootDir, "project-a"), projectName: "project-a" }],
          "feature",
          "main"
        )
      ).rejects.toThrow("createMultiProject requires at least two projects");
    });
  });

  test("remove() deletes all project workspaces and the shared container for multi-project workspaces", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-remove";
      const workspaceName = "feature-remove";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");

      const removeWorkspaceMock = mock(() => Promise.resolve());

      const mockConfig: Partial<Config> = {
        srcDir: path.join(rootDir, "src"),
        loadConfigOrDefault: mock(() => ({
          projects: new Map([
            [projectAPath, { workspaces: [], trusted: true }],
            [projectBPath, { workspaces: [], trusted: true }],
          ]),
        })),
        getSessionDir: mock((id: string) => path.join(rootDir, "sessions", id)),
        removeWorkspace: removeWorkspaceMock,
        findWorkspace: mock(() => null),
      };

      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve(Ok(undefined))),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: workspaceName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "src") },
            })
          )
        ),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;

      const deleteWorkspaceAMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted-a" })
      );
      const deleteWorkspaceBMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted-b" })
      );

      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              deleteWorkspace: deleteWorkspaceAMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              deleteWorkspace: deleteWorkspaceBMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );

      const removeContainerSpy = spyOn(
        ContainerManager.prototype,
        "removeContainer"
      ).mockResolvedValue();

      try {
        const workspaceService = new WorkspaceService(
          mockConfig as Config,
          historyService,
          mockAIService,
          createMockInitStateManager(),
          mockExtensionMetadataService as ExtensionMetadataService,
          mockBackgroundProcessManager as BackgroundProcessManager
        );

        const result = await workspaceService.remove(workspaceId, true);

        expect(result.success).toBe(true);
        expect(deleteWorkspaceAMock).toHaveBeenCalledWith(
          projectAPath,
          workspaceName,
          true,
          undefined,
          true
        );
        expect(deleteWorkspaceBMock).toHaveBeenCalledWith(
          projectBPath,
          workspaceName,
          true,
          undefined,
          true
        );
        expect(removeContainerSpy).toHaveBeenCalledWith(workspaceName);
        expect(removeWorkspaceMock).toHaveBeenCalledWith(workspaceId);
      } finally {
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });

  test("rename() renames all project workspaces and recreates the shared container", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-rename";
      const oldName = "feature-old";
      const newName = "feature-new";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const oldContainerPath = path.join(srcDir, "_workspaces", oldName);
      const newContainerPath = path.join(srcDir, "_workspaces", newName);

      const configState: ProjectsConfig = {
        projects: new Map([
          [projectAPath, { workspaces: [], trusted: true }],
          [projectBPath, { workspaces: [], trusted: true }],
          [
            MULTI_PROJECT_CONFIG_KEY,
            {
              workspaces: [
                {
                  id: workspaceId,
                  name: oldName,
                  path: oldContainerPath,
                  runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
                  projects: [
                    { projectPath: projectAPath, projectName: "project-a" },
                    { projectPath: projectBPath, projectName: "project-b" },
                  ],
                },
              ],
            },
          ],
        ]),
      };

      const mockConfig: Partial<Config> = {
        srcDir,
        loadConfigOrDefault: mock(() => configState),
        findWorkspace: mock(() => ({
          workspacePath: oldContainerPath,
          projectPath: MULTI_PROJECT_CONFIG_KEY,
          workspaceName: oldName,
        })),
        editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
          fn(configState);
          return Promise.resolve();
        }),
        getAllWorkspaceMetadata: mock(() => {
          const workspace = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces[0];
          return Promise.resolve(
            workspace
              ? [
                  {
                    id: workspace.id ?? workspaceId,
                    name: workspace.name ?? oldName,
                    projectPath: workspace.projects?.[0]?.projectPath ?? projectAPath,
                    projectName:
                      workspace.projects?.map((project) => project.projectName).join("+") ?? "",
                    projects: workspace.projects,
                    runtimeConfig: workspace.runtimeConfig ?? {
                      type: "worktree",
                      srcBaseDir: srcDir,
                    },
                    namedWorkspacePath: workspace.path,
                  } satisfies FrontendWorkspaceMetadata,
                ]
              : []
          );
        }),
        getSessionDir: mock((id: string) => path.join(rootDir, "sessions", id)),
      };

      const mockAIService = {
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
            })
          )
        ),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;

      const renameWorkspaceAMock = mock(() =>
        Promise.resolve({
          success: true as const,
          oldPath: path.join(srcDir, "project-a", oldName),
          newPath: path.join(srcDir, "project-a", newName),
        })
      );
      const renameWorkspaceBMock = mock(() =>
        Promise.resolve({
          success: true as const,
          oldPath: path.join(srcDir, "project-b", oldName),
          newPath: path.join(srcDir, "project-b", newName),
        })
      );

      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              renameWorkspace: renameWorkspaceAMock,
              getMuxHome: mock(() => rootDir),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              renameWorkspace: renameWorkspaceBMock,
              getMuxHome: mock(() => rootDir),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );

      const removeContainerSpy = spyOn(
        ContainerManager.prototype,
        "removeContainer"
      ).mockResolvedValue();
      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockResolvedValue(newContainerPath);

      try {
        const workspaceService = new WorkspaceService(
          mockConfig as Config,
          historyService,
          mockAIService,
          createMockInitStateManager(),
          mockExtensionMetadataService as ExtensionMetadataService,
          mockBackgroundProcessManager as BackgroundProcessManager
        );

        const result = await workspaceService.rename(workspaceId, newName);

        expect(result.success).toBe(true);
        expect(renameWorkspaceAMock).toHaveBeenCalledWith(
          projectAPath,
          oldName,
          newName,
          undefined,
          true
        );
        expect(renameWorkspaceBMock).toHaveBeenCalledWith(
          projectBPath,
          oldName,
          newName,
          undefined,
          true
        );

        expect(removeContainerSpy).toHaveBeenCalledWith(oldName);
        expect(createContainerSpy).toHaveBeenCalledWith(newName, [
          {
            projectName: "project-a",
            workspacePath: path.join(srcDir, "project-a", newName),
          },
          {
            projectName: "project-b",
            workspacePath: path.join(srcDir, "project-b", newName),
          },
        ]);

        const renamedWorkspace = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces[0];
        expect(renamedWorkspace?.name).toBe(newName);
        expect(renamedWorkspace?.path).toBe(newContainerPath);
      } finally {
        createContainerSpy.mockRestore();
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
});
