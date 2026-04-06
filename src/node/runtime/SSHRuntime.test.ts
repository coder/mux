import * as crypto from "node:crypto";
import * as path from "node:path";
import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import * as disposableExec from "@/node/utils/disposableExec";
import * as submoduleSync from "./submoduleSync";
import { SSHRuntime, clearSharedProjectLayoutCache, computeBaseRepoPath } from "./SSHRuntime";
import {
  buildLegacyRemoteProjectLayout,
  buildRemoteProjectLayout,
  getRemoteWorkspacePath,
  getSnapshotMarkerPath,
} from "./remoteProjectLayout";
import { createSSHTransport } from "./transports";
import { projectSyncCoordinator } from "./projectSyncCoordinator";

/**
 * SSHRuntime unit tests (run with bun test)
 *
 * Integration tests for workspace operations (renameWorkspace, deleteWorkspace, forkWorkspace,
 * worktree-based operations) require Docker and are in tests/runtime/runtime.test.ts.
 * Run with: TEST_INTEGRATION=1 bun x jest tests/runtime/runtime.test.ts
 */
function createMockExecResult(
  result: Promise<{ stdout: string; stderr: string }>
): ReturnType<typeof disposableExec.execFileAsync> {
  void result.catch(() => undefined);
  return {
    result,
    get promise() {
      return result;
    },
    child: {},
    [Symbol.dispose]: () => undefined,
  } as unknown as ReturnType<typeof disposableExec.execFileAsync>;
}

afterEach(() => {
  clearSharedProjectLayoutCache();
});

describe("SSHRuntime constructor", () => {
  it("should accept tilde in srcBaseDir", () => {
    // Tildes are now allowed - they will be resolved via resolvePath()
    expect(() => {
      const config = { host: "example.com", srcBaseDir: "~/mux" };
      new SSHRuntime(config, createSSHTransport(config, false));
    }).not.toThrow();
  });

  it("should accept bare tilde in srcBaseDir", () => {
    // Tildes are now allowed - they will be resolved via resolvePath()
    expect(() => {
      const config = { host: "example.com", srcBaseDir: "~" };
      new SSHRuntime(config, createSSHTransport(config, false));
    }).not.toThrow();
  });

  it("should accept absolute paths in srcBaseDir", () => {
    expect(() => {
      const config = { host: "example.com", srcBaseDir: "/home/user/mux" };
      new SSHRuntime(config, createSSHTransport(config, false));
    }).not.toThrow();
  });
});

describe("SSHRuntime base repo config normalization", () => {
  type NormalizeBaseRepoSharedConfig = (
    baseRepoPathArg: string,
    abortSignal?: AbortSignal
  ) => Promise<boolean>;

  let execBufferedSpy: ReturnType<typeof spyOn<typeof runtimeHelpers, "execBuffered">> | null =
    null;
  let runtime: SSHRuntime;

  beforeEach(() => {
    const config = { host: "example.com", srcBaseDir: "/home/user/src" };
    runtime = new SSHRuntime(config, createSSHTransport(config, false));
  });

  afterEach(() => {
    execBufferedSpy?.mockRestore();
    execBufferedSpy = null;
  });

  function getNormalizeBaseRepoSharedConfig(): NormalizeBaseRepoSharedConfig {
    const normalizeUnknown: unknown = Reflect.get(runtime, "normalizeBaseRepoSharedConfig");
    if (typeof normalizeUnknown !== "function") {
      throw new Error("normalizeBaseRepoSharedConfig is unavailable");
    }

    return normalizeUnknown as NormalizeBaseRepoSharedConfig;
  }

  function normalizeBaseRepoSharedConfig(): Promise<boolean> {
    return getNormalizeBaseRepoSharedConfig().call(
      runtime,
      '"/home/user/src/project/.mux-base.git"'
    );
  }

  it("removes a local core.bare entry from the shared base repo config", async () => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      duration: 0,
    });

    expect(await normalizeBaseRepoSharedConfig()).toBe(true);
    expect(execBufferedSpy).toHaveBeenCalledWith(
      runtime,
      expect.stringContaining("config --local --unset-all core.bare"),
      expect.objectContaining({ cwd: "/tmp", timeout: 10 })
    );
  });

  it("treats missing local core.bare config as already normalized", async () => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 5,
      duration: 0,
    });

    expect(await normalizeBaseRepoSharedConfig()).toBe(false);
  });

  it("treats lock conflicts as a no-op when another writer already removed core.bare", async () => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered")
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "error: could not lock config file config: File exists",
        exitCode: 255,
        duration: 0,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 1,
        duration: 0,
      });

    expect(await normalizeBaseRepoSharedConfig()).toBe(false);
    expect(execBufferedSpy).toHaveBeenNthCalledWith(
      2,
      runtime,
      expect.stringContaining("config --local --get core.bare"),
      expect.objectContaining({ cwd: "/tmp", timeout: 10 })
    );
  });

  it("retries lock conflicts while the shared core.bare entry still exists", async () => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered")
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "error: could not lock config file config: File exists",
        exitCode: 255,
        duration: 0,
      })
      .mockResolvedValueOnce({
        stdout: "true\n",
        stderr: "",
        exitCode: 0,
        duration: 0,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
        duration: 0,
      });

    expect(await normalizeBaseRepoSharedConfig()).toBe(true);
    expect(execBufferedSpy).toHaveBeenCalledTimes(3);
  });
});

