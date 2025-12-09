/**
 * Test helpers for runtime integration tests
 */

import * as fs from "fs/promises";
import { realpathSync } from "fs";
import * as os from "os";
import * as path from "path";
import type { Runtime } from "@/node/runtime/Runtime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import type { SSHServerConfig } from "./ssh-fixture";

/**
 * Runtime type for test matrix
 * Note: "local" here means worktree runtime (isolated git worktrees), not project-dir runtime
 */
export type RuntimeType = "local" | "ssh";

/**
 * Create runtime instance based on type
 */
export function createTestRuntime(
  type: RuntimeType,
  workdir: string,
  sshConfig?: SSHServerConfig
): Runtime {
  switch (type) {
    case "local":
      // Resolve symlinks (e.g., /tmp -> /private/tmp on macOS) to match git worktree paths
      // Note: "local" in tests means WorktreeRuntime (isolated git worktrees)
      const resolvedWorkdir = realpathSync(workdir);
      return new WorktreeRuntime(resolvedWorkdir, resolvedWorkdir);
    case "ssh":
      if (!sshConfig) {
        throw new Error("SSH config required for SSH runtime");
      }
      return new SSHRuntime({
        host: `testuser@localhost`,
        srcBaseDir: sshConfig.workdir,
        identityFile: sshConfig.privateKeyPath,
        port: sshConfig.port,
      });
  }
}

/**
 * Test workspace - isolated temp directory for each test
 */
export class TestWorkspace {
  public readonly path: string;
  private readonly runtime: Runtime;
  private readonly isRemote: boolean;

  private constructor(runtime: Runtime, workspacePath: string, isRemote: boolean) {
    this.runtime = runtime;
    this.path = workspacePath;
    this.isRemote = isRemote;
  }

  /**
   * Create a test workspace with isolated directory
   */
  static async create(runtime: Runtime, type: RuntimeType): Promise<TestWorkspace> {
    const isRemote = type === "ssh";

    if (isRemote) {
      // For SSH, create subdirectory in remote workdir
      // The path is already set in SSHRuntime config
      // Create a unique subdirectory
      const testId = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const workspacePath = `/home/testuser/workspace/${testId}`;

      // Create directory on remote
      const stream = await runtime.exec(`mkdir -p ${workspacePath}`, {
        cwd: "/home/testuser",
        timeout: 30,
      });
      await stream.stdin.close();
      const exitCode = await stream.exitCode;

      if (exitCode !== 0) {
        throw new Error(`Failed to create remote workspace: ${workspacePath}`);
      }

      return new TestWorkspace(runtime, workspacePath, true);
    } else {
      // For local, use temp directory
      // Resolve symlinks (e.g., /tmp -> /private/tmp on macOS) to avoid git worktree path mismatches
      const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-test-"));
      const workspacePath = await fs.realpath(tempPath);
      return new TestWorkspace(runtime, workspacePath, false);
    }
  }

  /**
   * Cleanup workspace
   */
  async cleanup(): Promise<void> {
    if (this.isRemote) {
      // Remove remote directory
      try {
        const stream = await this.runtime.exec(`rm -rf ${this.path}`, {
          cwd: "/home/testuser",
          timeout: 60,
        });
        await stream.stdin.close();
        await stream.exitCode;
      } catch (error) {
        console.error(`Failed to cleanup remote workspace ${this.path}:`, error);
      }
    } else {
      // Remove local directory
      try {
        await fs.rm(this.path, { recursive: true, force: true });
      } catch (error) {
        console.error(`Failed to cleanup local workspace ${this.path}:`, error);
      }
    }
  }

  /**
   * Disposable interface for using declarations
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }
}

/**
 * Configure SSH client to use test key
 *
 * Returns environment variables to pass to SSH commands
 */
export function getSSHEnv(sshConfig: SSHServerConfig): Record<string, string> {
  // Create SSH config content
  const sshConfigContent = `
Host ${sshConfig.host}
  HostName localhost
  Port ${sshConfig.port}
  User testuser
  IdentityFile ${sshConfig.privateKeyPath}
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
`;

  // For SSH commands, we need to write this to a temp file and use -F
  // But for our SSHRuntime, we can configure ~/.ssh/config or use environment
  // For now, we'll rely on ssh command finding the key via standard paths

  // Filter out undefined values from process.env
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Wait for predicate to become true
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  options?: { timeout?: number; interval?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 5000;
  const interval = options?.interval ?? 100;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await predicate()) {
      return;
    }
    await sleep(interval);
  }

  throw new Error("Timeout waiting for predicate");
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
