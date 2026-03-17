import { describe, expect, it, spyOn } from "bun:test";

import { WorktreeManager } from "@/node/worktree/WorktreeManager";

import type { InitLogger, WorkspaceCreationResult } from "./Runtime";
import { DevcontainerRuntime } from "./DevcontainerRuntime";
import { DockerRuntime } from "./DockerRuntime";
import { SSHRuntime } from "./SSHRuntime";
import { createSSHTransport } from "./transports";
import * as submoduleSync from "./submoduleSync";
import { WorktreeRuntime } from "./WorktreeRuntime";

function createInitLogger(): InitLogger {
  return {
    logStep: (_message) => undefined,
    logStdout: (_line) => undefined,
    logStderr: (_line) => undefined,
    logComplete: (_exitCode) => undefined,
  };
}

function createExecStream(result: { stdout?: string; stderr?: string; exitCode: number }) {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.stdout) {
          controller.enqueue(new TextEncoder().encode(result.stdout));
        }
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.stderr) {
          controller.enqueue(new TextEncoder().encode(result.stderr));
        }
        controller.close();
      },
    }),
    stdin: new WritableStream<Uint8Array>({
      write: () => undefined,
      close: () => undefined,
      abort: () => undefined,
    }),
    exitCode: Promise.resolve(result.exitCode),
    duration: Promise.resolve(0),
  };
}

const createWorkspaceCases = [
  {
    name: "worktree",
    createRuntime: () => new WorktreeRuntime("/tmp/mux-worktrees"),
  },
  {
    name: "devcontainer",
    createRuntime: () =>
      new DevcontainerRuntime({
        srcBaseDir: "/tmp/mux-worktrees",
        configPath: ".devcontainer/devcontainer.json",
      }),
  },
] as const;

describe("workspace checkout orchestration", () => {
  for (const testCase of createWorkspaceCases) {
    it(`delegates ${testCase.name} host checkout prep to WorktreeManager during workspace creation`, async () => {
      const runtime = testCase.createRuntime();
      const initLogger = createInitLogger();
      const abortController = new AbortController();
      const createSpy = spyOn(WorktreeManager.prototype, "createWorkspace").mockResolvedValue({
        success: true,
        workspacePath: "/workspace",
      } satisfies WorkspaceCreationResult);

      try {
        const result = await runtime.createWorkspace({
          projectPath: "/project",
          branchName: "feature",
          trunkBranch: "main",
          directoryName: "feature",
          initLogger,
          abortSignal: abortController.signal,
          env: { GH_TOKEN: "token" },
          trusted: true,
        });

        expect(result).toEqual({ success: true, workspacePath: "/workspace" });
        expect(createSpy).toHaveBeenCalledWith({
          projectPath: "/project",
          branchName: "feature",
          trunkBranch: "main",
          initLogger,
          abortSignal: abortController.signal,
          env: { GH_TOKEN: "token" },
          trusted: true,
        });
      } finally {
        createSpy.mockRestore();
      }
    });
  }

  it("cleans up the provisioned container when docker submodule materialization fails", async () => {
    const runtime = new DockerRuntime({
      image: "ubuntu:22.04",
      containerName: "mux-submodule-test",
    });
    const initLogger = createInitLogger();
    const abortController = new AbortController();
    const syncSpy = spyOn(submoduleSync, "syncRuntimeGitSubmodules").mockRejectedValue(
      new Error("submodule checkout failed")
    );
    const runtimeInternals = runtime as unknown as {
      materializeCheckedOutWorkspace: (args: {
        containerName: string;
        workspacePath: string;
        initLogger: InitLogger;
        abortSignal?: AbortSignal;
        env?: Record<string, string>;
        trusted?: boolean;
      }) => Promise<void>;
      removeProvisioningContainer: (containerName: string) => Promise<void>;
    };
    const cleanupSpy = spyOn(runtimeInternals, "removeProvisioningContainer").mockResolvedValue(
      undefined
    );

    let errorMessage = "";
    try {
      await runtimeInternals.materializeCheckedOutWorkspace({
        containerName: "mux-submodule-test",
        workspacePath: "/src",
        initLogger,
        abortSignal: abortController.signal,
        env: { GH_TOKEN: "token" },
        trusted: true,
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(syncSpy).toHaveBeenCalledWith({
      runtime,
      workspacePath: "/src",
      initLogger,
      abortSignal: abortController.signal,
      env: { GH_TOKEN: "token" },
      trusted: true,
    });
    expect(cleanupSpy).toHaveBeenCalledWith("mux-submodule-test");
    expect(errorMessage).toContain("submodule checkout failed");

    cleanupSpy.mockRestore();
    syncSpy.mockRestore();
  });

  it("materializes submodules as part of SSH checkout prep before init hooks are skipped", async () => {
    const config = { host: "example.com", srcBaseDir: "/remote/src" };
    const runtime = new SSHRuntime(config, createSSHTransport(config, false));
    const initLogger = createInitLogger();
    const syncSpy = spyOn(submoduleSync, "syncRuntimeGitSubmodules").mockResolvedValue(undefined);
    const execSpy = spyOn(runtime, "exec").mockImplementation((command) => {
      if (command.includes("test -d") && command.includes("/remote/workspace")) {
        return Promise.resolve(createExecStream({ exitCode: 0 }));
      }

      if (command.includes("rev-parse --is-inside-work-tree")) {
        return Promise.resolve(createExecStream({ stdout: "true\n", exitCode: 0 }));
      }

      if (command.includes("git fetch origin main")) {
        return Promise.resolve(createExecStream({ exitCode: 0 }));
      }

      if (command.includes("git merge-base --is-ancestor")) {
        return Promise.resolve(createExecStream({ exitCode: 1 }));
      }

      return Promise.reject(new Error(`Unexpected SSH command: ${command}`));
    });

    try {
      const result = await runtime.initWorkspace({
        projectPath: "/project",
        branchName: "feature",
        trunkBranch: "main",
        workspacePath: "/remote/workspace",
        initLogger,
        skipInitHook: true,
      });

      expect(result.success).toBe(true);
      expect(syncSpy).toHaveBeenCalledWith({
        runtime,
        workspacePath: "/remote/workspace",
        initLogger,
        abortSignal: undefined,
        env: undefined,
        trusted: undefined,
      });
    } finally {
      execSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });
});