describe("SSHRuntime bundle sync reuse", () => {
  type ShouldReuseCurrentBundleTrunk = (
    projectPath: string,
    trunkBranch: string,
    initLogger: {
      logStep: (message: string) => void;
      logStdout: (line: string) => void;
      logStderr: (line: string) => void;
      logComplete: (exitCode: number) => void;
    },
    abortSignal?: AbortSignal
  ) => Promise<boolean>;

  interface RuntimeWithResolveLocalSyncRefManifest {
    resolveLocalSyncRefManifest: (projectPath: string) => Promise<string | null>;
  }

  interface RuntimeWithResolveRemoteSyncRefManifest {
    resolveRemoteSyncRefManifest: (
      baseRepoPathArg: string,
      abortSignal?: AbortSignal
    ) => Promise<string | null>;
  }

  interface RuntimeWithSyncProjectToRemote {
    syncProjectToRemote: (
      projectPath: string,
      workspacePath: string,
      initLogger: {
        logStep: (message: string) => void;
        logStdout: (line: string) => void;
        logStderr: (line: string) => void;
        logComplete: (exitCode: number) => void;
      },
      abortSignal?: AbortSignal
    ) => Promise<void>;
  }

  interface RuntimeWithEnsureBaseRepo {
    ensureBaseRepo: (
      projectPath: string,
      initLogger: {
        logStep: (message: string) => void;
        logStdout: (line: string) => void;
        logStderr: (line: string) => void;
        logComplete: (exitCode: number) => void;
      },
      abortSignal?: AbortSignal
    ) => Promise<string>;
  }

  interface RuntimeWithComputeSnapshotDigest {
    computeSnapshotDigest: (projectPath: string) => Promise<string>;
  }

  interface RuntimeWithTransferBundleToRemote {
    transferBundleToRemote: (
      projectPath: string,
      remoteBundlePath: string,
      initLogger: {
        logStep: (message: string) => void;
        logStdout: (line: string) => void;
        logStderr: (line: string) => void;
        logComplete: (exitCode: number) => void;
      },
      abortSignal?: AbortSignal
    ) => Promise<string>;
  }

  interface RuntimeWithRefreshBaseRepoOrigin {
    refreshBaseRepoOrigin: (
      projectPath: string,
      baseRepoPathArg: string,
      initLogger: {
        logStep: (message: string) => void;
        logStdout: (line: string) => void;
        logStderr: (line: string) => void;
        logComplete: (exitCode: number) => void;
      },
      abortSignal?: AbortSignal
    ) => Promise<void>;
  }

  let runtime: SSHRuntime;
  let execBufferedSpy: ReturnType<typeof spyOn<typeof runtimeHelpers, "execBuffered">> | null =
    null;
  let execFileAsyncSpy: ReturnType<typeof spyOn<typeof disposableExec, "execFileAsync">> | null =
    null;
  const initMessages: string[] = [];
  const initLogger = {
    logStep: (message: string) => {
      initMessages.push(message);
    },
    logStdout: () => undefined,
    logStderr: () => undefined,
    logComplete: () => undefined,
  };

  beforeEach(() => {
    const config = { host: "example.com", srcBaseDir: "/home/user/src" };
    runtime = new SSHRuntime(config, createSSHTransport(config, false));
    initMessages.length = 0;
  });

  afterEach(() => {
    execBufferedSpy?.mockRestore();
    execBufferedSpy = null;
    execFileAsyncSpy?.mockRestore();
    execFileAsyncSpy = null;
  });

  function getShouldReuseCurrentBundleTrunk(): ShouldReuseCurrentBundleTrunk {
    const reuseUnknown: unknown = Reflect.get(runtime, "shouldReuseCurrentBundleTrunk");
    if (typeof reuseUnknown !== "function") {
      throw new Error("shouldReuseCurrentBundleTrunk is unavailable");
    }

    return reuseUnknown as ShouldReuseCurrentBundleTrunk;
  }

  it("reuses the shared bundle when the remote refs already match local refs", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockReturnValue(
      createMockExecResult(Promise.resolve({ stdout: "abc123\n", stderr: "" }))
    );
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "abc123\n",
      stderr: "",
      exitCode: 0,
      duration: 0,
    });
    const localManifestSpy = spyOn(
      runtime as unknown as RuntimeWithResolveLocalSyncRefManifest,
      "resolveLocalSyncRefManifest"
    ).mockResolvedValue("refs/heads/main abc123\nrefs/tags/v1 def456");
    const remoteManifestSpy = spyOn(
      runtime as unknown as RuntimeWithResolveRemoteSyncRefManifest,
      "resolveRemoteSyncRefManifest"
    ).mockResolvedValue("refs/heads/main abc123\nrefs/tags/v1 def456");

    try {
      expect(
        await getShouldReuseCurrentBundleTrunk().call(runtime, "/projects/demo", "main", initLogger)
      ).toBe(true);
      expect(execFileAsyncSpy).toHaveBeenCalledWith("git", [
        "-C",
        "/projects/demo",
        "rev-parse",
        "--verify",
        "main",
      ]);
      expect(execBufferedSpy).toHaveBeenCalledWith(
        runtime,
        expect.stringContaining("refs/mux-bundle/main"),
        expect.objectContaining({ cwd: "/tmp", timeout: 10 })
      );
      expect(localManifestSpy).toHaveBeenCalledWith("/projects/demo");
      expect(remoteManifestSpy).toHaveBeenCalledWith(
        JSON.stringify(computeBaseRepoPath("/home/user/src", "/projects/demo")),
        undefined
      );
      expect(initMessages.some((message) => message.includes("skipping sync"))).toBe(true);
    } finally {
      localManifestSpy.mockRestore();
      remoteManifestSpy.mockRestore();
    }
  });

  it("uploads snapshot bundles through a per-attempt temp path", async () => {
    const projectPath = "/projects/demo";
    const snapshotDigest = "abc123";
    const layout = buildRemoteProjectLayout("/home/user/src", projectPath);
    const baseRepoPathArg = JSON.stringify(layout.baseRepoPath);
    const bundleUuid = "11111111-1111-1111-1111-111111111111";
    const bundleFileName = `${snapshotDigest}.${bundleUuid}.bundle`;
    const expectedRemoteBundlePath = path.posix.join(
      "~/.mux-bundles",
      layout.projectId,
      bundleFileName
    );
    const snapshotMarkerPath = getSnapshotMarkerPath(layout, snapshotDigest);
    const currentSnapshotPath = path.posix.join(layout.snapshotMarkerDir, "current");
    const writeFileCalls: string[] = [];
    const randomUuidSpy = spyOn(crypto, "randomUUID").mockReturnValue(bundleUuid);
    const ensureBaseRepoSpy = spyOn(
      runtime as unknown as RuntimeWithEnsureBaseRepo,
      "ensureBaseRepo"
    ).mockResolvedValue(baseRepoPathArg);
    const computeSnapshotDigestSpy = spyOn(
      runtime as unknown as RuntimeWithComputeSnapshotDigest,
      "computeSnapshotDigest"
    ).mockResolvedValue(snapshotDigest);
    const transferBundleSpy = spyOn(
      runtime as unknown as RuntimeWithTransferBundleToRemote,
      "transferBundleToRemote"
    ).mockResolvedValue(expectedRemoteBundlePath);
    const refreshBaseRepoOriginSpy = spyOn(
      runtime as unknown as RuntimeWithRefreshBaseRepoOrigin,
      "refreshBaseRepoOrigin"
    ).mockResolvedValue(undefined);
    const writeFileSpy = spyOn(runtime, "writeFile").mockImplementation((filePath: string) => {
      writeFileCalls.push(filePath);
      return new WritableStream<Uint8Array>({
        write() {
          return Promise.resolve();
        },
        close() {
          return Promise.resolve();
        },
      });
    });
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      (_runtime, command) => {
        if (command.includes('current_snapshot=""')) {
          return Promise.resolve({ stdout: "missing\n", stderr: "", exitCode: 0, duration: 0 });
        }
        if (command.startsWith("mkdir -p ")) {
          expect(command).toContain(layout.projectId);
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, duration: 0 });
        }
        if (command.includes(" fetch ")) {
          expect(command).toContain("fetch --prune --prune-tags");
          expect(command).toContain(bundleFileName);
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, duration: 0 });
        }
        if (command.startsWith("rm -f ")) {
          expect(command).toContain(bundleFileName);
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, duration: 0 });
        }
        throw new Error(`Unexpected execBuffered command: ${command}`);
      }
    );

    try {
      await (runtime as unknown as RuntimeWithSyncProjectToRemote).syncProjectToRemote(
        projectPath,
        "/unused/workspace",
        initLogger
      );

      expect(transferBundleSpy).toHaveBeenCalledWith(
        projectPath,
        expectedRemoteBundlePath,
        initLogger,
        expect.any(AbortSignal)
      );
      expect(refreshBaseRepoOriginSpy).toHaveBeenCalledWith(
        projectPath,
        baseRepoPathArg,
        initLogger,
        expect.any(AbortSignal)
      );
      expect(writeFileCalls).toEqual([snapshotMarkerPath, currentSnapshotPath]);
    } finally {
      randomUuidSpy.mockRestore();
      ensureBaseRepoSpy.mockRestore();
      computeSnapshotDigestSpy.mockRestore();
      transferBundleSpy.mockRestore();
      refreshBaseRepoOriginSpy.mockRestore();
      writeFileSpy.mockRestore();
      projectSyncCoordinator.clearAll();
    }
  });

  it("does not reuse the shared bundle when the remote trunk ref is stale", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockReturnValue(
      createMockExecResult(Promise.resolve({ stdout: "abc123\n", stderr: "" }))
    );
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "def456\n",
      stderr: "",
      exitCode: 0,
      duration: 0,
    });

    expect(
      await getShouldReuseCurrentBundleTrunk().call(runtime, "/projects/demo", "main", initLogger)
    ).toBe(false);
    expect(initMessages).toHaveLength(0);
  });

  it("does not reuse the shared bundle when non-trunk refs drift", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockReturnValue(
      createMockExecResult(Promise.resolve({ stdout: "abc123\n", stderr: "" }))
    );
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "abc123\n",
      stderr: "",
      exitCode: 0,
      duration: 0,
    });
    const localManifestSpy = spyOn(
      runtime as unknown as RuntimeWithResolveLocalSyncRefManifest,
      "resolveLocalSyncRefManifest"
    ).mockResolvedValue("refs/heads/main abc123\nrefs/tags/v2 fedcba");
    const remoteManifestSpy = spyOn(
      runtime as unknown as RuntimeWithResolveRemoteSyncRefManifest,
      "resolveRemoteSyncRefManifest"
    ).mockResolvedValue("refs/heads/main abc123\nrefs/tags/v1 def456");

    try {
      expect(
        await getShouldReuseCurrentBundleTrunk().call(runtime, "/projects/demo", "main", initLogger)
      ).toBe(false);
      expect(initMessages).toHaveLength(0);
    } finally {
      localManifestSpy.mockRestore();
      remoteManifestSpy.mockRestore();
    }
  });

  it("falls back to sync when the remote bundle probe throws", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockReturnValue(
      createMockExecResult(Promise.resolve({ stdout: "abc123\n", stderr: "" }))
    );
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(() => {
      throw new Error("ssh unavailable");
    });

    expect(
      await getShouldReuseCurrentBundleTrunk().call(runtime, "/projects/demo", "main", initLogger)
    ).toBe(false);
    expect(initMessages).toHaveLength(0);
  });

  it("does not reuse the shared bundle when the local trunk ref is missing", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockReturnValue(
      createMockExecResult(Promise.reject(new Error("unknown revision")))
    );
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "abc123\n",
      stderr: "",
      exitCode: 0,
      duration: 0,
    });

    expect(
      await getShouldReuseCurrentBundleTrunk().call(runtime, "/projects/demo", "main", initLogger)
    ).toBe(false);
    expect(execBufferedSpy).not.toHaveBeenCalled();
  });
});

