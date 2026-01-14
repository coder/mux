import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProjectsConfig, ProjectConfig } from "@/common/types/project";
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
  };
}

function isMissingFileError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  return (err as { code?: unknown }).code === "ENOENT";
}

function stripArgWithOptionalValue(args: string[], matcher: (arg: string) => boolean): string[] {
  const result: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (matcher(arg)) {
      // Handle `--flag value` and `--flag=value`.
      if (!arg.includes("=") && args[i + 1] && !args[i + 1].startsWith("-")) {
        i += 1;
      }
      continue;
    }

    result.push(arg);
  }

  return result;
}

function buildSpawnArgsForNewRoot(newRoot: string): string[] {
  const baseArgs = process.argv.slice(1);

  const withoutMuxRoot = stripArgWithOptionalValue(baseArgs, (arg) => {
    return (
      arg === "--mux-root" ||
      arg === "--root" ||
      arg.startsWith("--mux-root=") ||
      arg.startsWith("--root=")
    );
  });

  // Avoid debug port collisions when spawning a second Electron instance in dev.
  const withoutRemoteDebugPort = stripArgWithOptionalValue(withoutMuxRoot, (arg) => {
    return arg === "--remote-debugging-port" || arg.startsWith("--remote-debugging-port=");
  });

  return [...withoutRemoteDebugPort, "--mux-root", newRoot];
}

export class TestInstanceService {
  constructor(private readonly config: Config) {}

  private async createInstanceRoot(): Promise<string> {
    const instancesDir = path.join(this.config.rootDir, "instances");
    await fs.mkdir(instancesDir, { recursive: true });

    // Keep it Windows-safe (no ':'), but also readable.
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const rand = Math.random().toString(16).slice(2, 8);
    const rootDir = path.join(instancesDir, `${stamp}-${rand}`);

    await fs.mkdir(rootDir, { recursive: true });
    return rootDir;
  }

  private async copyIfExists(src: string, dest: string): Promise<void> {
    try {
      await fs.copyFile(src, dest);
    } catch (err) {
      if (isMissingFileError(err)) return;
      throw err;
    }
  }

  async launchTestInstance(): Promise<
    { success: true; data: { rootDir: string } } | { success: false; error: string }
  > {
    if (!process.versions.electron) {
      return {
        success: false,
        error: "Launch Test Instance is only available in the desktop app.",
      };
    }

    const rootDir = await this.createInstanceRoot();

    // Copy provider setup (API keys, endpoints), but not workspaces/sessions.
    await this.copyIfExists(
      path.join(this.config.rootDir, "providers.jsonc"),
      path.join(rootDir, "providers.jsonc")
    );
    await this.copyIfExists(
      path.join(this.config.rootDir, "secrets.json"),
      path.join(rootDir, "secrets.json")
    );

    const sourceConfig = this.config.loadConfigOrDefault();
    const isolatedConfig = createIsolatedConfigForTestInstance(sourceConfig);

    const instanceConfig = new Config(rootDir);
    await instanceConfig.saveConfig(isolatedConfig);

    try {
      // Intentionally lazy import (rare debug action).
      // eslint-disable-next-line no-restricted-syntax -- main-process-only builtin
      const { spawn } = await import("node:child_process");

      const child = spawn(process.execPath, buildSpawnArgsForNewRoot(rootDir), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();

      return { success: true, data: { rootDir } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async deleteTestInstances(): Promise<
    | { success: true; data: { instancesDir: string; deletedCount: number } }
    | { success: false; error: string }
  > {
    const instancesDir = path.join(this.config.rootDir, "instances");

    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(instancesDir, { withFileTypes: true });
    } catch (err) {
      if (isMissingFileError(err)) {
        return { success: true, data: { instancesDir, deletedCount: 0 } };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(instancesDir, e.name));

    try {
      await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
      return { success: true, data: { instancesDir, deletedCount: dirs.length } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
