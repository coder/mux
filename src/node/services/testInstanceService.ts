import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProjectsConfig, ProjectConfig } from "@/common/types/project";
import { Err, Ok, type Result } from "@/common/types/result";
import { Config } from "@/node/config";

function sanitizeProjectConfigForTestInstance(project: ProjectConfig): ProjectConfig {
  return {
    ...project,
    // Drop workspace history so the test instance starts clean.
    workspaces: [],
    // Ensure arrays aren't shared between instances.
    sections: project.sections ? [...project.sections] : undefined,
  };
}

export function createIsolatedConfigForTestInstance(source: ProjectsConfig): ProjectsConfig {
  const projects = new Map<string, ProjectConfig>();
  for (const [projectPath, projectConfig] of source.projects.entries()) {
    projects.set(projectPath, sanitizeProjectConfigForTestInstance(projectConfig));
  }

  return {
    ...source,
    projects,
    // Avoid API server port collisions if the main instance is pinned to a fixed port.
    apiServerPort: undefined,
  };
}

function isMissingFileError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  return (err as { code?: unknown }).code === "ENOENT";
}

function buildSpawnArgsForNewRoot(newRoot: string): string[] {
  const baseArgs = process.argv.slice(1);
  const filtered: string[] = [];

  for (let i = 0; i < baseArgs.length; i++) {
    const arg = baseArgs[i];

    const isMuxRootFlag = arg === "--mux-root" || arg === "--root";
    const isRemoteDebuggingFlag = arg === "--remote-debugging-port";

    if (isMuxRootFlag || isRemoteDebuggingFlag) {
      // Handle `--flag value`.
      const maybeValue = baseArgs[i + 1];
      if (maybeValue && !maybeValue.startsWith("-")) {
        i += 1;
      }
      continue;
    }

    // Handle `--flag=value`.
    if (
      arg.startsWith("--mux-root=") ||
      arg.startsWith("--root=") ||
      arg.startsWith("--remote-debugging-port=")
    ) {
      continue;
    }

    filtered.push(arg);
  }

  return [...filtered, "--mux-root", newRoot];
}

export class TestInstanceService {
  constructor(private readonly config: Config) {}

  private async createInstanceRoot(): Promise<string> {
    const instancesDir = path.join(this.config.rootDir, "instances");
    await fs.mkdir(instancesDir, { recursive: true });

    // node:fs mkdtemp always appends 6 random characters.
    // Keep the prefix Windows-safe (no ':'), but human-readable.
    return fs.mkdtemp(path.join(instancesDir, "test-instance-"));
  }

  private async copyIfExists(src: string, dest: string): Promise<void> {
    try {
      await fs.copyFile(src, dest);
    } catch (err) {
      if (isMissingFileError(err)) return;
      throw err;
    }
  }

  async launchTestInstance(): Promise<Result<{ rootDir: string }>> {
    if (!process.versions.electron) {
      return Err("Launch Test Instance is only available in the desktop app.");
    }

    const rootDir = await this.createInstanceRoot();

    // Copy provider setup (API keys, endpoints), but not workspaces/sessions.
    for (const file of ["providers.jsonc", "secrets.json"] as const) {
      await this.copyIfExists(path.join(this.config.rootDir, file), path.join(rootDir, file));
    }

    const sourceConfig = this.config.loadConfigOrDefault();
    const instanceConfig = new Config(rootDir);
    await instanceConfig.saveConfig(createIsolatedConfigForTestInstance(sourceConfig));

    try {
      // Intentionally lazy import (rare debug action).
      // eslint-disable-next-line no-restricted-syntax -- main-process-only builtin
      const { spawn } = await import("node:child_process");

      const child = spawn(process.execPath, buildSpawnArgsForNewRoot(rootDir), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          // Ensure test instances stay isolated even if the parent was launched with
          // MUX_USER_DATA_DIR (which would otherwise override per-root userData).
          MUX_USER_DATA_DIR: path.join(rootDir, "user-data"),
        },
      });
      child.unref();

      return Ok({ rootDir });
    } catch (err) {
      return Err(err instanceof Error ? err.message : String(err));
    }
  }

  async deleteTestInstances(): Promise<Result<{ instancesDir: string; deletedCount: number }>> {
    const instancesDir = path.join(this.config.rootDir, "instances");

    let entries;
    try {
      entries = await fs.readdir(instancesDir, { withFileTypes: true });
    } catch (err) {
      if (isMissingFileError(err)) {
        return Ok({ instancesDir, deletedCount: 0 });
      }
      return Err(err instanceof Error ? err.message : String(err));
    }

    const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(instancesDir, e.name));

    try {
      await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
      return Ok({ instancesDir, deletedCount: dirs.length });
    } catch (err) {
      return Err(err instanceof Error ? err.message : String(err));
    }
  }
}
