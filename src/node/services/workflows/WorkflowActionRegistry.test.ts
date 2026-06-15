import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import type { Runtime } from "@/node/runtime/Runtime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowActionRegistry } from "./WorkflowActionRegistry";

function streamFromString(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

function createRuntimeWithExistingActions(): Runtime {
  return {
    normalizePath(relativePath: string, root?: string) {
      return root == null ? relativePath : path.posix.join(root, relativePath);
    },
    exec() {
      return Promise.resolve({
        stdout: streamFromString(""),
        stderr: streamFromString(""),
        stdin: new WritableStream(),
        exitCode: Promise.resolve(0),
        duration: Promise.resolve(1),
      });
    },
  } as unknown as Runtime;
}

function createRuntimeWithoutActions(): Runtime {
  return {
    normalizePath(relativePath: string, root?: string) {
      return root == null ? relativePath : path.posix.join(root, relativePath);
    },
    exec() {
      return Promise.resolve({
        stdout: streamFromString(""),
        stderr: streamFromString(""),
        stdin: new WritableStream(),
        exitCode: Promise.resolve(1),
        duration: Promise.resolve(1),
      });
    },
  } as unknown as Runtime;
}

async function writeAction(root: string, relativePath: string, source = "module.exports = {};") {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source, "utf-8");
  return filePath;
}

async function expectRuntimeProjectActionRejection(registry: WorkflowActionRegistry) {
  try {
    await registry.resolveAction("remoteOnly", { projectTrusted: true });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toMatch(/runtime-backed workspaces/);
    return;
  }
  throw new Error("Expected runtime-backed project action to be rejected");
}

async function expectProjectTrustRejection(registry: WorkflowActionRegistry) {
  try {
    await registry.resolveAction("localOnly", { projectTrusted: false });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toMatch(/Project trust is required/);
    return;
  }
  throw new Error("Expected project-local action to require Project Trust");
}

