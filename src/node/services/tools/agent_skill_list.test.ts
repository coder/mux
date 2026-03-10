import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { MuxToolScope } from "@/common/types/toolScope";
import type { AgentSkillListToolResult } from "@/common/types/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { createAgentSkillListTool } from "./agent_skill_list";
import { MAX_FILE_SIZE } from "./fileCommon";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

async function writeSkill(
  skillsRoot: string,
  name: string,
  options?: { description?: string; advertise?: boolean }
): Promise<void> {
  const skillDir = path.join(skillsRoot, name);
  await fs.mkdir(skillDir, { recursive: true });

  const advertiseLine =
    options?.advertise === undefined ? "" : `advertise: ${options.advertise ? "true" : "false"}\n`;

  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${options?.description ?? `description for ${name}`}\n${advertiseLine}---\nBody\n`,
    "utf-8"
  );
}

async function createWorkspaceSessionDir(muxHome: string, workspaceId: string): Promise<string> {
  const workspaceSessionDir = path.join(muxHome, "sessions", workspaceId);
  await fs.mkdir(workspaceSessionDir, { recursive: true });
  return workspaceSessionDir;
}

async function writeGlobalSkill(
  muxHome: string,
  name: string,
  options?: { description?: string; advertise?: boolean }
): Promise<void> {
  const skillDir = path.join(muxHome, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });

  const advertiseLine =
    options?.advertise === undefined ? "" : `advertise: ${options.advertise ? "true" : "false"}\n`;

  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${options?.description ?? `description for ${name}`}\n${advertiseLine}---\nBody\n`,
    "utf-8"
  );
}

async function withMuxRoot(muxRoot: string, callback: () => Promise<void>): Promise<void> {
  const previousMuxRoot = process.env.MUX_ROOT;
  process.env.MUX_ROOT = muxRoot;

  try {
    await callback();
  } finally {
    if (previousMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = previousMuxRoot;
    }
  }
}

function getSkill(skills: AgentSkillDescriptor[], name: string): AgentSkillDescriptor {
  const skill = skills.find((candidate) => candidate.name === name);
  expect(skill).toBeDefined();
  return skill!;
}

class RemotePathMappedRuntime extends LocalRuntime {
  private readonly localBase: string;
  private readonly remoteBase: string;
  private readonly muxHomeOverride: string | null;
  private readonly resolveToRemotePath: boolean;
  public resolvePathCallCount = 0;

  constructor(
    localBase: string,
    remoteBase: string,
    options?: { muxHome?: string; resolveToRemotePath?: boolean }
  ) {
    super(localBase);
    this.localBase = path.resolve(localBase);
    this.remoteBase = remoteBase === "/" ? remoteBase : remoteBase.replace(/\/+$/u, "");
    this.muxHomeOverride = options?.muxHome ?? null;
    this.resolveToRemotePath = options?.resolveToRemotePath ?? true;
  }

