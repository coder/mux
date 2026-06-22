/* eslint-disable @typescript-eslint/await-thenable */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  TestTempDir,
  TrueRemotePathMappedRuntime,
  writeGlobalSkill,
  writeProjectSkill,
} from "@/node/services/tools/testHelpers";
import { resolveWorkflowScript } from "./workflowScriptResolver";

async function writeWorkflowFile(
  root: string,
  relativePath: string,
  source = "export default function workflow() {}"
) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, source, "utf-8");
  return target;
}

describe("resolveWorkflowScript", () => {
  test("resolves a trusted project skill workflow by explicit skill path", async () => {
    using tempDir = new TestTempDir("workflow-script-project-skill");
    await writeProjectSkill(tempDir.path, "research", {
      files: { "workflow.js": "export const meta = { name: 'Research' };" },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://research/workflow.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
    });

    expect(resolved.source).toContain("Research");
    expect(resolved.sourceKind).toBe("skill");
    expect(resolved.skillName).toBe("research");
    expect(resolved.scope).toBe("project");
    expect(resolved.relativePath).toBe("workflow.js");
    expect(resolved.canonicalScriptPath).toBe("skill://research/workflow.js");
  });

  test("resolves project skill workflow files through remote runtime containment", async () => {
    using tempDir = new TestTempDir("workflow-script-remote-project-skill");
    const remoteWorkspacePath = "/remote/workspace";
    await writeProjectSkill(tempDir.path, "research", {
      files: { "workflow.js": "export const meta = { name: 'RemoteResearch' };" },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://research/workflow.js",
      runtime: new TrueRemotePathMappedRuntime(tempDir.path, remoteWorkspacePath),
      workspacePath: remoteWorkspacePath,
      projectTrusted: true,
    });

    expect(resolved.source).toContain("RemoteResearch");
    expect(resolved.scope).toBe("project");
    expect(resolved.resolvedPath).toBe(`${remoteWorkspacePath}/.mux/skills/research/workflow.js`);
  });

  test("blocks project skill workflow scripts when the project is untrusted", async () => {
    using tempDir = new TestTempDir("workflow-script-untrusted-project-skill");
    await writeProjectSkill(tempDir.path, "research", {
      files: { "workflow.js": "export default function workflow() {}" },
    });

    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research/workflow.js",
        runtime: new LocalRuntime(tempDir.path),
        workspacePath: tempDir.path,
        projectTrusted: false,
      })
    ).rejects.toThrow("Project trust is required");
  });

  test("resolves a global skill workflow when no project skill shadows it", async () => {
    using tempDir = new TestTempDir("workflow-script-global-skill");
    const muxHome = path.join(tempDir.path, "mux-home");
    await writeGlobalSkill(muxHome, "research", {
      files: { "workflow.js": "export default function workflow() { return 'global'; }" },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://research/workflow.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: false,
      roots: {
        projectRoot: path.join(tempDir.path, ".mux", "skills"),
        globalRoot: path.join(muxHome, "skills"),
      },
    });

    expect(resolved.source).toContain("global");
    expect(resolved.scope).toBe("global");
  });

  test("resolves a built-in skill workflow by explicit skill path", async () => {
    using tempDir = new TestTempDir("workflow-script-built-in-skill");

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://workflow-smoke/workflow.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: false,
    });

    expect(resolved.source).toContain("Workflow Smoke");
    expect(resolved.sourceKind).toBe("skill");
    expect(resolved.skillName).toBe("workflow-smoke");
    expect(resolved.scope).toBe("built-in");
    expect(resolved.relativePath).toBe("workflow.js");
    expect(resolved.canonicalScriptPath).toBe("skill://workflow-smoke/workflow.js");
  });

  test("resolves an explicit trusted workspace JavaScript file", async () => {
    using tempDir = new TestTempDir("workflow-script-workspace-file");
    await writeWorkflowFile(
      tempDir.path,
      "workflows/smoke.js",
      "export default function workflow() { return 'ok'; }"
    );

    const resolved = await resolveWorkflowScript({
      scriptPath: "./workflows/smoke.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
    });

    expect(resolved.sourceKind).toBe("workspace-file");
    expect(resolved.source).toContain("ok");
    expect(resolved.resolvedPath).toBe(path.join(tempDir.path, "workflows", "smoke.js"));
    expect(resolved.canonicalScriptPath).toBe("./workflows/smoke.js");
  });

  test("rejects missing paths, directories, non-js files, traversal, and untrusted workspace files", async () => {
    using tempDir = new TestTempDir("workflow-script-invalid");
    await fs.mkdir(path.join(tempDir.path, "workflows", "dir.js"), { recursive: true });
    await writeWorkflowFile(tempDir.path, "workflows/readme.md", "not js");
    const runtime = new LocalRuntime(tempDir.path);

    await expect(
      resolveWorkflowScript({
        scriptPath: "./missing.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow();
    await expect(
      resolveWorkflowScript({
        scriptPath: "./workflows/dir.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("regular JavaScript file");
    await expect(
      resolveWorkflowScript({
        scriptPath: "./workflows/readme.md",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow(".js");
    await expect(
      resolveWorkflowScript({
        scriptPath: "../outside.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("outside the workspace");
    await expect(
      resolveWorkflowScript({
        scriptPath: "./workflows/readme.md",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: false,
      })
    ).rejects.toThrow("Project trust is required");
  });

  test("rejects malformed skill script paths", async () => {
    using tempDir = new TestTempDir("workflow-script-malformed-skill");
    const runtime = new LocalRuntime(tempDir.path);

    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("must include a relative .js file path");
    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research/../workflow.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("path traversal");
    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research/workflow.ts",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow(".js");
  });
});
