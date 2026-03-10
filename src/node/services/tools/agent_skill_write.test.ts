import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { MuxToolScope } from "@/common/types/toolScope";
import { FILE_EDIT_DIFF_OMITTED_MESSAGE } from "@/common/types/tools";
import type { AgentSkillReadToolResult, AgentSkillWriteToolResult } from "@/common/types/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { createAgentSkillReadTool } from "./agent_skill_read";
import { createAgentSkillWriteTool } from "./agent_skill_write";
import { SKILL_FILENAME } from "./skillFileUtils";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

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

  constructor(localBase: string, remoteBase: string) {
    super(localBase);
    this.localBase = path.resolve(localBase);
    this.remoteBase = remoteBase === "/" ? remoteBase : remoteBase.replace(/\/+$/u, "");
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

function skillMarkdown(
  name: string,
  options?: { description?: string; advertise?: boolean; body?: string }
): string {
  const advertiseLine =
    options?.advertise === undefined ? "" : `advertise: ${options.advertise ? "true" : "false"}\n`;

  return [
    "---",
    `name: ${name}`,
    `description: ${options?.description ?? `description for ${name}`}`,
    advertiseLine.trimEnd(),
    "---",
    options?.body ?? "Body",
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

async function createWriteTool(
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

  return createAgentSkillWriteTool(config);
}

describe("agent_skill_write", () => {
  it("creates SKILL.md for a new global skill", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-create");

    const tool = await createWriteTool(tempDir.path);
    const content = skillMarkdown("demo-skill");

    const result = (await tool.execute!(
      { name: "demo-skill", content },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"),
      "utf-8"
    );
    expect(stored).toBe(content);
  });

  it("recreates deleted global mux home before validating skill writes", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-recreate-mux-home");

    const tool = await createWriteTool(tempDir.path);
    const content = skillMarkdown("demo-skill", { body: "Recovered body" });

    await fs.rm(tempDir.path, { recursive: true, force: true });

    const result = (await tool.execute!(
      { name: "demo-skill", content },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME),
      "utf-8"
    );
    expect(stored).toBe(content);
  });

  it("operates on project skills root when scope is project", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-project-scope");

    const projectRoot = path.join(tempDir.path, "my-project");
    await fs.mkdir(path.join(projectRoot, ".mux", "skills"), { recursive: true });

    const projectScope: MuxToolScope = {
      type: "project",
      muxHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const tool = await createWriteTool(tempDir.path, MUX_HELP_CHAT_WORKSPACE_ID, projectScope);
    const content = skillMarkdown("demo-skill", { body: "Project scoped" });

    const result = (await tool.execute!(
      { name: "demo-skill", content },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const projectSkillPath = path.join(projectRoot, ".mux", "skills", "demo-skill", "SKILL.md");
    const stored = await fs.readFile(projectSkillPath, "utf-8");
    expect(stored).toBe(content);
  });
  describe("split-root (project-runtime)", () => {
    it("writes project skill via runtime APIs in split-root context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-split-root-project-runtime");
      const skillName = "split-root-runtime-write-skill";
      const remoteWorkspaceRoot = "/remote/workspace";
      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);

      const projectScope: MuxToolScope = {
        type: "project",
        muxHome: tempDir.path,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      };

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        muxScope: projectScope,
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const writeTool = createAgentSkillWriteTool(config);
      const content = skillMarkdown(skillName, { body: "Body from split-root runtime" });

      const writeResult = (await writeTool.execute!(
        { name: skillName, content },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;
      expect(writeResult.success).toBe(true);

      const localSkillFile = path.join(tempDir.path, ".mux", "skills", skillName, "SKILL.md");
      const stored = await fs.readFile(localSkillFile, "utf-8");
      expect(stored).toBe(content);

      const readTool = createAgentSkillReadTool(config);
      const readResult = (await readTool.execute!(
        { name: skillName },
        mockToolCallOptions
      )) as AgentSkillReadToolResult;

      expect(readResult.success).toBe(true);
      if (readResult.success) {
        expect(readResult.skill.body).toContain("Body from split-root runtime");
      }
    });

    it("rejects write when .mux is symlinked outside workspace in split-root runtime context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-split-root-runtime-symlink-escape");
      using externalDir = new TestTempDir(
        "test-agent-skill-write-split-root-runtime-symlink-target"
      );
      const skillName = "split-root-runtime-write-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      const externalMuxDir = externalDir.path;
      await fs.mkdir(path.join(externalMuxDir, "skills"), { recursive: true });
      await fs.symlink(
        externalMuxDir,
        path.join(tempDir.path, ".mux"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const projectScope: MuxToolScope = {
        type: "project",
        muxHome: tempDir.path,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      };

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        muxScope: projectScope,
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const writeTool = createAgentSkillWriteTool(config);
      const content = skillMarkdown(skillName, { body: "Body from split-root runtime" });

      const writeResult = (await writeTool.execute!(
        { name: skillName, content },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(writeResult.success).toBe(false);
      if (!writeResult.success) {
        expect(writeResult.error).toMatch(/outside workspace root|escape|symlink/i);
      }

      const externalSkillFile = path.join(externalMuxDir, "skills", skillName, "SKILL.md");
      const externalSkillExists = await fs
        .stat(externalSkillFile)
        .then(() => true)
        .catch(() => false);
      expect(externalSkillExists).toBe(false);

      const externalSkillEntries = await fs.readdir(path.join(externalMuxDir, "skills"));
      expect(externalSkillEntries).toEqual([]);
    });

    it("rejects write via casing-variant filePath when canonical SKILL.md is a symlink", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-write-split-root-runtime-case-variant-symlink"
      );
      const skillName = "split-root-runtime-case-variant-symlink";
      const remoteWorkspaceRoot = "/remote/workspace";
      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);

      const projectScope: MuxToolScope = {
        type: "project",
        muxHome: tempDir.path,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      };

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        muxScope: projectScope,
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const localSkillDir = path.join(tempDir.path, ".mux", "skills", skillName);
      await fs.mkdir(localSkillDir, { recursive: true });

      const symlinkTargetPath = path.join(tempDir.path, "outside-skill-target.md");
      const symlinkTargetContent = "outside target should remain unchanged\n";
      await fs.writeFile(symlinkTargetPath, symlinkTargetContent, "utf-8");
      await fs.symlink(
        symlinkTargetPath,
        path.join(localSkillDir, SKILL_FILENAME),
        process.platform === "win32" ? "file" : undefined
      );

      const writeTool = createAgentSkillWriteTool(config);
      const content = skillMarkdown(skillName, { body: "Attempted overwrite" });

      const writeResult = (await writeTool.execute!(
        {
          name: skillName,
          filePath: "skill.md",
          content,
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(writeResult.success).toBe(false);
      if (!writeResult.success) {
        expect(writeResult.error).toMatch(/symbolic link|symlink/i);
      }

      const storedTarget = await fs.readFile(symlinkTargetPath, "utf-8");
      expect(storedTarget).toBe(symlinkTargetContent);
    });

    it("writes correctly via casing-variant filePath when SKILL.md does not exist", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-write-split-root-runtime-case-variant-create"
      );
      const skillName = "split-root-runtime-case-variant-create";
      const remoteWorkspaceRoot = "/remote/workspace";
      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);

      const projectScope: MuxToolScope = {
        type: "project",
        muxHome: tempDir.path,
        projectRoot: "/host/project",
        projectStorageAuthority: "runtime",
      };

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        muxScope: projectScope,
      });
      const config = {
        ...baseConfig,
        cwd: remoteWorkspaceRoot,
      };

      const writeTool = createAgentSkillWriteTool(config);
      const content = skillMarkdown(skillName, { body: "Created through lowercase path" });

      const writeResult = (await writeTool.execute!(
        {
          name: skillName,
          filePath: "skill.md",
          content,
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(writeResult.success).toBe(true);

      const canonicalSkillPath = path.join(
        tempDir.path,
        ".mux",
        "skills",
        skillName,
        SKILL_FILENAME
      );
      const stored = await fs.readFile(canonicalSkillPath, "utf-8");
      expect(stored).toBe(content);
    });
  });

  it("updates SKILL.md and returns ui_only diff payload", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-update");

    const tool = await createWriteTool(tempDir.path);

    const initialContent = skillMarkdown("demo-skill", { body: "Body" });
    const initialResult = (await tool.execute!(
      { name: "demo-skill", content: initialContent },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(initialResult.success).toBe(true);

    const updatedContent = skillMarkdown("demo-skill", { body: "Updated body" });
    const updateResult = (await tool.execute!(
      { name: "demo-skill", content: updatedContent },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(updateResult.success).toBe(true);
    if (updateResult.success) {
      expect(updateResult.diff).toBe(FILE_EDIT_DIFF_OMITTED_MESSAGE);
      expect(updateResult.ui_only?.file_edit?.diff).toContain("SKILL.md");
      expect(updateResult.ui_only?.file_edit?.diff).toContain("Updated body");
    }

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"),
      "utf-8"
    );
    expect(stored).toBe(updatedContent);
  });

  it("rejects invalid SKILL.md frontmatter", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-invalid-frontmatter");

    const tool = await createWriteTool(tempDir.path);

    const result = (await tool.execute!(
      { name: "demo-skill", content: "not-frontmatter" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/frontmatter/i);
    }
  });

  describe("SKILL.md casing canonicalization", () => {
    it("validates SKILL.md content even with lowercase filePath", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-lowercase-skillmd");

      const tool = await createWriteTool(tempDir.path);

      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: "skill.md",
          content: "not-frontmatter",
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/frontmatter/i);
      }
    });

    it("injects frontmatter name for case-variant filePath", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-case-variant-name-injection");

      const tool = await createWriteTool(tempDir.path);
      const contentWithMismatchedName = skillMarkdown("wrong-name", {
        description: "description for demo-skill",
      });

      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: "Skill.md",
          content: contentWithMismatchedName,
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(true);

      const stored = await fs.readFile(
        path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME),
        "utf-8"
      );
      expect(stored).toContain("name: demo-skill");
      expect(stored).not.toContain("name: wrong-name");
    });

    it("writes to canonical SKILL.md path regardless of input casing", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-canonical-skillmd-path");

      const tool = await createWriteTool(tempDir.path);
      const content = skillMarkdown("demo-skill", { body: "Canonical body" });

      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: "SKILL.MD",
          content,
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(true);

      const canonicalPath = path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME);
      const stored = await fs.readFile(canonicalPath, "utf-8");
      expect(stored).toBe(content);
    });
  });

  it("name-mismatch injection preserves all other formatting", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-name-mismatch");

    const tool = await createWriteTool(tempDir.path);

    const originalContent = [
      "---",
      'name  : "Holistic Design"',
      "description: >-",
      "  Keep this wording exactly as authored.",
      "  Preserve wrapping and punctuation: colon: yes.",
      'compatibility: "mux >= 1.0"',
      "metadata:",
      '  owner: "docs-team"',
      "advertise: false",
      "---",
      "Body line 1",
      "",
      "Body line 3",
      "",
    ].join("\n");

    const result = (await tool.execute!(
      {
        name: "holistic-design",
        content: originalContent,
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "holistic-design", "SKILL.md"),
      "utf-8"
    );

    const expectedContent = originalContent.replace(
      'name  : "Holistic Design"',
      "name: holistic-design"
    );
    expect(stored).toBe(expectedContent);

    const originalLines = originalContent.split("\n");
    const storedLines = stored.split("\n");
    const changedLineIndexes = originalLines.flatMap((line, index) =>
      line === storedLines[index] ? [] : [index]
    );

    expect(changedLineIndexes).toEqual([1]);
  });

  it("missing-name insertion preserves existing content", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-name-missing");

    const tool = await createWriteTool(tempDir.path);

    const originalContent = [
      "---",
      "description: >-",
      "  Keep this exact text.",
      "  Preserve order and spacing.",
      'compatibility: "mux >= 1.0"',
      "metadata:",
      "  owner: docs-team",
      "---",
      "Body",
      "",
    ].join("\n");

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        content: originalContent,
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"),
      "utf-8"
    );

    const expectedContent = [
      "---",
      "name: demo-skill",
      ...originalContent.split("\n").slice(1),
    ].join("\n");
    expect(stored).toBe(expectedContent);

    const storedLines = stored.split("\n");
    expect(storedLines[1]).toBe("name: demo-skill");
    expect([storedLines[0], ...storedLines.slice(2)]).toEqual(originalContent.split("\n"));
  });

  it("writes reference files within the skill directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-reference");

    const tool = await createWriteTool(tempDir.path);

    const createResult = (await tool.execute!(
      { name: "demo-skill", content: skillMarkdown("demo-skill") },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(createResult.success).toBe(true);

    const refResult = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "references/foo.txt",
        content: "reference content",
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(refResult.success).toBe(true);

    const referencePath = path.join(tempDir.path, "skills", "demo-skill", "references", "foo.txt");
    const stored = await fs.readFile(referencePath, "utf-8");
    expect(stored).toBe("reference content");
  });

  it.each(["/etc/passwd", "../escape", "~/bad"])(
    "rejects invalid filePath %s",
    async (filePathValue) => {
      using tempDir = new TestTempDir("test-agent-skill-write-invalid-path");

      const tool = await createWriteTool(tempDir.path);
      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: filePathValue,
          content: "text",
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Invalid filePath|path traversal/i);
      }
    }
  );

  it("rejects writes when skills root is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-symlinked-root");
    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = tempDir.path;

    try {
      const externalDir = path.join(tempDir.path, "external-skills-tree");
      const externalSkillDir = path.join(externalDir, "evil-skill");
      await fs.mkdir(externalSkillDir, { recursive: true });

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

      const tool = createAgentSkillWriteTool(baseConfig);
      const result = (await tool.execute!(
        {
          name: "evil-skill",
          content: "---\nname: evil-skill\ndescription: test\n---\nBody\n",
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/symbolic link|outside containment root/i);
      }

      const externalEntries = await fs.readdir(externalDir);
      expect(externalEntries).toEqual(["evil-skill"]);
    } finally {
      restoreMuxRoot(previousMuxRoot);
    }
  });

  it("rejects writes when skill directory is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-symlinked-dir");

    const tool = await createWriteTool(tempDir.path);

    const externalDir = path.join(tempDir.path, "external-target");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.mkdir(path.join(tempDir.path, "skills"), { recursive: true });
    await fs.symlink(externalDir, path.join(tempDir.path, "skills", "demo-skill"));

    const result = (await tool.execute!(
      { name: "demo-skill", content: skillMarkdown("demo-skill") },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const entries = await fs.readdir(externalDir);
    expect(entries).toEqual([]);
  });

  it("rejects writes when intermediate subdir is a symlinked escape", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-intermediate-symlink");

    const tool = await createWriteTool(tempDir.path);

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown("demo-skill"), "utf-8");

    const externalDir = path.join(tempDir.path, "external-escape");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.symlink(externalDir, path.join(skillDir, "references"));

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "references/secret.txt",
        content: "should not land here",
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/escape|symlink/i);
    }

    const entries = await fs.readdir(externalDir);
    expect(entries).toEqual([]);
  });

  it("rejects writes to symlink targets", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-symlink");

    const tool = await createWriteTool(tempDir.path);

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });

    const symlinkTarget = path.join(tempDir.path, "external-target.md");
    await fs.writeFile(symlinkTarget, "external", "utf-8");
    await fs.symlink(symlinkTarget, path.join(skillDir, "SKILL.md"));

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        content: skillMarkdown("demo-skill"),
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }
  });

  it("rejects internal symlink alias pointing to existing file", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-internal-alias-symlink");

    const tool = await createWriteTool(tempDir.path);

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });

    const skillPath = path.join(skillDir, "SKILL.md");
    const originalContent = skillMarkdown("demo-skill", { body: "Original body" });
    await fs.writeFile(skillPath, originalContent, "utf-8");
    await fs.symlink("SKILL.md", path.join(skillDir, "link.txt"));

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "link.txt",
        content: "new alias content",
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const stored = await fs.readFile(skillPath, "utf-8");
    expect(stored).toBe(originalContent);
  });

  it("rejects project writes when .mux is a symlink to external directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-project-mux-symlink");

    const projectRoot = path.join(tempDir.path, "project");
    await fs.mkdir(projectRoot, { recursive: true });

    // Create external directory and symlink .mux to it
    const externalDir = path.join(tempDir.path, "external");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.symlink(externalDir, path.join(projectRoot, ".mux"));

    const projectScope: MuxToolScope = {
      type: "project",
      muxHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const tool = await createWriteTool(tempDir.path, MUX_HELP_CHAT_WORKSPACE_ID, projectScope);
    const content = skillMarkdown("demo-skill", { body: "Should not land outside project" });

    const result = (await tool.execute!(
      { name: "demo-skill", content },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/outside containment root|symbolic link/i);
    }

    // Verify no directories were created in external target
    const externalEntries = await fs.readdir(externalDir);
    expect(externalEntries).toEqual([]);
  });
});
