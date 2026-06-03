import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { Config } from "@/node/config";
import { DisposableTempDir } from "@/node/services/tempDir";
import { resolveWorkflowScratchRoots } from "./workflowScratchRoots";

describe("resolveWorkflowScratchRoots", () => {
  test("resolves scratch workflows under the active workspace root", () => {
    using tmp = new DisposableTempDir("workflow-scratch-roots");
    const config = new Config(tmp.path);
    const workspaceRoot = path.join(tmp.path, "project", "feature");

    expect(
      resolveWorkflowScratchRoots(config, "workspace-1", { workspaceRootPath: workspaceRoot })
    ).toEqual({
      scratchRoot: path.join(workspaceRoot, ".mux", "workflows", ".scratch"),
    });
  });

  test("uses runtime path normalization for remote workspace roots", () => {
    using tmp = new DisposableTempDir("workflow-scratch-roots");
    const config = new Config(tmp.path);

    expect(
      resolveWorkflowScratchRoots(config, "workspace-1", {
        workspaceRootPath: "/remote/workspace",
        normalizePath: (relativePath, basePath) => `${basePath}/${relativePath}`,
      })
    ).toEqual({
      scratchRoot: "/remote/workspace/.mux/workflows/.scratch",
    });
  });

  test("falls back to the persisted workspace path when no root is provided", async () => {
    using tmp = new DisposableTempDir("workflow-scratch-roots");
    const config = new Config(tmp.path);
    const projectPath = path.join(tmp.path, "project");
    const workspacePath = path.join(projectPath, "feature");

    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        workspaces: [{ id: "workspace-1", name: "feature", path: workspacePath }],
      });
      return current;
    });

    expect(resolveWorkflowScratchRoots(config, "workspace-1")).toEqual({
      scratchRoot: path.join(workspacePath, ".mux", "workflows", ".scratch"),
    });
  });
});
