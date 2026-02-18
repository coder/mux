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
      .mockResolvedValueOnce({ stdout: ".git", stderr: "", exitCode: 0, duration: 0 });

    const result = await runtime.ensureReady();

    expect(execBufferedSpy).toHaveBeenCalledTimes(2);
    const firstCommand = execBufferedSpy?.mock.calls[0]?.[1];
    expect(firstCommand).toContain("test -d");
    expect(firstCommand).toContain("test -f");
    expect(result).toEqual({ ready: true });
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
