import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowActionRegistry } from "./WorkflowActionRegistry";

async function writeAction(root: string, relativePath: string, source = "module.exports = {};") {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source, "utf-8");
  return filePath;
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

    expect(actions).toEqual([{ name: "graphite.stackSnapshot", scope: "project", sourcePath }]);
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
    expect(actions).toEqual([{ name: "shared", scope: "global", sourcePath: shared.sourcePath }]);
  });
});
