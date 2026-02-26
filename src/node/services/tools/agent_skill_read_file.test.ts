import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { AgentSkillReadFileToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { createAgentSkillReadFileTool } from "./agent_skill_read_file";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

async function writeProjectSkill(workspacePath: string, name: string): Promise<void> {
  const skillDir = path.join(workspacePath, ".mux", "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\n---\nBody\n`,
    "utf-8"
  );
}

async function writeGlobalSkill(muxRoot: string, name: string): Promise<void> {
  const skillDir = path.join(muxRoot, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\n---\nBody\n`,
    "utf-8"
  );
}

function restoreMuxRoot(previousMuxRoot: string | undefined): void {
  if (previousMuxRoot === undefined) {
    delete process.env.MUX_ROOT;
    return;
  }

  process.env.MUX_ROOT = previousMuxRoot;
}

const REMOTE_WORKSPACE_ROOT = "/remote/workspace";

class RemotePathMappedRuntime extends LocalRuntime {
  private readonly localWorkspaceRoot: string;
  private readonly remoteWorkspaceRoot: string;

  constructor(localWorkspaceRoot: string, remoteWorkspaceRoot: string) {
    super(localWorkspaceRoot);
    this.localWorkspaceRoot = path.resolve(localWorkspaceRoot);
    this.remoteWorkspaceRoot =
      remoteWorkspaceRoot === "/" ? remoteWorkspaceRoot : remoteWorkspaceRoot.replace(/\/+$/u, "");
  }

  private toLocalPath(runtimePath: string): string {
    const normalizedRuntimePath = runtimePath.replaceAll("\\", "/");

    if (normalizedRuntimePath === this.remoteWorkspaceRoot) {
      return this.localWorkspaceRoot;
    }

    if (normalizedRuntimePath.startsWith(`${this.remoteWorkspaceRoot}/`)) {
      const suffix = normalizedRuntimePath.slice(this.remoteWorkspaceRoot.length + 1);
      return path.join(this.localWorkspaceRoot, ...suffix.split("/"));
    }

    return runtimePath;
  }

  private toRemotePath(localPath: string): string {
    const resolvedLocalPath = path.resolve(localPath);

    if (resolvedLocalPath === this.localWorkspaceRoot) {
      return this.remoteWorkspaceRoot;
    }

    const localPrefix = `${this.localWorkspaceRoot}${path.sep}`;
    if (resolvedLocalPath.startsWith(localPrefix)) {
      const suffix = resolvedLocalPath.slice(localPrefix.length).split(path.sep).join("/");
      return `${this.remoteWorkspaceRoot}/${suffix}`;
    }

    return localPath.replaceAll("\\", "/");
  }

  private translateCommandToLocal(command: string): string {
    return command
      .split(this.remoteWorkspaceRoot)
      .join(this.localWorkspaceRoot.replaceAll("\\", "/"));
  }

  override normalizePath(targetPath: string, basePath: string): string {
    const normalizedBasePath = this.toRemotePath(basePath);
    return path.posix.resolve(normalizedBasePath, targetPath.replaceAll("\\", "/"));
  }

  override async resolvePath(filePath: string): Promise<string> {
    const resolvedLocalPath = await super.resolvePath(this.toLocalPath(filePath));
    return this.toRemotePath(resolvedLocalPath);
  }

  override exec(
    command: string,
    options: Parameters<LocalRuntime["exec"]>[1]
  ): ReturnType<LocalRuntime["exec"]> {
    return super.exec(this.translateCommandToLocal(command), {
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

function createRemoteRuntimeConfig(tempDirPath: string) {
  const runtime = new RemotePathMappedRuntime(tempDirPath, REMOTE_WORKSPACE_ROOT);
  const baseConfig = createTestToolConfig(tempDirPath, {
    workspaceId: "regular-workspace",
    runtime,
  });

  return {
    ...baseConfig,
    cwd: REMOTE_WORKSPACE_ROOT,
    workspaceSessionDir: REMOTE_WORKSPACE_ROOT,
  };
}

describe("agent_skill_read_file", () => {
  it("allows reading built-in skill files", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-mux-chat");
    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
    });

    const tool = createAgentSkillReadFileTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!(
        { name: "mux-docs", filePath: "SKILL.md", offset: 1, limit: 25 },
        mockToolCallOptions
      )
    );

    const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toMatch(/name:\s*mux-docs/i);
    }
  });

  it("allows reading global skill files on disk in Chat with Mux workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-global");
    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = tempDir.path;

    try {
      await writeGlobalSkill(tempDir.path, "foo");

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      });
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!(
          { name: "foo", filePath: "SKILL.md", offset: 1, limit: 5 },
          mockToolCallOptions
        )
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toMatch(/name:\s*foo/i);
      }
    } finally {
      restoreMuxRoot(previousMuxRoot);
    }
  });

  it("allows reading project skill files on disk outside Chat with Mux workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-project");
    await writeProjectSkill(tempDir.path, "project-skill");

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
    });
    const tool = createAgentSkillReadFileTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!(
        { name: "project-skill", filePath: "SKILL.md", offset: 1, limit: 5 },
        mockToolCallOptions
      )
    );

    const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toMatch(/name:\s*project-skill/i);
    }
  });

  describe("runtime-aware containment with remote runtime paths", () => {
    it("reads project skill files through the injected runtime", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-remote-runtime-read");
      await writeProjectSkill(tempDir.path, "remote-skill");

      const skillDir = path.join(tempDir.path, ".mux", "skills", "remote-skill");
      await fs.writeFile(path.join(skillDir, "extra.txt"), "extra content", "utf-8");

      const baseConfig = createRemoteRuntimeConfig(tempDir.path);
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!(
          { name: "remote-skill", filePath: "extra.txt", offset: 1, limit: 5 },
          mockToolCallOptions
        )
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toMatch(/extra content/i);
      }
    });

    it("rejects symlinked skill directories through the runtime probe", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-remote-runtime-symlinked-dir");

      const skillsRoot = path.join(tempDir.path, ".mux", "skills");
      const externalDir = path.join(tempDir.path, "external-skill-source");
      await fs.mkdir(externalDir, { recursive: true });
      await fs.writeFile(
        path.join(externalDir, "SKILL.md"),
        "---\nname: evil\ndescription: test\n---\nBody\n",
        "utf-8"
      );
      await fs.writeFile(path.join(externalDir, "secret.txt"), "top secret", "utf-8");

      await fs.mkdir(skillsRoot, { recursive: true });
      await fs.symlink(
        externalDir,
        path.join(skillsRoot, "evil"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const baseConfig = createRemoteRuntimeConfig(tempDir.path);
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "evil", filePath: "secret.txt" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/symbolic link/i);
      }
    });

    it("rejects escaped symlink files through the runtime probe", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-remote-runtime-symlinked-file");
      await writeProjectSkill(tempDir.path, "real-skill");

      const skillDir = path.join(tempDir.path, ".mux", "skills", "real-skill");
      const externalFile = path.join(tempDir.path, "external-secret.txt");
      await fs.writeFile(externalFile, "outside skill", "utf-8");
      await fs.symlink(externalFile, path.join(skillDir, "link.txt"), "file");

      const baseConfig = createRemoteRuntimeConfig(tempDir.path);
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "real-skill", filePath: "link.txt" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/escape|outside|symbolic link|symlink/i);
      }
    });
    it("treats missing nested parent dirs as not-found, not path escape (runtime)", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-read-file-remote-runtime-missing-parent-dir"
      );
      await writeProjectSkill(tempDir.path, "missing-parent");

      const baseConfig = createRemoteRuntimeConfig(tempDir.path);
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!(
          { name: "missing-parent", filePath: "references/foo.txt" },
          mockToolCallOptions
        )
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).not.toMatch(/outside the skill directory|escape/i);
        expect(result.error).toMatch(/failed to stat|enoent|no such file/i);
      }
    });

    it("rejects symlinked ancestors above missing segments as path escape (runtime)", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-read-file-remote-runtime-missing-parent-symlink-ancestor"
      );
      await writeProjectSkill(tempDir.path, "symlink-ancestor");

      const skillDir = path.join(tempDir.path, ".mux", "skills", "symlink-ancestor");
      const externalDir = path.join(tempDir.path, "external-linked-root");
      await fs.mkdir(externalDir, { recursive: true });
      await fs.symlink(
        externalDir,
        path.join(skillDir, "link-outside"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const baseConfig = createRemoteRuntimeConfig(tempDir.path);
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!(
          { name: "symlink-ancestor", filePath: "link-outside/missing-subdir/file.txt" },
          mockToolCallOptions
        )
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/outside the skill directory|escape/i);
      }
    });
  });

  describe("symlink safety", () => {
    it("rejects reads from a symlinked skill directory", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-symlinked-dir");

      const skillsRoot = path.join(tempDir.path, ".mux", "skills");
      const externalDir = path.join(tempDir.path, "external-skill-source");
      await fs.mkdir(externalDir, { recursive: true });
      await fs.writeFile(
        path.join(externalDir, "SKILL.md"),
        "---\nname: evil\ndescription: test\n---\nBody\n",
        "utf-8"
      );
      await fs.writeFile(path.join(externalDir, "secret.txt"), "top secret", "utf-8");

      await fs.mkdir(skillsRoot, { recursive: true });
      await fs.symlink(
        externalDir,
        path.join(skillsRoot, "evil"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
      });
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "evil", filePath: "secret.txt" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/symbolic link/i);
      }
    });

    it("rejects reads from a symlinked file that escapes containment", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-symlinked-file");
      await writeProjectSkill(tempDir.path, "real-skill");

      const skillDir = path.join(tempDir.path, ".mux", "skills", "real-skill");
      const externalFile = path.join(tempDir.path, "external-secret.txt");
      await fs.writeFile(externalFile, "outside skill", "utf-8");
      await fs.symlink(externalFile, path.join(skillDir, "link.txt"), "file");

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
      });
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "real-skill", filePath: "link.txt" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/escape|outside|symbolic link|symlink/i);
      }
    });
  });
});
