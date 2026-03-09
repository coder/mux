import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import type { Config } from "@/node/config";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as gitModule from "@/node/git";
import type { AIService } from "@/node/services/aiService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import * as bashToolModule from "@/node/services/tools/bash";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { Ok } from "@/common/types/result";
import type { ProjectsConfig } from "@/common/types/project";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";

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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
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

describe("WorkspaceService executeBash runtime selection", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("uses the multi-project container runtime and container-root cwd for script mode", async () => {
    const workspaceId = "ws-multi-bash";
    const workspaceName = "feature-multi-bash";
    const srcDir = "/tmp/src";
    const projectAPath = "/tmp/project-a";
    const projectBPath = "/tmp/project-b";
    const metadata: WorkspaceMetadata = {
      id: workspaceId,
      name: workspaceName,
      projectPath: projectAPath,
      projectName: "project-a",
      projects: [
        { projectPath: projectAPath, projectName: "project-a" },
        { projectPath: projectBPath, projectName: "project-b" },
      ],
      runtimeConfig: { type: "local" },
    };
    const waitForInitMock = mock(() => Promise.resolve());
    const ensureReadyAMock = mock(() => Promise.resolve({ ready: true as const }));
    const ensureReadyBMock = mock(() => Promise.resolve({ ready: true as const }));
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
      (_runtimeConfig, options) => {
        if (options?.projectPath === projectAPath) {
          return {
            ensureReady: ensureReadyAMock,
            getWorkspacePath: mock(() => `/tmp/workspaces/project-a/${workspaceName}`),
          } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
        }
        if (options?.projectPath === projectBPath) {
          return {
            ensureReady: ensureReadyBMock,
            getWorkspacePath: mock(() => `/tmp/workspaces/project-b/${workspaceName}`),
          } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
        }
        throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
      }
    );
    const bashExecuteMock = mock(() =>
      Promise.resolve({ success: true as const, output: "ok", exitCode: 0, wall_duration_ms: 1 })
    );
    let capturedToolConfig: Parameters<typeof bashToolModule.createBashTool>[0] | undefined;
    const createBashToolSpy = spyOn(bashToolModule, "createBashTool").mockImplementation(
      (config) => {
        capturedToolConfig = config;
        return {
          execute: bashExecuteMock,
        } as unknown as ReturnType<typeof bashToolModule.createBashTool>;
      }
    );

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(metadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const workspaceService = new WorkspaceService(
      {
        srcDir,
        getSessionDir: mock(() => "/tmp/test/sessions"),
        findWorkspace: mock(() => ({
          projectPath: projectAPath,
          workspacePath: `/tmp/workspaces/project-a/${workspaceName}`,
        })),
        loadConfigOrDefault: mock(() => ({
          projects: new Map([[projectAPath, { workspaces: [], trusted: true }]]),
        })),
        getEffectiveSecrets: mock(() => []),
      } as unknown as Config,
      historyService,
      aiService,
      {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        waitForInit: waitForInitMock,
      } as unknown as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    try {
      const result = await workspaceService.executeBash(workspaceId, "pwd");

      expect(result.success).toBe(true);
      expect(waitForInitMock).toHaveBeenCalledWith(workspaceId);
      expect(createRuntimeSpy).toHaveBeenCalledTimes(2);
      expect(createRuntimeSpy).toHaveBeenNthCalledWith(1, metadata.runtimeConfig, {
        projectPath: projectAPath,
        workspaceName,
      });
      expect(createRuntimeSpy).toHaveBeenNthCalledWith(2, metadata.runtimeConfig, {
        projectPath: projectBPath,
        workspaceName,
      });
      assert(capturedToolConfig);
      expect(capturedToolConfig.runtime).toBeInstanceOf(MultiProjectRuntime);
      expect(capturedToolConfig.cwd).toBe(
        new ContainerManager(srcDir).getContainerPath(workspaceName)
      );
      expect(ensureReadyAMock).toHaveBeenCalledTimes(1);
      expect(ensureReadyBMock).toHaveBeenCalledTimes(1);
      expect(bashExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      createBashToolSpy.mockRestore();
      createRuntimeSpy.mockRestore();
    }
  });

  test("uses the primary project git root for multi-project git command mode", async () => {
    const workspaceId = "ws-multi-git";
    const workspaceName = "feature-multi-git";
    const srcDir = "/tmp/src";
    const projectAPath = "/tmp/project-a";
    const projectBPath = "/tmp/project-b";
    const metadata: WorkspaceMetadata = {
      id: workspaceId,
      name: workspaceName,
      projectPath: projectAPath,
      projectName: "project-a",
      projects: [
        { projectPath: projectAPath, projectName: "project-a" },
        { projectPath: projectBPath, projectName: "project-b" },
      ],
      runtimeConfig: { type: "local" },
    };
    const waitForInitMock = mock(() => Promise.resolve());
    const ensureReadyAMock = mock(() => Promise.resolve({ ready: true as const }));
    const ensureReadyBMock = mock(() => Promise.resolve({ ready: true as const }));
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
      (_runtimeConfig, options) => {
        if (options?.projectPath === projectAPath) {
          return {
            ensureReady: ensureReadyAMock,
            getWorkspacePath: mock(() => `/tmp/workspaces/project-a/${workspaceName}`),
          } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
        }
        if (options?.projectPath === projectBPath) {
          return {
            ensureReady: ensureReadyBMock,
            getWorkspacePath: mock(() => `/tmp/workspaces/project-b/${workspaceName}`),
          } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
        }
        throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
      }
    );
    const bashExecuteMock = mock(() =>
      Promise.resolve({ success: true as const, output: "ok", exitCode: 0, wall_duration_ms: 1 })
    );
    let capturedToolConfig: Parameters<typeof bashToolModule.createBashTool>[0] | undefined;
    const createBashToolSpy = spyOn(bashToolModule, "createBashTool").mockImplementation(
      (config) => {
        capturedToolConfig = config;
        return {
          execute: bashExecuteMock,
        } as unknown as ReturnType<typeof bashToolModule.createBashTool>;
      }
    );

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(metadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const workspaceService = new WorkspaceService(
      {
        srcDir,
        getSessionDir: mock(() => "/tmp/test/sessions"),
        findWorkspace: mock(() => ({
          projectPath: projectAPath,
          workspacePath: `/tmp/workspaces/project-a/${workspaceName}`,
        })),
        loadConfigOrDefault: mock(() => ({
          projects: new Map([[projectAPath, { workspaces: [], trusted: true }]]),
        })),
        getEffectiveSecrets: mock(() => []),
      } as unknown as Config,
      historyService,
      aiService,
      {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        waitForInit: waitForInitMock,
      } as unknown as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    try {
      const result = await workspaceService.executeBash(workspaceId, "", undefined, "git", [
        "status",
        "--short",
      ]);

      expect(result.success).toBe(true);
      expect(waitForInitMock).toHaveBeenCalledWith(workspaceId);
      expect(createRuntimeSpy).toHaveBeenCalledTimes(2);
      assert(capturedToolConfig);
      expect(capturedToolConfig.runtime).toBeInstanceOf(MultiProjectRuntime);
      expect(capturedToolConfig.cwd).toBe(projectAPath);
      expect(bashExecuteMock).toHaveBeenCalledTimes(1);
      const [toolInput, toolContext] = bashExecuteMock.mock.calls[0] as unknown as [
        { script: string; timeout_secs: number },
        { toolCallId: string; messages: unknown[] },
      ];
      expect(toolInput).toEqual({
        script: "'git' 'status' '--short'",
        timeout_secs: 120,
      });
      expect(toolContext.toolCallId).toMatch(/^bash-/);
      expect(toolContext.messages).toEqual([]);
    } finally {
      createBashToolSpy.mockRestore();
      createRuntimeSpy.mockRestore();
    }
  });

  test("keeps single-project executeBash on the workspace runtime path", async () => {
    const workspaceId = "ws-single-bash";
    const workspaceName = "feature-single-bash";
    const projectPath = "/tmp/project-single";
    const workspacePath = `/tmp/workspaces/project-single/${workspaceName}`;
    const metadata: WorkspaceMetadata = {
      id: workspaceId,
      name: workspaceName,
      projectPath,
      projectName: "project-single",
      runtimeConfig: { type: "local" },
    };
    const waitForInitMock = mock(() => Promise.resolve());
    const singleRuntime = {
      ensureReady: mock(() => Promise.resolve({ ready: true as const })),
      getWorkspacePath: mock(() => workspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(singleRuntime);
    const bashExecuteMock = mock(() =>
      Promise.resolve({ success: true as const, output: "ok", exitCode: 0, wall_duration_ms: 1 })
    );
    let capturedToolConfig: Parameters<typeof bashToolModule.createBashTool>[0] | undefined;
    const createBashToolSpy = spyOn(bashToolModule, "createBashTool").mockImplementation(
      (config) => {
        capturedToolConfig = config;
        return {
          execute: bashExecuteMock,
        } as unknown as ReturnType<typeof bashToolModule.createBashTool>;
      }
    );

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(metadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const workspaceService = new WorkspaceService(
      {
        srcDir: "/tmp/src",
        getSessionDir: mock(() => "/tmp/test/sessions"),
        findWorkspace: mock(() => ({ projectPath, workspacePath })),
        loadConfigOrDefault: mock(() => ({
          projects: new Map([[projectPath, { workspaces: [], trusted: true }]]),
        })),
        getEffectiveSecrets: mock(() => []),
      } as unknown as Config,
      historyService,
      aiService,
      {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        waitForInit: waitForInitMock,
      } as unknown as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    try {
      const result = await workspaceService.executeBash(workspaceId, "pwd");

      expect(result.success).toBe(true);
      expect(waitForInitMock).toHaveBeenCalledWith(workspaceId);
      expect(createRuntimeSpy).toHaveBeenCalledTimes(1);
      assert(capturedToolConfig);
      expect(capturedToolConfig.runtime).toBe(singleRuntime);
      expect(capturedToolConfig.cwd).toBe(workspacePath);
      expect(bashExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      createBashToolSpy.mockRestore();
      createRuntimeSpy.mockRestore();
    }
  });
});

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
            workspaces.map((workspace) => {
              const metadata: FrontendWorkspaceMetadata = {
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
              };

              return metadata;
            })
          );
        }),
        getEffectiveSecrets: mock(() => []),
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
      const initWorkspaceAMock = mock(() => Promise.resolve({ success: true as const }));
      const initWorkspaceBMock = mock(() => Promise.resolve({ success: true as const }));
      const deleteWorkspaceMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
      );

      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              createWorkspace: createWorkspaceAMock,
              initWorkspace: initWorkspaceAMock,
              deleteWorkspace: deleteWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              createWorkspace: createWorkspaceBMock,
              initWorkspace: initWorkspaceBMock,
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

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(initWorkspaceAMock).toHaveBeenCalledWith(
          expect.objectContaining({
            projectPath: projectAPath,
            branchName,
            trunkBranch: "main",
            workspacePath: path.join(srcDir, "project-a", branchName),
          })
        );
        expect(initWorkspaceBMock).toHaveBeenCalledWith(
          expect.objectContaining({
            projectPath: projectBPath,
            branchName,
            trunkBranch: "main",
            workspacePath: path.join(srcDir, "project-b", branchName),
          })
        );

        const storedMultiWorkspaces =
          configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces ?? [];
        expect(storedMultiWorkspaces).toHaveLength(1);
        expect(configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.projectKind).toBe("system");
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

  test("createMultiProject preserves a pre-existing container when branchName collides", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-existing-container";
      const branchName = "feature-existing-container";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const originalProjectAWorkspacePath = path.join(rootDir, "existing-project-a-workspace");
      await fsPromises.mkdir(originalProjectAWorkspacePath, { recursive: true });
      await fsPromises.writeFile(
        path.join(originalProjectAWorkspacePath, "marker.txt"),
        "pre-existing marker",
        "utf8"
      );

      const containerManager = new ContainerManager(srcDir);
      const existingContainerPath = await containerManager.createContainer(branchName, [
        {
          projectName: "project-a",
          workspacePath: originalProjectAWorkspacePath,
        },
      ]);

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
        getEffectiveSecrets: mock(() => []),
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
      const deleteWorkspaceAMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted-a" })
      );
      const deleteWorkspaceBMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted-b" })
      );
      const initWorkspaceMock = mock(() => Promise.resolve({ success: true as const }));

      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              createWorkspace: createWorkspaceAMock,
              deleteWorkspace: deleteWorkspaceAMock,
              initWorkspace: initWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              createWorkspace: createWorkspaceBMock,
              deleteWorkspace: deleteWorkspaceBMock,
              initWorkspace: initWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );

      const removeContainerSpy = spyOn(ContainerManager.prototype, "removeContainer");

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
          "main"
        );

        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }

        expect(result.error).toContain("already exists");
        expect(deleteWorkspaceAMock).toHaveBeenCalledTimes(1);
        expect(deleteWorkspaceAMock).toHaveBeenCalledWith(
          projectAPath,
          branchName,
          false,
          expect.any(AbortSignal),
          true
        );
        expect(deleteWorkspaceBMock).toHaveBeenCalledTimes(1);
        expect(deleteWorkspaceBMock).toHaveBeenCalledWith(
          projectBPath,
          branchName,
          false,
          expect.any(AbortSignal),
          true
        );
        expect(initWorkspaceMock).not.toHaveBeenCalled();
        expect(removeContainerSpy).not.toHaveBeenCalled();

        await fsPromises.access(existingContainerPath);
        expect(await fsPromises.realpath(path.join(existingContainerPath, "project-a"))).toBe(
          await fsPromises.realpath(originalProjectAWorkspacePath)
        );
        expect(
          await fsPromises.readFile(
            path.join(existingContainerPath, "project-a", "marker.txt"),
            "utf8"
          )
        ).toBe("pre-existing marker");
      } finally {
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });

  test("createMultiProject resolves trunk branch per project when requested branch is missing", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-project-trunk-resolution";
      const branchName = "feature-per-project-trunk";
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
            workspaces.map((workspace) => ({
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
            }))
          );
        }),
        getEffectiveSecrets: mock(() => []),
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
      const initWorkspaceAMock = mock(() => Promise.resolve({ success: true as const }));
      const initWorkspaceBMock = mock(() => Promise.resolve({ success: true as const }));
      const deleteWorkspaceMock = mock(() =>
        Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
      );

      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              createWorkspace: createWorkspaceAMock,
              initWorkspace: initWorkspaceAMock,
              deleteWorkspace: deleteWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              createWorkspace: createWorkspaceBMock,
              initWorkspace: initWorkspaceBMock,
              deleteWorkspace: deleteWorkspaceMock,
              resolvePath: mock(() => Promise.resolve(srcDir)),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );

      const listLocalBranchesSpy = spyOn(gitModule, "listLocalBranches").mockImplementation(
        (projectPath) => {
          if (projectPath === projectAPath) {
            return Promise.resolve(["main", "feature-a"]);
          }
          if (projectPath === projectBPath) {
            return Promise.resolve(["master", "feature-b"]);
          }
          throw new Error(`Unexpected project path for listLocalBranches: ${projectPath}`);
        }
      );

      const detectDefaultTrunkBranchSpy = spyOn(
        gitModule,
        "detectDefaultTrunkBranch"
      ).mockImplementation((_projectPath, branches) => {
        assert(branches, "Expected branches to be provided for trunk detection");
        return Promise.resolve(branches.includes("master") ? "master" : "main");
      });

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
          "main"
        );

        expect(result.success).toBe(true);

        expect(createWorkspaceAMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectAPath, trunkBranch: "main" })
        );
        expect(createWorkspaceBMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectBPath, trunkBranch: "master" })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(initWorkspaceAMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectAPath, trunkBranch: "main" })
        );
        expect(initWorkspaceBMock).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath: projectBPath, trunkBranch: "master" })
        );

        expect(detectDefaultTrunkBranchSpy).toHaveBeenCalledWith(projectBPath, [
          "master",
          "feature-b",
        ]);
      } finally {
        createContainerSpy.mockRestore();
        detectDefaultTrunkBranchSpy.mockRestore();
        listLocalBranchesSpy.mockRestore();
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

      await assert.rejects(
        workspaceService.createMultiProject(
          [{ projectPath: path.join(rootDir, "project-a"), projectName: "project-a" }],
          "feature",
          "main"
        ),
        /createMultiProject requires at least two projects/
      );
    });
  });

  test("createMultiProject rejects runtimes that are not local/worktree", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");

      const mockConfig: Partial<Config> = {
        rootDir,
        srcDir: path.join(rootDir, "src"),
        generateStableId: mock(() => "ws-unsupported-runtime"),
        loadConfigOrDefault: mock(() => ({
          projects: new Map([
            [projectAPath, { workspaces: [], trusted: true }],
            [projectBPath, { workspaces: [], trusted: true }],
          ]),
        })),
        getSessionDir: mock((workspace: string) => path.join(rootDir, "sessions", workspace)),
      };

      const mockAIService = {
        isStreaming: mock(() => false),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;

      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime");

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
          "feature-unsupported-runtime",
          "main",
          "Unsupported runtime",
          {
            type: "docker",
            image: "ubuntu:22.04",
          }
        );

        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }

        expect(result.error).toContain(
          "Multi-project workspaces currently require local or worktree runtime, got: docker"
        );
        expect(createRuntimeSpy).not.toHaveBeenCalled();
      } finally {
        createRuntimeSpy.mockRestore();
      }
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

  test("remove() preflights all project workspaces before deleting any when force=false", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-remove-preflight";
      const workspaceName = "feature-remove-preflight";
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

      const preflightWorkspaceAMock = mock(() => Promise.resolve({ success: true as const }));
      const preflightWorkspaceBMock = mock(() =>
        Promise.resolve({ success: false as const, error: "Workspace has uncommitted changes" })
      );
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
              canDeleteWorkspaceWithoutForce: preflightWorkspaceAMock,
              deleteWorkspace: deleteWorkspaceAMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              canDeleteWorkspaceWithoutForce: preflightWorkspaceBMock,
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

        const result = await workspaceService.remove(workspaceId, false);

        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }

        expect(result.error).toContain(
          "Failed to delete multi-project workspace from disk: [project-b] Workspace has uncommitted changes"
        );
        expect(preflightWorkspaceAMock).toHaveBeenCalledWith(projectAPath, workspaceName, true);
        expect(preflightWorkspaceBMock).toHaveBeenCalledWith(projectBPath, workspaceName, true);
        expect(deleteWorkspaceAMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceBMock).not.toHaveBeenCalled();
        expect(removeContainerSpy).not.toHaveBeenCalled();
        expect(removeWorkspaceMock).not.toHaveBeenCalled();
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

  test("rename() preserves per-project git-root paths for multi-project task entries", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-rename-task-entry";
      const oldName = "feature-old";
      const newName = "feature-new";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const oldContainerPath = path.join(srcDir, "_workspaces", oldName);
      const newContainerPath = path.join(srcDir, "_workspaces", newName);
      const oldWorkspaceAPath = path.join(srcDir, "project-a", oldName);
      const newWorkspaceAPath = path.join(srcDir, "project-a", newName);

      const configState: ProjectsConfig = {
        projects: new Map([
          [
            projectAPath,
            {
              trusted: true,
              workspaces: [
                {
                  id: workspaceId,
                  name: oldName,
                  path: oldWorkspaceAPath,
                  runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
                  projects: [
                    { projectPath: projectAPath, projectName: "project-a" },
                    { projectPath: projectBPath, projectName: "project-b" },
                  ],
                },
              ],
            },
          ],
          [projectBPath, { workspaces: [], trusted: true }],
        ]),
      };

      const mockConfig: Partial<Config> = {
        srcDir,
        loadConfigOrDefault: mock(() => configState),
        findWorkspace: mock(() => ({
          workspacePath: oldWorkspaceAPath,
          projectPath: projectAPath,
          workspaceName: oldName,
        })),
        editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
          fn(configState);
          return Promise.resolve();
        }),
        getAllWorkspaceMetadata: mock(() => {
          const workspace = configState.projects.get(projectAPath)?.workspaces[0];
          return Promise.resolve(
            workspace
              ? [
                  {
                    id: workspace.id ?? workspaceId,
                    name: workspace.name ?? oldName,
                    projectPath: projectAPath,
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
          oldPath: oldWorkspaceAPath,
          newPath: newWorkspaceAPath,
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
        expect(removeContainerSpy).toHaveBeenCalledWith(oldName);
        expect(createContainerSpy).toHaveBeenCalledWith(newName, [
          {
            projectName: "project-a",
            workspacePath: newWorkspaceAPath,
          },
          {
            projectName: "project-b",
            workspacePath: path.join(srcDir, "project-b", newName),
          },
        ]);

        const renamedWorkspace = configState.projects.get(projectAPath)?.workspaces[0];
        expect(renamedWorkspace?.name).toBe(newName);
        expect(renamedWorkspace?.path).toBe(newWorkspaceAPath);
        expect(renamedWorkspace?.path).not.toBe(newContainerPath);
        expect(oldContainerPath).not.toBe(newWorkspaceAPath);
      } finally {
        createContainerSpy.mockRestore();
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });

  test("rename() rolls back already-renamed projects when a later project rename fails", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-rename-rollback";
      const oldName = "feature-old";
      const newName = "feature-new";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const oldContainerPath = path.join(srcDir, "_workspaces", oldName);

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

      const editConfigMock = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        fn(configState);
        return Promise.resolve();
      });

      const mockConfig: Partial<Config> = {
        srcDir,
        loadConfigOrDefault: mock(() => configState),
        findWorkspace: mock(() => ({
          workspacePath: oldContainerPath,
          projectPath: MULTI_PROJECT_CONFIG_KEY,
          workspaceName: oldName,
        })),
        editConfig: editConfigMock,
        getAllWorkspaceMetadata: mock(() =>
          Promise.resolve([
            {
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
              namedWorkspacePath: oldContainerPath,
            } satisfies FrontendWorkspaceMetadata,
          ])
        ),
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

      const renameWorkspaceAMock = mock(
        (
          _projectPath: string,
          sourceName: string,
          targetName: string,
          _abortSignal?: AbortSignal,
          _trusted?: boolean
        ) => {
          if (sourceName === oldName && targetName === newName) {
            return Promise.resolve({
              success: true as const,
              oldPath: path.join(srcDir, "project-a", oldName),
              newPath: path.join(srcDir, "project-a", newName),
            });
          }

          if (sourceName === newName && targetName === oldName) {
            return Promise.resolve({
              success: true as const,
              oldPath: path.join(srcDir, "project-a", newName),
              newPath: path.join(srcDir, "project-a", oldName),
            });
          }

          return Promise.resolve({
            success: false as const,
            error: `Unexpected rename request ${sourceName} -> ${targetName}`,
          });
        }
      );
      const renameWorkspaceBMock = mock(() =>
        Promise.resolve({
          success: false as const,
          error: "project-b rename failed",
        })
      );

      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              renameWorkspace: renameWorkspaceAMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              renameWorkspace: renameWorkspaceBMock,
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
      ).mockResolvedValue(path.join(srcDir, "_workspaces", newName));

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

        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }

        expect(result.error).toContain("Failed to rename workspace for project project-b");
        expect(renameWorkspaceAMock).toHaveBeenCalledTimes(2);
        expect(renameWorkspaceAMock).toHaveBeenNthCalledWith(
          1,
          projectAPath,
          oldName,
          newName,
          undefined,
          true
        );
        expect(renameWorkspaceAMock).toHaveBeenNthCalledWith(
          2,
          projectAPath,
          newName,
          oldName,
          undefined,
          true
        );
        expect(renameWorkspaceBMock).toHaveBeenCalledTimes(1);

        expect(removeContainerSpy).not.toHaveBeenCalled();
        expect(createContainerSpy).not.toHaveBeenCalled();
        expect(editConfigMock).not.toHaveBeenCalled();

        const storedWorkspace = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces[0];
        expect(storedWorkspace?.name).toBe(oldName);
        expect(storedWorkspace?.path).toBe(oldContainerPath);
      } finally {
        createContainerSpy.mockRestore();
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });

  test("rename() rolls back all renamed projects when container recreation fails", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-rename-container-rollback";
      const oldName = "feature-old";
      const newName = "feature-new";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const oldContainerPath = path.join(srcDir, "_workspaces", oldName);
      const newContainerPath = path.join(srcDir, "_workspaces", newName);
      const oldWorkspaceAPath = path.join(srcDir, "project-a", oldName);
      const oldWorkspaceBPath = path.join(srcDir, "project-b", oldName);
      const newWorkspaceAPath = path.join(srcDir, "project-a", newName);
      const newWorkspaceBPath = path.join(srcDir, "project-b", newName);

      await fsPromises.mkdir(oldWorkspaceAPath, { recursive: true });
      await fsPromises.mkdir(oldWorkspaceBPath, { recursive: true });
      await fsPromises.mkdir(oldContainerPath, { recursive: true });
      await fsPromises.symlink(oldWorkspaceAPath, path.join(oldContainerPath, "project-a"));
      await fsPromises.symlink(oldWorkspaceBPath, path.join(oldContainerPath, "project-b"));

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

      const editConfigMock = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        fn(configState);
        return Promise.resolve();
      });

      const mockConfig: Partial<Config> = {
        srcDir,
        loadConfigOrDefault: mock(() => configState),
        findWorkspace: mock(() => ({
          workspacePath: oldContainerPath,
          projectPath: MULTI_PROJECT_CONFIG_KEY,
          workspaceName: oldName,
        })),
        editConfig: editConfigMock,
        getAllWorkspaceMetadata: mock(() =>
          Promise.resolve([
            {
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
              namedWorkspacePath: oldContainerPath,
            } satisfies FrontendWorkspaceMetadata,
          ])
        ),
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

      const renameWorkspaceAMock = mock(
        (
          _projectPath: string,
          sourceName: string,
          targetName: string,
          _abortSignal?: AbortSignal,
          _trusted?: boolean
        ) => {
          if (
            (sourceName === oldName && targetName === newName) ||
            (sourceName === newName && targetName === oldName)
          ) {
            return Promise.resolve({
              success: true as const,
              oldPath: sourceName === oldName ? oldWorkspaceAPath : newWorkspaceAPath,
              newPath: targetName === oldName ? oldWorkspaceAPath : newWorkspaceAPath,
            });
          }

          return Promise.resolve({
            success: false as const,
            error: `Unexpected rename request ${sourceName} -> ${targetName}`,
          });
        }
      );
      const renameWorkspaceBMock = mock(
        (
          _projectPath: string,
          sourceName: string,
          targetName: string,
          _abortSignal?: AbortSignal,
          _trusted?: boolean
        ) => {
          if (
            (sourceName === oldName && targetName === newName) ||
            (sourceName === newName && targetName === oldName)
          ) {
            return Promise.resolve({
              success: true as const,
              oldPath: sourceName === oldName ? oldWorkspaceBPath : newWorkspaceBPath,
              newPath: targetName === oldName ? oldWorkspaceBPath : newWorkspaceBPath,
            });
          }

          return Promise.resolve({
            success: false as const,
            error: `Unexpected rename request ${sourceName} -> ${targetName}`,
          });
        }
      );

      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              renameWorkspace: renameWorkspaceAMock,
              getWorkspacePath: mock(() => oldWorkspaceAPath),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              renameWorkspace: renameWorkspaceBMock,
              getWorkspacePath: mock(() => oldWorkspaceBPath),
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );

      const removeContainerSpy = spyOn(
        ContainerManager.prototype,
        "removeContainer"
      ).mockImplementation(async (workspaceName: string) => {
        await fsPromises.rm(path.join(srcDir, "_workspaces", workspaceName), {
          recursive: true,
          force: true,
        });
      });
      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockImplementation(async () => {
        await fsPromises.mkdir(newContainerPath, { recursive: true });
        await fsPromises.symlink(newWorkspaceAPath, path.join(newContainerPath, "project-a"));
        throw new Error("container create failed");
      });

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

        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }

        expect(result.error).toContain("Failed to recreate container");
        expect(renameWorkspaceAMock).toHaveBeenCalledTimes(2);
        expect(renameWorkspaceAMock).toHaveBeenNthCalledWith(
          1,
          projectAPath,
          oldName,
          newName,
          undefined,
          true
        );
        expect(renameWorkspaceAMock).toHaveBeenNthCalledWith(
          2,
          projectAPath,
          newName,
          oldName,
          undefined,
          true
        );
        expect(renameWorkspaceBMock).toHaveBeenCalledTimes(2);
        expect(renameWorkspaceBMock).toHaveBeenNthCalledWith(
          1,
          projectBPath,
          oldName,
          newName,
          undefined,
          true
        );
        expect(renameWorkspaceBMock).toHaveBeenNthCalledWith(
          2,
          projectBPath,
          newName,
          oldName,
          undefined,
          true
        );

        expect(removeContainerSpy).toHaveBeenCalledWith(oldName);
        expect(createContainerSpy).toHaveBeenCalledTimes(1);
        expect(editConfigMock).not.toHaveBeenCalled();

        const storedWorkspace = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces[0];
        expect(storedWorkspace?.name).toBe(oldName);
        expect(storedWorkspace?.path).toBe(oldContainerPath);
        expect(await pathExists(newContainerPath)).toBe(false);

        const recreatedProjectALink = await fsPromises.readlink(
          path.join(oldContainerPath, "project-a")
        );
        const recreatedProjectBLink = await fsPromises.readlink(
          path.join(oldContainerPath, "project-b")
        );
        expect(recreatedProjectALink).toBe(oldWorkspaceAPath);
        expect(recreatedProjectBLink).toBe(oldWorkspaceBPath);
        expect(recreatedProjectBLink).not.toBe(oldWorkspaceAPath);
      } finally {
        createContainerSpy.mockRestore();
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });

  test("rename() preserves a pre-existing new container when recreation fails", async () => {
    await withTempMuxRoot(async (rootDir) => {
      const workspaceId = "ws-multi-rename-preexisting-new-container";
      const oldName = "feature-old";
      const newName = "feature-new";
      const projectAPath = path.join(rootDir, "project-a");
      const projectBPath = path.join(rootDir, "project-b");
      const srcDir = path.join(rootDir, "src");
      const oldContainerPath = path.join(srcDir, "_workspaces", oldName);
      const newContainerPath = path.join(srcDir, "_workspaces", newName);
      const oldWorkspaceAPath = path.join(srcDir, "project-a", oldName);
      const oldWorkspaceBPath = path.join(srcDir, "project-b", oldName);
      const newWorkspaceAPath = path.join(srcDir, "project-a", newName);
      const newWorkspaceBPath = path.join(srcDir, "project-b", newName);
      const preexistingMarkerPath = path.join(newContainerPath, "marker.txt");

      await fsPromises.mkdir(oldWorkspaceAPath, { recursive: true });
      await fsPromises.mkdir(oldWorkspaceBPath, { recursive: true });
      await fsPromises.mkdir(oldContainerPath, { recursive: true });
      await fsPromises.symlink(oldWorkspaceAPath, path.join(oldContainerPath, "project-a"));
      await fsPromises.symlink(oldWorkspaceBPath, path.join(oldContainerPath, "project-b"));
      await fsPromises.mkdir(newContainerPath, { recursive: true });
      await fsPromises.writeFile(preexistingMarkerPath, "keep me", "utf8");

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

      const editConfigMock = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        fn(configState);
        return Promise.resolve();
      });

      const mockConfig: Partial<Config> = {
        srcDir,
        loadConfigOrDefault: mock(() => configState),
        findWorkspace: mock(() => ({
          workspacePath: oldContainerPath,
          projectPath: MULTI_PROJECT_CONFIG_KEY,
          workspaceName: oldName,
        })),
        editConfig: editConfigMock,
        getAllWorkspaceMetadata: mock(() =>
          Promise.resolve([
            {
              id: workspaceId,
              name: oldName,
              projectPath: projectAPath,
              projectName: "project-a+project-b",
              projects: [
                { projectPath: projectAPath, projectName: "project-a" },
                { projectPath: projectBPath, projectName: "project-b" },
              ],
              runtimeConfig: { type: "worktree", srcBaseDir: srcDir },
              namedWorkspacePath: oldContainerPath,
            } satisfies FrontendWorkspaceMetadata,
          ])
        ),
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

      const renameWorkspaceAMock = mock(
        (
          _projectPath: string,
          sourceName: string,
          targetName: string,
          _abortSignal?: AbortSignal,
          _trusted?: boolean
        ) => {
          if (
            (sourceName === oldName && targetName === newName) ||
            (sourceName === newName && targetName === oldName)
          ) {
            return Promise.resolve({
              success: true as const,
              oldPath: sourceName === oldName ? oldWorkspaceAPath : newWorkspaceAPath,
              newPath: targetName === oldName ? oldWorkspaceAPath : newWorkspaceAPath,
            });
          }

          return Promise.resolve({
            success: false as const,
            error: `Unexpected rename request ${sourceName} -> ${targetName}`,
          });
        }
      );
      const renameWorkspaceBMock = mock(
        (
          _projectPath: string,
          sourceName: string,
          targetName: string,
          _abortSignal?: AbortSignal,
          _trusted?: boolean
        ) => {
          if (
            (sourceName === oldName && targetName === newName) ||
            (sourceName === newName && targetName === oldName)
          ) {
            return Promise.resolve({
              success: true as const,
              oldPath: sourceName === oldName ? oldWorkspaceBPath : newWorkspaceBPath,
              newPath: targetName === oldName ? oldWorkspaceBPath : newWorkspaceBPath,
            });
          }

          return Promise.resolve({
            success: false as const,
            error: `Unexpected rename request ${sourceName} -> ${targetName}`,
          });
        }
      );

      const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
        (_runtimeConfig, options) => {
          if (options?.projectPath === projectAPath) {
            return {
              renameWorkspace: renameWorkspaceAMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          if (options?.projectPath === projectBPath) {
            return {
              renameWorkspace: renameWorkspaceBMock,
            } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
          }
          throw new Error(`Unexpected projectPath: ${options?.projectPath ?? "missing"}`);
        }
      );

      const removeContainerSpy = spyOn(
        ContainerManager.prototype,
        "removeContainer"
      ).mockImplementation(async (workspaceName: string) => {
        await fsPromises.rm(path.join(srcDir, "_workspaces", workspaceName), {
          recursive: true,
          force: true,
        });
      });
      const createContainerSpy = spyOn(
        ContainerManager.prototype,
        "createContainer"
      ).mockRejectedValue(new Error("container create failed"));

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

        expect(result.success).toBe(false);
        if (result.success) {
          return;
        }

        expect(result.error).toContain("Failed to recreate container");
        expect(removeContainerSpy).toHaveBeenCalledWith(oldName);
        expect(createContainerSpy).toHaveBeenCalledTimes(1);
        expect(editConfigMock).not.toHaveBeenCalled();

        const storedWorkspace = configState.projects.get(MULTI_PROJECT_CONFIG_KEY)?.workspaces[0];
        expect(storedWorkspace?.name).toBe(oldName);
        expect(storedWorkspace?.path).toBe(oldContainerPath);
        expect(await pathExists(newContainerPath)).toBe(true);
        expect(await fsPromises.readFile(preexistingMarkerPath, "utf8")).toBe("keep me");

        const recreatedProjectALink = await fsPromises.readlink(
          path.join(oldContainerPath, "project-a")
        );
        const recreatedProjectBLink = await fsPromises.readlink(
          path.join(oldContainerPath, "project-b")
        );
        expect(recreatedProjectALink).toBe(oldWorkspaceAPath);
        expect(recreatedProjectBLink).toBe(oldWorkspaceBPath);
      } finally {
        createContainerSpy.mockRestore();
        removeContainerSpy.mockRestore();
        createRuntimeSpy.mockRestore();
      }
    });
  });
});
