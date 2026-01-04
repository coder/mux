/**
 * Shared git-bundle sync logic for remote runtimes (SSH, Docker).
 *
 * Each runtime is responsible for creating a bundle on the remote runtime (via pipe/cp/etc.).
 * This module handles the common steps once a remote bundle path exists.
 */

import type { ExecOptions, ExecStream, InitLogger } from "./Runtime";
import { streamToString, shescape } from "./streamUtils";
import { execAsync } from "@/node/utils/disposableExec";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";

interface OriginUrlResult {
  originUrl: string | null;
}

async function getOriginUrlForBundle(
  projectPath: string,
  initLogger: InitLogger,
  logErrors: boolean
): Promise<OriginUrlResult> {
  try {
    // Use git -C to avoid shell-specific `cd && ...` quoting.
    using proc = execAsync(`git -C "${projectPath}" remote get-url origin`);
    const { stdout } = await proc.result;
    const url = stdout.trim();

    if (url && !url.includes(".bundle") && !url.includes(".mux-bundle")) {
      return { originUrl: url };
    }

    return { originUrl: null };
  } catch (error) {
    // Not fatal (repo may not have an origin remote).
    if (logErrors) {
      initLogger.logStderr(`Could not get origin URL: ${getErrorMessage(error)}`);
    } else {
      log.debug("Could not get origin URL", { error: getErrorMessage(error) });
    }
    return { originUrl: null };
  }
}

const TRACKING_BRANCHES_COMMAND =
  "for branch in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/ | grep -v 'origin/HEAD'); do localname=${branch#origin/}; git show-ref --verify --quiet refs/heads/$localname || git branch $localname $branch; done";

export interface GitBundleSyncParams {
  /** Local project path (where git bundle is created) */
  projectPath: string;
  /** Destination workspace path on the remote runtime */
  workspacePath: string;
  /** Remote temp directory for clone/cleanup (e.g., "~" or "/tmp") */
  remoteTmpDir: string;
  /** Remote path where the bundle will be created/copied */
  remoteBundlePath: string;

  /** Remote exec implementation (typically runtime.exec) */
  exec: (command: string, options: ExecOptions) => Promise<ExecStream>;
  /** Quote/expand a path for the remote shell */
  quoteRemotePath: (path: string) => string;

  /** Logger for progress streaming */
  initLogger: InitLogger;
  /** Whether to surface origin-lookup failures to init logger (default: false) */
  logOriginErrors?: boolean;

  /** Optional abort signal */
  abortSignal?: AbortSignal;

  /**
   * Runtime-specific hook that ensures `remoteBundlePath` exists on the remote runtime.
   * May perform multiple steps (e.g., create bundle locally + transfer).
   */
  createRemoteBundle: (args: {
    remoteBundlePath: string;
    initLogger: InitLogger;
    abortSignal?: AbortSignal;
  }) => Promise<{
    cleanupLocal?: () => Promise<void>;
  } | void>;

  /** Step label for cloning (runtime-specific: remote vs container) */
  cloneStep: string;
}

export async function syncProjectViaGitBundle(params: GitBundleSyncParams): Promise<void> {
  const {
    projectPath,
    workspacePath,
    remoteTmpDir,
    remoteBundlePath,
    exec,
    quoteRemotePath,
    initLogger,
    logOriginErrors,
    abortSignal,
    createRemoteBundle,
    cloneStep,
  } = params;

  if (abortSignal?.aborted) {
    throw new Error("Sync operation aborted before starting");
  }

  const { originUrl } = await getOriginUrlForBundle(
    projectPath,
    initLogger,
    logOriginErrors ?? false
  );

  // Ensure the bundle exists on the remote runtime.
  initLogger.logStep("Creating git bundle...");
  let createResult: Awaited<ReturnType<GitBundleSyncParams["createRemoteBundle"]>>;
  try {
    createResult = await createRemoteBundle({ remoteBundlePath, initLogger, abortSignal });
  } catch (error) {
    // Best-effort cleanup (remote bundle may have been partially written).
    try {
      const rmStream = await exec(`rm -f ${quoteRemotePath(remoteBundlePath)}`, {
        cwd: remoteTmpDir,
        timeout: 10,
        abortSignal,
      });
      await rmStream.exitCode;
    } catch {
      // Ignore cleanup errors.
    }

    throw error;
  }

  try {
    // Clone from the bundle on the remote runtime.
    initLogger.logStep(cloneStep);
    const cloneStream = await exec(
      `git clone --quiet ${quoteRemotePath(remoteBundlePath)} ${quoteRemotePath(workspacePath)}`,
      {
        cwd: remoteTmpDir,
        timeout: 300,
        abortSignal,
      }
    );

    const [cloneStdout, cloneStderr, cloneExitCode] = await Promise.all([
      streamToString(cloneStream.stdout),
      streamToString(cloneStream.stderr),
      cloneStream.exitCode,
    ]);

    if (cloneExitCode !== 0) {
      throw new Error(`Failed to clone repository: ${cloneStderr || cloneStdout}`);
    }

    // Create local tracking branches.
    initLogger.logStep("Creating local tracking branches...");
    const trackingStream = await exec(TRACKING_BRANCHES_COMMAND, {
      cwd: workspacePath,
      timeout: 30,
      abortSignal,
    });
    await trackingStream.exitCode;

    // Update origin remote.
    if (originUrl) {
      initLogger.logStep(`Setting origin remote to ${originUrl}...`);
      const setOriginStream = await exec(`git remote set-url origin ${shescape.quote(originUrl)}`, {
        cwd: workspacePath,
        timeout: 10,
        abortSignal,
      });

      const setOriginExitCode = await setOriginStream.exitCode;
      if (setOriginExitCode !== 0) {
        const stderr = await streamToString(setOriginStream.stderr);
        log.debug("Failed to set origin remote", { stderr });
      }
    } else {
      initLogger.logStep("Removing bundle origin remote...");
      const removeOriginStream = await exec(`git remote remove origin 2>/dev/null || true`, {
        cwd: workspacePath,
        timeout: 10,
        abortSignal,
      });
      await removeOriginStream.exitCode;
    }

    // Clean up remote bundle.
    initLogger.logStep("Cleaning up bundle file...");
    const rmStream = await exec(`rm -f ${quoteRemotePath(remoteBundlePath)}`, {
      cwd: remoteTmpDir,
      timeout: 10,
      abortSignal,
    });

    const rmExitCode = await rmStream.exitCode;
    if (rmExitCode !== 0) {
      log.debug("Failed to remove remote bundle file", { remoteBundlePath });
    }

    if (createResult && "cleanupLocal" in createResult && createResult.cleanupLocal) {
      await createResult.cleanupLocal();
    }

    initLogger.logStep("Repository cloned successfully");
  } catch (error) {
    // Best-effort cleanup (remote bundle + any local temp file).
    try {
      const rmStream = await exec(`rm -f ${quoteRemotePath(remoteBundlePath)}`, {
        cwd: remoteTmpDir,
        timeout: 10,
        abortSignal,
      });
      await rmStream.exitCode;
    } catch {
      // Ignore cleanup errors.
    }

    try {
      if (createResult && "cleanupLocal" in createResult && createResult.cleanupLocal) {
        await createResult.cleanupLocal();
      }
    } catch {
      // Ignore cleanup errors.
    }

    throw error;
  }
}