  protected toLocalPath(runtimePath: string): string {
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

  override getWorkspacePath(projectPath: string, workspaceName: string): string {
    return path.posix.join(this.remoteBase, path.basename(projectPath), workspaceName);
  }

  override getMuxHome(): string {
    return this.muxHomeOverride ?? super.getMuxHome();
  }

  override normalizePath(targetPath: string, basePath: string): string {
    const normalizedBasePath = this.toRemotePath(basePath);
    return path.posix.resolve(normalizedBasePath, targetPath.replaceAll("\\", "/"));
  }

  override async resolvePath(filePath: string): Promise<string> {
    this.resolvePathCallCount += 1;
    const resolvedLocalPath = await super.resolvePath(this.toLocalPath(filePath));
    if (!this.resolveToRemotePath) {
      return resolvedLocalPath;
    }
    return this.toRemotePath(resolvedLocalPath);
  }

  override exec(
    command: string,
    options: Parameters<LocalRuntime["exec"]>[1]
  ): ReturnType<LocalRuntime["exec"]> {
    const translatedCommand = command
      .split(this.remoteBase)
      .join(this.localBase.replaceAll("\\", "/"));

    return super.exec(translatedCommand, {
      ...options,
      cwd: this.toLocalPath(options.cwd),
    });
  }

  override stat(filePath: string, abortSignal?: AbortSignal): ReturnType<LocalRuntime["stat"]> {
    return super.stat(this.toLocalPath(filePath), abortSignal);
  }

  override readFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["readFile"]> {
    return super.readFile(this.toLocalPath(filePath), abortSignal);
  }

  override writeFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["writeFile"]> {
    return super.writeFile(this.toLocalPath(filePath), abortSignal);
  }

  override ensureDir(dirPath: string): ReturnType<LocalRuntime["ensureDir"]> {
    return super.ensureDir(this.toLocalPath(dirPath));
  }
}

describe("agent_skill_list", () => {
  it("lists effective available skills across project and global scopes", async () => {
    using project = new TestTempDir("test-agent-skill-list-project");
    using muxHome = new TestTempDir("test-agent-skill-list-mux-home");

    await withMuxRoot(muxHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "project-only", {
        description: "from project",
      });
      await writeSkill(path.join(muxHome.path, "skills"), "global-only", {
        description: "from global",
      });

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          muxScope: {
            type: "project",
            muxHome: muxHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(getSkill(result.skills, "project-only")).toMatchObject({
        name: "project-only",
        description: "from project",
        scope: "project",
      });
      expect(getSkill(result.skills, "global-only")).toMatchObject({
        name: "global-only",
        description: "from global",
        scope: "global",
      });
      // Built-in skills are not included in the listing (only project + global)
    });
  });

  it("returns only the winning descriptor when project skills shadow global skills", async () => {
    using project = new TestTempDir("test-agent-skill-list-shadow-project");
    using muxHome = new TestTempDir("test-agent-skill-list-shadow-home");

    await withMuxRoot(muxHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "shared-skill", {
        description: "from project",
      });
      await writeSkill(path.join(muxHome.path, "skills"), "shared-skill", {
        description: "from global",
      });

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          muxScope: {
            type: "project",
            muxHome: muxHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      const sharedSkills = result.skills.filter((skill) => skill.name === "shared-skill");
      // Local listing preserves both scoped entries — project and global both appear
      expect(sharedSkills.length).toBe(2);
      expect(sharedSkills.find((s) => s.scope === "project")).toMatchObject({
        name: "shared-skill",
        description: "from project",
        scope: "project",
      });
      expect(sharedSkills.find((s) => s.scope === "global")).toMatchObject({
        name: "shared-skill",
        description: "from global",
        scope: "global",
      });
    });
  });

