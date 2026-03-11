import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { SkillNameSchema } from "@/common/orpc/schemas";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { RemoteRuntime, type SpawnResult } from "@/node/runtime/RemoteRuntime";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  discoverAgentSkills,
  discoverAgentSkillsDiagnostics,
  getDefaultAgentSkillsRoots,
  readAgentSkill,
} from "./agentSkillsService";

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  const content = `---
name: ${name}
description: ${description}
---
Body
`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");
}

class RemotePathMappedRuntime extends RemoteRuntime {
  private readonly localRuntime: LocalRuntime;
  private readonly localBase: string;
  private readonly remoteBase: string;

  public execCallCount = 0;

  constructor(localBase: string, remoteBase: string) {
    super();
    this.localRuntime = new LocalRuntime(localBase);
    this.localBase = path.resolve(localBase);
    this.remoteBase = remoteBase === "/" ? remoteBase : remoteBase.replace(/\/+$/u, "");
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

    if (normalizedRuntimePath === this.remoteBase) {
      return this.localBase;
    }

    if (normalizedRuntimePath.startsWith(`${this.remoteBase}/`)) {
      const suffix = normalizedRuntimePath.slice(this.remoteBase.length + 1);
      return path.join(this.localBase, ...suffix.split("/"));
    }

    return runtimePath;
  }

  private toRemotePath(localPath: string): string {
    const resolvedLocalPath = path.resolve(localPath);

    if (resolvedLocalPath === this.localBase) {
      return this.remoteBase;
    }

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
    this.execCallCount += 1;

    const translatedCommand = command
      .split(this.remoteBase)
      .join(this.localBase.replaceAll("\\", "/"));

    return this.localRuntime.exec(translatedCommand, {
      ...options,
      cwd: this.toLocalPath(options.cwd),
    });
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
    return Promise.resolve({
      success: false,
      error: "createWorkspace not implemented in test runtime",
    });
  }

  override initWorkspace(
    _params: Parameters<LocalRuntime["initWorkspace"]>[0]
  ): ReturnType<LocalRuntime["initWorkspace"]> {
    return Promise.resolve({
      success: false,
      error: "initWorkspace not implemented in test runtime",
    });
  }

