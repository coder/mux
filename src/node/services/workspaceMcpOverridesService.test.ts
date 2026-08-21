import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";

function getWorkspacePath(args: {
  srcDir: string;
  projectName: string;
  workspaceName: string;
}): string {
  return path.join(args.srcDir, args.projectName, args.workspaceName);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("WorkspaceMcpOverridesService", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-mcp-overrides-test-"));
    config = new Config(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function registerWorkspace(workspaceName: string): Promise<{
    workspaceId: string;
    workspacePath: string;
  }> {
    const projectPath = `/fake/${workspaceName}`;
    const workspaceId = `ws-${workspaceName}`;
    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: workspaceName,
      workspaceName: "branch",
    });
    await fs.mkdir(workspacePath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: "branch",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });
    return { workspaceId, workspacePath };
  }

  it("returns empty overrides when no file and no legacy config", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);
    const overrides = await service.getOverridesForWorkspace(workspaceId);

    expect(overrides).toEqual({});
    expect(await pathExists(path.join(workspacePath, ".xum", "mcp.local.jsonc"))).toBe(false);
  });

  it("reads legacy JSONC and JSON override files", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    for (const [index, filename] of ["mcp.local.jsonc", "mcp.local.json"].entries()) {
      const { workspaceId, workspacePath } = await registerWorkspace(`legacy-${index}`);
      await fs.mkdir(path.join(workspacePath, ".mux"), { recursive: true });
      await fs.writeFile(
        path.join(workspacePath, ".mux", filename),
        JSON.stringify({ disabledServers: [`legacy-${index}`] }),
        "utf-8"
      );

      expect(await service.getOverridesForWorkspace(workspaceId)).toEqual({
        disabledServers: [`legacy-${index}`],
      });
    }
  });

  it("prefers canonical override files when both metadata trees exist", async () => {
    const { workspaceId, workspacePath } = await registerWorkspace("canonical-precedence");
    await fs.mkdir(path.join(workspacePath, ".mux"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, ".mux", "mcp.local.jsonc"),
      JSON.stringify({ disabledServers: ["legacy"] }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspacePath, ".xum", "mcp.local.jsonc"),
      JSON.stringify({ disabledServers: ["canonical"] }),
      "utf-8"
    );

    const service = new WorkspaceMcpOverridesService(config);
    expect(await service.getOverridesForWorkspace(workspaceId)).toEqual({
      disabledServers: ["canonical"],
    });
  });

  it("adds .xum/mcp.local.jsonc to git exclude when writing overrides", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    const runtime = createRuntime({ type: "local" }, { projectPath: workspacePath });
    const gitInitResult = await execBuffered(runtime, "git init", {
      cwd: workspacePath,
      timeout: 10,
    });
    expect(gitInitResult.exitCode).toBe(0);

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);

    const excludePathResult = await execBuffered(runtime, "git rev-parse --git-path info/exclude", {
      cwd: workspacePath,
      timeout: 10,
    });
    expect(excludePathResult.exitCode).toBe(0);

    const excludePathRaw = excludePathResult.stdout.trim();
    expect(excludePathRaw.length).toBeGreaterThan(0);

    const excludePath = path.isAbsolute(excludePathRaw)
      ? excludePathRaw
      : path.join(workspacePath, excludePathRaw);

    const before = (await pathExists(excludePath)) ? await fs.readFile(excludePath, "utf-8") : "";
    expect(before).not.toContain(".xum/mcp.local.jsonc");

    await service.setOverridesForWorkspace(workspaceId, {
      disabledServers: ["server-a"],
    });

    const after = await fs.readFile(excludePath, "utf-8");
    expect(after).toContain(".xum/mcp.local.jsonc");
    expect(after).toContain(".mux/mcp.local.jsonc");
  });
  it("persists overrides to .xum/mcp.local.jsonc and reads them back", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);

    await service.setOverridesForWorkspace(workspaceId, {
      disabledServers: ["server-a", "server-a"],
      toolAllowlist: { "server-b": ["tool1", "tool1", ""] },
    });

    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    expect(await pathExists(filePath)).toBe(true);

    const roundTrip = await service.getOverridesForWorkspace(workspaceId);
    expect(roundTrip).toEqual({
      disabledServers: ["server-a"],
      toolAllowlist: { "server-b": ["tool1"] },
    });
  });

  it("removes workspace-local file when overrides are set to empty", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);

    await service.setOverridesForWorkspace(workspaceId, {
      disabledServers: ["server-a"],
    });

    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    expect(await pathExists(filePath)).toBe(true);

    await service.setOverridesForWorkspace(workspaceId, {});
    expect(await pathExists(filePath)).toBe(false);
  });

  it("migrates legacy config.json overrides into workspace-local file", async () => {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            mcp: {
              disabledServers: ["server-a"],
              toolAllowlist: { "server-b": ["tool1"] },
            },
          },
        ],
      });
      return cfg;
    });

    const service = new WorkspaceMcpOverridesService(config);
    const overrides = await service.getOverridesForWorkspace(workspaceId);

    expect(overrides).toEqual({
      disabledServers: ["server-a"],
      toolAllowlist: { "server-b": ["tool1"] },
    });

    // File written
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    expect(await pathExists(filePath)).toBe(true);

    // Legacy config cleared
    const loaded = config.loadConfigOrDefault();
    const projectConfig = loaded.projects.get(projectPath);
    expect(projectConfig).toBeDefined();
    expect(projectConfig!.workspaces[0].mcp).toBeUndefined();
  });
});