describe("WorkflowActionRegistry", () => {
  test("maps nested action files to namespaced action names", async () => {
    using tmp = new DisposableTempDir("workflow-actions-registry");
    const projectRoot = path.join(tmp.path, "project", ".mux", "actions");
    const globalRoot = path.join(tmp.path, "global", "actions");
    const sourcePath = await writeAction(projectRoot, path.join("graphite", "stackSnapshot.js"));
    const registry = new WorkflowActionRegistry({ projectRoot, globalRoot });

    const actions = await registry.listActions({ projectTrusted: true });

    expect(actions).toContainEqual({
      name: "graphite.stackSnapshot",
      scope: "project",
      sourcePath,
    });
  });

  test("ships built-in Git workflow actions", async () => {
    using tmp = new DisposableTempDir("workflow-actions-built-in");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    const registry = new WorkflowActionRegistry({ projectRoot, globalRoot });

    const resolved = await registry.resolveAction("git.status", { projectTrusted: false });
    const actions = await registry.listActions({ projectTrusted: false });

    expect(resolved.scope).toBe("built-in");
    expect(resolved.source).toContain("git status");
    const byName = new Map(actions.map((action) => [action.name, action]));
    expect(byName.get("git.status")?.scope).toBe("built-in");
    expect(byName.get("git.commitsBetween")?.scope).toBe("built-in");
    expect(byName.get("git.diff")?.scope).toBe("built-in");
    expect(byName.get("git.diffStat")?.scope).toBe("built-in");
    expect(byName.get("git.changedFiles")?.scope).toBe("built-in");
    expect(byName.get("security.loadState")?.scope).toBe("built-in");
    expect(byName.get("security.hashFiles")?.scope).toBe("built-in");
    expect(byName.get("security.matchFindings")?.scope).toBe("built-in");
    expect(byName.get("security.writeThreatModel")?.scope).toBe("built-in");
    expect(byName.get("security.writeEvidenceBundle")?.scope).toBe("built-in");
    expect(byName.get("security.writeState")?.scope).toBe("built-in");
  });

  test("uses project actions before global actions when trusted", async () => {
    using tmp = new DisposableTempDir("workflow-actions-precedence");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await writeAction(projectRoot, "tool.js", "module.exports = { project: true };");
    await writeAction(globalRoot, "tool.js", "module.exports = { global: true };");
    const registry = new WorkflowActionRegistry({ projectRoot, globalRoot });

    const resolved = await registry.resolveAction("tool", { projectTrusted: true });

    expect(resolved.scope).toBe("project");
    expect(resolved.source).toContain("project: true");
    expect(resolved.sourceHash).toMatch(/^sha256:/);
  });

  test("uses user actions before built-in actions", async () => {
    using tmp = new DisposableTempDir("workflow-actions-built-in-precedence");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await writeAction(
      globalRoot,
      path.join("git", "status.js"),
      "module.exports = { global: true };"
    );
    const registry = new WorkflowActionRegistry({ projectRoot, globalRoot });

    const resolved = await registry.resolveAction("git.status", { projectTrusted: true });

    expect(resolved.scope).toBe("global");
    expect(resolved.source).toContain("global: true");
  });

  test("can resolve built-in actions without user overrides", async () => {
    using tmp = new DisposableTempDir("workflow-actions-built-in-only");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await writeAction(
      globalRoot,
      path.join("git", "status.js"),
      "module.exports = { global: true };"
    );
    const registry = new WorkflowActionRegistry({ projectRoot, globalRoot });

    const resolved = await registry.resolveAction("git.status", {
      projectTrusted: true,
      builtInOnly: true,
    });

    expect(resolved.scope).toBe("built-in");
    expect(resolved.source).toContain("git status");
  });

  test("does not fall back to a global action when a trusted project action is invalid", async () => {
    using tmp = new DisposableTempDir("workflow-actions-invalid-project");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    const requires = Array.from({ length: 65 }, (_, index) => `require("./dep${index}.js");`).join(
      "\n"
    );
    await writeAction(projectRoot, "tool.js", requires);
    await writeAction(globalRoot, "tool.js", "module.exports = { global: true };");
    for (let index = 0; index < 65; index += 1) {
      await writeAction(projectRoot, `dep${index}.js`, "module.exports = {};\n");
    }
    const registry = new WorkflowActionRegistry({ projectRoot, globalRoot });

    try {
      await registry.resolveAction("tool", { projectTrusted: true });
      throw new Error("Expected invalid project action to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : "").toMatch(
        /static dependency limit exceeded/
      );
    }
  });

  test("rejects runtime-backed project actions instead of executing them locally", async () => {
    using tmp = new DisposableTempDir("workflow-actions-runtime");
    const projectRoot = "/runtime/project/.mux/actions";
    const globalRoot = path.join(tmp.path, "global-actions");
    const registry = new WorkflowActionRegistry({
      projectRoot,
      globalRoot,
      projectRuntime: createRuntimeWithExistingActions(),
      projectCwd: "/runtime/project",
    });

    await expectRuntimeProjectActionRejection(registry);
    const actions = await registry.listActions({ projectTrusted: true });

    expect(actions.map((action) => ({ name: action.name, scope: action.scope }))).toEqual([
      { name: "workflows.start", scope: "built-in" },
    ]);
  });

  test("rejects runtime-backed global actions instead of using a remote cwd locally", async () => {
    using tmp = new DisposableTempDir("workflow-actions-runtime-global");
    const projectRoot = "/runtime/project/.mux/actions";
    const globalRoot = path.join(tmp.path, "global-actions");
    await writeAction(globalRoot, "shared.js");
    const registry = new WorkflowActionRegistry({
      projectRoot,
      globalRoot,
      projectRuntime: createRuntimeWithExistingActions(),
      projectCwd: "/runtime/project",
    });

    try {
      await registry.resolveAction("shared", { projectTrusted: true });
      throw new Error("Expected runtime-backed global action to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : "").toMatch(/runtime-backed workspaces/);
    }
    const actions = await registry.listActions({ projectTrusted: true });

    expect(actions.map((action) => ({ name: action.name, scope: action.scope }))).toEqual([
      { name: "workflows.start", scope: "built-in" },
    ]);
  });

  test("rejects runtime-backed built-in actions instead of using a remote cwd locally", async () => {
    using tmp = new DisposableTempDir("workflow-actions-runtime-built-in");
    const projectRoot = "/runtime/project/.mux/actions";
    const globalRoot = path.join(tmp.path, "global-actions");
    const registry = new WorkflowActionRegistry({
      projectRoot,
      globalRoot,
      projectRuntime: createRuntimeWithoutActions(),
      projectCwd: "/runtime/project",
    });

    try {
      await registry.resolveAction("git.status", { projectTrusted: true });
      throw new Error("Expected runtime-backed built-in action to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : "").toMatch(/runtime-backed workspaces/);
    }
  });

  test("allows runner-coordinated workflows.start in runtime-backed workspaces", async () => {
    using tmp = new DisposableTempDir("workflow-actions-runtime-workflows-start");
    const registry = new WorkflowActionRegistry({
      projectRoot: "/runtime/project/.mux/actions",
      globalRoot: path.join(tmp.path, "global-actions"),
      projectRuntime: createRuntimeWithoutActions(),
      projectCwd: "/runtime/project",
    });

    const action = await registry.resolveAction("workflows.start", { projectTrusted: true });
    const actions = await registry.listActions({ projectTrusted: true });

    expect(action).toMatchObject({ name: "workflows.start", scope: "built-in" });
    expect(actions.map((action) => ({ name: action.name, scope: action.scope }))).toEqual([
      { name: "workflows.start", scope: "built-in" },
    ]);
  });

  test("blocks project-local actions without Project Trust while allowing global actions", async () => {
    using tmp = new DisposableTempDir("workflow-actions-trust");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await writeAction(projectRoot, "localOnly.js");
    await writeAction(globalRoot, "shared.js");
    const registry = new WorkflowActionRegistry({ projectRoot, globalRoot });

    await expectProjectTrustRejection(registry);
    const shared = await registry.resolveAction("shared", { projectTrusted: false });
    const actions = await registry.listActions({ projectTrusted: false });

    expect(shared.scope).toBe("global");
    expect(actions).toContainEqual({
      name: "shared",
      scope: "global",
      sourcePath: shared.sourcePath,
    });
  });
});
