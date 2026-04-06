import { describe, expect, it } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import { DevcontainerRuntime } from "./DevcontainerRuntime";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
} from "./runtimeHelpers";

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

  it("seeds ssh runtimes from the persisted workspace root", () => {
    const metadata = {
      runtimeConfig: {
        type: "ssh",
        host: "example.com",
        srcBaseDir: "/remote/src",
      } satisfies RuntimeConfig,
      projectPath: "/projects/demo",
      name: "review-1",
      namedWorkspacePath: "/remote/src/demo/review-1",
    };

    const runtime = createRuntimeForWorkspace(metadata);
    expect(runtime.getWorkspacePath(metadata.projectPath, "review-2")).toMatch(
      /^\/remote\/src\/demo-[a-f0-9]{12}\/review-2$/
    );
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

  it("requires the persisted path for SSH workspaces", () => {
    const metadata = {
      runtimeConfig: {
        type: "ssh",
        host: "example.com",
        srcBaseDir: "/remote/src",
      } satisfies RuntimeConfig,
      projectPath: "/projects/demo",
      name: "review-1",
    };

    const runtime = createRuntimeForWorkspace(metadata);
    expect(() => resolveWorkspaceExecutionPath(metadata, runtime)).toThrow(
      /missing a persisted workspace path/
    );
  });

  it("falls back to the runtime path for non-SSH workspaces when persisted metadata is unavailable", () => {
    const metadata = {
      runtimeConfig: {
        type: "worktree",
        srcBaseDir: "/tmp/src",
      } satisfies RuntimeConfig,
      projectPath: "/projects/demo",
      name: "review-1",
    };

    const runtime = createRuntimeForWorkspace(metadata);
    const runtimeWorkspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);
    expect(resolveWorkspaceExecutionPath(metadata, runtime)).toBe(runtimeWorkspacePath);
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

  it("returns the project root for in-place workspaces", () => {
    const metadata = {
      runtimeConfig: {
        type: "worktree",
        srcBaseDir: "/tmp/src",
      } satisfies RuntimeConfig,
      projectPath: "/projects/cli",
      name: "/projects/cli",
    };

    const runtime = createRuntimeForWorkspace(metadata);
    expect(resolveWorkspaceExecutionPath(metadata, runtime)).toBe("/projects/cli");
  });
});

describe("createRuntimeContextForWorkspace", () => {
  it("returns a runtime together with the resolved execution path", () => {
    const metadata = {
      runtimeConfig: {
        type: "ssh",
        host: "example.com",
        srcBaseDir: "/remote/src",
      } satisfies RuntimeConfig,
      projectPath: "/projects/demo",
      name: "review-1",
      namedWorkspacePath: "/remote/src/demo/review-1",
    };

    const context = createRuntimeContextForWorkspace(metadata);

    expect(context.workspacePath).toBe("/remote/src/demo/review-1");
    expect(context.runtime.getWorkspacePath(metadata.projectPath, "review-2")).toMatch(
      /^\/remote\/src\/demo-[a-f0-9]{12}\/review-2$/
    );
  });
});