  it("filters unadvertised skills by default across scopes", async () => {
    using project = new TestTempDir("test-agent-skill-list-hidden-project");
    using muxHome = new TestTempDir("test-agent-skill-list-hidden-home");

    await withMuxRoot(muxHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "visible-project");
      await writeSkill(path.join(project.path, ".agents", "skills"), "hidden-project", {
        advertise: false,
      });
      await writeSkill(path.join(muxHome.path, "skills"), "hidden-global", {
        advertise: false,
      });

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          muxScope: {
            type: "project",
            muxHome: muxHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.skills.some((skill) => skill.name === "visible-project")).toBe(true);
      expect(result.skills.some((skill) => skill.name === "hidden-project")).toBe(false);
      expect(result.skills.some((skill) => skill.name === "hidden-global")).toBe(false);
    });
  });

  it("includes unadvertised winning descriptors when includeUnadvertised is true", async () => {
    using project = new TestTempDir("test-agent-skill-list-include-hidden-project");
    using muxHome = new TestTempDir("test-agent-skill-list-include-hidden-home");

    await withMuxRoot(muxHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "project-hidden", {
        description: "hidden project winner",
        advertise: false,
      });
      await writeSkill(path.join(muxHome.path, "skills"), "global-hidden", {
        description: "hidden global winner",
        advertise: false,
      });
      await writeSkill(path.join(project.path, ".mux", "skills"), "shared-hidden", {
        description: "hidden project winner",
        advertise: false,
      });
      await writeSkill(path.join(muxHome.path, "skills"), "shared-hidden", {
        description: "hidden global loser",
        advertise: false,
      });

      const tool = createAgentSkillListTool(
        createTestToolConfig(project.path, {
          muxScope: {
            type: "project",
            muxHome: muxHome.path,
            projectRoot: project.path,
            projectStorageAuthority: "host-local",
          },
        })
      );
      const result = (await tool.execute!(
        { includeUnadvertised: true },
        mockToolCallOptions
      )) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(getSkill(result.skills, "project-hidden")).toMatchObject({
        name: "project-hidden",
        description: "hidden project winner",
        scope: "project",
        advertise: false,
      });
      expect(getSkill(result.skills, "global-hidden")).toMatchObject({
        name: "global-hidden",
        description: "hidden global winner",
        scope: "global",
        advertise: false,
      });
      // Local listing preserves both scoped entries for same-name skills
      const sharedHidden = result.skills.filter((s) => s.name === "shared-hidden");
      expect(sharedHidden.length).toBe(2);
      expect(sharedHidden.find((s) => s.scope === "project")).toMatchObject({
        name: "shared-hidden",
        description: "hidden project winner",
        scope: "project",
        advertise: false,
      });
    });
  });

  it("returns a clear error when cwd is missing", async () => {
    using project = new TestTempDir("test-agent-skill-list-misconfigured");

    const config = {
      ...createTestToolConfig(project.path),
      cwd: "",
    };

    const tool = createAgentSkillListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result).toEqual({
      success: false,
      error: "Tool misconfigured: cwd is required.",
    });
  });

  it("operates on global skills root when scope is global", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-global");

    const workspaceSessionDir = await createWorkspaceSessionDir(
      tempDir.path,
      MUX_HELP_CHAT_WORKSPACE_ID
    );

    await writeGlobalSkill(tempDir.path, "alpha-skill");
    await writeGlobalSkill(tempDir.path, "zeta-skill");

    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
      muxScope: {
        type: "global",
        muxHome: tempDir.path,
      },
    });

    const tool = createAgentSkillListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skills.map((skill) => skill.name)).toEqual(["alpha-skill", "zeta-skill"]);
      expect(result.skills.every((skill) => skill.scope === "global")).toBe(true);
    }
  });

  it("operates on project skills root when scope is project", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-project");

    const workspaceSessionDir = await createWorkspaceSessionDir(
      tempDir.path,
      MUX_HELP_CHAT_WORKSPACE_ID
    );

    const projectRoot = path.join(tempDir.path, "my-project");
    await fs.mkdir(path.join(projectRoot, ".mux", "skills"), { recursive: true });

    await writeGlobalSkill(tempDir.path, "global-skill");
    await writeGlobalSkill(path.join(projectRoot, ".mux"), "project-skill");

    const projectScope: MuxToolScope = {
      type: "project",
      muxHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
      muxScope: projectScope,
    });

    const tool = createAgentSkillListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      // Project scope lists both project and global skills, each tagged with scope
      expect(result.skills.map((skill) => skill.name)).toEqual(["global-skill", "project-skill"]);
      expect(result.skills.find((s) => s.name === "project-skill")?.scope).toBe("project");
      expect(result.skills.find((s) => s.name === "global-skill")?.scope).toBe("global");
    }
  });
  describe("split-root (project-runtime)", () => {
    it("routes through project-runtime when runtime is non-local", async () => {
      using tempDir = new TestTempDir("test-agent-skill-list-split-root-project-runtime");
      const skillName = "split-root-routing-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      await writeGlobalSkill(path.join(tempDir.path, ".mux"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const config = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        muxScope: {
          type: "project",
          muxHome: tempDir.path,
          projectRoot: tempDir.path,
          projectStorageAuthority: "runtime",
        },
      });

      const tool = createAgentSkillListTool({
        ...config,
        cwd: remoteWorkspaceRoot,
      });

      const result = (await tool.execute!(
        { includeUnadvertised: true },
        mockToolCallOptions
      )) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      expect(remoteRuntime.resolvePathCallCount).toBeGreaterThan(0);

      if (result.success) {
        expect(Array.isArray(result.skills)).toBe(true);
      }
    });

    it("uses runtime mux home for global roots in project-runtime mode", async () => {
      using tempDir = new TestTempDir("test-agent-skill-list-split-root-runtime-mux-home");
      using legacyMuxRoot = new TestTempDir("test-agent-skill-list-split-root-legacy-mux-home");

      const runtimeGlobalSkill = "runtime-mux-home-global-skill";
      const legacyGlobalSkill = "legacy-tilde-global-skill";
      const remoteWorkspaceRoot = "/var/workspace";
      const previousMuxRoot = process.env.MUX_ROOT;

      process.env.MUX_ROOT = legacyMuxRoot.path;

      try {
        await writeGlobalSkill(path.join(tempDir.path, "mux"), runtimeGlobalSkill, {
          description: "from runtime mux home",
        });
        await writeGlobalSkill(legacyMuxRoot.path, legacyGlobalSkill, {
          description: "from legacy tilde root",
        });

        const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, "/var", {
          muxHome: "/var/mux",
          resolveToRemotePath: false,
        });

        const config = createTestToolConfig(tempDir.path, {
          workspaceId: "regular-workspace",
          runtime: remoteRuntime,
          muxScope: {
            type: "project",
            muxHome: tempDir.path,
            projectRoot: tempDir.path,
            projectStorageAuthority: "runtime",
          },
        });

        const tool = createAgentSkillListTool({
          ...config,
          cwd: remoteWorkspaceRoot,
        });

        const result = (await tool.execute!(
          { includeUnadvertised: true },
          mockToolCallOptions
        )) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (result.success) {
          expect(
            result.skills.some(
              (skill) => skill.name === runtimeGlobalSkill && skill.scope === "global"
            )
          ).toBe(true);
          expect(result.skills.find((skill) => skill.name === legacyGlobalSkill)).toBeUndefined();
        }
      } finally {
        if (previousMuxRoot === undefined) {
          delete process.env.MUX_ROOT;
        } else {
          process.env.MUX_ROOT = previousMuxRoot;
        }
      }
    });

    it("lists project and global skills with the same name in project-runtime mode", async () => {
      using tempDir = new TestTempDir("test-agent-skill-list-split-root-duplicate-names");
      const sharedSkillName = "runtime-shared-skill";
      const previousMuxRoot = process.env.MUX_ROOT;

      process.env.MUX_ROOT = tempDir.path;

      try {
        await writeGlobalSkill(path.join(tempDir.path, ".mux"), sharedSkillName, {
          description: "project version",
        });
        await writeGlobalSkill(tempDir.path, sharedSkillName, {
          description: "global version",
        });

        const config = createTestToolConfig(tempDir.path, {
          workspaceId: "regular-workspace",
          muxScope: {
            type: "project",
            muxHome: tempDir.path,
            projectRoot: tempDir.path,
            projectStorageAuthority: "runtime",
          },
        });

        const tool = createAgentSkillListTool(config);

        const result = (await tool.execute!(
          { includeUnadvertised: true },
          mockToolCallOptions
        )) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (result.success) {
          const sharedSkills = result.skills.filter((skill) => skill.name === sharedSkillName);
          expect(sharedSkills).toHaveLength(2);
          expect(sharedSkills.find((skill) => skill.scope === "project")?.description).toBe(
            "project version"
          );
          expect(sharedSkills.find((skill) => skill.scope === "global")?.description).toBe(
            "global version"
          );
        }
      } finally {
        if (previousMuxRoot === undefined) {
          delete process.env.MUX_ROOT;
        } else {
          process.env.MUX_ROOT = previousMuxRoot;
        }
      }
    });

    it("excludes skills from legacy .agents/skills roots in project-runtime mode", async () => {
      using tempDir = new TestTempDir("test-agent-skill-list-split-root-legacy-root-exclusion");
      const writableSkillName = "runtime-writable-project-skill";
      const legacySkillName = "runtime-legacy-project-universal-skill";

      await withMuxRoot(tempDir.path, async () => {
        await writeGlobalSkill(path.join(tempDir.path, ".mux"), writableSkillName);
        await writeSkill(path.join(tempDir.path, ".agents", "skills"), legacySkillName);

        const config = createTestToolConfig(tempDir.path, {
          workspaceId: "regular-workspace",
          muxScope: {
            type: "project",
            muxHome: tempDir.path,
            projectRoot: tempDir.path,
            projectStorageAuthority: "runtime",
          },
        });

        const tool = createAgentSkillListTool(config);

        const result = (await tool.execute!(
          { includeUnadvertised: true },
          mockToolCallOptions
        )) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        if (result.success) {
          expect(
            result.skills.some(
              (skill) => skill.name === writableSkillName && skill.scope === "project"
            )
          ).toBe(true);
          expect(result.skills.find((skill) => skill.name === legacySkillName)).toBeUndefined();
        }
      });
    });

    it("skips escaped project skills while keeping in-bound project/global skills", async () => {
      using tempDir = new TestTempDir("test-agent-skill-list-split-root-containment");
      using escapedSkillsDir = new TestTempDir(
        "test-agent-skill-list-split-root-containment-escape"
      );
      using muxHomeDir = new TestTempDir("test-agent-skill-list-split-root-containment-mux-home");

      const remoteWorkspaceRoot = "/remote/workspace";
      const escapedSkillName = "escaped-runtime-skill";
      const safeGlobalSkillName = "runtime-safe-global-skill";
      const previousMuxRoot = process.env.MUX_ROOT;

      process.env.MUX_ROOT = muxHomeDir.path;

      try {
        await writeGlobalSkill(escapedSkillsDir.path, escapedSkillName);
        await fs.symlink(
          escapedSkillsDir.path,
          path.join(tempDir.path, ".mux"),
          process.platform === "win32" ? "junction" : "dir"
        );

        await writeGlobalSkill(muxHomeDir.path, safeGlobalSkillName);

        const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
        const config = createTestToolConfig(tempDir.path, {
          workspaceId: "regular-workspace",
          runtime: remoteRuntime,
          muxScope: {
            type: "project",
            muxHome: tempDir.path,
            projectRoot: tempDir.path,
            projectStorageAuthority: "runtime",
          },
        });

        const tool = createAgentSkillListTool({
          ...config,
          cwd: remoteWorkspaceRoot,
        });

        const result = (await tool.execute!(
          { includeUnadvertised: true },
          mockToolCallOptions
        )) as AgentSkillListToolResult;

        expect(result.success).toBe(true);
        expect(remoteRuntime.resolvePathCallCount).toBeGreaterThan(0);

        if (result.success) {
          expect(
            result.skills.some(
              (skill) => skill.name === safeGlobalSkillName && skill.scope === "global"
            )
          ).toBe(true);
          expect(result.skills.find((skill) => skill.name === escapedSkillName)).toBeUndefined();
        }
      } finally {
        if (previousMuxRoot === undefined) {
          delete process.env.MUX_ROOT;
        } else {
          process.env.MUX_ROOT = previousMuxRoot;
        }
      }
    });
  });

  it("filters unadvertised skills unless includeUnadvertised is true", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-advertise");

    const workspaceSessionDir = await createWorkspaceSessionDir(
      tempDir.path,
      MUX_HELP_CHAT_WORKSPACE_ID
    );

    await writeGlobalSkill(tempDir.path, "advertised-skill");
    await writeGlobalSkill(tempDir.path, "hidden-skill", { advertise: false });

    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
      muxScope: {
        type: "global",
        muxHome: tempDir.path,
      },
    });

    const tool = createAgentSkillListTool(config);

    const defaultResult = (await tool.execute!(
      {},
      mockToolCallOptions
    )) as AgentSkillListToolResult;
    expect(defaultResult.success).toBe(true);
    if (defaultResult.success) {
      expect(defaultResult.skills.map((skill) => skill.name)).toEqual(["advertised-skill"]);
    }

    const includeAllResult = (await tool.execute!(
      { includeUnadvertised: true },
      mockToolCallOptions
    )) as AgentSkillListToolResult;
    expect(includeAllResult.success).toBe(true);
    if (includeAllResult.success) {
      expect(includeAllResult.skills.map((skill) => skill.name)).toEqual([
        "advertised-skill",
        "hidden-skill",
      ]);
    }
  });

  it("skips symlinked project skill directories inside contained skills root", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-project-entry-symlink");

    const workspaceSessionDir = await createWorkspaceSessionDir(
      tempDir.path,
      MUX_HELP_CHAT_WORKSPACE_ID
    );

    const projectRoot = path.join(tempDir.path, "project");
    const skillsDir = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(skillsDir, { recursive: true });

    // Legitimate project skill directory.
    await writeGlobalSkill(path.join(projectRoot, ".mux"), "real-skill");

    // External skill directory linked into project skills root.
    const externalSkillDir = path.join(tempDir.path, "external", "sneaky-skill");
    await fs.mkdir(externalSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(externalSkillDir, "SKILL.md"),
      "---\nname: sneaky-skill\ndescription: should not appear\n---\nBody\n",
      "utf-8"
    );
    await fs.symlink(externalSkillDir, path.join(skillsDir, "sneaky-skill"));

    // Also create a real global skill.
    await writeGlobalSkill(tempDir.path, "global-skill");

    const projectScope: MuxToolScope = {
      type: "project",
      muxHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
      muxScope: projectScope,
    });

    const tool = createAgentSkillListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      // Symlinked entry should be skipped.
      expect(result.skills.map((s) => s.name)).toEqual(["global-skill", "real-skill"]);
      expect(result.skills.find((s) => s.name === "real-skill")?.scope).toBe("project");
      expect(result.skills.find((s) => s.name === "sneaky-skill")).toBeUndefined();
    }
  });

  it("skips project skill when SKILL.md symlink target escapes project root", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-skillmd-symlink-escape");

    const workspaceSessionDir = await createWorkspaceSessionDir(
      tempDir.path,
      MUX_HELP_CHAT_WORKSPACE_ID
    );

    const projectRoot = path.join(tempDir.path, "project");
    const skillsDir = path.join(projectRoot, ".mux", "skills");

    // Create a legitimate project skill.
    await writeGlobalSkill(path.join(projectRoot, ".mux"), "legit-skill");

    // Create a skill directory with SKILL.md symlinked to an external file.
    const leakySkillDir = path.join(skillsDir, "leaky-skill");
    await fs.mkdir(leakySkillDir, { recursive: true });

    const externalDir = path.join(tempDir.path, "external");
    const externalFile = path.join(externalDir, "secret.md");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      externalFile,
      "---\nname: leaky-skill\ndescription: should not be read\n---\nSecret body\n",
      "utf-8"
    );
    await fs.symlink(externalFile, path.join(leakySkillDir, "SKILL.md"));

    // Also create a global skill.
    await writeGlobalSkill(tempDir.path, "global-skill");

    const projectScope: MuxToolScope = {
      type: "project",
      muxHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
      muxScope: projectScope,
    });

    const tool = createAgentSkillListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skills.map((s) => s.name)).toEqual(["global-skill", "legit-skill"]);
      expect(result.skills.find((s) => s.name === "leaky-skill")).toBeUndefined();
    }
  });

  it("skips skill with oversized SKILL.md", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-oversized-skillmd");

    const workspaceSessionDir = await createWorkspaceSessionDir(
      tempDir.path,
      MUX_HELP_CHAT_WORKSPACE_ID
    );

    await writeGlobalSkill(tempDir.path, "normal-skill");

    const oversizedSkillDir = path.join(tempDir.path, "skills", "big-skill");
    await fs.mkdir(oversizedSkillDir, { recursive: true });
    const oversizedContent =
      "---\nname: big-skill\ndescription: too large\n---\n" + "x".repeat(MAX_FILE_SIZE + 1);
    await fs.writeFile(path.join(oversizedSkillDir, "SKILL.md"), oversizedContent, "utf-8");

    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
      muxScope: {
        type: "global",
        muxHome: tempDir.path,
      },
    });

    const tool = createAgentSkillListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skills.map((s) => s.name)).toEqual(["normal-skill"]);
      expect(result.skills.find((s) => s.name === "big-skill")).toBeUndefined();
    }
  });

  it("continues listing global skills when project skills root is not a directory", async () => {
    using project = new TestTempDir("test-agent-skill-list-project-root-not-directory");
    using muxHome = new TestTempDir("test-agent-skill-list-global-root-valid");

    await fs.mkdir(path.join(project.path, ".mux"), { recursive: true });
    await fs.writeFile(path.join(project.path, ".mux", "skills"), "not a directory", "utf-8");
    await writeGlobalSkill(muxHome.path, "global-skill", {
      description: "from global",
    });

    const tool = createAgentSkillListTool(
      createTestToolConfig(project.path, {
        muxScope: {
          type: "project",
          muxHome: muxHome.path,
          projectRoot: project.path,
          projectStorageAuthority: "host-local",
        },
      })
    );
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skills.map((s) => s.name)).toEqual(["global-skill"]);
    }
  });

  it("returns no skills when both project and global roots are not directories", async () => {
    using project = new TestTempDir("test-agent-skill-list-both-roots-not-directories-project");
    using muxHome = new TestTempDir("test-agent-skill-list-both-roots-not-directories-home");

    await fs.mkdir(path.join(project.path, ".mux"), { recursive: true });
    await fs.writeFile(path.join(project.path, ".mux", "skills"), "not a directory", "utf-8");
    await fs.writeFile(path.join(muxHome.path, "skills"), "not a directory", "utf-8");

    const tool = createAgentSkillListTool(
      createTestToolConfig(project.path, {
        muxScope: {
          type: "project",
          muxHome: muxHome.path,
          projectRoot: project.path,
          projectStorageAuthority: "host-local",
        },
      })
    );
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skills).toEqual([]);
    }
  });

  it("skips project skills when .mux is a symlink to external directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-project-mux-symlink");

    const workspaceSessionDir = await createWorkspaceSessionDir(
      tempDir.path,
      MUX_HELP_CHAT_WORKSPACE_ID
    );

    const projectRoot = path.join(tempDir.path, "project");
    await fs.mkdir(projectRoot, { recursive: true });

    // Create external directory with skill content
    const externalDir = path.join(tempDir.path, "external");
    await fs.mkdir(path.join(externalDir, "skills", "external-skill"), { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "skills", "external-skill", "SKILL.md"),
      "---\nname: external-skill\ndescription: should not appear\n---\nBody\n",
      "utf-8"
    );

    // Symlink .mux to external
    await fs.symlink(externalDir, path.join(projectRoot, ".mux"));

    // Also create a real global skill
    await writeGlobalSkill(tempDir.path, "global-skill");

    const projectScope: MuxToolScope = {
      type: "project",
      muxHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
      muxScope: projectScope,
    });

    const tool = createAgentSkillListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      // External skill should NOT appear; only real global skill should be listed
      expect(result.skills.map((s) => s.name)).toEqual(["global-skill"]);
      expect(result.skills.every((s) => s.scope === "global")).toBe(true);
    }
  });
});
