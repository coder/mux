import { describe, expect, it, mock, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import type { CoderService } from "@/node/services/coderService";
import type { RuntimeConfig } from "@/common/types/runtime";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};
import type { RuntimeStatusEvent } from "./Runtime";

import { CoderSSHRuntime, type CoderSSHRuntimeConfig } from "./CoderSSHRuntime";
import { SSHRuntime } from "./SSHRuntime";
import { createSSHTransport } from "./transports";

/**
 * Create a minimal mock CoderService for testing.
 * Only mocks methods used by the tested code paths.
 */
function createMockCoderService(overrides?: Partial<CoderService>): CoderService {
  const provisioningSession = {
    token: "token",
    dispose: mock(() => Promise.resolve()),
  };

  return {
    createWorkspace: mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        // default: no output
        for (const line of [] as string[]) {
          yield line;
        }
      })()
    ),
    deleteWorkspace: mock(() => Promise.resolve()),
    ensureProvisioningSession: mock(() => Promise.resolve(provisioningSession)),
    takeProvisioningSession: mock(() => provisioningSession),
    disposeProvisioningSession: mock(() => Promise.resolve()),
    fetchDeploymentSshConfig: mock(() => Promise.resolve({ hostnameSuffix: "coder" })),
    ensureSSHConfig: mock(() => Promise.resolve()),
    getWorkspaceStatus: mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "running" as const })
    ),
    listWorkspaces: mock(() => Promise.resolve([])),
    waitForStartupScripts: mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        // default: no output (startup scripts completed)
        for (const line of [] as string[]) {
          yield line;
        }
      })()
    ),
    workspaceExists: mock(() => Promise.resolve(false)),
    ...overrides,
  } as unknown as CoderService;
}

/**
 * Create a CoderSSHRuntime with minimal config for testing.
 */
function createRuntime(
  coderConfig: {
    existingWorkspace?: boolean;
    workspaceName?: string;
    template?: string;
  },
  coderService: CoderService
): CoderSSHRuntime {
  const template = "template" in coderConfig ? coderConfig.template : "default-template";

  const config: CoderSSHRuntimeConfig = {
    host: "placeholder.coder",
    srcBaseDir: "~/src",
    coder: {
      existingWorkspace: coderConfig.existingWorkspace ?? false,
      workspaceName: coderConfig.workspaceName,
      template,
    },
  };
  const transport = createSSHTransport(config, false);
  return new CoderSSHRuntime(config, transport, coderService);
}

/**
 * Create an SSH+Coder RuntimeConfig for finalizeConfig tests.
 */
function createSSHCoderConfig(coder: {
  existingWorkspace?: boolean;
  workspaceName?: string;
}): RuntimeConfig {
  return {
    type: "ssh",
    host: "placeholder.coder",
    srcBaseDir: "~/src",
    coder: {
      existingWorkspace: coder.existingWorkspace ?? false,
      workspaceName: coder.workspaceName,
      template: "default-template",
    },
  };
}

// =============================================================================
// Test Suite 1: finalizeConfig (name/host derivation)
// =============================================================================

