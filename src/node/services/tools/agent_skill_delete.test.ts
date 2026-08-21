import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect, spyOn } from "bun:test";
import type { XumToolScope } from "@/common/types/toolScope";
import type { AgentSkillDeleteToolResult } from "@/common/types/tools";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { SKILL_FILENAME } from "./skillFileUtils";
import { createAgentSkillDeleteTool } from "./agent_skill_delete";
import {
  createTestToolConfig,
  createWorkspaceSessionDir,
  mockToolCallOptions,
  RemotePathMappedRuntime,
  restoreXumRoot,
  TEST_GLOBAL_WORKSPACE_ID as GLOBAL_WORKSPACE_ID,
  TestTempDir,
  writeSkill,
  writeSkillWithReference,
} from "./testHelpers";

const TILDE_WORKSPACE_ROOT = "~/xum/project/main";

async function createDeleteTool(
  xumHome: string,
  workspaceId: string = GLOBAL_WORKSPACE_ID,
  xumScope?: XumToolScope
) {
  const workspaceSessionDir = await createWorkspaceSessionDir(xumHome, workspaceId);
  const config = createTestToolConfig(xumHome, {
    workspaceId,
    sessionsDir: workspaceSessionDir,
    xumScope,
  });

  return createAgentSkillDeleteTool(config);
}