describe("SSHRuntime.prepareWorkspaceCheckout", () => {
  interface RuntimeWithPrepareWorkspaceCheckout {
    prepareWorkspaceCheckout: (
      params: {
        projectPath: string;
        branchName: string;
        trunkBranch: string;
        workspacePath: string;
        initLogger: {
          logStep: (message: string) => void;
          logStdout: (line: string) => void;
          logStderr: (line: string) => void;
          logComplete: (exitCode: number) => void;
        };
        abortSignal?: AbortSignal;
        env?: Record<string, string>;
        trusted?: boolean;
      },
      nhp: string
    ) => Promise<void>;
  }

  interface RuntimeWithShouldReuseCurrentBundleTrunk {
    shouldReuseCurrentBundleTrunk: (
      projectPath: string,
      trunkBranch: string,
      initLogger: {
        logStep: (message: string) => void;
        logStdout: (line: string) => void;
        logStderr: (line: string) => void;
        logComplete: (exitCode: number) => void;
      },
      abortSignal?: AbortSignal
    ) => Promise<boolean>;
  }

  interface RuntimeWithFetchOriginTrunk {
    fetchOriginTrunk: (
      workspacePath: string,
      trunkBranch: string,
      initLogger: {
        logStep: (message: string) => void;
        logStdout: (line: string) => void;
        logStderr: (line: string) => void;
        logComplete: (exitCode: number) => void;
      },
      abortSignal?: AbortSignal,
      nhp?: string
    ) => Promise<boolean>;
  }

  interface RuntimeWithResolveBundleTrunkRef {
    resolveBundleTrunkRef: (
      baseRepoPathArg: string,
      trunkBranch: string,
      abortSignal?: AbortSignal
    ) => Promise<string | null>;
  }

  interface RuntimeWithEnsureBaseRepo {
    ensureBaseRepo: (
      projectPath: string,
      initLogger: {
        logStep: (message: string) => void;
        logStdout: (line: string) => void;
        logStderr: (line: string) => void;
        logComplete: (exitCode: number) => void;
      },
      abortSignal?: AbortSignal
    ) => Promise<string>;
  }

  interface RuntimeWithGetOriginUrlForSync {
    getOriginUrlForSync: (
      projectPath: string,
      initLogger: {
        logStep: (message: string) => void;
        logStdout: (line: string) => void;
        logStderr: (line: string) => void;
        logComplete: (exitCode: number) => void;
      }
    ) => Promise<{ originUrl: string | null }>;
  }

  interface RuntimeWithCanFastForwardToOrigin {
    canFastForwardToOrigin: (
      workspacePath: string,
      localRef: string,
      originBranch: string,
      initLogger: {
        logStep: (message: string) => void;
        logStdout: (line: string) => void;
        logStderr: (line: string) => void;
        logComplete: (exitCode: number) => void;
      },
      abortSignal?: AbortSignal
    ) => Promise<boolean>;
  }

  interface RuntimeWithSyncProjectToRemote {
    syncProjectToRemote: (
      projectPath: string,
      workspacePath: string,
      initLogger: {
        logStep: (message: string) => void;
        logStdout: (line: string) => void;
        logStderr: (line: string) => void;
        logComplete: (exitCode: number) => void;
      },
      abortSignal?: AbortSignal
    ) => Promise<void>;
  }

  it("still creates a worktree when bundle sync is skipped for a new workspace", async () => {
    const config = { host: "example.com", srcBaseDir: "/home/user/src" };
    const runtime = new SSHRuntime(config, createSSHTransport(config, false));
    const initMessages: string[] = [];
    const initLogger = {
      logStep: (message: string) => {
        initMessages.push(message);
      },
      logStdout: () => undefined,
      logStderr: () => undefined,
      logComplete: () => undefined,
    };

    const execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      (_runtime, command) => {
        if (command === "test -d /home/user/src/demo/review-slot") {
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 1, duration: 0 });
        }
        if (
          command.includes("remote set-url origin") ||
          command.includes("remote add origin") ||
          command.includes('worktree add "/home/user/src/demo/review-slot"')
        ) {
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, duration: 0 });
        }
        throw new Error(`Unexpected execBuffered command: ${command}`);
      }
    );
    const reuseSpy = spyOn(
      runtime as unknown as RuntimeWithShouldReuseCurrentBundleTrunk,
      "shouldReuseCurrentBundleTrunk"
    ).mockResolvedValue(true);
    const fetchOriginSpy = spyOn(
      runtime as unknown as RuntimeWithFetchOriginTrunk,
      "fetchOriginTrunk"
    ).mockResolvedValue(false);
    const resolveBundleSpy = spyOn(
      runtime as unknown as RuntimeWithResolveBundleTrunkRef,
      "resolveBundleTrunkRef"
    ).mockResolvedValue("refs/mux-bundle/main");
    const ensureBaseRepoSpy = spyOn(
      runtime as unknown as RuntimeWithEnsureBaseRepo,
      "ensureBaseRepo"
    ).mockResolvedValue('"/home/user/src/demo/.mux-base.git"');
    const getOriginUrlSpy = spyOn(
      runtime as unknown as RuntimeWithGetOriginUrlForSync,
      "getOriginUrlForSync"
    ).mockResolvedValue({ originUrl: "git@github.com:coder/mux.git" });
    const canFastForwardSpy = spyOn(
      runtime as unknown as RuntimeWithCanFastForwardToOrigin,
      "canFastForwardToOrigin"
    ).mockResolvedValue(false);
    const syncProjectSpy = spyOn(
      runtime as unknown as RuntimeWithSyncProjectToRemote,
      "syncProjectToRemote"
    ).mockResolvedValue(undefined);
    const syncSubmodulesSpy = spyOn(submoduleSync, "syncRuntimeGitSubmodules").mockResolvedValue(
      undefined
    );

    try {
      await (runtime as unknown as RuntimeWithPrepareWorkspaceCheckout).prepareWorkspaceCheckout(
        {
          projectPath: "/projects/demo",
          branchName: "review-slot",
          trunkBranch: "main",
          workspacePath: "/home/user/src/demo/review-slot",
          initLogger,
          env: {},
          trusted: true,
        },
        ""
      );

      expect(reuseSpy).toHaveBeenCalled();
      expect(syncProjectSpy).not.toHaveBeenCalled();
      expect(ensureBaseRepoSpy).toHaveBeenCalledWith("/projects/demo", initLogger, undefined);
      expect(fetchOriginSpy).toHaveBeenCalled();
      expect(resolveBundleSpy).toHaveBeenCalled();
      expect(getOriginUrlSpy).toHaveBeenCalledWith("/projects/demo", initLogger);
      expect(canFastForwardSpy).not.toHaveBeenCalled();
      expect(execBufferedSpy).toHaveBeenCalledWith(
        runtime,
        expect.stringContaining("remote set-url origin 'git@github.com:coder/mux.git'"),
        expect.objectContaining({ cwd: "/tmp", timeout: 10 })
      );
      expect(execBufferedSpy).toHaveBeenCalledWith(
        runtime,
        expect.stringContaining(
          "worktree add \"/home/user/src/demo/review-slot\" -B 'review-slot' 'refs/mux-bundle/main'"
        ),
        expect.objectContaining({ cwd: "/tmp", timeout: 300 })
      );
      expect(syncSubmodulesSpy).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: "/home/user/src/demo/review-slot" })
      );
      expect(initMessages).toContain("Worktree created successfully");
    } finally {
      execBufferedSpy.mockRestore();
      reuseSpy.mockRestore();
      fetchOriginSpy.mockRestore();
      resolveBundleSpy.mockRestore();
      ensureBaseRepoSpy.mockRestore();
      getOriginUrlSpy.mockRestore();
      canFastForwardSpy.mockRestore();
      syncProjectSpy.mockRestore();
      syncSubmodulesSpy.mockRestore();
    }
  });
});

