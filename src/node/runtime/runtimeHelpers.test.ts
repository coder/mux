import { describe, expect, it } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import { DevcontainerRuntime } from "./DevcontainerRuntime";
import { createRuntimeForWorkspace, resolveWorkspaceExecutionPath } from "./runtimeHelpers";

describe("createRuntimeForWorkspace", () => {
  it("forwards the persisted workspace path to devcontainer runtimes", () => {
    const runtime = createRuntimeForWorkspace({
      runtimeConfig: {
        type: "devcontainer",
        configPath: ".devcontainer/devcontainer.json",
      },
      projectPath: "/projects/demo",
      name: "review-1",
      namedWorkspacePath: "/tmp/non-canonical/workspaces/review-1",
    });

    expect(runtime).toBeInstanceOf(DevcontainerRuntime);
    const internal = runtime as unknown as { currentWorkspacePath?: string };
    expect(internal.currentWorkspacePath).toBe("/tmp/non-canonical/workspaces/review-1");
  });
});

describe("resolveWorkspaceExecutionPath", () => {
  it("uses the persisted path for non-docker workspaces", () => {
    const metadata = {
      runtimeConfig: {
        type: "worktree",
        srcBaseDir: "/tmp/src",
      } satisfies RuntimeConfig,
      projectPath: "/projects/demo",
      name: "review-1",
      namedWorkspacePath: "/persisted/review-1",
    };

    const runtime = createRuntimeForWorkspace(metadata);
    expect(resolveWorkspaceExecutionPath(metadata, runtime)).toBe("/persisted/review-1");
  });

  it("uses the runtime path for docker workspaces", () => {
    const metadata = {
      runtimeConfig: {
        type: "docker",
        image: "node:20",
      } satisfies RuntimeConfig,
      projectPath: "/projects/demo",
      name: "review-1",
      namedWorkspacePath: "/host/review-1",
    };

    const runtime = createRuntimeForWorkspace(metadata);
    expect(resolveWorkspaceExecutionPath(metadata, runtime)).toBe("/src");
  });
});