describe("agent_skill_delete", () => {
  it("requires confirm: true before deleting", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-confirm");

    await writeSkillWithReference(tempDir.path, "demo-skill");

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
    await fs.mkdir(path.join(projectRoot, ".xum", "skills"), { recursive: true });
    await writeSkillWithReference(path.join(projectRoot, ".xum"), "demo-skill");

    const projectScope: XumToolScope = {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, projectScope);
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
      .stat(path.join(projectRoot, ".xum", "skills", "demo-skill"))
      .catch((error: NodeJS.ErrnoException) => error);
    expect(statErr).toMatchObject({ code: "ENOENT" });
  });
  it("deletes legacy-only and shadowed project packages without reappearing", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-legacy");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalRoot = path.join(projectRoot, ".xum", "skills");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    await writeSkill(legacyRoot, "legacy-only");
    await writeSkill(canonicalRoot, "shadowed");
    await writeSkill(legacyRoot, "shadowed");

    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    for (const name of ["legacy-only", "shadowed"]) {
      const result = (await tool.execute!(
        { name, target: "skill", confirm: true },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;
      expect(result).toMatchObject({ success: true, deleted: "skill" });
      expect(fs.stat(path.join(canonicalRoot, name))).rejects.toThrow();
      expect(fs.stat(path.join(legacyRoot, name))).rejects.toThrow();
    }
  });

  it("deletes canonical and legacy manifests so fallback skills stay hidden", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-manifest-shadow");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalRoot = path.join(projectRoot, ".xum", "skills");
    const legacyRoot = path.join(projectRoot, ".mux", "skills");
    await writeSkill(canonicalRoot, "demo-skill");
    await writeSkill(legacyRoot, "demo-skill");
    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });

    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "references/../SKILL.md", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "file" });
    expect(fs.stat(path.join(canonicalRoot, "demo-skill", SKILL_FILENAME))).rejects.toThrow();
    expect(fs.stat(path.join(legacyRoot, "demo-skill", SKILL_FILENAME))).rejects.toThrow();
  });

  it("migrates an incomplete canonical package before deleting its fallback manifest", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-partial-canonical-manifest");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalDir = path.join(projectRoot, ".xum", "skills", "demo-skill");
    const legacyDir = path.join(projectRoot, ".mux", "skills", "demo-skill");
    await fs.mkdir(path.join(canonicalDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(canonicalDir, "references", "canonical.txt"),
      "canonical",
      "utf-8"
    );
    await writeSkill(path.dirname(legacyDir), "demo-skill");

    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    });
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: SKILL_FILENAME, confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "file" });
    expect(fs.stat(path.join(canonicalDir, SKILL_FILENAME))).rejects.toThrow();
    expect(fs.stat(path.join(legacyDir, SKILL_FILENAME))).rejects.toThrow();
    expect(await fs.readFile(path.join(canonicalDir, "references", "canonical.txt"), "utf-8")).toBe(
      "canonical"
    );
  });

  it("keeps the canonical manifest when legacy manifest deletion fails", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-manifest-failure");
    const projectRoot = path.join(tempDir.path, "project");
    const canonicalManifest = path.join(
      projectRoot,
      ".xum",
      "skills",
      "demo-skill",
      SKILL_FILENAME
    );
    const legacyManifest = path.join(projectRoot, ".mux", "skills", "demo-skill", SKILL_FILENAME);
    await writeSkill(path.dirname(path.dirname(canonicalManifest)), "demo-skill");
    await writeSkill(path.dirname(path.dirname(legacyManifest)), "demo-skill");
    const rmSpy = spyOn(fs, "rm").mockRejectedValueOnce(new Error("permission denied"));
    try {
      const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      });
      const result = (await tool.execute!(
        { name: "demo-skill", filePath: SKILL_FILENAME, confirm: true },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;
      expect(result.success).toBe(false);
      expect(await fs.readFile(canonicalManifest, "utf-8")).toContain("name: demo-skill");
      expect(await fs.readFile(legacyManifest, "utf-8")).toContain("name: demo-skill");
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("deletes host-local project skills through the host runtime for Devcontainers", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-devcontainer-host");
    const projectRoot = path.join(tempDir.path, "project");
    await writeSkill(path.join(projectRoot, ".xum", "skills"), "demo-skill");
    const runtime = new DevcontainerRuntime({
      srcBaseDir: path.join(tempDir.path, "src"),
      configPath: path.join(projectRoot, ".devcontainer", "devcontainer.json"),
    });
    const config = createTestToolConfig(tempDir.path, {
      runtime,
      xumScope: {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      },
    });

    const result = (await createAgentSkillDeleteTool(config).execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });
    expect(fs.stat(path.join(projectRoot, ".xum", "skills", "demo-skill"))).rejects.toThrow();
  });

  describe("split-root (project-runtime)", () => {
    it("deletes project skill via runtime in split-root context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-delete-split-root-project-runtime");
      const skillName = "my-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      await writeSkillWithReference(path.join(tempDir.path, ".xum"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
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

      const skillDir = path.join(tempDir.path, ".xum", "skills", skillName);
      const statErr = await fs.stat(skillDir).catch((error: NodeJS.ErrnoException) => error);
      expect(statErr).toMatchObject({ code: "ENOENT" });
    });

    it("deletes project skill via runtime with tilde-prefixed workspace root", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-delete-split-root-project-runtime-tilde-skill"
      );
      const skillName = "my-skill";
      const runtimeWorkspaceRoot = path.join(tempDir.path, "remote-home", "xum", "project", "main");

      await writeSkillWithReference(path.join(runtimeWorkspaceRoot, ".xum"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
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

      const skillDir = path.join(runtimeWorkspaceRoot, ".xum", "skills", skillName);
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
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
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

      await writeSkillWithReference(path.join(tempDir.path, ".xum"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
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
        ".xum",
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
        path.join(tempDir.path, ".xum", "skills", skillName, "SKILL.md")
      );
      expect(skillStat.isFile()).toBe(true);
    });

    it("deletes single file from project skill via runtime with tilde-prefixed workspace root", async () => {
      using tempDir = new TestTempDir(
        "test-agent-skill-delete-split-root-project-runtime-tilde-file"
      );
      const skillName = "my-skill";
      const runtimeWorkspaceRoot = path.join(tempDir.path, "remote-home", "xum", "project", "main");

      await writeSkillWithReference(path.join(runtimeWorkspaceRoot, ".xum"), skillName);

      const remoteRuntime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
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
        ".xum",
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
        path.join(runtimeWorkspaceRoot, ".xum", "skills", skillName, "SKILL.md")
      );
      expect(skillStat.isFile()).toBe(true);
    });

    it("rejects delete when .xum is symlinked outside workspace in split-root runtime context", async () => {
      using tempDir = new TestTempDir("test-agent-skill-delete-split-root-runtime-symlink-escape");
      using externalDir = new TestTempDir(
        "test-agent-skill-delete-split-root-runtime-symlink-target"
      );
      const skillName = "demo-skill";
      const remoteWorkspaceRoot = "/remote/workspace";

      const externalXumDir = externalDir.path;
      const externalSkillDir = path.join(externalXumDir, "skills", skillName);
      await fs.mkdir(externalSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(externalSkillDir, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: fixture\n---\nBody\n`,
        "utf-8"
      );

      await fs.symlink(
        externalXumDir,
        path.join(tempDir.path, ".xum"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const remoteRuntime = new RemotePathMappedRuntime(tempDir.path, remoteWorkspaceRoot);
      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
        runtime: remoteRuntime,
        xumScope: {
          type: "project",
          xumHome: tempDir.path,
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

    await writeSkillWithReference(tempDir.path, "demo-skill");

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

    await writeSkillWithReference(tempDir.path, "demo-skill");

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

    await writeSkillWithReference(tempDir.path, "demo-skill");

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
    const previousXumRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = tempDir.path;

    try {
      const externalDir = path.join(tempDir.path, "external-skills-tree");
      const externalSkillDir = path.join(externalDir, "evil-skill");
      await fs.mkdir(externalSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(externalSkillDir, "SKILL.md"),
        "---\nname: evil-skill\ndescription: test\n---\nBody\n",
        "utf-8"
      );

      const xumDir = path.join(tempDir.path, ".xum");
      await fs.mkdir(xumDir, { recursive: true });
      await fs.symlink(
        externalDir,
        path.join(xumDir, "skills"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
        sessionsDir: path.join(xumDir, "sessions", GLOBAL_WORKSPACE_ID),
        xumScope: {
          type: "global",
          xumHome: xumDir,
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
      restoreXumRoot(previousXumRoot);
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

    await writeSkillWithReference(tempDir.path, "demo-skill");

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

    await writeSkillWithReference(tempDir.path, "demo-skill");

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

      await writeSkillWithReference(tempDir.path, "demo-skill");

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

  it("returns a clear not-found error when global xum home is missing", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-missing-global-xum-home");

    const missingXumHome = path.join(tempDir.path, "missing-xum-home");
    const tool = createAgentSkillDeleteTool(
      createTestToolConfig(tempDir.path, {
        xumScope: {
          type: "global",
          xumHome: missingXumHome,
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

    await writeSkillWithReference(tempDir.path, "demo-skill");

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

  it("rejects project deletes when .xum is a symlink to external directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-project-xum-symlink");

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

    // Symlink .xum to external
    await fs.symlink(externalDir, path.join(projectRoot, ".xum"));

    const projectScope: XumToolScope = {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const tool = await createDeleteTool(tempDir.path, GLOBAL_WORKSPACE_ID, projectScope);
    const result = (await tool.execute!(
      { name: "demo-skill", target: "skill", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/outside (?:containment|workspace) root|symbolic link/i);
    }

    // Verify external content is still intact
    const stat = await fs.stat(path.join(externalDir, "skills", "demo-skill", "SKILL.md"));
    expect(stat.isFile()).toBe(true);
  });
});
