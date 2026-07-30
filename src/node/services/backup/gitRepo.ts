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

export class BackupOriginMismatchError extends Error {
  constructor(actual: string, expected: string) {
    super(`Backup cache origin is '${actual}', expected '${expected}'`);
    this.name = "BackupOriginMismatchError";
  }
}

export class BackupNonFastForwardError extends Error {
  constructor() {
    super("The backup changed since you last read it");
    this.name = "BackupNonFastForwardError";
  }
}

export interface BackupGitRepoOptions extends Omit<GitCredentialOptions, "repoUrl"> {
  repoUrl: string;
  branch: string;
  cacheRoot: string;
}

export interface RemoteRefs {
  credential: BackupCredential;
  branchCommit: string | null;
  refs: ReadonlyMap<string, string>;
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
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

export class BackupGitRepo {
  readonly cachePath: string;
  private baseRemoteCommit: string | null | undefined;

  constructor(private readonly options: BackupGitRepoOptions) {
    this.cachePath = backupCachePath(options.cacheRoot, options.repoUrl, options.branch);
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
    return await runGitWithCredentialLadder(args, this.credentialOptions());
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
      await this.localGit([
        "checkout",
        "-B",
        this.options.branch,
        `refs/remotes/origin/${this.options.branch}`,
      ]);
    } else {
      let currentBranch: string | null = null;
      try {
        currentBranch = (await this.localGit(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
      } catch {
        currentBranch = null;
      }
      if (currentBranch !== this.options.branch) {
        await this.localGit(["checkout", "--orphan", this.options.branch]);
      }
      await this.localGit(["rm", "-rf", "--ignore-unmatch", "."]);
    }
    this.baseRemoteCommit = remoteCommit;
    return remoteCommit;
  }

  async cleanManagedPath(managedPath: string): Promise<void> {
    assertSafeRelativePath(managedPath);
    await this.localGit(["clean", "-fd", "--", managedPath]);
  }

  async stageAndCommit(managedPath: string, message: string): Promise<string | null> {
    assertSafeRelativePath(managedPath);
    await this.localGit(["add", "-A", "--", managedPath]);
    const status = await this.porcelainStatus(managedPath);
    if (!status) return null;

    await this.localGit([...GIT_IDENTITY_ARGS, "commit", "-m", message, "--", managedPath]);
    return (await this.localGit(["rev-parse", "HEAD"])).stdout.trim();
  }

  async push(): Promise<string> {
    if (this.baseRemoteCommit === undefined) {
      throw new Error("Fetch and reset the backup cache before pushing");
    }
    const currentRemote = (await this.lsRemote()).branchCommit;
    if (currentRemote !== this.baseRemoteCommit) {
      throw new BackupNonFastForwardError();
    }

    try {
      await this.networkGit([
        "-C",
        this.cachePath,
        "push",
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

  async diffNameStatus(ref: string, managedPath?: string): Promise<string> {
    if (managedPath) assertSafeRelativePath(managedPath);
    const args = ["diff", "--name-status", ref];
    if (managedPath) args.push("--", managedPath);
    return (await this.localGit(args)).stdout.trim();
  }
}