describe("CoderSSHRuntime.finalizeConfig", () => {
  let coderService: CoderService;
  let runtime: CoderSSHRuntime;

  beforeEach(() => {
    coderService = createMockCoderService();
    runtime = createRuntime({}, coderService);
  });

  describe("new workspace mode", () => {
    it("uses hostname suffix from deployment SSH config", async () => {
      const fetchDeploymentSshConfig = mock(() => Promise.resolve({ hostnameSuffix: "corp" }));
      coderService = createMockCoderService({ fetchDeploymentSshConfig });
      runtime = createRuntime({}, coderService);

      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("my-feature", config);

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "ssh") {
        expect(result.data.host).toBe("mux-my-feature.corp");
      }
      expect(fetchDeploymentSshConfig).toHaveBeenCalled();
    });
    it("derives Coder name from branch name when not provided", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("my-feature", config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("ssh");
        if (result.data.type === "ssh") {
          expect(result.data.coder?.workspaceName).toBe("mux-my-feature");
          expect(result.data.host).toBe("mux-my-feature.coder");
        }
      }
    });

    it("converts underscores to hyphens", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("my_feature_branch", config);

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "ssh") {
        expect(result.data.coder?.workspaceName).toBe("mux-my-feature-branch");
        expect(result.data.host).toBe("mux-my-feature-branch.coder");
      }
    });

    it("collapses multiple hyphens and trims leading/trailing", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("--my--feature--", config);

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "ssh") {
        expect(result.data.coder?.workspaceName).toBe("mux-my-feature");
      }
    });

    it("rejects names that fail regex after conversion", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      // Name with special chars that can't form a valid Coder name (only hyphens/underscores become invalid)
      const result = await runtime.finalizeConfig("@#$%", config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("cannot be converted to a valid Coder name");
      }
    });

    it("returns error when deployment SSH config fetch fails", async () => {
      const provisioningSession = {
        token: "token",
        dispose: mock(() => Promise.resolve()),
      };
      const ensureProvisioningSession = mock(() => Promise.resolve(provisioningSession));
      const fetchDeploymentSshConfig = mock(() => Promise.reject(new Error("nope")));
      const disposeProvisioningSession = mock(() => Promise.resolve());

      coderService = createMockCoderService({
        ensureProvisioningSession,
        fetchDeploymentSshConfig,
        disposeProvisioningSession,
      });
      runtime = createRuntime({}, coderService);

      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("branch", config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Failed to read Coder deployment SSH config");
        expect(result.error).toContain("nope");
      }
      expect(ensureProvisioningSession).toHaveBeenCalledWith("mux-branch");
      expect(fetchDeploymentSshConfig).toHaveBeenCalledWith(provisioningSession);
      expect(disposeProvisioningSession).toHaveBeenCalledWith("mux-branch");
    });
    it("uses provided workspaceName over branch name", async () => {
      const config = createSSHCoderConfig({
        existingWorkspace: false,
        workspaceName: "custom-name",
      });
      const result = await runtime.finalizeConfig("branch-name", config);

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "ssh") {
        expect(result.data.coder?.workspaceName).toBe("custom-name");
        expect(result.data.host).toBe("custom-name.coder");
      }
    });
  });

  describe("existing workspace mode", () => {
    it("requires workspaceName to be provided", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: true });
      const result = await runtime.finalizeConfig("branch-name", config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("required for existing workspaces");
      }
    });

    it("keeps provided workspaceName and sets host", async () => {
      const config = createSSHCoderConfig({
        existingWorkspace: true,
        workspaceName: "existing-ws",
      });
      const result = await runtime.finalizeConfig("branch-name", config);

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "ssh") {
        expect(result.data.coder?.workspaceName).toBe("existing-ws");
        expect(result.data.host).toBe("existing-ws.coder");
      }
    });
  });

  it("passes through non-SSH configs unchanged", async () => {
    const config: RuntimeConfig = { type: "local" };
    const result = await runtime.finalizeConfig("branch", config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(config);
    }
  });

  it("passes through SSH configs without coder unchanged", async () => {
    const config: RuntimeConfig = { type: "ssh", host: "example.com", srcBaseDir: "/src" };
    const result = await runtime.finalizeConfig("branch", config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(config);
    }
  });
});

// =============================================================================
// Test Suite 2: deleteWorkspace behavior
// =============================================================================

