import { describe, expect, it, mock } from "bun:test";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";
import {
  checkRuntimeAvailability,
  createRuntime,
  IncompatibleRuntimeError,
} from "./runtimeFactory";
import type { RuntimeConfig } from "@/common/types/runtime";
import { LocalRuntime } from "./LocalRuntime";
import { WorktreeRuntime } from "./WorktreeRuntime";
import { CoderSSHRuntime } from "./CoderSSHRuntime";
import type { CoderService } from "@/node/services/coderService";

describe("isIncompatibleRuntimeConfig", () => {
  it("returns false for undefined config", () => {
    expect(isIncompatibleRuntimeConfig(undefined)).toBe(false);
  });

  it("returns false for local config with srcBaseDir (legacy worktree)", () => {
    const config: RuntimeConfig = {
      type: "local",
      srcBaseDir: "~/.mux/src",
    };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns false for local config without srcBaseDir (project-dir mode)", () => {
    // Local without srcBaseDir is now supported as project-dir mode
    const config: RuntimeConfig = { type: "local" };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns false for worktree config", () => {
    const config: RuntimeConfig = {
      type: "worktree",
      srcBaseDir: "~/.mux/src",
    };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns false for SSH config", () => {
    const config: RuntimeConfig = {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/home/user/mux",
    };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns true for unknown runtime type from future versions", () => {
    // Simulate a config from a future version with new type
    const config = { type: "future-runtime" } as unknown as RuntimeConfig;
    expect(isIncompatibleRuntimeConfig(config)).toBe(true);
  });
});

describe("createRuntime", () => {
  it("creates WorktreeRuntime for local config with srcBaseDir (legacy)", () => {
    const config: RuntimeConfig = {
      type: "local",
      srcBaseDir: "/tmp/test-src",
    };
    const runtime = createRuntime(config);
    expect(runtime).toBeInstanceOf(WorktreeRuntime);
  });

  it("creates LocalRuntime for local config without srcBaseDir (project-dir)", () => {
    const config: RuntimeConfig = { type: "local" };
    const runtime = createRuntime(config, { projectPath: "/tmp/my-project" });
    expect(runtime).toBeInstanceOf(LocalRuntime);
  });

  it("creates WorktreeRuntime for explicit worktree config", () => {
    const config: RuntimeConfig = {
      type: "worktree",
      srcBaseDir: "/tmp/test-src",
    };
    const runtime = createRuntime(config);
    expect(runtime).toBeInstanceOf(WorktreeRuntime);
  });

  it("throws error for local project-dir without projectPath option", () => {
    const config: RuntimeConfig = { type: "local" };
    expect(() => createRuntime(config)).toThrow(/projectPath/);
  });

  it("throws IncompatibleRuntimeError for unknown runtime type", () => {
    const config = { type: "future-runtime" } as unknown as RuntimeConfig;
    expect(() => createRuntime(config)).toThrow(IncompatibleRuntimeError);
    expect(() => createRuntime(config)).toThrow(/newer version of mux/);
  });
});

