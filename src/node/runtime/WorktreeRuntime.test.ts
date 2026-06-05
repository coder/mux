import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";

import { WorktreeRuntime } from "./WorktreeRuntime";

describe("WorktreeRuntime workspacePath override", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-worktree-rt-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("returns the persisted path for its own workspace and the derived path otherwise", () => {
    const srcBaseDir = path.join(rootDir, "src");
    const projectPath = path.join(rootDir, "repo");
    const sharedPath = path.join(rootDir, "parent-checkout");

    // A shared (isolation: "none") task: unique child name, but path points at the parent checkout.
    const runtime = new WorktreeRuntime(srcBaseDir, {
      projectPath,
      workspaceName: "agent_explore_child",
      workspacePath: sharedPath,
    });

    // Its own identity resolves to the persisted shared path...
    expect(runtime.getWorkspacePath(projectPath, "agent_explore_child")).toBe(sharedPath);
    // ...while other workspaces still use the name-derived worktree path.
    const derivedSibling = runtime.getWorkspacePath(projectPath, "sibling");
    expect(derivedSibling).not.toBe(sharedPath);
    expect(derivedSibling).toContain("sibling");
  });

  it("reports ready when the shared checkout is a git repo even though the derived path is absent", async () => {
    const srcBaseDir = path.join(rootDir, "src");
    const projectPath = path.join(rootDir, "repo");
    const sharedPath = path.join(rootDir, "parent-checkout");
    await fs.mkdir(sharedPath, { recursive: true });
    execSync("git init -b main", { cwd: sharedPath, stdio: "ignore" });

    // Name-derived path (<srcBaseDir>/<project>/agent_explore_child) was never created.
    const runtime = new WorktreeRuntime(srcBaseDir, {
      projectPath,
      workspaceName: "agent_explore_child",
      workspacePath: sharedPath,
    });

    const ready = await runtime.ensureReady();
    expect(ready.ready).toBe(true);
  });

  it("reports not-ready without an override when the derived path does not exist", async () => {
    const srcBaseDir = path.join(rootDir, "src");
    const projectPath = path.join(rootDir, "repo");

    const runtime = new WorktreeRuntime(srcBaseDir, {
      projectPath,
      workspaceName: "missing-workspace",
    });

    const ready = await runtime.ensureReady();
    expect(ready.ready).toBe(false);
  });
});