  override renameWorkspace(
    _projectPath: string,
    _oldName: string,
    _newName: string,
    _abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["renameWorkspace"]> {
    return Promise.resolve({
      success: false,
      error: "renameWorkspace not implemented in test runtime",
    });
  }

  override deleteWorkspace(
    _projectPath: string,
    _workspaceName: string,
    _force: boolean,
    _abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["deleteWorkspace"]> {
    return Promise.resolve({
      success: false,
      error: "deleteWorkspace not implemented in test runtime",
    });
  }

  override forkWorkspace(
    _params: Parameters<LocalRuntime["forkWorkspace"]>[0]
  ): ReturnType<LocalRuntime["forkWorkspace"]> {
    return Promise.resolve({
      success: false,
      error: "forkWorkspace not implemented in test runtime",
    });
  }
}

describe("agentSkillsService", () => {
  test("getDefaultAgentSkillsRoots derives global root from runtime mux home", () => {
    class MuxHomeRuntime extends LocalRuntime {
      constructor(
        workspacePath: string,
        private readonly muxHome: string
      ) {
        super(workspacePath);
      }

      override getMuxHome(): string {
        return this.muxHome;
      }
    }

    const workspacePath = "/workspace/project";

    const dockerRoots = getDefaultAgentSkillsRoots(
      new MuxHomeRuntime(workspacePath, "/var/mux"),
      workspacePath
    );
    expect(dockerRoots.globalRoot).toBe("/var/mux/skills");

    const defaultRoots = getDefaultAgentSkillsRoots(
      new MuxHomeRuntime(workspacePath, "~/.mux"),
      workspacePath
    );
    expect(defaultRoots.globalRoot).toBe("~/.mux/skills");
  });

  test("project skills override global skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(globalSkillsRoot, "foo", "from global");
    await writeSkill(projectSkillsRoot, "foo", "from project");
    await writeSkill(globalSkillsRoot, "bar", "global only");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    // Should include project/global skills plus built-in skills
    // Note: deep-review skill is a project skill in the Mux repo, not a built-in
    expect(skills.map((s) => s.name)).toEqual(["bar", "foo", "init", "mux-diagram", "mux-docs"]);

    const foo = skills.find((s) => s.name === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.description).toBe("from project");

    const bar = skills.find((s) => s.name === "bar");
    expect(bar).toBeDefined();
    expect(bar!.scope).toBe("global");
  });

  test("explicit global-only roots exclude workspace-local skills from discovery", async () => {
    using project = new DisposableTempDir("agent-skills-project-global-only");
    using global = new DisposableTempDir("agent-skills-global-only");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(projectSkillsRoot, "project-only", "from project");
    await writeSkill(globalSkillsRoot, "global-only", "from global");
    await writeSkill(globalSkillsRoot, "shared", "from global");

    const roots = {
      projectRoot: "",
      globalRoot: globalSkillsRoot,
    };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    expect(skills.find((skill) => skill.name === "project-only")).toBeUndefined();
    expect(skills.find((skill) => skill.name === "global-only")).toMatchObject({
      name: "global-only",
      description: "from global",
      scope: "global",
    });
    expect(skills.find((skill) => skill.name === "shared")).toMatchObject({
      name: "shared",
      description: "from global",
      scope: "global",
    });
    expect(skills.find((skill) => skill.name === "init")).toBeDefined();
    expect(skills.find((skill) => skill.name === "mux-docs")).toBeDefined();
  });

  test("project-local devcontainer contexts discover and read host-global skills", async () => {
    using host = new DisposableTempDir("agent-skills-devcontainer-host");

    const projectRoot = path.join(host.path, "project");
    const hostMuxHome = path.join(host.path, "mux-home");
    const projectSkillsRoot = path.join(projectRoot, ".mux", "skills");
    const hostGlobalSkillsRoot = path.join(hostMuxHome, "skills");

    await writeSkill(projectSkillsRoot, "project-skill", "from project");
    await writeSkill(hostGlobalSkillsRoot, "host-global-skill", "from host global");

    const context = resolveSkillStorageContext({
      runtime: new DevcontainerRuntime({
        srcBaseDir: path.join(host.path, "src-base"),
        configPath: path.join(host.path, ".devcontainer", "devcontainer.json"),
      }),
      workspacePath: "/remote/workspace",
      muxScope: {
        type: "project",
        muxHome: hostMuxHome,
        projectRoot,
        projectStorageAuthority: "host-local",
      },
    });

    if (context.kind !== "project-local" || context.roots == null) {
      throw new Error("Expected project-local skill storage context");
    }

    expect(context.runtime).toBeInstanceOf(LocalRuntime);

    const skills = await discoverAgentSkills(context.runtime, context.workspacePath, {
      roots: context.roots,
      containment: context.containment,
    });

    expect(skills.find((skill) => skill.name === "project-skill")).toMatchObject({
      name: "project-skill",
      description: "from project",
      scope: "project",
    });
    expect(skills.find((skill) => skill.name === "host-global-skill")).toMatchObject({
      name: "host-global-skill",
      description: "from host global",
      scope: "global",
    });

    const resolved = await readAgentSkill(
      context.runtime,
      context.workspacePath,
      SkillNameSchema.parse("host-global-skill"),
      {
        roots: context.roots,
        containment: context.containment,
      }
    );

    expect(resolved.package.scope).toBe("global");
    expect(resolved.package.frontmatter.description).toBe("from host global");
  });

  test("non-SSH remote runtimes discover project skills via runtime exec listing", async () => {
    using runtimeBase = new DisposableTempDir("agent-skills-remote-runtime");

    const localWorkspaceRoot = path.join(runtimeBase.path, "workspace");
    await fs.mkdir(localWorkspaceRoot, { recursive: true });

    const localProjectSkillsRoot = path.join(localWorkspaceRoot, ".mux", "skills");
    const localGlobalSkillsRoot = path.join(localWorkspaceRoot, ".mux", "global-skills");
    await writeSkill(localProjectSkillsRoot, "docker-like-skill", "from remote runtime");
    await fs.mkdir(localGlobalSkillsRoot, { recursive: true });

    const remoteWorkspaceRoot = "/remote/workspace";
    const runtime = new RemotePathMappedRuntime(localWorkspaceRoot, remoteWorkspaceRoot);

    const roots = {
      projectRoot: path.posix.join(remoteWorkspaceRoot, ".mux", "skills"),
      globalRoot: path.posix.join(remoteWorkspaceRoot, ".mux", "global-skills"),
    };

    const skills = await discoverAgentSkills(runtime, remoteWorkspaceRoot, { roots });

    expect(runtime.execCallCount).toBeGreaterThan(0);
    expect(skills.find((skill) => skill.name === "docker-like-skill")).toMatchObject({
      name: "docker-like-skill",
      description: "from remote runtime",
      scope: "project",
    });

    runtime.execCallCount = 0;
    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, remoteWorkspaceRoot, {
      roots,
    });

    expect(runtime.execCallCount).toBeGreaterThan(0);
    expect(diagnostics.skills.find((skill) => skill.name === "docker-like-skill")).toMatchObject({
      name: "docker-like-skill",
      description: "from remote runtime",
      scope: "project",
    });
  });

  test("scans universal root after mux global root", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");
    using universal = new DisposableTempDir("agent-skills-universal");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;
    const universalSkillsRoot = universal.path;

    await writeSkill(globalSkillsRoot, "shared", "from global");
    await writeSkill(universalSkillsRoot, "shared", "from universal");
    await writeSkill(universalSkillsRoot, "universal-only", "from universal only");

    const roots = {
      projectRoot: projectSkillsRoot,
      globalRoot: globalSkillsRoot,
      universalRoot: universalSkillsRoot,
    };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    const shared = skills.find((s) => s.name === "shared");
    expect(shared).toBeDefined();
    expect(shared!.scope).toBe("global");
    expect(shared!.description).toBe("from global");

    const universalOnly = skills.find((s) => s.name === "universal-only");
    expect(universalOnly).toBeDefined();
    expect(universalOnly!.scope).toBe("global");
    expect(universalOnly!.description).toBe("from universal only");

    const universalOnlyName = SkillNameSchema.parse("universal-only");
    const resolved = await readAgentSkill(runtime, project.path, universalOnlyName, { roots });
    expect(resolved.package.scope).toBe("global");
    expect(resolved.package.frontmatter.description).toBe("from universal only");
  });