describe("SSHRuntime.createWorkspace", () => {
  function createExecStream(exitCode = 0) {
    return {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stdin: new WritableStream<Uint8Array>(),
      exitCode: Promise.resolve(exitCode),
      duration: Promise.resolve(0),
    };
  }

  it("uses directoryName for the workspace path while preparing the remote parent directory", async () => {
    const config = { host: "example.com", srcBaseDir: "/home/user/src" };
    const runtime = new SSHRuntime(config, createSSHTransport(config, false));
    const expectedLayout = buildRemoteProjectLayout(config.srcBaseDir, "/projects/demo");
    const expectedWorkspacePath = getRemoteWorkspacePath(expectedLayout, "review-slot");
    const execSpy = spyOn(runtime, "exec").mockImplementation(() =>
      Promise.resolve(createExecStream())
    );
    const readFileSpy = spyOn(runtime, "readFile").mockImplementation(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("missing branch metadata"));
          },
        })
    );
    const writeFileSpy = spyOn(runtime, "writeFile").mockImplementation(
      () => new WritableStream<Uint8Array>()
    );

    try {
      const result = await runtime.createWorkspace({
        projectPath: "/projects/demo",
        branchName: "feature-branch",
        directoryName: "review-slot",
        trunkBranch: "main",
        initLogger: {
          logStep: () => undefined,
          logStdout: () => undefined,
          logStderr: () => undefined,
          logComplete: () => undefined,
        },
      });

      expect(result).toEqual({
        success: true,
        workspacePath: expectedWorkspacePath,
      });
      expect(execSpy).toHaveBeenCalledWith(
        `mkdir -p ${JSON.stringify(expectedLayout.projectRoot)}`,
        {
          cwd: "/tmp",
          timeout: 10,
          abortSignal: undefined,
        }
      );
    } finally {
      execSpy.mockRestore();
      readFileSpy.mockRestore();
      writeFileSpy.mockRestore();
    }
  });
});

