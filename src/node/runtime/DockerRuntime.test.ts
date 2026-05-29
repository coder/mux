import { describe, expect, it } from "bun:test";
import { DockerRuntime, getContainerName } from "./DockerRuntime";
import type { InitLogger } from "./Runtime";

const noopInitLogger: InitLogger = {
  logStep: () => {
    // no-op
  },
  logStdout: () => {
    // no-op
  },
  logStderr: () => {
    // no-op
  },
  logComplete: () => {
    // no-op
  },
};

/**
 * DockerRuntime constructor tests (run with bun test)
 *
 * Note: Docker workspace operation tests require Docker
 * and should be in tests/runtime/runtime.test.ts
 */
describe("DockerRuntime constructor", () => {
  it("should accept image name", () => {
    expect(() => {
      new DockerRuntime({ image: "ubuntu:22.04" });
    }).not.toThrow();
  });

  it("should accept registry image", () => {
    expect(() => {
      new DockerRuntime({ image: "ghcr.io/myorg/dev-image:latest" });
    }).not.toThrow();
  });

  it("should return image via getImage()", () => {
    const runtime = new DockerRuntime({ image: "node:20" });
    expect(runtime.getImage()).toBe("node:20");
  });

  it("should return /src for workspace path", () => {
    const runtime = new DockerRuntime({ image: "ubuntu:22.04" });
    expect(runtime.getWorkspacePath("/any/project", "any-branch")).toBe("/src");
  });

  it("should accept containerName for existing workspaces", () => {
    // When recreating runtime for existing workspace, containerName is passed in config
    const runtime = new DockerRuntime({
      image: "ubuntu:22.04",
      containerName: "mux-myproject-my-feature",
    });
    expect(runtime.getImage()).toBe("ubuntu:22.04");
    // Runtime should be ready for exec operations without calling createWorkspace
  });
});

describe("DockerRuntime.forkWorkspace", () => {
  it("stops before Docker commands when the fork is already aborted", async () => {
    const runtime = new DockerRuntime({ image: "ubuntu:22.04" });
    const abortController = new AbortController();
    abortController.abort();

    const result = await runtime.forkWorkspace({
      projectPath: "/tmp/project",
      sourceWorkspaceName: "main",
      newWorkspaceName: "feature",
      initLogger: noopInitLogger,
      abortSignal: abortController.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
  });
});

describe("getContainerName", () => {
  it("should generate container name from project and workspace", () => {
    expect(getContainerName("/home/user/myproject", "feature-branch")).toBe(
      "mux-myproject-feature-branch-a8d18a"
    );
  });

  it("should sanitize special characters", () => {
    expect(getContainerName("/home/user/my@project", "feature/branch")).toBe(
      "mux-my-project-feature-branch-b354b4"
    );
  });

  it("should handle long names", () => {
    const longName = "a".repeat(100);
    const result = getContainerName("/project", longName);
    // Docker has 64 char limit, function uses 63 to be safe
    expect(result.length).toBeLessThanOrEqual(63);
  });
});
