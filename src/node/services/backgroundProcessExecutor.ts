/**
 * Unified executor for background bash processes.
 *
 * ALL bash commands are spawned through this executor with background-style
 * infrastructure (nohup, file output, exit code trap). This enables:
 *
 * 1. Uniform code path - one spawn mechanism for all bash commands
 * 2. Crash resilience - output always persisted to files
 * 3. Seamless fg→bg transition - "background this" = "stop waiting"
 *
 * The executor uses only primitive Runtime operations (exec, file I/O),
 * keeping the Runtime interface minimal and focused.
 */

import type { Runtime, BackgroundHandle } from "@/node/runtime/Runtime";
import { log } from "./log";
import {
  buildWrapperScript,
  buildSpawnCommand,
  parsePid,
  shellQuote,
} from "@/node/runtime/backgroundCommands";
import { LocalBackgroundHandle } from "@/node/runtime/LocalBackgroundHandle";
import { SSHBackgroundHandle } from "@/node/runtime/SSHBackgroundHandle";
import type { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { expandTildeForSSH, cdCommandForSSH } from "@/node/runtime/tildeExpansion";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { execAsync } from "@/node/utils/disposableExec";
import { getBashPath } from "@/node/utils/main/bashPath";
import { toPosixPath } from "@/node/utils/paths";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Options for spawning a process
 */
export interface SpawnOptions {
  /** Working directory for command execution */
  cwd: string;
  /** Workspace ID for output directory organization */
  workspaceId: string;
  /** Process ID (e.g., "bash_1") - caller must provide unique ID */
  processId: string;
  /** Environment variables to inject */
  env?: Record<string, string>;
  /** Process niceness level (-20 to 19, lower = higher priority) */
  niceness?: number;
}

/**
 * Result of spawning a process
 */
export type SpawnResult =
  | { success: true; handle: BackgroundHandle; pid: number; outputDir: string }
  | { success: false; error: string };

/**
 * Detect if a runtime is an SSHRuntime by checking for SSH-specific methods.
 * This avoids circular imports while allowing type-safe SSH handle creation.
 */
function isSSHRuntime(runtime: Runtime): runtime is SSHRuntime {
  return "exec" in runtime && "getBgOutputDir" in runtime;
}

/**
 * Spawn a background process using the appropriate method for the runtime type.
 *
 * For local runtimes: uses execAsync with bash shell
 * For SSH runtimes: uses execBuffered to run commands over SSH
 *
 * All processes get the same infrastructure:
 * - nohup/setsid for process isolation
 * - stdout/stderr redirected to files
 * - Exit code captured via bash trap
 *
 * @param runtime Runtime to spawn on
 * @param script Script to execute
 * @param options Spawn options
 * @param bgOutputDir Base directory for output files (used for local, SSH uses its own config)
 */
export async function spawnProcess(
  runtime: Runtime,
  script: string,
  options: SpawnOptions,
  bgOutputDir: string
): Promise<SpawnResult> {
  const isSSH = isSSHRuntime(runtime);

  if (isSSH) {
    // For SSH, get the runtime's configured bgOutputDir (resolves tildes on remote)
    const sshBgOutputDir = await runtime.getBgOutputDir();
    return spawnSSH(runtime, script, options, sshBgOutputDir);
  } else {
    return spawnLocal(runtime, script, options, bgOutputDir);
  }
}

/**
 * Spawn a process locally using nohup/setsid
 */
async function spawnLocal(
  _runtime: Runtime,
  script: string,
  options: SpawnOptions,
  bgOutputDir: string
): Promise<SpawnResult> {
  log.debug(`BackgroundProcessExecutor.spawnLocal: Spawning in ${options.cwd}`);

  // Check if working directory exists
  try {
    await fs.access(options.cwd);
  } catch {
    return { success: false, error: `Working directory does not exist: ${options.cwd}` };
  }

  // Compute output paths
  const outputDir = path.join(bgOutputDir, options.workspaceId, options.processId);
  const stdoutPath = path.join(outputDir, "stdout.log");
  const stderrPath = path.join(outputDir, "stderr.log");
  const exitCodePath = path.join(outputDir, "exit_code");

  // Create output directory and empty files
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(stdoutPath, "");
  await fs.writeFile(stderrPath, "");

  // Build wrapper script and spawn command
  // On Windows, convert paths to POSIX format for Git Bash (C:\foo → /c/foo)
  const wrapperScript = buildWrapperScript({
    exitCodePath: toPosixPath(exitCodePath),
    cwd: toPosixPath(options.cwd),
    env: { ...options.env, ...NON_INTERACTIVE_ENV_VARS },
    script,
  });

  const spawnCommand = buildSpawnCommand({
    wrapperScript,
    stdoutPath: toPosixPath(stdoutPath),
    stderrPath: toPosixPath(stderrPath),
    bashPath: getBashPath(),
    niceness: options.niceness,
  });

  try {
    // Use bash shell explicitly - spawnCommand uses POSIX commands (nohup, ps)
    using proc = execAsync(spawnCommand, { shell: getBashPath() });
    const result = await proc.result;

    const pid = parsePid(result.stdout);
    if (!pid) {
      log.debug(`BackgroundProcessExecutor.spawnLocal: Invalid PID: ${result.stdout}`);
      return { success: false, error: `Failed to get valid PID from spawn: ${result.stdout}` };
    }

    log.debug(`BackgroundProcessExecutor.spawnLocal: Spawned with PID ${pid}`);
    const handle = new LocalBackgroundHandle(pid, outputDir);
    return { success: true, handle, pid, outputDir };
  } catch (e) {
    const err = e as Error;
    log.debug(`BackgroundProcessExecutor.spawnLocal: Failed to spawn: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Spawn a process on a remote machine via SSH
 */
async function spawnSSH(
  runtime: SSHRuntime,
  script: string,
  options: SpawnOptions,
  bgOutputDir: string
): Promise<SpawnResult> {
  log.debug(`BackgroundProcessExecutor.spawnSSH: Spawning in ${options.cwd}`);

  // Verify working directory exists on remote
  const cwdCheck = await execBuffered(runtime, cdCommandForSSH(options.cwd), {
    cwd: "/",
    timeout: 10,
  });
  if (cwdCheck.exitCode !== 0) {
    return { success: false, error: `Working directory does not exist: ${options.cwd}` };
  }

  // Compute output paths
  const outputDir = `${bgOutputDir}/${options.workspaceId}/${options.processId}`;
  const stdoutPath = `${outputDir}/stdout.log`;
  const stderrPath = `${outputDir}/stderr.log`;
  const exitCodePath = `${outputDir}/exit_code`;

  // Use expandTildeForSSH for paths that may contain ~ (shescape.quote prevents tilde expansion)
  const outputDirExpanded = expandTildeForSSH(outputDir);
  const stdoutPathExpanded = expandTildeForSSH(stdoutPath);
  const stderrPathExpanded = expandTildeForSSH(stderrPath);
  const exitCodePathExpanded = expandTildeForSSH(exitCodePath);

  // Create output directory and empty files on remote
  const mkdirResult = await execBuffered(
    runtime,
    `mkdir -p ${outputDirExpanded} && touch ${stdoutPathExpanded} ${stderrPathExpanded}`,
    { cwd: "/", timeout: 30 }
  );
  if (mkdirResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to create output directory: ${mkdirResult.stderr}`,
    };
  }

  // Build the wrapper script with trap to capture exit code
  // SSH uses expandTildeForSSH/cdCommandForSSH for tilde expansion
  const wrapperParts: string[] = [];

  // Set up trap first (use expanded path for tilde support)
  wrapperParts.push(`trap 'echo $? > ${exitCodePathExpanded}' EXIT`);

  // Change to working directory
  wrapperParts.push(cdCommandForSSH(options.cwd));

  // Add environment variable exports
  const envVars = { ...options.env, ...NON_INTERACTIVE_ENV_VARS };
  for (const [key, value] of Object.entries(envVars)) {
    wrapperParts.push(`export ${key}=${shellQuote(value)}`);
  }

  // Add the actual script
  wrapperParts.push(script);

  const wrapperScript = wrapperParts.join(" && ");

  // Use shared buildSpawnCommand for parity with Local
  const spawnCommand = buildSpawnCommand({
    wrapperScript,
    stdoutPath,
    stderrPath,
    niceness: options.niceness,
    quotePath: expandTildeForSSH,
  });

  try {
    // No timeout - the spawn command backgrounds the process and returns immediately
    const result = await execBuffered(runtime, spawnCommand, {
      cwd: "/", // cwd doesn't matter, we cd in the wrapper
    });

    if (result.exitCode !== 0) {
      log.debug(`BackgroundProcessExecutor.spawnSSH: spawn command failed: ${result.stderr}`);
      return {
        success: false,
        error: `Failed to spawn background process: ${result.stderr}`,
      };
    }

    const pid = parsePid(result.stdout);
    if (!pid) {
      log.debug(`BackgroundProcessExecutor.spawnSSH: Invalid PID: ${result.stdout}`);
      return {
        success: false,
        error: `Failed to get valid PID from spawn: ${result.stdout}`,
      };
    }

    log.debug(`BackgroundProcessExecutor.spawnSSH: Spawned with PID ${pid}`);
    const handle = new SSHBackgroundHandle(runtime, pid, outputDir);
    return { success: true, handle, pid, outputDir };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.debug(`BackgroundProcessExecutor.spawnSSH: Error: ${errorMessage}`);
    return {
      success: false,
      error: `Failed to spawn background process: ${errorMessage}`,
    };
  }
}