describe("SSHRuntime.deleteWorkspace", () => {
  function createExecStream(exitCode: number) {
    return {
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
      stdin: new WritableStream<Uint8Array>(),
      exitCode: Promise.resolve(exitCode),
      duration: Promise.resolve(0),
    };
  }

  it("deletes the mapped workspace branch instead of the current remote checkout", async () => {
    const config = { host: "example.com", srcBaseDir: "/home/user/src" };
    const runtime = new SSHRuntime(config, createSSHTransport(config, false));
    const expectedLayout = buildRemoteProjectLayout(config.srcBaseDir, "/projects/demo");
    const expectedDeletedPath = getRemoteWorkspacePath(expectedLayout, "review-slot");
    const execSpy = spyOn(runtime, "exec").mockImplementation((command) => {
      if (command.includes("git diff --quiet") || command.includes("test -d")) {
        return Promise.resolve(createExecStream(0));
      }
      if (command.includes("worktree remove")) {
        return Promise.resolve(createExecStream(0));
      }
      throw new Error(`Unexpected exec command: ${command}`);
    });
    const readFileSpy = spyOn(runtime, "readFile").mockImplementation(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"review-slot":"feature-branch"}\n'));
            controller.close();
          },
        })
    );
    const execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      (_runtime, command) => {
        if (command.startsWith("test -f ")) {
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, duration: 0 });
        }
        if (command.startsWith("rm -f ")) {
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, duration: 0 });
        }
        if (command.includes(" branch -D ")) {
          expect(command).toContain("feature-branch");
          expect(command).not.toContain("review-slot");
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, duration: 0 });
        }
        throw new Error(`Unexpected execBuffered command: ${command}`);
      }
    );

    try {
      const result = await runtime.deleteWorkspace("/projects/demo", "review-slot", true);
      expect(result).toEqual({
        success: true,
        deletedPath: expectedDeletedPath,
      });
    } finally {
      execSpy.mockRestore();
      readFileSpy.mockRestore();
      execBufferedSpy.mockRestore();
    }
  });
});
describe("SSHRuntime branch metadata compatibility", () => {
  it("keeps the legacy branch manifest in sync when renaming a legacy workspace", async () => {
    type UpdateWorkspaceBranchMapping = (
      projectPath: string,
      oldWorkspaceName: string,
      newWorkspaceName: string
    ) => Promise<void>;

    const config = { host: "example.com", srcBaseDir: "/home/user/src" };
    const projectPath = "/projects/demo";
    const oldWorkspaceName = "review-slot";
    const newWorkspaceName = "renamed-slot";
    const legacyLayout = buildLegacyRemoteProjectLayout(config.srcBaseDir, projectPath);
    const legacyManifestPath = path.posix.join(
      legacyLayout.projectRoot,
      ".mux-workspace-branches.json"
    );
    const runtime = new SSHRuntime(config, createSSHTransport(config, false), {
      projectPath,
      workspaceName: oldWorkspaceName,
      workspacePath: getRemoteWorkspacePath(legacyLayout, oldWorkspaceName),
    });
    const files = new Map<string, string>([
      [legacyManifestPath, '{"review-slot":"feature-branch"}\n'],
    ]);
    const readFileSpy = spyOn(runtime, "readFile").mockImplementation((filePath: string) => {
      const contents = files.get(filePath);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (contents === undefined) {
            controller.error(new Error(`Missing file: ${filePath}`));
            return;
          }
          controller.enqueue(new TextEncoder().encode(contents));
          controller.close();
        },
      });
    });
    const writeFileSpy = spyOn(runtime, "writeFile").mockImplementation((filePath: string) => {
      const decoder = new TextDecoder();
      let contents = "";
      return new WritableStream<Uint8Array>({
        write(chunk) {
          contents += decoder.decode(chunk, { stream: true });
        },
        close() {
          contents += decoder.decode();
          files.set(filePath, contents);
        },
      });
    });
    const execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      (_runtime, command) => {
        if (command.startsWith("mkdir -p ") || command.startsWith("rm -f ")) {
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, duration: 0 });
        }
        throw new Error(`Unexpected execBuffered command: ${command}`);
      }
    );

    try {
      const updateWorkspaceBranchMapping = Reflect.get(
        runtime,
        "updateWorkspaceBranchMapping"
      ) as UpdateWorkspaceBranchMapping;
      await updateWorkspaceBranchMapping.call(
        runtime,
        projectPath,
        oldWorkspaceName,
        newWorkspaceName
      );

      expect(JSON.parse(files.get(legacyManifestPath) ?? "null")).toEqual({
        [newWorkspaceName]: "feature-branch",
      });
    } finally {
      readFileSpy.mockRestore();
      writeFileSpy.mockRestore();
      execBufferedSpy.mockRestore();
      projectSyncCoordinator.clearAll();
    }
  });
  it("removes stale legacy branch manifest entries even when layout detection falls back to preferred", async () => {
    type DeletePersistedWorkspaceBranchMapping = (
      projectPath: string,
      workspaceName: string
    ) => Promise<void>;

    const config = { host: "example.com", srcBaseDir: "/home/user/src" };
    const projectPath = "/projects/demo";
    const workspaceName = "review-slot";
    const legacyManifestPath = path.posix.join(
      buildLegacyRemoteProjectLayout(config.srcBaseDir, projectPath).projectRoot,
      ".mux-workspace-branches.json"
    );
    const runtime = new SSHRuntime(config, createSSHTransport(config, false));
    const files = new Map<string, string>([
      [legacyManifestPath, '{"review-slot":"feature-branch"}\n'],
    ]);
    const readFileSpy = spyOn(runtime, "readFile").mockImplementation((filePath: string) => {
      const contents = files.get(filePath);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (contents === undefined) {
            controller.error(new Error(`Missing file: ${filePath}`));
            return;
          }
          controller.enqueue(new TextEncoder().encode(contents));
          controller.close();
        },
      });
    });
    const execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      (_runtime, command) => {
        if (command.includes("echo legacy") && command.includes("echo preferred")) {
          return Promise.resolve({ stdout: "preferred\n", stderr: "", exitCode: 0, duration: 0 });
        }
        if (command.startsWith("rm -f ")) {
          const pathMatch = /^rm -f\s+(.+)$/.exec(command);
          if (pathMatch?.[1]) {
            files.delete(pathMatch[1].replace(/^"|"$/g, ""));
          }
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, duration: 0 });
        }
        throw new Error(`Unexpected execBuffered command: ${command}`);
      }
    );

    try {
      const deletePersistedWorkspaceBranchMapping = Reflect.get(
        runtime,
        "deletePersistedWorkspaceBranchMapping"
      ) as DeletePersistedWorkspaceBranchMapping;
      await deletePersistedWorkspaceBranchMapping.call(runtime, projectPath, workspaceName);

      expect(files.has(legacyManifestPath)).toBe(false);
    } finally {
      readFileSpy.mockRestore();
      execBufferedSpy.mockRestore();
      projectSyncCoordinator.clearAll();
    }
  });
});

