import { describe, expect, it, mock, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { CoderSSHRuntime, type CoderSSHRuntimeConfig } from "./CoderSSHRuntime";
import { SSHRuntime } from "./SSHRuntime";
import type { CoderService } from "@/node/services/coderService";
import type { RuntimeConfig } from "@/common/types/runtime";

/**
 * Create a minimal mock CoderService for testing.
 * Only mocks methods used by the tested code paths.
 */
function createMockCoderService(overrides?: Partial<CoderService>): CoderService {
  return {
    deleteWorkspace: mock(() => Promise.resolve()),
    listWorkspaces: mock(() => Promise.resolve([])),
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
  const config: CoderSSHRuntimeConfig = {
    host: "placeholder.coder",
    srcBaseDir: "~/src",
    coder: {
      existingWorkspace: coderConfig.existingWorkspace ?? false,
      workspaceName: coderConfig.workspaceName,
      template: coderConfig.template ?? "default-template",
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
