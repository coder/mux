import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { RUNTIME_MODE } from "@/common/types/runtime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { TrueRemotePathMappedRuntime } from "@/node/services/tools/testHelpers";
import { execFileAsync } from "@/node/utils/disposableExec";
import {
  shouldDisableHostWorkflowActions,
  shouldUseRuntimeWorkflowProjectIO,
  WorkflowDefinitionStore,
} from "./WorkflowDefinitionStore";

async function writeWorkflow(
  root: string,
  name: string,
  description: string,
  body = "return args;"
) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, `${name}.js`),
    `// description: ${description}\nexport default async function workflow({ args }) { ${body} }\n`,
    "utf-8"
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  using proc = execFileAsync("git", ["-C", cwd, ...args], { timeoutMs: 5_000 });
  const result = await proc.result;
  return result.stdout.replace(/\r?\n$/u, "");
}

async function readGitExclude(repoPath: string): Promise<string> {
  const excludePath = await runGit(repoPath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  try {
    return await fs.readFile(excludePath, "utf-8");
  } catch {
    return "";
  }
}

describe("WorkflowDefinitionStore", () => {
  test("uses runtime project I/O only when workspace paths are runtime-owned", () => {
    expect(shouldUseRuntimeWorkflowProjectIO(RUNTIME_MODE.LOCAL)).toBe(false);
    expect(shouldUseRuntimeWorkflowProjectIO(RUNTIME_MODE.WORKTREE)).toBe(false);
    expect(shouldUseRuntimeWorkflowProjectIO(RUNTIME_MODE.DEVCONTAINER)).toBe(false);
    expect(shouldUseRuntimeWorkflowProjectIO(RUNTIME_MODE.SSH)).toBe(true);
    expect(shouldUseRuntimeWorkflowProjectIO(RUNTIME_MODE.DOCKER)).toBe(true);
  });

  test("disables host workflow actions for remote and devcontainer runtimes", () => {
    expect(shouldDisableHostWorkflowActions(RUNTIME_MODE.LOCAL)).toBe(false);
    expect(shouldDisableHostWorkflowActions(RUNTIME_MODE.WORKTREE)).toBe(false);
    expect(shouldDisableHostWorkflowActions(RUNTIME_MODE.DEVCONTAINER)).toBe(true);
    expect(shouldDisableHostWorkflowActions(RUNTIME_MODE.SSH)).toBe(true);
    expect(shouldDisableHostWorkflowActions(RUNTIME_MODE.DOCKER)).toBe(true);
  });

  test("discovers workflows by project, global, then built-in precedence when trusted", async () => {
    using tmp = new DisposableTempDir("workflow-definitions");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(projectRoot, "demo", "Project demo");
    await writeWorkflow(globalRoot, "demo", "Global demo");
    await writeWorkflow(globalRoot, "global-only", "Global only");

    const store = new WorkflowDefinitionStore({
      projectRoot,
      globalRoot,
      builtIns: [
        { name: "demo", description: "Built-in demo", source: "export default () => null;" },
        {
          name: "deep-research",
          description: "Built-in research",
          source: "export default () => null;",
        },
      ],
    });

    const definitions = await store.listDefinitions({ projectTrusted: true });

    expect(definitions.map((definition) => [definition.name, definition.scope])).toEqual([
      ["deep-research", "built-in"],
      ["demo", "project"],
      ["global-only", "global"],
    ]);
    expect(definitions.find((definition) => definition.name === "demo")?.description).toBe(
      "Project demo"
    );
  });

  test("omits project-local workflows when the project is not trusted", async () => {
    using tmp = new DisposableTempDir("workflow-definitions");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(projectRoot, "demo", "Project demo");
    await writeWorkflow(globalRoot, "demo", "Global demo");

    const store = new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] });

    const definitions = await store.listDefinitions({ projectTrusted: false });

    expect(definitions).toEqual([
      {
        name: "demo",
        description: "Global demo",
        scope: "global",
        sourcePath: path.join(globalRoot, "demo.js"),
        executable: true,
      },
    ]);
  });

  test("reads the selected reusable definition source", async () => {
    using tmp = new DisposableTempDir("workflow-definitions");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(projectRoot, "demo", "Project demo", "return { project: true };");

    const store = new WorkflowDefinitionStore({
      projectRoot,
      globalRoot,
      builtIns: [
        {
          name: "scratch-example",
          description: "Built-in fallback",
          source: "export default () => null;",
        },
      ],
    });

    const definition = await store.readDefinition("demo", { projectTrusted: true });
    const discovered = await store.listDefinitions({ projectTrusted: true });

    expect(definition.source).toContain("project: true");
    expect(definition.descriptor.scope).toBe("project");
    expect(discovered.every((candidate) => candidate.scope !== "scratch")).toBe(true);
  });

  test("does not create workspace scratch files while listing without scratch drafts", async () => {
    using tmp = new DisposableTempDir("workflow-definitions");
    const workspaceRoot = path.join(tmp.path, "project");
    const scratchRoot = path.join(workspaceRoot, ".mux", "workflows", ".scratch");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await runGit(workspaceRoot, ["init"]);
    const store = new WorkflowDefinitionStore({
      scratchRoot,
      projectRoot,
      globalRoot,
      builtIns: [],
    });

    const definitions = await store.listDefinitions({ projectTrusted: true });

    let muxDirExists = true;
    try {
      await fs.stat(path.join(workspaceRoot, ".mux"));
    } catch {
      muxDirExists = false;
    }
    const gitExclude = await readGitExclude(workspaceRoot);
    expect(definitions).toEqual([]);
    expect(muxDirExists).toBe(false);
    expect(gitExclude).not.toContain(".mux/workflows/.scratch");
    expect(await runGit(workspaceRoot, ["status", "--short"])).toBe("");
  });

  test("discovers trusted workspace scratch workflows before reusable definitions and excludes scratch locally", async () => {
    using tmp = new DisposableTempDir("workflow-definitions");
    const repoRoot = path.join(tmp.path, "repo");
    const workspaceRoot = path.join(repoRoot, "packages", "app");
    const scratchRoot = path.join(workspaceRoot, ".mux", "workflows", ".scratch");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await writeWorkflow(globalRoot, "scratch-demo", "Global fallback");
    await writeWorkflow(
      scratchRoot,
      "scratch-demo",
      "Workspace scratch demo",
      "return { reportMarkdown: 'scratch' };"
    );
    const store = new WorkflowDefinitionStore({
      scratchRoot,
      projectRoot,
      globalRoot,
      builtIns: [
        {
          name: "scratch-demo",
          description: "Built-in fallback",
          source: "export default () => null;",
        },
      ],
    });

    const definitions = await store.listDefinitions({ projectTrusted: true });
    const definition = await store.readDefinition("scratch-demo", { projectTrusted: true });
    const gitExclude = await readGitExclude(workspaceRoot);

    expect(definitions).toEqual([
      {
        name: "scratch-demo",
        description: "Workspace scratch demo",
        scope: "scratch",
        sourcePath: path.join(scratchRoot, "scratch-demo.js"),
        executable: true,
      },
    ]);
    expect(definition.descriptor.scope).toBe("scratch");
    expect(definition.source).toContain("// description: Workspace scratch demo");
    expect(definition.source).toContain("reportMarkdown: 'scratch'");
    expect(await pathExists(path.join(scratchRoot, ".gitignore"))).toBe(false);
    expect(gitExclude).toContain("# mux: local scratch workflow drafts");
    expect(gitExclude).toContain("/packages/app/.mux/workflows/.scratch/");
    expect(
      await runGit(repoRoot, ["status", "--short", "--", "packages/app/.mux/workflows/.scratch"])
    ).toBe("");

    await writeWorkflow(projectRoot, "project-demo", "Project demo");
    expect(
      await runGit(repoRoot, [
        "status",
        "--short",
        "--",
        "packages/app/.mux/workflows/project-demo.js",
      ])
    ).toBe("?? packages/app/.mux/workflows/project-demo.js");
  });

  test("locally excludes an existing generated scratch gitignore", async () => {
    using tmp = new DisposableTempDir("workflow-definitions");
    const workspaceRoot = path.join(tmp.path, "project");
    const scratchRoot = path.join(workspaceRoot, ".mux", "workflows", ".scratch");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await fs.mkdir(scratchRoot, { recursive: true });
    await runGit(workspaceRoot, ["init"]);
    await fs.writeFile(path.join(scratchRoot, ".gitignore"), "*\n!.gitignore\n", "utf-8");
    const store = new WorkflowDefinitionStore({
      scratchRoot,
      projectRoot,
      globalRoot,
      builtIns: [],
    });

    const definitions = await store.listDefinitions({ projectTrusted: true });

    const gitExclude = await readGitExclude(workspaceRoot);
    expect(definitions).toEqual([]);
    expect(gitExclude).toContain("/.mux/workflows/.scratch/");
    expect(await runGit(workspaceRoot, ["status", "--short"])).toBe("");
  });

  test("omits workspace scratch workflows when the project is not trusted", async () => {
    using tmp = new DisposableTempDir("workflow-definitions");
    const workspaceRoot = path.join(tmp.path, "project");
    const scratchRoot = path.join(workspaceRoot, ".mux", "workflows", ".scratch");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(globalRoot, "scratch-demo", "Global fallback");
    await writeWorkflow(scratchRoot, "scratch-demo", "Untrusted scratch demo");
    const store = new WorkflowDefinitionStore({
      scratchRoot,
      projectRoot,
      globalRoot,
      builtIns: [],
    });

    const definitions = await store.listDefinitions({ projectTrusted: false });
    const definition = await store.readDefinition("scratch-demo", { projectTrusted: false });

    expect(definitions).toEqual([
      {
        name: "scratch-demo",
        description: "Global fallback",
        scope: "global",
        sourcePath: path.join(globalRoot, "scratch-demo.js"),
        executable: true,
      },
    ]);
    expect(definition.descriptor.scope).toBe("global");
  });

  test("uses runtime I/O for project workflow discovery and promotion", async () => {
    using tmp = new DisposableTempDir("workflow-definitions");
    const remoteBase = "/remote-workspaces";
    const workspacePath = path.posix.join(remoteBase, "project", "feature");
    const runtime = new TrueRemotePathMappedRuntime(tmp.path, remoteBase);
    const projectRoot = runtime.normalizePath(".mux/workflows", workspacePath);
    const scratchRoot = runtime.normalizePath(".mux/workflows/.scratch", workspacePath);
    const localWorkspaceRoot = path.join(tmp.path, "project", "feature");
    const localWorkflowRoot = path.join(localWorkspaceRoot, ".mux", "workflows");
    const localScratchRoot = path.join(localWorkflowRoot, ".scratch");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await fs.mkdir(localWorkspaceRoot, { recursive: true });
    await runGit(localWorkspaceRoot, ["init"]);
    await writeWorkflow(
      localWorkflowRoot,
      "remote-demo",
      "Remote project demo",
      "return { remote: true };"
    );
    await writeWorkflow(
      localScratchRoot,
      "scratch-remote",
      "Remote scratch demo",
      "return { scratch: true };"
    );

    const store = new WorkflowDefinitionStore({
      projectRoot,
      scratchRoot,
      projectRuntime: runtime,
      projectCwd: workspacePath,
      globalRoot,
      builtIns: [],
    });

    const definition = await store.readDefinition("remote-demo", { projectTrusted: true });
    const scratchDefinition = await store.readDefinition("scratch-remote", {
      projectTrusted: true,
    });
    const promoted = await store.promoteDefinition({
      name: "promoted-demo",
      description: "Promoted over runtime",
      source: "export default function workflow() { return { reportMarkdown: 'ok' }; }",
      location: "project",
      overwrite: false,
      projectTrusted: true,
    });

    expect(definition.descriptor.sourcePath).toBe(`${projectRoot}/remote-demo.js`);
    expect(definition.source).toContain("remote: true");
    expect(scratchDefinition.descriptor.sourcePath).toBe(`${scratchRoot}/scratch-remote.js`);
    expect(scratchDefinition.source).toContain("scratch: true");
    expect(await pathExists(path.join(localScratchRoot, ".gitignore"))).toBe(false);
    expect(await readGitExclude(localWorkspaceRoot)).toContain("/.mux/workflows/.scratch/");
    expect(promoted.sourcePath).toBe(`${projectRoot}/promoted-demo.js`);
    const promotedSource = await fs.readFile(
      path.join(localWorkflowRoot, "promoted-demo.js"),
      "utf-8"
    );
    expect(promotedSource).toContain("// description: Promoted over runtime");

    let duplicateError: unknown;
    try {
      await store.promoteDefinition({
        name: "promoted-demo",
        description: "Duplicate",
        source: "export default function workflow() { return null; }",
        location: "project",
        overwrite: false,
        projectTrusted: true,
      });
    } catch (error) {
      duplicateError = error;
    }
    if (!(duplicateError instanceof Error)) {
      throw new Error("Expected duplicate promotion to fail");
    }
    expect(duplicateError.message).toMatch(/already exists/);
  });

  test("skips invalid filenames and unreadable descriptors", async () => {
    using tmp = new DisposableTempDir("workflow-definitions");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(projectRoot, "valid-name", "Valid workflow");
    await fs.writeFile(path.join(projectRoot, "BadName.js"), "// description: bad\n", "utf-8");
    await fs.writeFile(
      path.join(projectRoot, "missing-description.js"),
      "export default () => null;",
      "utf-8"
    );

    const store = new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] });

    const definitions = await store.listDefinitions({ projectTrusted: true });

    expect(definitions.map((definition) => definition.name)).toEqual(["valid-name"]);
  });
});
