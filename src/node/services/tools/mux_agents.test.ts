import { existsSync } from "fs";
import { describe, it, expect, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import type { ToolExecutionOptions } from "ai";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  MUX_HELP_CHAT_WORKSPACE_ID,
  MUX_HELP_CHAT_WORKSPACE_NAME,
  MUX_HELP_CHAT_WORKSPACE_TITLE,
} from "@/common/constants/muxChat";
import type { MuxToolScope } from "@/common/types/toolScope";
import { FILE_EDIT_DIFF_OMITTED_MESSAGE } from "@/common/types/tools";

import { resolveAgentsPathOnRuntime } from "./mux_agents_path";
import { createMuxAgentsReadTool } from "./mux_agents_read";
import { createMuxAgentsWriteTool } from "./mux_agents_write";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

function createGlobalMuxAgentsToolConfig(muxHome: string, workspaceSessionDir: string) {
  return {
    ...createTestToolConfig(muxHome, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
    }),
    muxScope: {
      type: "global" as const,
      muxHome,
    },
  };
}

function createProjectMuxAgentsToolConfig(
  muxHome: string,
  workspaceSessionDir: string,
  projectRoot: string
) {
  const muxScope: MuxToolScope = {
    type: "project",
    muxHome,
    projectRoot,
    projectStorageAuthority: "host-local",
  };

  return {
    ...createTestToolConfig(muxHome, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
    }),
    cwd: projectRoot,
    muxScope,
  };
}
const REMOTE_WORKSPACE_ROOT = "/remote/workspace";
const TILDE_WORKSPACE_ROOT = "~/mux/project/main";

function isAgentsPathProbeCommand(command: string): boolean {
  return (
    command.includes("__MUX_DANGLING__") &&
    command.includes("__MUX_EXISTS__") &&
    command.includes("__MUX_MISSING__")
  );
}

function createMockExecStream({
  stdout = "",
  stderr = "",
  exitCode,
}: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}): Awaited<ReturnType<LocalRuntime["exec"]>> {
  const toReadableStream = (content: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (content.length > 0) {
          controller.enqueue(new TextEncoder().encode(content));
        }
        controller.close();
      },
    });

  return {
    stdout: toReadableStream(stdout),
    stderr: toReadableStream(stderr),
    stdin: new WritableStream<Uint8Array>(),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(0),
  };
}

function mockAgentsPathProbe(
  runtime: RemotePathMappedRuntime,
  result: { stdout?: string; stderr?: string; exitCode: number }
) {
  const originalExec = runtime.exec.bind(runtime);
  return spyOn(runtime, "exec").mockImplementation((command, options) => {
    if (isAgentsPathProbeCommand(command)) {
      return Promise.resolve(createMockExecStream(result));
    }
    return originalExec(command, options);
  });
}

class RemotePathMappedRuntime extends LocalRuntime {
  private readonly localWorkspaceRoot: string;
  private readonly remoteWorkspaceRoot: string;
  private readonly localHomeForTildeRoot: string | null;