describe("SSHRuntime.ensureReady repository checks", () => {
  let execBufferedSpy: ReturnType<typeof spyOn<typeof runtimeHelpers, "execBuffered">> | null =
    null;
  let runtime: SSHRuntime;

  beforeEach(() => {
    const config = { host: "example.com", srcBaseDir: "/home/user/src" };
    runtime = new SSHRuntime(config, createSSHTransport(config, false), {
      projectPath: "/project",
      workspaceName: "ws",
    });
  });

  afterEach(() => {
    execBufferedSpy?.mockRestore();
    execBufferedSpy = null;
  });

  it("accepts worktrees where .git is a file", async () => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered")
      .mockResolvedValueOnce({ stdout: "preferred\n", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({ stdout: ".git\n", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({ stdout: "true\n", stderr: "", exitCode: 0, duration: 0 });

    const result = await runtime.ensureReady();

    expect(execBufferedSpy).toHaveBeenCalledTimes(4);
    const secondCommand = execBufferedSpy?.mock.calls[1]?.[1];
    expect(secondCommand).toContain("test -d");
    expect(secondCommand).toContain("test -f");
    const fourthCommand = execBufferedSpy?.mock.calls[3]?.[1];
    expect(fourthCommand).toContain("rev-parse --is-inside-work-tree");
    expect(result).toEqual({ ready: true });
  });

  it("returns runtime_not_ready when git reports the workspace is not inside a work tree", async () => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered")
      .mockResolvedValueOnce({ stdout: "preferred\n", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({ stdout: ".git\n", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({ stdout: "false\n", stderr: "", exitCode: 0, duration: 0 });

    const result = await runtime.ensureReady();

    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.errorType).toBe("runtime_not_ready");
    }
  });

  it("returns runtime_not_ready when the repo is missing", async () => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered")
      .mockResolvedValueOnce({ stdout: "preferred\n", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 1,
        duration: 0,
      });

    const result = await runtime.ensureReady();

    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.errorType).toBe("runtime_not_ready");
    }
  });

  it("returns runtime_start_failed when git is unavailable", async () => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered")
      .mockResolvedValueOnce({ stdout: "preferred\n", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "command not found",
        exitCode: 127,
        duration: 0,
      });

    const result = await runtime.ensureReady();

    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.errorType).toBe("runtime_start_failed");
    }
  });
});

