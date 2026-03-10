import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { MuxToolScope } from "@/common/types/toolScope";
import type { AgentSkillDeleteToolResult } from "@/common/types/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { createAgentSkillDeleteTool } from "./agent_skill_delete";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

const TILDE_WORKSPACE_ROOT = "~/mux/project/main";

async function createWorkspaceSessionDir(muxHome: string, workspaceId: string): Promise<string> {
  const workspaceSessionDir = path.join(muxHome, "sessions", workspaceId);
  await fs.mkdir(workspaceSessionDir, { recursive: true });
  return workspaceSessionDir;
}

function restoreMuxRoot(previousMuxRoot: string | undefined): void {
  if (previousMuxRoot === undefined) {
    delete process.env.MUX_ROOT;
    return;
  }

  process.env.MUX_ROOT = previousMuxRoot;
}

class RemotePathMappedRuntime extends LocalRuntime {
  private readonly localBase: string;
  private readonly remoteBase: string;
  private readonly localHomeForTildeRoot: string | null;

  constructor(localBase: string, remoteBase: string) {
    super(localBase);
    this.localBase = path.resolve(localBase);
    this.remoteBase = remoteBase === "/" ? remoteBase : remoteBase.replace(/\/+$/u, "");

    if (this.remoteBase === "~") {
      this.localHomeForTildeRoot = this.localBase;
    } else if (this.remoteBase.startsWith("~/")) {
      const homeRelativeSuffix = this.remoteBase.slice(1);
      const normalizedLocalRoot = this.localBase.replaceAll("\\", "/");
      if (normalizedLocalRoot.endsWith(homeRelativeSuffix)) {
        const derivedHome = normalizedLocalRoot.slice(
          0,
          normalizedLocalRoot.length - homeRelativeSuffix.length
        );
        this.localHomeForTildeRoot = derivedHome.length > 0 ? derivedHome : "/";
      } else {
        this.localHomeForTildeRoot = null;
      }
    } else {
      this.localHomeForTildeRoot = null;
    }
  }