  test("discovers skills from project .agents/skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const projectUniversalSkillsRoot = path.join(project.path, ".agents", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(projectUniversalSkillsRoot, "project-universal", "from project universal");

    const roots = {
      projectRoot: projectSkillsRoot,
      projectUniversalRoot: projectUniversalSkillsRoot,
      globalRoot: globalSkillsRoot,
    };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    const projectUniversal = skills.find((s) => s.name === "project-universal");
    expect(projectUniversal).toBeDefined();
    expect(projectUniversal!.scope).toBe("project");
    expect(projectUniversal!.description).toBe("from project universal");
  });

  test(".mux/skills overrides .agents/skills at project level", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const projectUniversalSkillsRoot = path.join(project.path, ".agents", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(projectUniversalSkillsRoot, "shared-project", "from project universal");
    await writeSkill(projectSkillsRoot, "shared-project", "from project mux");

    const roots = {
      projectRoot: projectSkillsRoot,
      projectUniversalRoot: projectUniversalSkillsRoot,
      globalRoot: globalSkillsRoot,
    };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    const sharedProject = skills.find((s) => s.name === "shared-project");
    expect(sharedProject).toBeDefined();
    expect(sharedProject!.scope).toBe("project");
    expect(sharedProject!.description).toBe("from project mux");
  });

  test("discoverAgentSkillsDiagnostics includes project .agents/skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const projectUniversalSkillsRoot = path.join(project.path, ".agents", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(projectUniversalSkillsRoot, "diag-project-universal", "from diagnostics root");

    const roots = {
      projectRoot: projectSkillsRoot,
      projectUniversalRoot: projectUniversalSkillsRoot,
      globalRoot: globalSkillsRoot,
    };
    const runtime = new LocalRuntime(project.path);

    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, project.path, { roots });

    const diagSkill = diagnostics.skills.find((s) => s.name === "diag-project-universal");
    expect(diagSkill).toBeDefined();
    expect(diagSkill!.scope).toBe("project");
    expect(diagSkill!.description).toBe("from diagnostics root");
  });

  test("readAgentSkill resolves project before global", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(globalSkillsRoot, "foo", "from global");
    await writeSkill(projectSkillsRoot, "foo", "from project");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const name = SkillNameSchema.parse("foo");
    const resolved = await readAgentSkill(runtime, project.path, name, { roots });

    expect(resolved.package.scope).toBe("project");
    expect(resolved.package.frontmatter.description).toBe("from project");
  });

  test("readAgentSkill can read built-in skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const name = SkillNameSchema.parse("mux-docs");
    const resolved = await readAgentSkill(runtime, project.path, name, { roots });

    expect(resolved.package.scope).toBe("built-in");
    expect(resolved.package.frontmatter.name).toBe("mux-docs");
    expect(resolved.skillDir).toBe("<built-in:mux-docs>");
  });

  test("project/global skills override built-in skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    // Override the built-in mux-docs skill with a project-local version
    await writeSkill(projectSkillsRoot, "mux-docs", "custom docs from project");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });
    const muxDocs = skills.find((s) => s.name === "mux-docs");

    expect(muxDocs).toBeDefined();
    expect(muxDocs!.scope).toBe("project");
    expect(muxDocs!.description).toBe("custom docs from project");

    // readAgentSkill should also return the project version
    const name = SkillNameSchema.parse("mux-docs");
    const resolved = await readAgentSkill(runtime, project.path, name, { roots });
    expect(resolved.package.scope).toBe("project");
  });

  test("discoverAgentSkillsDiagnostics surfaces invalid skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(projectSkillsRoot, "foo", "valid");

    // Invalid directory name (fails SkillNameSchema parsing)
    const invalidDirName = "Bad_Skill";
    const invalidDir = path.join(projectSkillsRoot, invalidDirName);
    await fs.mkdir(invalidDir, { recursive: true });

    // Valid directory name but missing SKILL.md
    await fs.mkdir(path.join(projectSkillsRoot, "missing-skill"), { recursive: true });

    // Invalid SKILL.md frontmatter (missing required description)
    const badFrontmatterDir = path.join(projectSkillsRoot, "bad-frontmatter");
    await fs.mkdir(badFrontmatterDir, { recursive: true });
    await fs.writeFile(
      path.join(badFrontmatterDir, "SKILL.md"),
      `---\nname: bad-frontmatter\n---\nBody\n`,
      "utf-8"
    );

    // Mismatched frontmatter.name vs directory name
    const mismatchDir = path.join(projectSkillsRoot, "name-mismatch");
    await fs.mkdir(mismatchDir, { recursive: true });
    await fs.writeFile(
      path.join(mismatchDir, "SKILL.md"),
      `---\nname: other-name\ndescription: mismatch\n---\nBody\n`,
      "utf-8"
    );

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, project.path, { roots });

    expect(diagnostics.skills.map((s) => s.name)).toEqual([
      "foo",
      "init",
      "mux-diagram",
      "mux-docs",
    ]);

    const invalidNames = diagnostics.invalidSkills.map((issue) => issue.directoryName).sort();
    expect(invalidNames).toEqual(
      [invalidDirName, "bad-frontmatter", "missing-skill", "name-mismatch"].sort()
    );

    for (const issue of diagnostics.invalidSkills) {
      expect(issue.scope).toBe("project");
      expect(issue.displayPath).toContain(issue.directoryName);
      expect(issue.message.length).toBeGreaterThan(0);
      expect(issue.hint?.length).toBeGreaterThan(0);
    }

    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === invalidDirName)?.message
    ).toContain("Invalid skill directory name");
    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === "missing-skill")?.message
    ).toContain("SKILL.md is missing");
    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === "bad-frontmatter")?.message
    ).toContain("Invalid SKILL.md frontmatter");
    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === "name-mismatch")?.message
    ).toContain("must match directory name");
  });

  test("discovers symlinked skill directories", async () => {
    using project = new DisposableTempDir("agent-skills-symlink");
    using skillSource = new DisposableTempDir("agent-skills-source");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    await fs.mkdir(projectSkillsRoot, { recursive: true });

    // Create a real skill in a separate location
    await writeSkill(skillSource.path, "my-skill", "A symlinked skill");

    // Symlink the skill directory into the project skills root
    await fs.symlink(
      path.join(skillSource.path, "my-skill"),
      path.join(projectSkillsRoot, "my-skill")
    );

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });
    const found = skills.find((s) => s.name === "my-skill");
    expect(found).toBeDefined();
    expect(found!.description).toBe("A symlinked skill");
    expect(found!.scope).toBe("project");
  });

  test("readAgentSkill reads from symlinked skill directory", async () => {
    using project = new DisposableTempDir("agent-skills-symlink-read");
    using skillSource = new DisposableTempDir("agent-skills-source-read");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    await fs.mkdir(projectSkillsRoot, { recursive: true });

    await writeSkill(skillSource.path, "linked-skill", "Symlinked for reading");
    await fs.symlink(
      path.join(skillSource.path, "linked-skill"),
      path.join(projectSkillsRoot, "linked-skill")
    );

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(project.path);

    const parsed = SkillNameSchema.safeParse("linked-skill");
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("bad name");

    const result = await readAgentSkill(runtime, project.path, parsed.data, { roots });
    expect(result.package.frontmatter.name).toBe("linked-skill");
    expect(result.package.frontmatter.description).toBe("Symlinked for reading");
    expect(result.package.scope).toBe("project");
  });

  test("discovers skill directory via relative symlink", async () => {
    // Mirrors a real-world layout:
    //   <project>/.agents/skills/kalshi-docs/SKILL.md   (real skill)
    //   <project>/.mux/skills/kalshi-docs -> ../../.agents/skills/kalshi-docs  (relative symlink)
    using project = new DisposableTempDir("agent-skills-relative-symlink");

    const projectRoot = project.path;
    const externalSkillsDir = path.join(projectRoot, ".agents", "skills");
    const muxSkillsRoot = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(externalSkillsDir, { recursive: true });
    await fs.mkdir(muxSkillsRoot, { recursive: true });

    // Write the real skill outside .mux/skills/
    await writeSkill(externalSkillsDir, "kalshi-docs", "Kalshi API documentation");

    // Create a relative symlink (../../.agents/skills/kalshi-docs)
    await fs.symlink(
      path.join("..", "..", ".agents", "skills", "kalshi-docs"),
      path.join(muxSkillsRoot, "kalshi-docs")
    );

    const roots = { projectRoot: muxSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(projectRoot);

    // Discovery should find the symlinked skill
    const skills = await discoverAgentSkills(runtime, projectRoot, { roots });
    const found = skills.find((s) => s.name === "kalshi-docs");
    expect(found).toBeDefined();
    expect(found!.description).toBe("Kalshi API documentation");
    expect(found!.scope).toBe("project");

    // readAgentSkill should also resolve through the relative symlink
    const parsed = SkillNameSchema.safeParse("kalshi-docs");
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("bad name");

    const result = await readAgentSkill(runtime, projectRoot, parsed.data, { roots });
    expect(result.package.frontmatter.name).toBe("kalshi-docs");
    expect(result.package.frontmatter.description).toBe("Kalshi API documentation");
  });

  test("runtime containment filters escaped project skills for discovery, diagnostics, and read", async () => {
    using project = new DisposableTempDir("agent-skills-runtime-containment");
    using escapedSource = new DisposableTempDir("agent-skills-runtime-containment-escape");

    const projectRoot = project.path;
    const projectSkillsRoot = path.join(projectRoot, ".mux", "skills");
    const projectUniversalSkillsRoot = path.join(projectRoot, ".agents", "skills");
    await fs.mkdir(projectSkillsRoot, { recursive: true });
    await fs.mkdir(projectUniversalSkillsRoot, { recursive: true });

    const safeSkillName = "runtime-safe-skill";
    const escapedSkillName = "runtime-escaped-skill";

    await writeSkill(projectUniversalSkillsRoot, safeSkillName, "inside project root");
    await writeSkill(escapedSource.path, escapedSkillName, "outside project root");

    await fs.symlink(
      path.join(escapedSource.path, escapedSkillName),
      path.join(projectSkillsRoot, escapedSkillName),
      process.platform === "win32" ? "junction" : "dir"
    );

    const roots = {
      projectRoot: projectSkillsRoot,
      projectUniversalRoot: projectUniversalSkillsRoot,
      globalRoot: "/nonexistent",
    };
    const runtime = new LocalRuntime(projectRoot);
    const containment = { kind: "runtime" as const, root: projectRoot };

    const discovered = await discoverAgentSkills(runtime, projectRoot, {
      roots,
      containment,
    });
    expect(discovered.find((skill) => skill.name === safeSkillName)?.scope).toBe("project");
    expect(discovered.find((skill) => skill.name === escapedSkillName)).toBeUndefined();

    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, projectRoot, {
      roots,
      containment,
    });
    expect(
      diagnostics.invalidSkills.some(
        (issue) =>
          issue.directoryName === escapedSkillName &&
          issue.message.includes("escapes containment root")
      )
    ).toBe(true);

    const safeParsed = SkillNameSchema.parse(safeSkillName);
    const safeResolved = await readAgentSkill(runtime, projectRoot, safeParsed, {
      roots,
      containment,
    });
    expect(safeResolved.package.frontmatter.name).toBe(safeSkillName);

    const escapedParsed = SkillNameSchema.parse(escapedSkillName);
    expect(
      readAgentSkill(runtime, projectRoot, escapedParsed, {
        roots,
        containment,
      })
    ).rejects.toThrow(/not found/i);
  });

  test("runtime containment allows in-workspace SKILL.md symlinks and rejects escaped ones", async () => {
    using project = new DisposableTempDir("agent-skills-runtime-symlinked-skill-md");
    using escapedSource = new DisposableTempDir("agent-skills-runtime-symlinked-skill-md-escape");

    const projectRoot = project.path;
    const projectSkillsRoot = path.join(projectRoot, ".mux", "skills");
    const projectSkillSourcesRoot = path.join(projectRoot, "skill-sources");
    await fs.mkdir(projectSkillsRoot, { recursive: true });
    await fs.mkdir(projectSkillSourcesRoot, { recursive: true });

    const safeSkillName = "runtime-safe-linked-skill";
    const escapedSkillName = "runtime-escaped-linked-skill";

    const safeSkillDir = path.join(projectSkillsRoot, safeSkillName);
    const escapedSkillDir = path.join(projectSkillsRoot, escapedSkillName);
    await fs.mkdir(safeSkillDir, { recursive: true });
    await fs.mkdir(escapedSkillDir, { recursive: true });

    const safeSkillPath = path.join(projectSkillSourcesRoot, `${safeSkillName}.md`);
    const escapedSkillPath = path.join(escapedSource.path, `${escapedSkillName}.md`);
    await fs.writeFile(
      safeSkillPath,
      `---\nname: ${safeSkillName}\ndescription: linked inside workspace\n---\nBody\n`,
      "utf-8"
    );
    await fs.writeFile(
      escapedSkillPath,
      `---\nname: ${escapedSkillName}\ndescription: linked outside workspace\n---\nBody\n`,
      "utf-8"
    );
    await fs.symlink(safeSkillPath, path.join(safeSkillDir, "SKILL.md"), "file");
    await fs.symlink(escapedSkillPath, path.join(escapedSkillDir, "SKILL.md"), "file");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(projectRoot);
    const containment = { kind: "runtime" as const, root: projectRoot };

    const discovered = await discoverAgentSkills(runtime, projectRoot, {
      roots,
      containment,
    });
    expect(discovered.find((skill) => skill.name === safeSkillName)?.scope).toBe("project");
    expect(discovered.find((skill) => skill.name === escapedSkillName)).toBeUndefined();

    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, projectRoot, {
      roots,
      containment,
    });
    expect(
      diagnostics.invalidSkills.find((issue) => issue.directoryName === safeSkillName)
    ).toBeUndefined();
    expect(
      diagnostics.invalidSkills.some(
        (issue) =>
          issue.directoryName === escapedSkillName &&
          issue.message.includes("escapes containment root")
      )
    ).toBe(true);

    const safeResolved = await readAgentSkill(
      runtime,
      projectRoot,
      SkillNameSchema.parse(safeSkillName),
      {
        roots,
        containment,
      }
    );
    expect(safeResolved.package.frontmatter.description).toBe("linked inside workspace");

    expect(
      readAgentSkill(runtime, projectRoot, SkillNameSchema.parse(escapedSkillName), {
        roots,
        containment,
      })
    ).rejects.toThrow(/not found/i);
  });

  test("discovers symlinked SKILL.md inside a real directory", async () => {
    using project = new DisposableTempDir("agent-skills-symlink-file");
    using skillSource = new DisposableTempDir("agent-skills-source-file");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const skillDir = path.join(projectSkillsRoot, "file-linked");
    await fs.mkdir(skillDir, { recursive: true });

    // Write SKILL.md to the source location and symlink just the file
    const sourceSkillMd = path.join(skillSource.path, "SKILL.md");
    await fs.writeFile(
      sourceSkillMd,
      `---\nname: file-linked\ndescription: Symlinked SKILL.md\n---\nBody\n`,
      "utf-8"
    );
    await fs.symlink(sourceSkillMd, path.join(skillDir, "SKILL.md"));

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });
    const found = skills.find((s) => s.name === "file-linked");
    expect(found).toBeDefined();
    expect(found!.description).toBe("Symlinked SKILL.md");
  });
});