  constructor(localWorkspaceRoot: string, remoteWorkspaceRoot: string) {
    super(localWorkspaceRoot);
    this.localWorkspaceRoot = path.resolve(localWorkspaceRoot);
    this.remoteWorkspaceRoot =
      remoteWorkspaceRoot === "/" ? remoteWorkspaceRoot : remoteWorkspaceRoot.replace(/\/+$/u, "");

    if (this.remoteWorkspaceRoot === "~") {
      this.localHomeForTildeRoot = this.localWorkspaceRoot;
    } else if (this.remoteWorkspaceRoot.startsWith("~/")) {
      const homeRelativeSuffix = this.remoteWorkspaceRoot.slice(1);
      const normalizedLocalRoot = this.localWorkspaceRoot.replaceAll("\\", "/");
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
    return this.remoteWorkspaceRoot === "~" || this.remoteWorkspaceRoot.startsWith("~/");
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
    const localHomeForTildeRoot =
      this.localHomeForTildeRoot ?? process.env.HOME ?? this.localWorkspaceRoot;

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

/** Simulates BSD/macOS where readlink doesn't support -f */
class NoReadlinkFRemoteRuntime extends RemotePathMappedRuntime {
  override exec(
    command: string,
    options: Parameters<LocalRuntime["exec"]>[1]
  ): ReturnType<LocalRuntime["exec"]> {
    if (command.includes("readlink -f")) {
      return super.exec("echo 'readlink: illegal option -- f' >&2; exit 1", options);
    }
    return super.exec(command, options);
  }
}

function createRemoteProjectMuxAgentsToolConfig(
  muxHome: string,
  workspaceSessionDir: string,
  localProjectRoot: string
) {
  const runtime = new RemotePathMappedRuntime(localProjectRoot, REMOTE_WORKSPACE_ROOT);
  const muxScope: MuxToolScope = {
    type: "project",
    muxHome,
    projectRoot: localProjectRoot,
    projectStorageAuthority: "runtime",
  };

  return {
    ...createTestToolConfig(muxHome, {
      workspaceId: "ssh-workspace",
      sessionsDir: workspaceSessionDir,
      runtime,
    }),
    cwd: REMOTE_WORKSPACE_ROOT,
    muxScope,
  };
}

describe("mux_agents_* tools", () => {
  it("reads ~/.mux/AGENTS.md (returns empty string if missing)", async () => {
    using muxHome = new TestTempDir("mux-global-agents");

    const workspaceSessionDir = path.join(muxHome.path, "sessions", MUX_HELP_CHAT_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const config = createGlobalMuxAgentsToolConfig(muxHome.path, workspaceSessionDir);

    const tool = createMuxAgentsReadTool(config);

    // Missing file -> empty
    const missing = (await tool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      content?: string;
    };
    expect(missing.success).toBe(true);
    if (missing.success) {
      expect(missing.content).toBe("");
    }

    // Present file -> contents
    const agentsPath = path.join(muxHome.path, "AGENTS.md");
    await fs.writeFile(
      agentsPath,
      `# ${MUX_HELP_CHAT_WORKSPACE_TITLE}\n${MUX_HELP_CHAT_WORKSPACE_NAME}\n`,
      "utf-8"
    );

    const result = (await tool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      content?: string;
    };
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toContain(MUX_HELP_CHAT_WORKSPACE_TITLE);
      expect(result.content).toContain(MUX_HELP_CHAT_WORKSPACE_NAME);
    }
  });

  it("reads project AGENTS.md when scope is project", async () => {
    using muxHome = new TestTempDir("mux-project-agents-read");

    const workspaceSessionDir = path.join(muxHome.path, "sessions", MUX_HELP_CHAT_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const projectRoot = path.join(muxHome.path, "my-project");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "# Project agents\n", "utf-8");

    const config = createProjectMuxAgentsToolConfig(muxHome.path, workspaceSessionDir, projectRoot);
    const tool = createMuxAgentsReadTool(config);

    const result = (await tool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      content?: string;
    };

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toContain("Project agents");
    }
  });
  it("refuses to write without explicit confirmation", async () => {
    using muxHome = new TestTempDir("mux-global-agents");

    const workspaceSessionDir = path.join(muxHome.path, "sessions", MUX_HELP_CHAT_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const config = createGlobalMuxAgentsToolConfig(muxHome.path, workspaceSessionDir);

    const tool = createMuxAgentsWriteTool(config);

    const agentsPath = path.join(muxHome.path, "AGENTS.md");

    const result = (await tool.execute!(
      { newContent: "test", confirm: false },
      mockToolCallOptions
    )) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("confirm");
    }

    let readError: unknown;
    try {
      await fs.readFile(agentsPath, "utf-8");
    } catch (error) {
      readError = error;
    }

    expect(readError).toMatchObject({ code: "ENOENT" });
  });

  it("writes ~/.mux/AGENTS.md and returns a diff", async () => {
    using muxHome = new TestTempDir("mux-global-agents");

    const workspaceSessionDir = path.join(muxHome.path, "sessions", MUX_HELP_CHAT_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const config = createGlobalMuxAgentsToolConfig(muxHome.path, workspaceSessionDir);

    const tool = createMuxAgentsWriteTool(config);

    const newContent = "# Global agents\n\nHello\n";

    const result = (await tool.execute!({ newContent, confirm: true }, mockToolCallOptions)) as {
      success: boolean;
      diff?: string;
      ui_only?: { file_edit?: { diff?: string } };
    };

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.diff).toBe(FILE_EDIT_DIFF_OMITTED_MESSAGE);
      expect(result.ui_only?.file_edit?.diff).toContain("AGENTS.md");
    }

    const written = await fs.readFile(path.join(muxHome.path, "AGENTS.md"), "utf-8");
    expect(written).toBe(newContent);
  });

  it("writes project AGENTS.md when scope is project", async () => {
    using muxHome = new TestTempDir("mux-project-agents-write");

    const workspaceSessionDir = path.join(muxHome.path, "sessions", MUX_HELP_CHAT_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const projectRoot = path.join(muxHome.path, "my-project");
    await fs.mkdir(projectRoot, { recursive: true });

    const config = createProjectMuxAgentsToolConfig(muxHome.path, workspaceSessionDir, projectRoot);
    const tool = createMuxAgentsWriteTool(config);

    const newContent = "# Project agents\n\nProject scoped\n";
    const result = (await tool.execute!({ newContent, confirm: true }, mockToolCallOptions)) as {
      success: boolean;
      diff?: string;
      ui_only?: { file_edit?: { diff?: string } };
    };

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.diff).toBe(FILE_EDIT_DIFF_OMITTED_MESSAGE);
      expect(result.ui_only?.file_edit?.diff).toContain("AGENTS.md");
    }

    const written = await fs.readFile(path.join(projectRoot, "AGENTS.md"), "utf-8");
    expect(written).toBe(newContent);
  });
  it("reads and writes project AGENTS.md through an in-root symlink", async () => {
    using muxHome = new TestTempDir("mux-project-agents-symlink");

    const workspaceSessionDir = path.join(muxHome.path, "sessions", MUX_HELP_CHAT_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const projectRoot = path.join(muxHome.path, "my-project");
    const docsDir = path.join(projectRoot, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    const targetPath = path.join(docsDir, "AGENTS.md");
    await fs.writeFile(targetPath, "# Project agents\n\nOriginal\n", "utf-8");
    await fs.symlink(path.join("docs", "AGENTS.md"), path.join(projectRoot, "AGENTS.md"));

    const config = createProjectMuxAgentsToolConfig(muxHome.path, workspaceSessionDir, projectRoot);
    const readTool = createMuxAgentsReadTool(config);
    const writeTool = createMuxAgentsWriteTool(config);

    const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      content?: string;
    };
    expect(readResult.success).toBe(true);
    if (readResult.success) {
      expect(readResult.content).toContain("Original");
    }

    const newContent = "# Project agents\n\nUpdated through symlink\n";
    const writeResult = (await writeTool.execute!(
      { newContent, confirm: true },
      mockToolCallOptions
    )) as {
      success: boolean;
      diff?: string;
      ui_only?: { file_edit?: { diff?: string } };
    };

    expect(writeResult.success).toBe(true);
    if (writeResult.success) {
      expect(writeResult.diff).toBe(FILE_EDIT_DIFF_OMITTED_MESSAGE);
      expect(writeResult.ui_only?.file_edit?.diff).toContain("AGENTS.md");
    }

    const writtenTarget = await fs.readFile(targetPath, "utf-8");
    expect(writtenTarget).toBe(newContent);
  });

  it("rejects dangling AGENTS.md symlinks for read and write", async () => {
    using muxHome = new TestTempDir("mux-project-agents-dangling-symlink");

    const workspaceSessionDir = path.join(muxHome.path, "sessions", MUX_HELP_CHAT_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const projectRoot = path.join(muxHome.path, "my-project");
    const outsideDir = path.join(muxHome.path, "outside");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    const danglingTarget = path.join(outsideDir, "AGENTS.md");
    await fs.symlink(danglingTarget, path.join(projectRoot, "AGENTS.md"));

    const config = createProjectMuxAgentsToolConfig(muxHome.path, workspaceSessionDir, projectRoot);
    const readTool = createMuxAgentsReadTool(config);
    const writeTool = createMuxAgentsWriteTool(config);

    const writeResult = (await writeTool.execute!(
      { newContent: "# should fail\n", confirm: true },
      mockToolCallOptions
    )) as { success: boolean; error?: string };
    expect(writeResult.success).toBe(false);
    if (!writeResult.success) {
      expect(writeResult.error).toContain("dangling symlink");
    }

    const accessError = await fs.access(danglingTarget).catch((e: unknown) => e);
    expect(accessError).toMatchObject({ code: "ENOENT" });

    const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      error?: string;
    };
    expect(readResult.success).toBe(false);
    if (!readResult.success) {
      expect(readResult.error).toContain("dangling symlink");
    }
  });

  it("rejects AGENTS.md symlink targets that escape the expected root", async () => {
    using muxHome = new TestTempDir("mux-global-agents");
    using outsideRoot = new TestTempDir("mux-global-agents-outside-root");

    const workspaceSessionDir = path.join(muxHome.path, "sessions", MUX_HELP_CHAT_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const config = createGlobalMuxAgentsToolConfig(muxHome.path, workspaceSessionDir);

    const readTool = createMuxAgentsReadTool(config);
    const writeTool = createMuxAgentsWriteTool(config);

    const agentsPath = path.join(muxHome.path, "AGENTS.md");
    const targetPath = path.join(outsideRoot.path, "target.txt");
    await fs.writeFile(targetPath, "secret", "utf-8");
    await fs.symlink(targetPath, agentsPath);

    const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      error?: string;
    };
    expect(readResult.success).toBe(false);
    if (!readResult.success) {
      expect(readResult.error).toContain("escapes expected root");
    }

    const writeResult = (await writeTool.execute!(
      { newContent: "nope", confirm: true },
      mockToolCallOptions
    )) as { success: boolean; error?: string };
    expect(writeResult.success).toBe(false);
    if (!writeResult.success) {
      expect(writeResult.error).toContain("escapes expected root");
    }
  });

  describe("missing root directory self-healing", () => {
    it("read returns empty content when root directory does not exist", async () => {
      using tempDir = new TestTempDir("mux-global-agents-missing-root-read");

      const workspaceId = "missing-root-read";
      const nonexistentMuxHome = path.join(tempDir.path, "nonexistent-mux-home");
      const workspaceSessionDir = path.join(tempDir.path, "sessions", workspaceId);
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const config = {
        ...createTestToolConfig(nonexistentMuxHome, {
          workspaceId,
          sessionsDir: workspaceSessionDir,
        }),
        cwd: nonexistentMuxHome,
        muxScope: {
          type: "global" as const,
          muxHome: nonexistentMuxHome,
        },
      };

      const readTool = createMuxAgentsReadTool(config);
      const result = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("");
      }
    });

    it("write succeeds and creates root directory when absent", async () => {
      using tempDir = new TestTempDir("mux-global-agents-missing-root-write");

      const workspaceId = "missing-root-write";
      const nonexistentMuxHome = path.join(tempDir.path, "nonexistent-mux-home");
      const workspaceSessionDir = path.join(tempDir.path, "sessions", workspaceId);
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const config = {
        ...createTestToolConfig(nonexistentMuxHome, {
          workspaceId,
          sessionsDir: workspaceSessionDir,
        }),
        cwd: nonexistentMuxHome,
        muxScope: {
          type: "global" as const,
          muxHome: nonexistentMuxHome,
        },
      };

      const writeTool = createMuxAgentsWriteTool(config);
      const newContent = "# Test AGENTS";
      const result = (await writeTool.execute!(
        { newContent, confirm: true },
        mockToolCallOptions
      )) as { success: boolean };

      expect(result.success).toBe(true);

      const written = await fs.readFile(path.join(nonexistentMuxHome, "AGENTS.md"), "utf-8");
      expect(written).toBe(newContent);
    });

    it("read sees content after write to previously-missing root", async () => {
      using tempDir = new TestTempDir("mux-global-agents-missing-root-round-trip");

      const workspaceId = "missing-root-round-trip";
      const nonexistentMuxHome = path.join(tempDir.path, "nonexistent-mux-home");
      const workspaceSessionDir = path.join(tempDir.path, "sessions", workspaceId);
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const config = {
        ...createTestToolConfig(nonexistentMuxHome, {
          workspaceId,
          sessionsDir: workspaceSessionDir,
        }),
        cwd: nonexistentMuxHome,
        muxScope: {
          type: "global" as const,
          muxHome: nonexistentMuxHome,
        },
      };

      const writeTool = createMuxAgentsWriteTool(config);
      const readTool = createMuxAgentsReadTool(config);
      const newContent = "# Test AGENTS\n\nRound trip\n";

      const writeResult = (await writeTool.execute!(
        { newContent, confirm: true },
        mockToolCallOptions
      )) as { success: boolean };
      expect(writeResult.success).toBe(true);

      const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };
      expect(readResult.success).toBe(true);
      if (readResult.success) {
        expect(readResult.content).toBe(newContent);
      }
    });

    it("write fails when project root directory does not exist", async () => {
      using tempDir = new TestTempDir("mux-project-agents-missing-root-write");

      const workspaceSessionDir = path.join(tempDir.path, "sessions", "project-missing-root-write");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const nonexistentProjectRoot = path.join(tempDir.path, "nonexistent-project");
      const config = createProjectMuxAgentsToolConfig(
        tempDir.path,
        workspaceSessionDir,
        nonexistentProjectRoot
      );

      const writeTool = createMuxAgentsWriteTool(config);
      const result = (await writeTool.execute!(
        { newContent: "# Test AGENTS", confirm: true },
        mockToolCallOptions
      )) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(existsSync(nonexistentProjectRoot)).toBe(false);
    });

    it("read returns empty content when project root directory does not exist", async () => {
      using tempDir = new TestTempDir("mux-project-agents-missing-root-read");

      const workspaceSessionDir = path.join(tempDir.path, "sessions", "project-missing-root-read");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const nonexistentProjectRoot = path.join(tempDir.path, "nonexistent-project");
      const config = createProjectMuxAgentsToolConfig(
        tempDir.path,
        workspaceSessionDir,
        nonexistentProjectRoot
      );

      const readTool = createMuxAgentsReadTool(config);
      const result = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("");
      }
      expect(existsSync(nonexistentProjectRoot)).toBe(false);
    });
  });

  describe("split-root (SSH/Docker) project workspaces", () => {
    it("reads AGENTS.md from runtime workspace (not host project root)", async () => {
      using muxHome = new TestTempDir("mux-project-agents-split-root-read");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(muxHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(muxHome.path, "runtime-project");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      await fs.writeFile(path.join(hostProjectRoot, "AGENTS.md"), "# Host AGENTS\n", "utf-8");
      await fs.writeFile(
        path.join(runtimeWorkspaceRoot, "AGENTS.md"),
        "# Runtime AGENTS\n",
        "utf-8"
      );

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);

      const tool = createMuxAgentsReadTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("# Runtime AGENTS\n");
      }
    });

    it("reads AGENTS.md from tilde-prefixed runtime workspace", async () => {
      using muxHome = new TestTempDir("mux-project-agents-split-root-read-tilde");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(muxHome.path, "host-project");
      const runtimeHomeRoot = path.join(muxHome.path, "remote-home");
      const runtimeWorkspaceRoot = path.join(runtimeHomeRoot, "mux", "project", "main");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      await fs.writeFile(
        path.join(runtimeWorkspaceRoot, "AGENTS.md"),
        "# Tilde Runtime AGENTS\n",
        "utf-8"
      );

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      config.cwd = TILDE_WORKSPACE_ROOT;

      const tool = createMuxAgentsReadTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("# Tilde Runtime AGENTS\n");
      }
    });

    it("reads AGENTS.md through symlink in tilde-prefixed runtime workspace", async () => {
      using muxHome = new TestTempDir("mux-project-agents-split-root-read-tilde-symlink");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(muxHome.path, "host-project");
      const runtimeHomeRoot = path.join(muxHome.path, "remote-home");
      const runtimeWorkspaceRoot = path.join(runtimeHomeRoot, "mux", "project", "main");
      const docsDir = path.join(runtimeWorkspaceRoot, "docs");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(docsDir, { recursive: true });

      await fs.writeFile(
        path.join(docsDir, "AGENTS.md"),
        "# Tilde Runtime Symlink AGENTS\n",
        "utf-8"
      );
      await fs.symlink(
        path.join("docs", "AGENTS.md"),
        path.join(runtimeWorkspaceRoot, "AGENTS.md")
      );

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      config.cwd = TILDE_WORKSPACE_ROOT;

      const tool = createMuxAgentsReadTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("# Tilde Runtime Symlink AGENTS\n");
      }
    });

    it("rejects AGENTS.md symlink escape in tilde-prefixed runtime workspace", async () => {
      using muxHome = new TestTempDir("mux-project-agents-split-root-tilde-symlink-escape");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(muxHome.path, "host-project");
      const runtimeHomeRoot = path.join(muxHome.path, "remote-home");
      const runtimeWorkspaceRoot = path.join(runtimeHomeRoot, "mux", "project", "main");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      const escapeTarget = path.join(muxHome.path, "secret.md");
      await fs.writeFile(escapeTarget, "secret content", "utf-8");
      await fs.symlink(escapeTarget, path.join(runtimeWorkspaceRoot, "AGENTS.md"));

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      config.cwd = TILDE_WORKSPACE_ROOT;

      const tool = createMuxAgentsReadTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain("escapes");
    });

    it("reads empty string when AGENTS.md missing in runtime workspace", async () => {
      using muxHome = new TestTempDir("mux-project-agents-split-root-read-missing");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(muxHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(muxHome.path, "runtime-project");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);

      const tool = createMuxAgentsReadTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result).toEqual({ success: true, content: "" });
    });

    it("returns an error when the runtime AGENTS probe exits non-zero during read", async () => {
      using muxHome = new TestTempDir("mux-project-agents-split-root-read-probe-error");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(muxHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(muxHome.path, "runtime-project");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });
      await fs.writeFile(
        path.join(runtimeWorkspaceRoot, "AGENTS.md"),
        "# Runtime AGENTS\n",
        "utf-8"
      );

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      const runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);
      config.runtime = runtime;

      const execSpy = mockAgentsPathProbe(runtime, {
        stderr: "ssh probe failed",
        exitCode: 255,
      });

      try {
        const tool = createMuxAgentsReadTool(config);
        const result = (await tool.execute!({}, mockToolCallOptions)) as {
          success: boolean;
          error?: string;
        };

        expect(result.success).toBe(false);
        expect(result.error).toContain("Runtime AGENTS.md probe failed");
        expect(result.error).toContain("ssh probe failed");
      } finally {
        execSpy.mockRestore();
      }
    });

    it("returns an error when the runtime AGENTS probe exits non-zero during write", async () => {
      using muxHome = new TestTempDir("mux-project-agents-split-root-write-probe-error");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(muxHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(muxHome.path, "runtime-project");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });
      await fs.writeFile(
        path.join(runtimeWorkspaceRoot, "AGENTS.md"),
        "# Runtime AGENTS\n",
        "utf-8"
      );

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      const runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);
      config.runtime = runtime;

      const execSpy = mockAgentsPathProbe(runtime, {
        stderr: "ssh probe failed",
        exitCode: 255,
      });

      try {
        const tool = createMuxAgentsWriteTool(config);
        const result = (await tool.execute!(
          { newContent: "# Updated Runtime AGENTS", confirm: true },
          mockToolCallOptions
        )) as { success: boolean; error?: string };

        expect(result.success).toBe(false);
        expect(result.error).toContain("Runtime AGENTS.md probe failed");
        expect(result.error).toContain("ssh probe failed");

        const runtimeAgentsPath = path.join(runtimeWorkspaceRoot, "AGENTS.md");
        const runtimeContent = await fs.readFile(runtimeAgentsPath, "utf-8");
        expect(runtimeContent).toBe("# Runtime AGENTS\n");
      } finally {
        execSpy.mockRestore();
      }
    });

    it("returns an error when the runtime AGENTS probe prints unexpected stdout", async () => {
      using muxHome = new TestTempDir("mux-project-agents-split-root-unexpected-probe-stdout");

      const runtimeWorkspaceRoot = path.join(muxHome.path, "runtime-project");
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      const runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);
      const execSpy = mockAgentsPathProbe(runtime, {
        stdout: "unexpected\n",
        exitCode: 0,
      });

      try {
        const resolved = await resolveAgentsPathOnRuntime(runtime, REMOTE_WORKSPACE_ROOT);

        expect(resolved.kind).toBe("error");
        if (resolved.kind === "error") {
          expect(resolved.error).toContain("unexpected output");
        }
      } finally {
        execSpy.mockRestore();
      }
    });

    it("writes AGENTS.md to runtime workspace (leaves host project root unchanged)", async () => {
      using muxHome = new TestTempDir("mux-project-agents-split-root-write");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(muxHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(muxHome.path, "runtime-project");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      const hostAgentsPath = path.join(hostProjectRoot, "AGENTS.md");
      await fs.writeFile(hostAgentsPath, "# Host AGENTS\n", "utf-8");

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);

      const tool = createMuxAgentsWriteTool(config);
      const result = (await tool.execute!(
        { newContent: "# Remote AGENTS", confirm: true },
        mockToolCallOptions
      )) as {
        success: boolean;
        diff?: string;
        ui_only?: { file_edit?: { diff?: string } };
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.diff).toBe(FILE_EDIT_DIFF_OMITTED_MESSAGE);
        expect(result.ui_only?.file_edit?.diff).toContain("AGENTS.md");
      }

      const runtimeAgentsPath = path.join(runtimeWorkspaceRoot, "AGENTS.md");
      const runtimeContent = await fs.readFile(runtimeAgentsPath, "utf-8");
      expect(runtimeContent).toBe("# Remote AGENTS");

      const hostContent = await fs.readFile(hostAgentsPath, "utf-8");
      expect(hostContent).toBe("# Host AGENTS\n");
    });
    it("writes through runtime AGENTS.md symlinks without replacing them", async () => {
      using muxHome = new TestTempDir("mux-project-agents-split-root-write-symlink");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(muxHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(muxHome.path, "runtime-project");
      const docsDir = path.join(runtimeWorkspaceRoot, "docs");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(docsDir, { recursive: true });

      const agentsPath = path.join(runtimeWorkspaceRoot, "AGENTS.md");
      const targetPath = path.join(docsDir, "AGENTS.md");
      const symlinkTarget = path.join("docs", "AGENTS.md");
      await fs.writeFile(targetPath, "# Runtime Symlink AGENTS\n", "utf-8");
      await fs.symlink(symlinkTarget, agentsPath);

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      const runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);
      config.runtime = runtime;

      const resolved = await resolveAgentsPathOnRuntime(runtime, REMOTE_WORKSPACE_ROOT);
      expect(resolved.kind).toBe("existing");
      if (resolved.kind === "existing") {
        expect(resolved.realPath).toBe(runtime.normalizePath(symlinkTarget, REMOTE_WORKSPACE_ROOT));
      }

      const tool = createMuxAgentsWriteTool(config);
      const newContent = "# Updated Runtime Symlink AGENTS\n";
      const result = (await tool.execute!({ newContent, confirm: true }, mockToolCallOptions)) as {
        success: boolean;
      };
      expect(result.success).toBe(true);

      const writtenTarget = await fs.readFile(targetPath, "utf-8");
      expect(writtenTarget).toBe(newContent);

      const linkStat = await fs.lstat(agentsPath);
      expect(linkStat.isSymbolicLink()).toBe(true);
      expect(await fs.readlink(agentsPath)).toBe(symlinkTarget);
    });

    it("rejects AGENTS.md symlink targets that escape runtime workspace root", async () => {
      using muxHome = new TestTempDir("mux-remote-agents-symlink-escape");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      // Create a project root with workspace backing dir
      const projectRoot = path.join(muxHome.path, "my-project");
      await fs.mkdir(projectRoot, { recursive: true });

      // Create an escape target outside the workspace root
      const escapeTarget = path.join(muxHome.path, "secret.md");
      await fs.writeFile(escapeTarget, "secret content", "utf-8");

      // Create AGENTS.md as symlink pointing outside workspace root
      await fs.symlink(escapeTarget, path.join(projectRoot, "AGENTS.md"));

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        projectRoot
      );

      const readTool = createMuxAgentsReadTool(config);
      const writeTool = createMuxAgentsWriteTool(config);

      // Read should reject the symlink escape
      const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        error?: string;
      };
      expect(readResult.success).toBe(false);
      expect(readResult.error).toContain("escapes");

      // Write should also reject
      const writeResult = (await writeTool.execute!(
        { newContent: "hacked", confirm: true },
        mockToolCallOptions
      )) as { success: boolean; error?: string };
      expect(writeResult.success).toBe(false);
      expect(writeResult.error).toContain("escapes");

      // Verify escape target was not modified
      const secretContent = await fs.readFile(escapeTarget, "utf-8");
      expect(secretContent).toBe("secret content");
    });

    it("rejects dangling symlinks in runtime workspace", async () => {
      using muxHome = new TestTempDir("mux-remote-agents-dangling-symlink");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const projectRoot = path.join(muxHome.path, "my-project");
      await fs.mkdir(projectRoot, { recursive: true });

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        projectRoot
      );

      const readTool = createMuxAgentsReadTool(config);
      const writeTool = createMuxAgentsWriteTool(config);

      const externalTarget = path.join(projectRoot, "..", "outside", "missing.md");
      const agentsPath = path.join(projectRoot, "AGENTS.md");
      await fs.symlink(externalTarget, agentsPath);

      const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        error?: string;
      };
      expect(readResult.success).toBe(false);
      expect(readResult.error).toContain("dangling symlink");

      const writeResult = (await writeTool.execute!(
        { newContent: "# Hacked", confirm: true },
        mockToolCallOptions
      )) as { success: boolean; error?: string };
      expect(writeResult.success).toBe(false);
      expect(writeResult.error).toContain("dangling symlink");

      const targetExists = await fs
        .access(externalTarget)
        .then(() => true)
        .catch(() => false);
      expect(targetExists).toBe(false);
    });

    it("works on BSD-like runtimes without GNU readlink -f", async () => {
      using muxHome = new TestTempDir("mux-remote-agents-bsd-compat");

      const workspaceSessionDir = path.join(muxHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const projectRoot = path.join(muxHome.path, "my-project");
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "# BSD Test\n", "utf-8");

      const config = createRemoteProjectMuxAgentsToolConfig(
        muxHome.path,
        workspaceSessionDir,
        projectRoot
      );
      // Replace runtime with one that rejects readlink -f
      config.runtime = new NoReadlinkFRemoteRuntime(projectRoot, REMOTE_WORKSPACE_ROOT);

      const readTool = createMuxAgentsReadTool(config);
      const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };
      expect(readResult.success).toBe(true);
      expect(readResult.content).toContain("BSD Test");

      const writeTool = createMuxAgentsWriteTool(config);
      const writeResult = (await writeTool.execute!(
        { newContent: "# Updated BSD", confirm: true },
        mockToolCallOptions
      )) as { success: boolean };
      expect(writeResult.success).toBe(true);
    });
  });
});