describe("checkRuntimeAvailability", () => {
  type RuntimeAvailabilityDependencies = NonNullable<
    NonNullable<Parameters<typeof checkRuntimeAvailability>[1]>["dependencies"]
  >;

  const createDependencies = (
    overrides: Partial<RuntimeAvailabilityDependencies> = {}
  ): RuntimeAvailabilityDependencies => ({
    isGitRepository: async () => true,
    isDockerAvailable: async () => true,
    checkDevcontainerCliVersion: async () => ({ available: true, version: "0.81.1" }),
    scanDevcontainerConfigs: async () => [],
    ...overrides,
  });

  it("enables git-dependent runtimes when every working directory is a git repository", async () => {
    const workingDirectories = ["/tmp/project-a", "/tmp/project-b"];
    const isGitRepository = mock(async () => true);

    const availability = await checkRuntimeAvailability(workingDirectories, {
      dependencies: createDependencies({ isGitRepository }),
    });

    expect(isGitRepository).toHaveBeenCalledTimes(2);
    expect(availability.local).toEqual({ available: true });
    expect(availability.worktree).toEqual({ available: true });
    expect(availability.ssh).toEqual({ available: true });
    expect(availability.docker).toEqual({ available: true });
    expect(availability.devcontainer).toEqual({
      available: false,
      reason: "No devcontainer.json found",
    });
  });

  it("returns an explicit reason for mixed git and non-git working directories", async () => {
    const workingDirectories = ["/tmp/project-a", "/tmp/project-b"];

    const availability = await checkRuntimeAvailability(workingDirectories, {
      dependencies: createDependencies({
        isGitRepository: async (projectPath) => projectPath === workingDirectories[0],
      }),
    });

    const reason = "Some working directories are not git repositories";
    expect(availability.worktree).toEqual({ available: false, reason });
    expect(availability.ssh).toEqual({ available: false, reason });
    expect(availability.docker).toEqual({ available: false, reason });
    expect(availability.devcontainer).toEqual({ available: false, reason });
  });

  it("returns an explicit reason when the working-directory set is empty", async () => {
    const isGitRepository = mock(async () => true);
    const isDockerAvailable = mock(async () => true);
    const checkDevcontainerCliVersion = mock(async () => ({
      available: true as const,
      version: "0.81.1",
    }));
    const scanDevcontainerConfigs = mock(async () => [".devcontainer/devcontainer.json"]);

    const availability = await checkRuntimeAvailability([], {
      dependencies: {
        isGitRepository,
        isDockerAvailable,
        checkDevcontainerCliVersion,
        scanDevcontainerConfigs,
      },
    });

    const reason = "No working directories configured";
    expect(availability.worktree).toEqual({ available: false, reason });
    expect(availability.ssh).toEqual({ available: false, reason });
    expect(availability.docker).toEqual({ available: false, reason });
    expect(availability.devcontainer).toEqual({ available: false, reason });
    expect(isGitRepository).not.toHaveBeenCalled();
    expect(isDockerAvailable).not.toHaveBeenCalled();
    expect(checkDevcontainerCliVersion).not.toHaveBeenCalled();
    expect(scanDevcontainerConfigs).not.toHaveBeenCalled();
  });

  it("aggregates devcontainer configs across every working directory", async () => {
    const workingDirectories = ["/tmp/project-a", "/tmp/project-b"];
    const scanDevcontainerConfigs = mock(async (projectPath: string) => {
      if (projectPath === workingDirectories[0]) {
        return [".devcontainer/devcontainer.json"];
      }

      return [".devcontainer/backend/devcontainer.json"];
    });

    const availability = await checkRuntimeAvailability(workingDirectories, {
      dependencies: createDependencies({ scanDevcontainerConfigs }),
    });

    expect(scanDevcontainerConfigs).toHaveBeenCalledTimes(2);
    expect(scanDevcontainerConfigs).toHaveBeenNthCalledWith(1, workingDirectories[0]);
    expect(scanDevcontainerConfigs).toHaveBeenNthCalledWith(2, workingDirectories[1]);

    expect(availability.devcontainer.available).toBe(true);
    if (availability.devcontainer.available && "configs" in availability.devcontainer) {
      expect(availability.devcontainer.configs).toEqual([
        {
          path: ".devcontainer/devcontainer.json",
          label: "Default (.devcontainer/devcontainer.json)",
        },
        {
          path: ".devcontainer/backend/devcontainer.json",
          label: "backend (.devcontainer/backend/devcontainer.json)",
        },
      ]);
      expect(availability.devcontainer.cliVersion).toBe("0.81.1");
    }
  });
});

describe("createRuntime - Coder host normalization", () => {
  it("uses normalized mux--coder host for both runtime and transport", () => {
    // Legacy persisted config: host still has old .coder suffix,
    // but coder.workspaceName is present for normalization.
    const config: RuntimeConfig = {
      type: "ssh",
      host: "legacy.coder",
      srcBaseDir: "~/src",
      coder: {
        existingWorkspace: true,
        workspaceName: "legacy",
        template: "default-template",
      },
    };

    const runtime = createRuntime(config, {
      coderService: {} as unknown as CoderService,
    });

    expect(runtime).toBeInstanceOf(CoderSSHRuntime);

    // Both runtime config and underlying transport must use the
    // canonical host — the P1 bug was transport keeping raw config.host.
    const sshRuntime = runtime as unknown as {
      getConfig(): { host: string };
      transport: { getConfig(): { host: string } };
    };

    expect(sshRuntime.getConfig().host).toBe("legacy.mux--coder");
    expect(sshRuntime.transport.getConfig().host).toBe("legacy.mux--coder");
  });
});