describe("SSHRuntime.resolvePath", () => {
  let runtime: SSHRuntime;
  let transport: ReturnType<typeof createSSHTransport>;
  let acquireConnectionSpy: ReturnType<typeof spyOn<typeof transport, "acquireConnection">> | null =
    null;
  let execBufferedSpy: ReturnType<typeof spyOn<typeof runtimeHelpers, "execBuffered">> | null =
    null;

  beforeEach(() => {
    const config = { host: "example.com", srcBaseDir: "/home/user/src" };
    transport = createSSHTransport(config, false);
    runtime = new SSHRuntime(config, transport, {
      projectPath: "/project",
      workspaceName: "ws",
    });
  });

  afterEach(() => {
    acquireConnectionSpy?.mockRestore();
    acquireConnectionSpy = null;
    execBufferedSpy?.mockRestore();
    execBufferedSpy = null;
  });

  it("passes a 10s timeout and max wait to preflight acquireConnection", async () => {
    acquireConnectionSpy = spyOn(transport, "acquireConnection").mockResolvedValue(undefined);
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "/home/user/foo\n",
      stderr: "",
      exitCode: 0,
      duration: 0,
    });

    expect(await runtime.resolvePath("~/foo")).toBe("/home/user/foo");
    expect(acquireConnectionSpy).toHaveBeenCalledWith({
      timeoutMs: 10_000,
      maxWaitMs: 10_000,
    });
  });
});
describe("SSHRuntime project sync coordination", () => {
  it("uses srcBaseDir in the per-project sync key", () => {
    const projectId = "demo-project-123456789abc";
    const configA = { host: "example.com", srcBaseDir: "/home/user/src-a" };
    const configB = { host: "example.com", srcBaseDir: "/home/user/src-b" };
    const runtimeA = new SSHRuntime(configA, createSSHTransport(configA, false));
    const runtimeB = new SSHRuntime(configB, createSSHTransport(configB, false));

    const getProjectSyncKey = (runtime: SSHRuntime): ((projectIdArg: string) => string) => {
      const maybeMethod: unknown = Reflect.get(runtime, "getProjectSyncKey");
      if (typeof maybeMethod !== "function") {
        throw new Error("getProjectSyncKey is unavailable");
      }
      return maybeMethod as (projectIdArg: string) => string;
    };

    expect(getProjectSyncKey(runtimeA).call(runtimeA, projectId)).not.toBe(
      getProjectSyncKey(runtimeB).call(runtimeB, projectId)
    );
  });
});

