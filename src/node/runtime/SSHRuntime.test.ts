import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import { SSHRuntime, computeBaseRepoPath } from "./SSHRuntime";
import { createSSHTransport } from "./transports";

/**
 * SSHRuntime unit tests (run with bun test)
 *
 * Integration tests for workspace operations (renameWorkspace, deleteWorkspace, forkWorkspace,
 * worktree-based operations) require Docker and are in tests/runtime/runtime.test.ts.
 * Run with: TEST_INTEGRATION=1 bun x jest tests/runtime/runtime.test.ts
 */
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
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({ stdout: ".git", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({ stdout: "true\n", stderr: "", exitCode: 0, duration: 0 });

    const result = await runtime.ensureReady();

    expect(execBufferedSpy).toHaveBeenCalledTimes(3);
    const firstCommand = execBufferedSpy?.mock.calls[0]?.[1];
    expect(firstCommand).toContain("test -d");
    expect(firstCommand).toContain("test -f");
    const thirdCommand = execBufferedSpy?.mock.calls[2]?.[1];
    expect(thirdCommand).toContain("rev-parse --is-inside-work-tree");
    expect(result).toEqual({ ready: true });
  });

  it("returns runtime_not_ready when git reports the workspace is not inside a work tree", async () => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered")
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({ stdout: ".git", stderr: "", exitCode: 0, duration: 0 })
      .mockResolvedValueOnce({ stdout: "false\n", stderr: "", exitCode: 0, duration: 0 });

    const result = await runtime.ensureReady();

    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.errorType).toBe("runtime_not_ready");
    }
  });

  it("returns runtime_not_ready when the repo is missing", async () => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
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
describe("computeBaseRepoPath", () => {
  it("computes the correct bare repo path", () => {
    // computeBaseRepoPath uses getProjectName (basename) to compute:
    // <srcBaseDir>/<projectName>/.mux-base.git
    const result = computeBaseRepoPath("~/mux", "/Users/me/code/my-project");
    expect(result).toBe("~/mux/my-project/.mux-base.git");
  });

  it("handles absolute srcBaseDir", () => {
    const result = computeBaseRepoPath("/home/user/src", "/code/repo");
    expect(result).toBe("/home/user/src/repo/.mux-base.git");
  });
});
