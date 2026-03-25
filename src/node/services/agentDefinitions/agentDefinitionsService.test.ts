import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { AgentIdSchema } from "@/common/orpc/schemas";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { RemoteRuntime, type SpawnResult } from "@/node/runtime/RemoteRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  discoverAgentDefinitions,
  getSkipScopesAboveForKnownScope,
  readAgentDefinition,
  resolveAgentBody,
  resolveAgentFrontmatter,
} from "./agentDefinitionsService";

async function writeAgent(root: string, id: string, name: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const content = `---
name: ${name}
policy:
  base: exec
---
Body
`;
  await fs.writeFile(path.join(root, `${id}.md`), content, "utf-8");
}

class RemotePathMappedRuntime extends RemoteRuntime {
  private readonly localRuntime: LocalRuntime;
  private readonly localBase: string;
  private readonly remoteBase: string;
  private readonly muxHomeOverride: string | null;

  constructor(localBase: string, remoteBase: string, options?: { muxHome?: string }) {
    super();
    this.localRuntime = new LocalRuntime(localBase);
    this.localBase = path.resolve(localBase);
    this.remoteBase = remoteBase === "/" ? remoteBase : remoteBase.replace(/\/+$/u, "");
    this.muxHomeOverride = options?.muxHome ?? null;
  }

  protected readonly commandPrefix = "TestRemoteRuntime";

  protected spawnRemoteProcess(): Promise<SpawnResult> {
    throw new Error("spawnRemoteProcess should not be called in RemotePathMappedRuntime tests");
  }

  protected getBasePath(): string {
    return this.remoteBase;
  }

  protected quoteForRemote(targetPath: string): string {
    return `'${targetPath.replaceAll("'", "'\\''")}'`;
  }

  protected cdCommand(cwd: string): string {
    return `cd ${this.quoteForRemote(cwd)}`;
  }

  private toLocalPath(runtimePath: string): string {
    const normalizedRuntimePath = runtimePath.replaceAll("\\", "/");
    if (normalizedRuntimePath === this.remoteBase) return this.localBase;
    if (normalizedRuntimePath.startsWith(`${this.remoteBase}/`)) {
      const suffix = normalizedRuntimePath.slice(this.remoteBase.length + 1);
      return path.join(this.localBase, ...suffix.split("/"));
    }
    return runtimePath;
  }

  private toRemotePath(localPath: string): string {
    const resolvedLocalPath = path.resolve(localPath);
    if (resolvedLocalPath === this.localBase) return this.remoteBase;
    const localPrefix = `${this.localBase}${path.sep}`;
    if (resolvedLocalPath.startsWith(localPrefix)) {
      const suffix = resolvedLocalPath.slice(localPrefix.length).split(path.sep).join("/");
      return `${this.remoteBase}/${suffix}`;
    }
    return localPath.replaceAll("\\", "/");
  }

  override exec(
    command: string,
    options: Parameters<LocalRuntime["exec"]>[1]
  ): ReturnType<LocalRuntime["exec"]> {
    const translatedCommand = command
      .split(this.remoteBase)
      .join(this.localBase.replaceAll("\\", "/"));
    return this.localRuntime.exec(translatedCommand, {
      ...options,
      cwd: this.toLocalPath(options.cwd),
    });
  }

  override getMuxHome(): string {
    return this.muxHomeOverride ?? super.getMuxHome();
  }

  override normalizePath(targetPath: string, basePath: string): string {
    const normalizedBasePath = this.toRemotePath(basePath);
    return path.posix.resolve(normalizedBasePath, targetPath.replaceAll("\\", "/"));
  }

  override async resolvePath(filePath: string): Promise<string> {
    const resolvedLocalPath = await this.localRuntime.resolvePath(this.toLocalPath(filePath));
    return this.toRemotePath(resolvedLocalPath);
  }

  override getWorkspacePath(projectPath: string, workspaceName: string): string {
    return path.posix.join(this.remoteBase, path.basename(projectPath), workspaceName);
  }

