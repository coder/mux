import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFileAsync, type ExecFileAsyncOptions } from "@/node/utils/disposableExec";
import {
  runGitWithCredentialLadder,
  type BackupCredential,
  type GitCredentialOptions,
} from "./credentials";

const GIT_IDENTITY_ARGS = [
  "-c",
  "user.name=Mux Settings Backup",
  "-c",
  "user.email=mux-settings-backup@localhost",
  "-c",
  "commit.gpgsign=false",
] as const;

// `code` is what BackupService.toOperationError maps onto the typed result, so these
// must carry one or they degrade to IO_ERROR and the UI loses the actionable message.
export class BackupOriginMismatchError extends Error {
  readonly code = "GIT_ERROR";

  constructor(actual: string, expected: string) {
    super(`Backup cache origin is '${actual}', expected '${expected}'`);
    this.name = "BackupOriginMismatchError";
  }
}

export class BackupNonFastForwardError extends Error {
  readonly code = "REPOSITORY_CHANGED";

  constructor() {
    super("The backup changed since you last read it");
    this.name = "BackupNonFastForwardError";
  }
}

export interface BackupRepoCacheOptions extends Omit<GitCredentialOptions, "repoUrl"> {
  repoUrl: string;
  branch: string;
  cacheRoot: string;
}

export interface RemoteRefs {
  credential: BackupCredential;
  branchCommit: string | null;
  refs: ReadonlyMap<string, string>;
}

/**
 * The managed path is user-supplied and is passed to `git clean -fd --` and
 * `git commit --`, so it has to stay a strict subdirectory. `.` would widen those
 * commands to the whole cache clone, which must never happen.
 */
function assertSafeRelativePath(relativePath: string): void {
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment !== "");
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "." || segment === ".." || segment.toLowerCase() === ".git"
    )
  ) {
    throw new Error(`Expected a safe relative path, got '${relativePath}'`);
  }
}