describe("CoderSSHRuntime.deleteWorkspace", () => {
  /**
   * For deleteWorkspace tests, we mock SSHRuntime.prototype.deleteWorkspace
   * to control the parent class behavior.
   */
  let sshDeleteSpy: Mock<typeof SSHRuntime.prototype.deleteWorkspace>;

  beforeEach(() => {
    sshDeleteSpy = spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
      success: true,
      deletedPath: "/path",
    });
  });

  afterEach(() => {
    sshDeleteSpy.mockRestore();
  });

  it("never calls coderService.deleteWorkspace when existingWorkspace=true", async () => {
    const deleteWorkspace = mock(() => Promise.resolve());
    const coderService = createMockCoderService({ deleteWorkspace });

    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "existing-ws" },
      coderService
    );

    await runtime.deleteWorkspace("/project", "ws", false);
    expect(deleteWorkspace).not.toHaveBeenCalled();
  });

  it("skips Coder deletion when workspaceName is not set", async () => {
    const deleteWorkspace = mock(() => Promise.resolve());
    const coderService = createMockCoderService({ deleteWorkspace });

    // No workspaceName provided
    const runtime = createRuntime({ existingWorkspace: false }, coderService);

    const result = await runtime.deleteWorkspace("/project", "ws", false);
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("skips Coder deletion when SSH delete fails and force=false", async () => {
    sshDeleteSpy.mockResolvedValue({ success: false, error: "dirty workspace" });

    const deleteWorkspace = mock(() => Promise.resolve());
    const coderService = createMockCoderService({ deleteWorkspace });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    const result = await runtime.deleteWorkspace("/project", "ws", false);
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("calls Coder deletion when SSH delete fails but force=true", async () => {
    sshDeleteSpy.mockResolvedValue({ success: false, error: "dirty workspace" });

    const deleteWorkspace = mock(() => Promise.resolve());
    const coderService = createMockCoderService({ deleteWorkspace });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    await runtime.deleteWorkspace("/project", "ws", true);
    expect(deleteWorkspace).toHaveBeenCalledWith("my-ws");
  });

  it("returns combined error when SSH succeeds but Coder delete throws", async () => {
    const deleteWorkspace = mock(() => Promise.reject(new Error("Coder API error")));
    const coderService = createMockCoderService({ deleteWorkspace });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    const result = await runtime.deleteWorkspace("/project", "ws", false);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("SSH delete succeeded");
      expect(result.error).toContain("Coder API error");
    }
  });

  it("succeeds immediately when Coder workspace is already deleted", async () => {
    // getWorkspaceStatus returns { kind: "not_found" } when workspace doesn't exist
    const getWorkspaceStatus = mock(() => Promise.resolve({ kind: "not_found" as const }));
    const deleteWorkspace = mock(() => Promise.resolve());
    const coderService = createMockCoderService({ getWorkspaceStatus, deleteWorkspace });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    const result = await runtime.deleteWorkspace("/project", "ws", false);

    // Should succeed without calling SSH delete or Coder delete
    expect(result.success).toBe(true);
    expect(sshDeleteSpy).not.toHaveBeenCalled();
    expect(deleteWorkspace).not.toHaveBeenCalled();
  });

  it("proceeds with SSH cleanup when status check fails with API error", async () => {
    // API error (auth, network) - should NOT treat as "already deleted"
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "error" as const, error: "coder timed out" })
    );
    const deleteWorkspace = mock(() => Promise.resolve());
    const coderService = createMockCoderService({ getWorkspaceStatus, deleteWorkspace });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    const result = await runtime.deleteWorkspace("/project", "ws", false);

    // Should proceed with SSH cleanup (which succeeds), then Coder delete
    expect(sshDeleteSpy).toHaveBeenCalled();
    expect(deleteWorkspace).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("succeeds immediately when Coder workspace status is 'deleting'", async () => {
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "deleting" as const })
    );
    const deleteWorkspace = mock(() => Promise.resolve());
    const coderService = createMockCoderService({ getWorkspaceStatus, deleteWorkspace });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    const result = await runtime.deleteWorkspace("/project", "ws", false);

    // Should succeed without calling SSH delete or Coder delete (workspace already dying)
    expect(result.success).toBe(true);
    expect(sshDeleteSpy).not.toHaveBeenCalled();
    expect(deleteWorkspace).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite 3: validateBeforePersist (collision detection)
// =============================================================================

describe("CoderSSHRuntime.validateBeforePersist", () => {
  it("returns error when Coder workspace already exists", async () => {
    const workspaceExists = mock(() => Promise.resolve(true));
    const coderService = createMockCoderService({ workspaceExists });
    const runtime = createRuntime({}, coderService);

    const config = createSSHCoderConfig({
      existingWorkspace: false,
      workspaceName: "my-ws",
    });

    const result = await runtime.validateBeforePersist("branch", config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("already exists");
    }
    expect(workspaceExists).toHaveBeenCalledWith("my-ws");
  });

  it("skips collision check for existingWorkspace=true", async () => {
    const workspaceExists = mock(() => Promise.resolve(true));
    const coderService = createMockCoderService({ workspaceExists });
    const runtime = createRuntime({}, coderService);

    const config = createSSHCoderConfig({
      existingWorkspace: true,
      workspaceName: "existing-ws",
    });

    const result = await runtime.validateBeforePersist("branch", config);
    expect(result.success).toBe(true);
    expect(workspaceExists).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite 4: postCreateSetup (provisioning)
// =============================================================================

describe("CoderSSHRuntime.postCreateSetup", () => {
  let execBufferedSpy: ReturnType<typeof spyOn<typeof runtimeHelpers, "execBuffered">>;

  beforeEach(() => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      duration: 0,
    });
  });

  afterEach(() => {
    execBufferedSpy.mockRestore();
  });

  it("creates a new Coder workspace and prepares the directory", async () => {
    const createWorkspace = mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        yield "build line 1";
        yield "build line 2";
      })()
    );
    const ensureSSHConfig = mock(() => Promise.resolve());
    const provisioningSession = {
      token: "token",
      dispose: mock(() => Promise.resolve()),
    };
    const takeProvisioningSession = mock(() => provisioningSession);

    // Start with workspace not found, then return running after creation
    let workspaceCreated = false;
    const getWorkspaceStatus = mock(() =>
      Promise.resolve(
        workspaceCreated
          ? { kind: "ok" as const, status: "running" as const }
          : { kind: "not_found" as const }
      )
    );

    const coderService = createMockCoderService({
      createWorkspace,
      ensureSSHConfig,
      getWorkspaceStatus,
      takeProvisioningSession,
    });
    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws", template: "my-template" },
      coderService
    );

    // Before postCreateSetup, ensureReady should fail (workspace doesn't exist on server)
    const beforeReady = await runtime.ensureReady();
    expect(beforeReady.ready).toBe(false);
    if (!beforeReady.ready) {
      expect(beforeReady.errorType).toBe("runtime_not_ready");
    }

    // Simulate workspace being created by postCreateSetup
    workspaceCreated = true;

    const steps: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const initLogger = {
      logStep: (s: string) => {
        steps.push(s);
      },
      logStdout: (s: string) => {
        stdout.push(s);
      },
      logStderr: (s: string) => {
        stderr.push(s);
      },
      logComplete: noop,
    };

    await runtime.postCreateSetup({
      initLogger,
      projectPath: "/project",
      branchName: "branch",
      trunkBranch: "main",
      workspacePath: "/home/user/src/my-project/my-ws",
    });

    expect(takeProvisioningSession).toHaveBeenCalledWith("my-ws");
    expect(createWorkspace).toHaveBeenCalledWith(
      "my-ws",
      "my-template",
      undefined,
      undefined,
      undefined,
      provisioningSession
    );
    expect(provisioningSession.dispose).toHaveBeenCalled();
    expect(ensureSSHConfig).toHaveBeenCalled();
    expect(execBufferedSpy).toHaveBeenCalled();

    // After postCreateSetup, ensureReady should succeed (workspace exists on server)
    const afterReady = await runtime.ensureReady();
    expect(afterReady.ready).toBe(true);

    expect(stdout).toEqual(["build line 1", "build line 2"]);
    expect(stderr).toEqual([]);
    expect(steps.join("\n")).toContain("Creating Coder workspace");
    expect(steps.join("\n")).toContain("Configuring SSH");
    expect(steps.join("\n")).toContain("Preparing workspace directory");
  });

  it("disposes provisioning session when workspace creation fails", async () => {
    const createWorkspace = mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        yield "Starting workspace...";
        await Promise.resolve();
        throw new Error("boom");
      })()
    );
    const provisioningSession = {
      token: "token",
      dispose: mock(() => Promise.resolve()),
    };
    const takeProvisioningSession = mock(() => provisioningSession);

    const coderService = createMockCoderService({
      createWorkspace,
      takeProvisioningSession,
    });
    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws", template: "my-template" },
      coderService
    );

    let caughtError: Error | undefined;
    try {
      await runtime.postCreateSetup({
        initLogger: {
          logStep: noop,
          logStdout: noop,
          logStderr: noop,
          logComplete: noop,
        },
        projectPath: "/project",
        branchName: "branch",
        trunkBranch: "main",
        workspacePath: "/home/user/src/my-project/my-ws",
      });
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError?.message).toContain("Failed to create Coder workspace");
    expect(takeProvisioningSession).toHaveBeenCalledWith("my-ws");
    expect(createWorkspace).toHaveBeenCalledWith(
      "my-ws",
      "my-template",
      undefined,
      undefined,
      undefined,
      provisioningSession
    );
    expect(provisioningSession.dispose).toHaveBeenCalled();
  });

  it("skips workspace creation when existingWorkspace=true and workspace is running", async () => {
    const createWorkspace = mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        yield "should not happen";
      })()
    );
    const waitForStartupScripts = mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        yield "Already running";
      })()
    );
    const ensureSSHConfig = mock(() => Promise.resolve());
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "running" as const })
    );

    const coderService = createMockCoderService({
      createWorkspace,
      waitForStartupScripts,
      ensureSSHConfig,
      getWorkspaceStatus,
    });
    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "existing-ws" },
      coderService
    );

    await runtime.postCreateSetup({
      initLogger: {
        logStep: noop,
        logStdout: noop,
        logStderr: noop,
        logComplete: noop,
      },
      projectPath: "/project",
      branchName: "branch",
      trunkBranch: "main",
      workspacePath: "/home/user/src/my-project/existing-ws",
    });

    expect(createWorkspace).not.toHaveBeenCalled();
    // waitForStartupScripts is called (it handles running workspaces quickly)
    expect(waitForStartupScripts).toHaveBeenCalled();
    expect(ensureSSHConfig).toHaveBeenCalled();
    expect(execBufferedSpy).toHaveBeenCalled();
  });

  it("uses waitForStartupScripts for existing stopped workspace (auto-starts via coder ssh)", async () => {
    const createWorkspace = mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        yield "should not happen";
      })()
    );
    const waitForStartupScripts = mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        yield "Starting workspace...";
        yield "Build complete";
        yield "Startup scripts finished";
      })()
    );
    const ensureSSHConfig = mock(() => Promise.resolve());
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "stopped" as const })
    );

    const coderService = createMockCoderService({
      createWorkspace,
      waitForStartupScripts,
      ensureSSHConfig,
      getWorkspaceStatus,
    });
    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "existing-ws" },
      coderService
    );

    const loggedStdout: string[] = [];
    await runtime.postCreateSetup({
      initLogger: {
        logStep: noop,
        logStdout: (line) => loggedStdout.push(line),
        logStderr: noop,
        logComplete: noop,
      },
      projectPath: "/project",
      branchName: "branch",
      trunkBranch: "main",
      workspacePath: "/home/user/src/my-project/existing-ws",
    });

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(waitForStartupScripts).toHaveBeenCalled();
    expect(loggedStdout).toContain("Starting workspace...");
    expect(loggedStdout).toContain("Startup scripts finished");
    expect(ensureSSHConfig).toHaveBeenCalled();
  });

  it("polls until stopping workspace becomes stopped before connecting", async () => {
    let pollCount = 0;
    const getWorkspaceStatus = mock(() => {
      pollCount++;
      // First 2 calls return "stopping", then "stopped"
      if (pollCount <= 2) {
        return Promise.resolve({ kind: "ok" as const, status: "stopping" as const });
      }
      return Promise.resolve({ kind: "ok" as const, status: "stopped" as const });
    });
    const waitForStartupScripts = mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        yield "Ready";
      })()
    );
    const ensureSSHConfig = mock(() => Promise.resolve());

    const coderService = createMockCoderService({
      getWorkspaceStatus,
      waitForStartupScripts,
      ensureSSHConfig,
    });

    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "stopping-ws" },
      coderService
    );

    // Avoid real sleeps in this polling test
    interface RuntimeWithSleep {
      sleep: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
    }
    spyOn(runtime as unknown as RuntimeWithSleep, "sleep").mockResolvedValue(undefined);

    const loggedSteps: string[] = [];
    await runtime.postCreateSetup({
      initLogger: {
        logStep: (step) => loggedSteps.push(step),
        logStdout: noop,
        logStderr: noop,
        logComplete: noop,
      },
      projectPath: "/project",
      branchName: "branch",
      trunkBranch: "main",
      workspacePath: "/home/user/src/my-project/stopping-ws",
    });

    // Should have polled status multiple times
    expect(pollCount).toBeGreaterThan(2);
    expect(loggedSteps.some((s) => s.includes("Waiting for Coder workspace"))).toBe(true);
    expect(waitForStartupScripts).toHaveBeenCalled();
  });

  it("throws when workspaceName is missing", () => {
    const coderService = createMockCoderService();
    const runtime = createRuntime({ existingWorkspace: false, template: "tmpl" }, coderService);

    return expect(
      runtime.postCreateSetup({
        initLogger: {
          logStep: noop,
          logStdout: noop,
          logStderr: noop,
          logComplete: noop,
        },
        projectPath: "/project",
        branchName: "branch",
        trunkBranch: "main",
        workspacePath: "/home/user/src/my-project/ws",
      })
    ).rejects.toThrow("Coder workspace name is required");
  });

  it("throws when template is missing for new workspaces", () => {
    const coderService = createMockCoderService();
    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws", template: undefined },
      coderService
    );

    return expect(
      runtime.postCreateSetup({
        initLogger: {
          logStep: noop,
          logStdout: noop,
          logStderr: noop,
          logComplete: noop,
        },
        projectPath: "/project",
        branchName: "branch",
        trunkBranch: "main",
        workspacePath: "/home/user/src/my-project/ws",
      })
    ).rejects.toThrow("Coder template is required");
  });
});