  override stat(filePath: string, abortSignal?: AbortSignal): ReturnType<LocalRuntime["stat"]> {
    return this.localRuntime.stat(this.toLocalPath(filePath), abortSignal);
  }

  override readFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["readFile"]> {
    return this.localRuntime.readFile(this.toLocalPath(filePath), abortSignal);
  }

  override writeFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["writeFile"]> {
    return this.localRuntime.writeFile(this.toLocalPath(filePath), abortSignal);
  }

  override ensureDir(dirPath: string): ReturnType<LocalRuntime["ensureDir"]> {
    return this.localRuntime.ensureDir(this.toLocalPath(dirPath));
  }

  override createWorkspace(
    _params: Parameters<LocalRuntime["createWorkspace"]>[0]
  ): ReturnType<LocalRuntime["createWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override initWorkspace(
    _params: Parameters<LocalRuntime["initWorkspace"]>[0]
  ): ReturnType<LocalRuntime["initWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override renameWorkspace(
    _projectPath: string,
    _oldName: string,
    _newName: string,
    _abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["renameWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override deleteWorkspace(
    _projectPath: string,
    _workspaceName: string,
    _force: boolean,
    _abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["deleteWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override forkWorkspace(
    _params: Parameters<LocalRuntime["forkWorkspace"]>[0]
  ): ReturnType<LocalRuntime["forkWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }
}

class TrackingRemotePathMappedRuntime extends RemotePathMappedRuntime {
  readonly statCalls: string[] = [];

  override stat(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<RemotePathMappedRuntime["stat"]> {
    this.statCalls.push(filePath);
    return super.stat(filePath, abortSignal);
  }
}

describe("agentDefinitionsService", () => {
  test("project agents override global agents", async () => {
    using project = new DisposableTempDir("agent-defs-project");
    using global = new DisposableTempDir("agent-defs-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await writeAgent(globalAgentsRoot, "foo", "Foo (global)");
    await writeAgent(projectAgentsRoot, "foo", "Foo (project)");
    await writeAgent(globalAgentsRoot, "bar", "Bar (global)");

    const roots = { projectRoot: projectAgentsRoot, globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const agents = await discoverAgentDefinitions(runtime, project.path, { roots });

    const foo = agents.find((a) => a.id === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.name).toBe("Foo (project)");

    const bar = agents.find((a) => a.id === "bar");
    expect(bar).toBeDefined();
    expect(bar!.scope).toBe("global");
  });

  test("readAgentDefinition resolves project before global", async () => {
    using project = new DisposableTempDir("agent-defs-project");
    using global = new DisposableTempDir("agent-defs-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await writeAgent(globalAgentsRoot, "foo", "Foo (global)");
    await writeAgent(projectAgentsRoot, "foo", "Foo (project)");

    const roots = { projectRoot: projectAgentsRoot, globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const agentId = AgentIdSchema.parse("foo");
    const pkg = await readAgentDefinition(runtime, project.path, agentId, { roots });

    expect(pkg.scope).toBe("project");
    expect(pkg.frontmatter.name).toBe("Foo (project)");
  });

  test("SSH workspaces discover host-global agents while keeping project overrides on the remote workspace", async () => {
    using project = new DisposableTempDir("agent-defs-ssh-project");
    using global = new DisposableTempDir("agent-defs-ssh-global");

    const remoteWorkspacePath = "/remote/workspace";
    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = path.join(global.path, "agents");

    await writeAgent(globalAgentsRoot, "host-only", "Host Only");
    await writeAgent(globalAgentsRoot, "shared", "Shared (global)");
    await writeAgent(projectAgentsRoot, "shared", "Shared (project)");

    const roots = {
      projectRoot: path.posix.join(remoteWorkspacePath, ".mux", "agents"),
      globalRoot: globalAgentsRoot,
    };
    const runtime = new RemotePathMappedRuntime(project.path, remoteWorkspacePath);

    const agents = await discoverAgentDefinitions(runtime, remoteWorkspacePath, { roots });

    const hostOnly = agents.find((agent) => agent.id === "host-only");
    expect(hostOnly).toBeDefined();
    expect(hostOnly?.scope).toBe("global");
    expect(hostOnly?.name).toBe("Host Only");

    const shared = agents.find((agent) => agent.id === "shared");
    expect(shared).toBeDefined();
    expect(shared?.scope).toBe("project");
    expect(shared?.name).toBe("Shared (project)");

    const hostOnlyPkg = await readAgentDefinition(runtime, remoteWorkspacePath, "host-only", {
      roots,
    });
    expect(hostOnlyPkg.scope).toBe("global");
    expect(hostOnlyPkg.frontmatter.name).toBe("Host Only");
  });

  test("SSH workspaces resolve inherited agent bodies across host-global and remote project roots", async () => {
    using project = new DisposableTempDir("agent-defs-ssh-body-project");
    using global = new DisposableTempDir("agent-defs-ssh-body-global");

    const remoteWorkspacePath = "/remote/workspace";
    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = path.join(global.path, "agents");
    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "base.md"),
      `---\nname: Base\n---\nGlobal instructions.\n`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(projectAgentsRoot, "child.md"),
      `---\nname: Child\nbase: base\n---\nProject instructions.\n`,
      "utf-8"
    );

    const roots = {
      projectRoot: path.posix.join(remoteWorkspacePath, ".mux", "agents"),
      globalRoot: globalAgentsRoot,
    };
    const runtime = new RemotePathMappedRuntime(project.path, remoteWorkspacePath);

    const body = await resolveAgentBody(runtime, remoteWorkspacePath, "child", { roots });
    expect(body).toContain("Global instructions.");
    expect(body).toContain("Project instructions.");
  });

  test("docker-like remote runtimes keep global agent reads on the runtime filesystem", async () => {
    using runtimeBase = new DisposableTempDir("agent-defs-docker-global-runtime");

    const remoteRuntimeRoot = "/var";
    const remoteWorkspacePath = "/var/workspace";
    const runtimeWorkspaceRoot = path.join(runtimeBase.path, "workspace");
    const runtimeGlobalAgentsRoot = path.join(runtimeBase.path, "global-agents");
    await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });
    await writeAgent(runtimeGlobalAgentsRoot, "docker-global", "Docker Global");

    const roots = {
      projectRoot: path.posix.join(remoteWorkspacePath, ".mux", "agents"),
      globalRoot: path.posix.join(remoteRuntimeRoot, "global-agents"),
    };
    const runtime = new RemotePathMappedRuntime(runtimeBase.path, remoteRuntimeRoot, {
      muxHome: "/var/mux",
    });

    const agents = await discoverAgentDefinitions(runtime, remoteWorkspacePath, { roots });

    expect(agents.find((agent) => agent.id === "docker-global")).toMatchObject({
      id: "docker-global",
      name: "Docker Global",
      scope: "global",
    });

    const pkg = await readAgentDefinition(runtime, remoteWorkspacePath, "docker-global", {
      roots,
    });
    expect(pkg.scope).toBe("global");
    expect(pkg.frontmatter.name).toBe("Docker Global");
  });

  test("known global-scope resolution skips remote project probes during inheritance", async () => {
    using project = new DisposableTempDir("agent-defs-ssh-frontmatter-project");
    using global = new DisposableTempDir("agent-defs-ssh-frontmatter-global");

    const remoteWorkspacePath = "/remote/workspace";
    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = path.join(global.path, "agents");
    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "asklike.md"),
      `---\nname: Ask Like\nbase: exec\n---\nAsk-like body.\n`,
      "utf-8"
    );

    const roots = {
      projectRoot: path.posix.join(remoteWorkspacePath, ".mux", "agents"),
      globalRoot: globalAgentsRoot,
    };
    const runtime = new TrackingRemotePathMappedRuntime(project.path, remoteWorkspacePath);

    const descriptors = await discoverAgentDefinitions(runtime, remoteWorkspacePath, { roots });
    const askLike = descriptors.find((descriptor) => descriptor.id === "asklike");
    expect(askLike).toBeDefined();
    expect(askLike?.scope).toBe("global");

    const frontmatter = await resolveAgentFrontmatter(runtime, remoteWorkspacePath, "asklike", {
      roots,
      skipScopesAbove: getSkipScopesAboveForKnownScope(askLike!.scope),
    });

    expect(frontmatter.name).toBe("Ask Like");
    expect(runtime.statCalls.some((filePath) => filePath.endsWith("/.mux/agents/exec.md"))).toBe(
      false
    );
  });

  test("resolveAgentBody appends by default (new default), replaces when prompt.append is false", async () => {
    using tempDir = new DisposableTempDir("agent-body-test");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    // Create base agent
    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
tools:
  add:
    - .*
---
Base instructions.
`,
      "utf-8"
    );

    // Create child agent that appends (default behavior)
    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
---
Child additions.
`,
      "utf-8"
    );

    // Create another child that explicitly replaces
    await fs.writeFile(
      path.join(agentsRoot, "replacer.md"),
      `---
name: Replacer
base: base
prompt:
  append: false
---
Replaced body.
`,
      "utf-8"
    );

    const roots = { projectRoot: agentsRoot, globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    // Child without explicit prompt settings should append (new default)
    const childBody = await resolveAgentBody(runtime, tempDir.path, "child", { roots });
    expect(childBody).toContain("Base instructions.");
    expect(childBody).toContain("Child additions.");

    // Child with prompt.append: false should replace (explicit opt-out)
    const replacerBody = await resolveAgentBody(runtime, tempDir.path, "replacer", { roots });
    expect(replacerBody).toBe("Replaced body.\n");
    expect(replacerBody).not.toContain("Base instructions");
  });

  test("project plan agents can replace the built-in plan prompt body without losing inherited frontmatter", async () => {
    using tempDir = new DisposableTempDir("agent-plan-guidance");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "custom-plan.md"),
      `---
name: Custom Plan
base: plan
prompt:
  append: false
---
Custom planning instructions.
`,
      "utf-8"
    );

    const runtime = new LocalRuntime(tempDir.path);

    const customPlanBody = await resolveAgentBody(runtime, tempDir.path, "custom-plan");
    expect(customPlanBody).toBe("Custom planning instructions.\n");

    const customPlanFrontmatter = await resolveAgentFrontmatter(
      runtime,
      tempDir.path,
      "custom-plan"
    );
    expect(customPlanFrontmatter.tools?.require).toEqual(["propose_plan"]);
  });
  test("same-name override: project agent with base: self extends built-in/global, not itself", async () => {
    using project = new DisposableTempDir("agent-same-name");
    using global = new DisposableTempDir("agent-same-name-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    // Global "foo" agent (simulates built-in or global config)
    await fs.writeFile(
      path.join(globalAgentsRoot, "foo.md"),
      `---
name: Foo
tools:
  add:
    - .*
---
Global foo instructions.
`,
      "utf-8"
    );

    // Project-local "foo" agent that extends the global one via base: foo
    // This should NOT cause a circular dependency (would previously infinite loop)
    await fs.writeFile(
      path.join(projectAgentsRoot, "foo.md"),
      `---
name: Foo
base: foo
---
Project-specific additions.
`,
      "utf-8"
    );

    const roots = { projectRoot: projectAgentsRoot, globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    // Verify project agent is discovered
    const agents = await discoverAgentDefinitions(runtime, project.path, { roots });
    const foo = agents.find((a) => a.id === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.base).toBe("foo"); // Points to itself by name

    // Verify body resolution correctly inherits from global (not self)
    const body = await resolveAgentBody(runtime, project.path, "foo", { roots });
    expect(body).toContain("Global foo instructions.");
    expect(body).toContain("Project-specific additions.");
  });

  test("readAgentDefinition with skipScopesAbove skips higher-priority scopes", async () => {
    using project = new DisposableTempDir("agent-skip-scope");
    using global = new DisposableTempDir("agent-skip-scope-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "test.md"),
      `---
name: Test Global
---
Global body.
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(projectAgentsRoot, "test.md"),
      `---
name: Test Project
---
Project body.
`,
      "utf-8"
    );

    const roots = { projectRoot: projectAgentsRoot, globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    // Without skip: project takes precedence
    const normalPkg = await readAgentDefinition(runtime, project.path, "test", { roots });
    expect(normalPkg.scope).toBe("project");
    expect(normalPkg.frontmatter.name).toBe("Test Project");

    // With skipScopesAbove: "project" → skip project, return global
    const skippedPkg = await readAgentDefinition(runtime, project.path, "test", {
      roots,
      skipScopesAbove: "project",
    });
    expect(skippedPkg.scope).toBe("global");
    expect(skippedPkg.frontmatter.name).toBe("Test Global");
  });

  test("resolveAgentFrontmatter inherits omitted fields from base chain (same-name override)", async () => {
    using project = new DisposableTempDir("agent-frontmatter-project");
    using global = new DisposableTempDir("agent-frontmatter-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "foo.md"),
      `---
name: Foo Base
description: Base description
ui:
  hidden: true
  color: red
  requires:
    - plan
subagent:
  runnable: true
  append_prompt: Base subagent prompt
  skip_init_hook: true
ai:
  model: base-model
  thinkingLevel: high
tools:
  add:
    - baseAdd
  remove:
    - baseRemove
---
Base body.
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(projectAgentsRoot, "foo.md"),
      `---
name: Foo Project
base: foo
ui:
  color: blue
---
Project body.
`,
      "utf-8"
    );

    const roots = { projectRoot: projectAgentsRoot, globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, project.path, "foo", { roots });

    expect(frontmatter.description).toBe("Base description");
    expect(frontmatter.ui?.hidden).toBe(true);
    expect(frontmatter.ui?.color).toBe("blue");
    expect(frontmatter.ui?.requires).toEqual(["plan"]);
    expect(frontmatter.subagent?.runnable).toBe(true);
    expect(frontmatter.subagent?.append_prompt).toBe("Base subagent prompt");
    expect(frontmatter.subagent?.skip_init_hook).toBe(true);
    expect(frontmatter.ai?.model).toBe("base-model");
    expect(frontmatter.ai?.thinkingLevel).toBe("high");
    expect(frontmatter.tools?.add).toEqual(["baseAdd"]);
    expect(frontmatter.tools?.remove).toEqual(["baseRemove"]);
  });

  test("resolveAgentFrontmatter preserves explicit falsy overrides", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-falsy");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
ui:
  hidden: true
subagent:
  runnable: true
  skip_init_hook: true
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
ui:
  hidden: false
subagent:
  runnable: false
  skip_init_hook: false
---
`,
      "utf-8"
    );

    const roots = { projectRoot: agentsRoot, globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, tempDir.path, "child", { roots });

    expect(frontmatter.ui?.hidden).toBe(false);
    expect(frontmatter.subagent?.runnable).toBe(false);
    expect(frontmatter.subagent?.skip_init_hook).toBe(false);
  });

  test("resolveAgentFrontmatter concatenates add/remove and overrides require with child value", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-tools");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
tools:
  add:
    - a
  remove:
    - b
  require:
    - switch_agent
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
tools:
  add:
    - c
  remove:
    - d
  require:
    - agent_report
---
`,
      "utf-8"
    );

    const roots = { projectRoot: agentsRoot, globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, tempDir.path, "child", { roots });

    expect(frontmatter.tools?.add).toEqual(["a", "c"]);
    expect(frontmatter.tools?.remove).toEqual(["b", "d"]);
    expect(frontmatter.tools?.require).toEqual(["agent_report"]);
  });

  test("resolveAgentFrontmatter detects cycles", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-cycle");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "a.md"),
      `---
name: A
base: b
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "b.md"),
      `---
name: B
base: a
---
`,
      "utf-8"
    );

    const roots = { projectRoot: agentsRoot, globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    expect(resolveAgentFrontmatter(runtime, tempDir.path, "a", { roots })).rejects.toThrow(
      "Circular agent inheritance detected"
    );
  });
});