async function runLocalGit(
  args: string[],
  options: ExecFileAsyncOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  using process = execFileAsync("git", args, options);
  return await process.result;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string") return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

export function backupCachePath(cacheRoot: string, repoUrl: string, branch: string): string {
  const key = createHash("sha256").update(`${repoUrl}\n${branch}`).digest("hex").slice(0, 12);
  return path.join(cacheRoot, key);
}

export class BackupRepoCache {
  readonly cachePath: string;
  private baseRemoteCommit: string | null | undefined;
  private usedCredential: BackupCredential | undefined;

  constructor(private readonly options: BackupRepoCacheOptions) {
    this.cachePath = backupCachePath(options.cacheRoot, options.repoUrl, options.branch);
  }

  get credential(): BackupCredential | undefined {
    return this.usedCredential;
  }

  private credentialOptions(): GitCredentialOptions {
    return {
      repoUrl: this.options.repoUrl,
      token: this.options.token,
      timeoutMs: this.options.timeoutMs,
      signal: this.options.signal,
      onStderrData: this.options.onStderrData,
      env: this.options.env,
    };
  }

  private async networkGit(args: string[]) {
    const result = await runGitWithCredentialLadder(args, this.credentialOptions());
    this.usedCredential = result.credential;
    return result;
  }

  private async localGit(args: string[]) {
    return await runLocalGit(["-C", this.cachePath, ...args], this.options);
  }

  async lsRemote(): Promise<RemoteRefs> {
    const result = await this.networkGit(["ls-remote", this.options.repoUrl]);
    const refs = new Map<string, string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^([0-9a-f]{40,64})\s+(.+)$/.exec(line.trim());
      if (match?.[1] && match[2]) refs.set(match[2], match[1]);
    }
    return {
      credential: result.credential,
      branchCommit: refs.get(`refs/heads/${this.options.branch}`) ?? null,
      refs,
    };
  }

  async ensureCache(): Promise<void> {
    await fs.mkdir(this.options.cacheRoot, { recursive: true });
    const gitDir = path.join(this.cachePath, ".git");
    if (!(await exists(gitDir))) {
      if (await exists(this.cachePath)) {
        throw new Error(`Backup cache path exists but is not a git repository: ${this.cachePath}`);
      }
      await this.networkGit(["clone", "--origin", "origin", this.options.repoUrl, this.cachePath]);
    }

    const actualOrigin = (await this.localGit(["remote", "get-url", "origin"])).stdout.trim();
    if (actualOrigin !== this.options.repoUrl) {
      throw new BackupOriginMismatchError(actualOrigin, this.options.repoUrl);
    }
  }

  async fetch(): Promise<string | null> {
    await this.networkGit([
      "-C",
      this.cachePath,
      "fetch",
      "--prune",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    return await this.remoteBranchCommit();
  }

  private async remoteBranchCommit(): Promise<string | null> {
    try {
      return (
        await this.localGit([
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/origin/${this.options.branch}`,
        ])
      ).stdout.trim();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 1) {
        return null;
      }
      throw error;
    }
  }

  async resetHardToRemote(): Promise<string | null> {
    const remoteCommit = await this.remoteBranchCommit();
    if (remoteCommit) {
      // -f because a previous preview leaves modified tracked files in this cache. Without
      // it the checkout keeps them and the next preview reads the local export as if it
      // were the remote's backup.
      await this.localGit([
        "checkout",
        "-f",
        "-B",
        this.options.branch,
        `refs/remotes/origin/${this.options.branch}`,
      ]);
    } else {
      await this.resetToUnbornBranch();
    }
    this.baseRemoteCommit = remoteCommit;
    return remoteCommit;
  }

  /**
   * The remote branch does not exist, so the next commit must be a root commit. Deleting
   * the local ref matters when this cache still holds the branch from before it was
   * deleted remotely: keeping it would make the push recreate the deleted history,
   * including files the user may have removed deliberately.
   */
  private async resetToUnbornBranch(): Promise<void> {
    const ref = `refs/heads/${this.options.branch}`;
    await this.localGit(["symbolic-ref", "HEAD", ref]);
    try {
      await this.localGit(["update-ref", "-d", ref]);
    } catch {
      // The ref is already absent, which is the state this method is establishing.
    }
    await this.localGit(["read-tree", "--empty"]);
    await this.localGit(["clean", "-fdx"]);
  }

  async cleanManagedPath(managedPath: string): Promise<void> {
    assertSafeRelativePath(managedPath);
    // -x so an ignored leftover from a preview or a blocked push cannot survive the
    // reset and be read back as if it were the remote's backup. Mux owns this path.
    await this.localGit(["clean", "-fdx", "--", managedPath]);
  }

  async stageAndCommit(managedPath: string, message: string): Promise<string | null> {
    assertSafeRelativePath(managedPath);
    // -f because the target may be a dotfiles repo whose ignore rules match payload
    // names. Skipping one file would push a manifest that references missing content.
    await this.localGit(["add", "-A", "-f", "--", managedPath]);
    const status = await this.porcelainStatus(managedPath);
    if (!status) return null;

    await this.localGit([...GIT_IDENTITY_ARGS, "commit", "-m", message, "--", managedPath]);
    return (await this.localGit(["rev-parse", "HEAD"])).stdout.trim();
  }

  /** Callers that report on the remote must confirm it still matches the fetched commit. */
  async assertRemoteUnchanged(): Promise<void> {
    if (this.baseRemoteCommit === undefined) {
      throw new Error("Fetch and reset the backup cache before pushing");
    }
    const currentRemote = (await this.lsRemote()).branchCommit;
    if (currentRemote !== this.baseRemoteCommit) {
      throw new BackupNonFastForwardError();
    }
  }

  async push(): Promise<string> {
    await this.assertRemoteUnchanged();

    try {
      await this.networkGit([
        "-C",
        this.cachePath,
        "push",
        // The lease makes the expectation atomic with the update. assertRemoteUnchanged
        // alone leaves a window where another client can delete the branch, which an
        // ordinary push would silently recreate with the history that client discarded.
        // An empty expected value means the ref must not exist yet.
        `--force-with-lease=refs/heads/${this.options.branch}:${this.baseRemoteCommit ?? ""}`,
        "origin",
        `HEAD:refs/heads/${this.options.branch}`,
      ]);
    } catch (error) {
      if (/non-fast-forward|fetch first|rejected/i.test(errorText(error))) {
        throw new BackupNonFastForwardError();
      }
      throw error;
    }

    const head = (await this.localGit(["rev-parse", "HEAD"])).stdout.trim();
    this.baseRemoteCommit = head;
    return head;
  }

  async porcelainStatus(managedPath?: string): Promise<string> {
    if (managedPath) assertSafeRelativePath(managedPath);
    const args = ["status", "--porcelain", "--untracked-files=all"];
    if (managedPath) args.push("--", managedPath);
    return (await this.localGit(args)).stdout.trim();
  }
}