// =============================================================================
// Test Suite 5: ensureReady (runtime readiness + status events)
// =============================================================================

describe("CoderSSHRuntime.ensureReady", () => {
  it("returns ready when workspace is already running", async () => {
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "running" as const })
    );
    const waitForStartupScripts = mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        yield "should not be called";
      })()
    );
    const coderService = createMockCoderService({ getWorkspaceStatus, waitForStartupScripts });

    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "my-ws" },
      coderService
    );

    const events: RuntimeStatusEvent[] = [];
    const result = await runtime.ensureReady({
      statusSink: (e) => events.push(e),
    });

    expect(result).toEqual({ ready: true });
    expect(getWorkspaceStatus).toHaveBeenCalled();
    // Short-circuited because status is already "running"
    expect(waitForStartupScripts).not.toHaveBeenCalled();
    expect(events.map((e) => e.phase)).toEqual(["checking", "ready"]);
    expect(events[0]?.runtimeType).toBe("ssh");
  });

  it("connects via waitForStartupScripts when status is stopped (auto-starts)", async () => {
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "stopped" as const })
    );
    const waitForStartupScripts = mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        yield "Starting workspace...";
        yield "Workspace started";
      })()
    );
    const coderService = createMockCoderService({ getWorkspaceStatus, waitForStartupScripts });

    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "my-ws" },
      coderService
    );

    const events: RuntimeStatusEvent[] = [];
    const result = await runtime.ensureReady({
      statusSink: (e) => events.push(e),
    });

    expect(result).toEqual({ ready: true });
    expect(waitForStartupScripts).toHaveBeenCalled();
    // We should see checking, then starting, then ready
    expect(events[0]?.phase).toBe("checking");
    expect(events.some((e) => e.phase === "starting")).toBe(true);
    expect(events.at(-1)?.phase).toBe("ready");
  });

  it("returns runtime_start_failed when waitForStartupScripts fails", async () => {
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "stopped" as const })
    );
    const waitForStartupScripts = mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        yield "Starting workspace...";
        throw new Error("connection failed");
      })()
    );
    const coderService = createMockCoderService({ getWorkspaceStatus, waitForStartupScripts });

    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "my-ws" },
      coderService
    );

    const events: RuntimeStatusEvent[] = [];
    const result = await runtime.ensureReady({
      statusSink: (e) => events.push(e),
    });

    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.errorType).toBe("runtime_start_failed");
      expect(result.error).toContain("Failed to connect");
    }

    expect(events.at(-1)?.phase).toBe("error");
  });
});
