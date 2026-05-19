import { describe, expect, it } from "bun:test";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";
import { createRuntime, IncompatibleRuntimeError, runBackgroundInit } from "./runtimeFactory";
import type { RuntimeConfig } from "@/common/types/runtime";
import { LocalRuntime } from "./LocalRuntime";
import { WorktreeRuntime } from "./WorktreeRuntime";
import { CoderSSHRuntime } from "./CoderSSHRuntime";
import type { Runtime } from "./Runtime";
import type { CoderService } from "@/node/services/coderService";

const noop = (): void => undefined;

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

describe("runBackgroundInit", () => {
  it("runs runtime cleanup when background init returns failure", async () => {
    let cleanupReason: string | null = null;
    let cleanupResolve: (() => void) | undefined;
    const cleanupDone = new Promise<void>((resolve) => {
      cleanupResolve = resolve;
    });
    const initLogger = {
      logStep: noop,
      logStdout: noop,
      logStderr: noop,
      logComplete: noop,
    };
    const runtime = {
      initWorkspace: () => Promise.resolve({ success: false, error: "checkout failed" }),
      cleanupFailedInit: (_params: unknown, reason: string) => {
        cleanupReason = reason;
        cleanupResolve?.();
        return Promise.resolve();
      },
    };

    runBackgroundInit(
      runtime as unknown as Runtime,
      {
        projectPath: "/project",
        branchName: "workspace-branch",
        trunkBranch: "main",
        workspacePath: "/remote/workspace",
        initLogger,
      },
      "workspace-id"
    );

    await Promise.race([
      cleanupDone,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cleanupFailedInit was not called")), 100)
      ),
    ]);

    expect(cleanupReason ?? "").toBe("checkout failed");
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