describe("SSHRuntime layout detection", () => {
  let execBufferedSpy: ReturnType<typeof spyOn<typeof runtimeHelpers, "execBuffered">> | null =
    null;

  afterEach(() => {
    execBufferedSpy?.mockRestore();
    execBufferedSpy = null;
  });

  it("does not treat legacy root existence alone as evidence of a legacy layout", async () => {
    const config = { host: "example.com", srcBaseDir: "/home/user/src" };
    const projectPath = "/projects/demo";
    const workspaceName = "fresh-workspace";
    const runtime = new SSHRuntime(config, createSSHTransport(config, false));
    const preferredLayout = buildRemoteProjectLayout(config.srcBaseDir, projectPath);
    const legacyLayout = buildLegacyRemoteProjectLayout(config.srcBaseDir, projectPath);

    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "preferred\n",
      stderr: "",
      exitCode: 0,
      duration: 0,
    });

    const resolveProjectLayout = Reflect.get(runtime, "resolveProjectLayout") as (
      projectPathArg: string,
      workspaceNameArg?: string
    ) => Promise<{ projectRoot: string }>;
    const layout = await resolveProjectLayout.call(runtime, projectPath, workspaceName);

    expect(layout.projectRoot).toBe(preferredLayout.projectRoot);
    const detectionCommand = execBufferedSpy.mock.calls[0]?.[1];
    expect(detectionCommand).toContain(`test -e "${legacyLayout.projectRoot}/${workspaceName}"`);
    expect(detectionCommand).not.toContain(`test -d "${legacyLayout.projectRoot}"`);
  });
  it("reuses a cached legacy layout for fresh runtimes without workspacePath hints", () => {
    const config = { host: "example.com", srcBaseDir: "/home/user/src" };
    const projectPath = "/projects/cached-legacy-demo";
    const workspaceName = "legacy-slot";
    const legacyLayout = buildLegacyRemoteProjectLayout(config.srcBaseDir, projectPath);
    const legacyWorkspacePath = getRemoteWorkspacePath(legacyLayout, workspaceName);

    new SSHRuntime(config, createSSHTransport(config, false), {
      projectPath,
      workspaceName,
      workspacePath: legacyWorkspacePath,
    });

    const freshRuntime = new SSHRuntime(config, createSSHTransport(config, false));

    expect(freshRuntime.getWorkspacePath(projectPath, workspaceName)).toBe(legacyWorkspacePath);
  });
});

describe("computeBaseRepoPath", () => {
  it("computes the correct bare repo path", () => {
    const layout = buildRemoteProjectLayout("~/mux", "/Users/me/code/my-project");
    const result = computeBaseRepoPath("~/mux", "/Users/me/code/my-project");
    expect(result).toBe(layout.baseRepoPath);
    expect(result).toMatch(/^~\/mux\/my-project-[a-f0-9]{12}\/\.mux-base\.git$/);
  });

  it("handles absolute srcBaseDir", () => {
    const layout = buildRemoteProjectLayout("/home/user/src", "/code/repo");
    const result = computeBaseRepoPath("/home/user/src", "/code/repo");
    expect(result).toBe(layout.baseRepoPath);
    expect(result).toMatch(/^\/home\/user\/src\/repo-[a-f0-9]{12}\/\.mux-base\.git$/);
  });
});