  private usesTildeWorkspaceRoot(): boolean {
    return this.remoteBase === "~" || this.remoteBase.startsWith("~/");
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

  private translateCommandToLocal(command: string): string {
    return command.split(this.remoteBase).join(this.localBase.replaceAll("\\", "/"));
  }

  override getWorkspacePath(projectPath: string, workspaceName: string): string {
    return path.posix.join(this.remoteBase, path.basename(projectPath), workspaceName);
  }

  override normalizePath(targetPath: string, basePath: string): string {
    const normalizedBasePath = this.toRemotePath(basePath);
    const normalizedTargetPath = targetPath.replaceAll("\\", "/");

    if (normalizedBasePath === "~" || normalizedBasePath.startsWith("~/")) {
      if (
        normalizedTargetPath === "~" ||
        normalizedTargetPath.startsWith("~/") ||
        normalizedTargetPath.startsWith("/")
      ) {
        return normalizedTargetPath;
      }
      return path.posix.normalize(path.posix.join(normalizedBasePath, normalizedTargetPath));
    }

    return path.posix.resolve(normalizedBasePath, normalizedTargetPath);
  }

  override async resolvePath(filePath: string): Promise<string> {
    const resolvedLocalPath = await super.resolvePath(this.toLocalPath(filePath));
    return this.toRemotePath(resolvedLocalPath);
  }

  override exec(
    command: string,
    options: Parameters<LocalRuntime["exec"]>[1]
  ): ReturnType<LocalRuntime["exec"]> {
    const usesTildeRoot = this.usesTildeWorkspaceRoot();
    const localHomeForTildeRoot = this.localHomeForTildeRoot ?? process.env.HOME ?? this.localBase;

    return super.exec(usesTildeRoot ? command : this.translateCommandToLocal(command), {
      ...options,
      cwd: this.toLocalPath(options.cwd),
      env: usesTildeRoot
        ? {
            ...(options.env ?? {}),
            HOME: localHomeForTildeRoot,
          }
        : options.env,
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

async function createDeleteTool(
  muxHome: string,
  workspaceId: string = MUX_HELP_CHAT_WORKSPACE_ID,
  muxScope?: MuxToolScope
) {
  const workspaceSessionDir = await createWorkspaceSessionDir(muxHome, workspaceId);
  const config = createTestToolConfig(muxHome, {
    workspaceId,
    sessionsDir: workspaceSessionDir,
    muxScope,
  });

  return createAgentSkillDeleteTool(config);
}

async function writeSkillFixture(muxHome: string, name: string): Promise<void> {
  const skillDir = path.join(muxHome, "skills", name);
  await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n---\nBody\n`,
    "utf-8"
  );
  await fs.writeFile(path.join(skillDir, "references", "foo.txt"), "fixture", "utf-8");
}

describe("agent_skill_delete", () => {
  it("requires confirm: true before deleting", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-confirm");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "SKILL.md", confirm: false },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/confirm/i);
    }

    const skillStat = await fs.stat(path.join(tempDir.path, "skills", "demo-skill"));
    expect(skillStat.isDirectory()).toBe(true);
  });

  it("operates on project skills root when scope is project", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-project-scope");

    const projectRoot = path.join(tempDir.path, "my-project");
    await fs.mkdir(path.join(projectRoot, ".mux", "skills"), { recursive: true });
    await writeSkillFixture(path.join(projectRoot, ".mux"), "demo-skill");

    const projectScope: MuxToolScope = {
      type: "project",
      muxHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const tool = await createDeleteTool(tempDir.path, MUX_HELP_CHAT_WORKSPACE_ID, projectScope);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "skill",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });

    const statErr = await fs
      .stat(path.join(projectRoot, ".mux", "skills", "demo-skill"))
      .catch((error: NodeJS.ErrnoException) => error);
    expect(statErr).toMatchObject({ code: "ENOENT" });
  });
  describe("split-root (project-runtime)", () => {
    it("deletes project skill via runtime in split-root context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-delete-split-root-project-runtime");
      const skillName = "my-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      await writeSkillFixture(path.join(tempDir.path, ".mux"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        muxScope: {
          type: "project",
          muxHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        { name: skillName, target: "skill", confirm: true },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result).toMatchObject({ success: true, deleted: "skill" });

      const skillDir = path.join(tempDir.path, ".mux", "skills", skillName);
      const statErr = await fs.stat(skillDir).catch((error: NodeJS.ErrnoException) => error);
      expect(statErr).toMatchObject({ code: "ENOENT" });
    });

    it("deletes project skill via runtime with tilde-prefixed workspace root", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-delete-split-root-project-runtime-tilde-skill"
      );
      const skillName = "my-skill";
      const runtimeWorkspaceRoot = path.join(tempDir.path, "remote-home", "mux", "project", "main");

      await writeSkillFixture(path.join(runtimeWorkspaceRoot, ".mux"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        muxScope: {
          type: "project",
          muxHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: TILDE_WORKSPACE_ROOT,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        { name: skillName, target: "skill", confirm: true },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result).toMatchObject({ success: true, deleted: "skill" });

      const skillDir = path.join(runtimeWorkspaceRoot, ".mux", "skills", skillName);
      const statErr = await fs.stat(skillDir).catch((error: NodeJS.ErrnoException) => error);
      expect(statErr).toMatchObject({ code: "ENOENT" });
    });

    it("returns explicit not-found when deleting a missing project skill via runtime in split-root context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-delete-split-root-project-runtime-missing");
      const missingSkillName = "missing-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        muxScope: {
          type: "project",
          muxHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        { name: missingSkillName, target: "skill", confirm: true },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(`Skill not found: ${missingSkillName}`);
      }
    });

    it("deletes single file from project skill via runtime in split-root context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-delete-split-root-project-runtime-file");
      const skillName = "my-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      await writeSkillFixture(path.join(tempDir.path, ".mux"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        muxScope: {
          type: "project",
          muxHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        {
          name: skillName,
          filePath: "references/foo.txt",
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result).toMatchObject({ success: true, deleted: "file" });

      const deletedFilePath = path.join(
        tempDir.path,
        ".mux",
        "skills",
        skillName,
        "references",
        "foo.txt"
      );
      const deletedFileStatErr = await fs
        .stat(deletedFilePath)
        .catch((error: NodeJS.ErrnoException) => error);
      expect(deletedFileStatErr).toMatchObject({ code: "ENOENT" });

      const skillStat = await fs.stat(
        path.join(tempDir.path, ".mux", "skills", skillName, "SKILL.md")
      );
      expect(skillStat.isFile()).toBe(true);
    });

    it("deletes single file from project skill via runtime with tilde-prefixed workspace root", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-delete-split-root-project-runtime-tilde-file"
      );
      const skillName = "my-skill";
      const runtimeWorkspaceRoot = path.join(tempDir.path, "remote-home", "mux", "project", "main");

      await writeSkillFixture(path.join(runtimeWorkspaceRoot, ".mux"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        muxScope: {
          type: "project",
          muxHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: TILDE_WORKSPACE_ROOT,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        {
          name: skillName,
          filePath: "references/foo.txt",
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result).toMatchObject({ success: true, deleted: "file" });

      const deletedFilePath = path.join(
        runtimeWorkspaceRoot,
        ".mux",
        "skills",
        skillName,
        "references",
        "foo.txt"
      );
      const deletedFileStatErr = await fs
        .stat(deletedFilePath)
        .catch((error: NodeJS.ErrnoException) => error);
      expect(deletedFileStatErr).toMatchObject({ code: "ENOENT" });

      const skillStat = await fs.stat(
        path.join(runtimeWorkspaceRoot, ".mux", "skills", skillName, "SKILL.md")
      );
      expect(skillStat.isFile()).toBe(true);
    });

    it("rejects delete when .mux is symlinked outside workspace in split-root runtime context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-delete-split-root-runtime-symlink-escape");
      using externalDir = new TestTempDir(
        "test-agent-skill-delete-split-root-runtime-symlink-target"
      );
      const skillName = "demo-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      const externalMuxDir = externalDir.path;
      const externalSkillDir = path.join(externalMuxDir, "skills", skillName);
      await fs.mkdir(externalSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(externalSkillDir, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: fixture\n---\nBody\n`,
        "utf-8"
      );

      await fs.symlink(
        externalMuxDir,
        path.join(tempDir.path, ".mux"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        muxScope: {
          type: "project",
          muxHome: tempDir.path,
          projectRoot: "/host/project",
          projectStorageAuthority: "runtime",
        },
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const tool = createAgentSkillDeleteTool(config);
      const result = (await tool.execute!(
        {
          name: skillName,
          target: "skill",
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/outside workspace root|escape|symlink/i);
      }

      const externalSkillStillExists = await fs
        .stat(path.join(externalSkillDir, "SKILL.md"))
        .then((stat) => stat.isFile())
        .catch(() => false);
      expect(externalSkillStillExists).toBe(true);
    });
  });

  it("deletes a specific file within a skill", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-file");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "references/foo.txt",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "file" });

    const statErr = await fs
      .stat(path.join(tempDir.path, "skills", "demo-skill", "references", "foo.txt"))
      .catch((e: NodeJS.ErrnoException) => e);
    expect(statErr).toMatchObject({ code: "ENOENT" });

    const skillStat = await fs.stat(path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"));
    expect(skillStat.isFile()).toBe(true);
  });

  it("deletes an entire skill directory when target is 'skill'", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-skill-dir");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "skill",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });

    const statErr = await fs
      .stat(path.join(tempDir.path, "skills", "demo-skill"))
      .catch((e: NodeJS.ErrnoException) => e);
    expect(statErr).toMatchObject({ code: "ENOENT" });
  });

  it("requires filePath when target is 'file'", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-filepath-required");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "file",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({
      success: false,
      error: "filePath is required when target is 'file'",
    });
  });

  it("rejects deletes when skills root is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-symlinked-root");
    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = tempDir.path;

    try {
      const externalDir = path.join(tempDir.path, "external-skills-tree");
      const externalSkillDir = path.join(externalDir, "evil-skill");
      await fs.mkdir(externalSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(externalSkillDir, "SKILL.md"),
        "---\nname: evil-skill\ndescription: test\n---\nBody\n",
        "utf-8"
      );

      const muxDir = path.join(tempDir.path, ".mux");
      await fs.mkdir(muxDir, { recursive: true });
      await fs.symlink(
        externalDir,
        path.join(muxDir, "skills"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
        sessionsDir: path.join(muxDir, "sessions", MUX_HELP_CHAT_WORKSPACE_ID),
        muxScope: {
          type: "global",
          muxHome: muxDir,
        },
      });

      const tool = createAgentSkillDeleteTool(baseConfig);
      const result = (await tool.execute!(
        {
          name: "evil-skill",
          target: "skill",
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/symbolic link|outside containment root/i);
      }

      const externalStillExists = await fs
        .stat(externalSkillDir)
        .then(() => true)
        .catch(() => false);
      expect(externalStillExists).toBe(true);
    } finally {
      restoreMuxRoot(previousMuxRoot);
    }
  });

  it("refuses to delete a symlinked skill directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-symlink-skill");

    const realSkillDir = path.join(tempDir.path, "real-skill-dir");
    await fs.mkdir(realSkillDir, { recursive: true });
    await fs.mkdir(path.join(tempDir.path, "skills"), { recursive: true });
    await fs.symlink(realSkillDir, path.join(tempDir.path, "skills", "demo-skill"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "skill",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const skillLinkStat = await fs.lstat(path.join(tempDir.path, "skills", "demo-skill"));
    expect(skillLinkStat.isSymbolicLink()).toBe(true);
  });

  it("refuses to delete a file when skill directory is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-symlinked-dir-file");

    const externalDir = path.join(tempDir.path, "external-target");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: fixture\n---\nBody\n",
      "utf-8"
    );

    await fs.mkdir(path.join(tempDir.path, "skills"), { recursive: true });
    await fs.symlink(externalDir, path.join(tempDir.path, "skills", "demo-skill"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "SKILL.md", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const stat = await fs.stat(path.join(externalDir, "SKILL.md"));
    expect(stat.isFile()).toBe(true);
  });

  it("refuses to delete a file via symlinked intermediate path", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-intermediate-symlink");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const externalDir = path.join(tempDir.path, "external-escape");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(path.join(externalDir, "secret.txt"), "important", "utf-8");

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.rm(path.join(skillDir, "references"), { recursive: true });
    await fs.symlink(externalDir, path.join(skillDir, "references"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "references/secret.txt", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/escape|symlink/i);
    }

    const stat = await fs.stat(path.join(externalDir, "secret.txt"));
    expect(stat.isFile()).toBe(true);
  });

  it("rejects internal symlink alias pointing to existing file", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-internal-alias-symlink");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    const skillPath = path.join(skillDir, "SKILL.md");
    const originalContent = await fs.readFile(skillPath, "utf-8");
    await fs.symlink("SKILL.md", path.join(skillDir, "link.txt"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "file",
        filePath: "link.txt",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const stored = await fs.readFile(skillPath, "utf-8");
    expect(stored).toBe(originalContent);
  });

  it.each(["/etc/passwd", "../escape", "~/bad"])(
    "rejects invalid filePath %s",
    async (filePathValue) => {
      using tempDir = new TestTempDir("test-agent-skill-delete-invalid-path");

      await writeSkillFixture(tempDir.path, "demo-skill");

      const tool = await createDeleteTool(tempDir.path);
      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: filePathValue,
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Invalid filePath|path traversal/i);
      }
    }
  );

  it("returns a clear error when the skill does not exist", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-missing");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "missing-skill", filePath: "SKILL.md", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Skill not found: missing-skill");
    }
  });

  it("returns a clear not-found error when global mux home is missing", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-missing-global-mux-home");

    const missingMuxHome = path.join(tempDir.path, "missing-mux-home");
    const tool = createAgentSkillDeleteTool(
      createTestToolConfig(tempDir.path, {
        muxScope: {
          type: "global",
          muxHome: missingMuxHome,
        },
      })
    );

    const result = (await tool.execute!(
      { name: "missing-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toEqual({
      success: false,
      error: "Skill not found: missing-skill",
    });
  });

  it("returns explicit not-found when deleting a file that does not exist within an existing skill", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-missing-file");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "nonexistent.txt",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("File not found in skill 'demo-skill': nonexistent.txt");
    }
  });

  it("rejects project deletes when .mux is a symlink to external directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-project-mux-symlink");

    const projectRoot = path.join(tempDir.path, "project");
    await fs.mkdir(projectRoot, { recursive: true });

    // Create external directory with skill content
    const externalDir = path.join(tempDir.path, "external");
    await fs.mkdir(path.join(externalDir, "skills", "demo-skill"), { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: external\n---\nBody\n",
      "utf-8"
    );

    // Symlink .mux to external
    await fs.symlink(externalDir, path.join(projectRoot, ".mux"));

    const projectScope: MuxToolScope = {
      type: "project",
      muxHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const tool = await createDeleteTool(tempDir.path, MUX_HELP_CHAT_WORKSPACE_ID, projectScope);
    const result = (await tool.execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/outside containment root|symbolic link/i);
    }

    // Verify external content is still intact
    const stat = await fs.stat(path.join(externalDir, "skills", "demo-skill", "SKILL.md"));
    expect(stat.isFile()).toBe(true);
  });
});
