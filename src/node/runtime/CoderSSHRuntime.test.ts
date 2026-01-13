import { describe, expect, it, mock, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import type { CoderService } from "@/node/services/coderService";
import type { RuntimeConfig } from "@/common/types/runtime";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};
import type { RuntimeStatusEvent } from "./Runtime";

const execBufferedMock = mock(() =>
  Promise.resolve({ stdout: "", stderr: "", exitCode: 0, duration: 0 })
);

void mock.module("@/node/utils/runtime/helpers", () => ({
  execBuffered: execBufferedMock,
}));

import { CoderSSHRuntime, type CoderSSHRuntimeConfig } from "./CoderSSHRuntime";
import { SSHRuntime } from "./SSHRuntime";

/**
 * Create a minimal mock CoderService for testing.
 * Only mocks methods used by the tested code paths.
 */
function createMockCoderService(overrides?: Partial<CoderService>): CoderService {
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
    ensureSSHConfig: mock(() => Promise.resolve()),
    getWorkspaceStatus: mock(() => Promise.resolve({ status: "running" as const })),
    listWorkspaces: mock(() => Promise.resolve([])),
    startWorkspaceAndWait: mock(() => Promise.resolve({ success: true })),
    workspaceExists: mock(() => Promise.resolve(false)),
    ...overrides,
  } as unknown as CoderService;
}

/**
 * Create a CoderSSHRuntime with minimal config for testing.
 */
function createRuntime(
  coderConfig: { existingWorkspace?: boolean; workspaceName?: string; template?: string },
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
  return new CoderSSHRuntime(config, coderService);
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
    it("derives Coder name from branch name when not provided", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("my-feature", config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("ssh");
        if (result.data.type === "ssh") {
          expect(result.data.coder?.workspaceName).toBe("my-feature");
          expect(result.data.host).toBe("my-feature.coder");
        }
      }
    });

    it("converts underscores to hyphens", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("my_feature_branch", config);

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "ssh") {
        expect(result.data.coder?.workspaceName).toBe("my-feature-branch");
        expect(result.data.host).toBe("my-feature-branch.coder");
      }
    });

    it("collapses multiple hyphens and trims leading/trailing", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("--my--feature--", config);

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "ssh") {
        expect(result.data.coder?.workspaceName).toBe("my-feature");
      }
    });

    it("rejects names that fail regex after conversion", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      // Name that becomes empty or invalid after conversion
      const result = await runtime.finalizeConfig("---", config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("cannot be converted to a valid Coder name");
      }
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
  beforeEach(() => {
    execBufferedMock.mockClear();
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

    const coderService = createMockCoderService({ createWorkspace, ensureSSHConfig });
    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws", template: "my-template" },
      coderService
    );

    // Before postCreateSetup, ensureReady should fail fast (workspace not created yet)
    const beforeReady = await runtime.ensureReady();
    expect(beforeReady.ready).toBe(false);

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

    expect(createWorkspace).toHaveBeenCalledWith("my-ws", "my-template", undefined, undefined);
    expect(ensureSSHConfig).toHaveBeenCalled();
    expect(execBufferedMock).toHaveBeenCalled();

    // After postCreateSetup, ensureReady should no longer fast-fail
    const afterReady = await runtime.ensureReady();
    expect(afterReady.ready).toBe(true);

    expect(stdout).toEqual(["build line 1", "build line 2"]);
    expect(stderr).toEqual([]);
    expect(steps.join("\n")).toContain("Creating Coder workspace");
    expect(steps.join("\n")).toContain("Configuring SSH");
    expect(steps.join("\n")).toContain("Preparing workspace directory");
  });

  it("skips workspace creation when existingWorkspace=true", async () => {
    const createWorkspace = mock(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        await Promise.resolve();
        yield "should not happen";
      })()
    );
    const ensureSSHConfig = mock(() => Promise.resolve());

    const coderService = createMockCoderService({ createWorkspace, ensureSSHConfig });
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
    expect(ensureSSHConfig).toHaveBeenCalled();
    expect(execBufferedMock).toHaveBeenCalled();
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
    const getWorkspaceStatus = mock(() => Promise.resolve({ status: "running" as const }));
    const startWorkspaceAndWait = mock(() => Promise.resolve({ success: true }));
    const coderService = createMockCoderService({ getWorkspaceStatus, startWorkspaceAndWait });

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
    expect(startWorkspaceAndWait).not.toHaveBeenCalled();
    expect(events.map((e) => e.phase)).toEqual(["checking", "ready"]);
    expect(events[0]?.runtimeType).toBe("ssh");
  });

  it("starts the workspace when status is stopped", async () => {
    const getWorkspaceStatus = mock(() => Promise.resolve({ status: "stopped" as const }));
    const startWorkspaceAndWait = mock(() => Promise.resolve({ success: true }));
    const coderService = createMockCoderService({ getWorkspaceStatus, startWorkspaceAndWait });

    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "my-ws" },
      coderService
    );

    const events: RuntimeStatusEvent[] = [];
    const result = await runtime.ensureReady({
      statusSink: (e) => events.push(e),
    });

    expect(result).toEqual({ ready: true });
    expect(startWorkspaceAndWait).toHaveBeenCalled();
    expect(events.map((e) => e.phase)).toEqual(["checking", "starting", "ready"]);
  });

  it("returns runtime_start_failed when start fails", async () => {
    const getWorkspaceStatus = mock(() => Promise.resolve({ status: "stopped" as const }));
    const startWorkspaceAndWait = mock(() => Promise.resolve({ success: false, error: "boom" }));
    const coderService = createMockCoderService({ getWorkspaceStatus, startWorkspaceAndWait });

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
      expect(result.error).toContain("Failed to start");
    }

    expect(events.at(-1)?.phase).toBe("error");
  });
});
