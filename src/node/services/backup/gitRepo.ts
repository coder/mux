import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFileAsync, type ExecFileAsyncOptions } from "@/node/utils/disposableExec";
import {
  runGitWithCredentialLadder,
  type BackupCredential,
  type GitCredentialOptions,
} from "./credentials";

/**
 * Only the managed directory is ever read out of the cache, so blobs are fetched on demand
 * rather than up front. A dotfiles repository can hold anything elsewhere in its tree.
 */
const BLOB_FILTER = "blob:none";

/**
 * The payload is bytes, not text: the manifest records a SHA-256 per file and a restore writes
 * what it reads. Any end-of-line conversion in the cache worktree therefore breaks the checksum
 * and would put the rewritten bytes on the user's disk. `core.autocrlf=true` is an ordinary
 * Windows setting, and `core.eol` reaches the same conversion, so both are pinned off on the
 * cache repository rather than passed per command: a git command run there by hand then behaves
 * the same way.
 */
const VERBATIM_CONTENT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.autocrlf", "false"],
  ["core.eol", "lf"],
];

/**
 * Config alone is not enough: `.gitattributes` in the backup repository outranks it, so a
 * dotfiles repo carrying `* text=auto eol=crlf` still converts (verified against git 2.54).
 * `.git/info/attributes` is the per-repository layer that outranks the tree's own file, and
 * `-text` there declines conversion for every path.
 */
const VERBATIM_ATTRIBUTES = "* -text\n";

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
  /** Scopes the sparse checkout, so nothing outside it is ever materialized. */
  managedPath: string;
}

export interface RemoteRefs {
  credential: BackupCredential;
  branchCommit: string | null;
  refs: ReadonlyMap<string, string>;
}

/**
 * `--no-cone` sparse patterns are gitignore-style rather than pathspecs, so the same
 * managed directory has to be escaped instead: unescaped, `/mux[1]/*` selects `mux1` and
 * the real backup is never materialized.
 */
function escapeSparsePattern(relativePath: string): string {
  return relativePath.replace(/[\\*?[\]]/g, "\\$&");
}

/**
 * The managed path is user-supplied and is passed to `git clean -fd --` and
 * `git commit --`, so it has to stay a strict subdirectory. `.` would widen those
 * commands to the whole cache clone, which must never happen.
 *
 * Returns the joined segments so every git call uses one normalized form. The settings
 * default is `mux/`, and as a gitignore-style sparse pattern `/mux//*` matches nothing
 * while the payload is still written to `mux`, leaving the backup invisible.
 */
function safeRelativePath(relativePath: string): string {
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
  return segments.join("/");
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

/**
 * A cache directory holds the local allowlisted payload, which includes files still awaiting the
 * user's approval, so it must be a real directory under the Mux root rather than a link out of
 * it. `mkdir` with `recursive` succeeds on a symlink to an existing directory, and a
 * pre-created per-repository link passes the origin check when its target is a valid clone, so
 * both the root and the path below it are checked.
 */
export async function assertNotSymlink(target: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isSymbolicLink() === true) {
    throw new Error(`Refusing to use '${target}': it is a symlink`);
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

  private async pinVerbatimContent(): Promise<void> {
    for (const [key, value] of VERBATIM_CONTENT_CONFIG) {
      await this.localGit(["config", key, value]);
    }
    // Every component is checked, and the file is opened without following a final link,
    // because this writes to a fixed path inside a directory that other processes can reach:
    // a link left at `.git`, `.git/info`, or the file itself would otherwise redirect the
    // write and truncate something outside the cache.
    const gitDir = path.join(this.cachePath, ".git");
    await assertNotSymlink(gitDir);
    const infoDir = path.join(gitDir, "info");
    await assertNotSymlink(infoDir);
    await fs.mkdir(infoDir, { recursive: true });
    const attributesPath = path.join(infoDir, "attributes");
    await assertNotSymlink(attributesPath);
    const handle = await fs.open(
      attributesPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_TRUNC |
        (fs.constants.O_NOFOLLOW ?? 0)
    );
    try {
      await handle.writeFile(VERBATIM_ATTRIBUTES, "utf-8");
    } finally {
      await handle.close();
    }
  }

  private async hasOriginRemote(): Promise<boolean> {
    try {
      await this.localGit(["remote", "get-url", "origin"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates, or finishes creating, a cache with no objects in it. Safe to re-run: every step
   * either sets a value or replaces the one already there, so an initialization interrupted
   * partway is repaired rather than leaving a `.git` that fails the origin check forever.
   *
   * The filter settings are what `clone --filter` writes for itself. Without them a later
   * `fetch` of this branch would download every blob reachable from it, including files outside
   * the managed directory that sparse checkout never materializes.
   */
  private async initEmptyCache(): Promise<void> {
    // `init <dir>` creates the directory, so this runs before `localGit` has one to -C into.
    await runLocalGit(
      ["init", "--initial-branch", this.options.branch, this.cachePath],
      this.options
    );
    // `remote add` fails when the remote is already there, so set the url either way.
    if (await this.hasOriginRemote()) {
      await this.localGit(["remote", "set-url", "origin", this.options.repoUrl]);
    } else {
      await this.localGit(["remote", "add", "origin", this.options.repoUrl]);
    }
    await this.localGit(["config", "remote.origin.promisor", "true"]);
    await this.localGit(["config", "remote.origin.partialclonefilter", BLOB_FILTER]);
  }

  async ensureCache(): Promise<void> {
    await assertNotSymlink(this.options.cacheRoot);
    await fs.mkdir(this.options.cacheRoot, { recursive: true });
    await assertNotSymlink(this.cachePath);
    const gitDir = path.join(this.cachePath, ".git");
    if (!(await exists(gitDir))) {
      if (await exists(this.cachePath)) {
        throw new Error(`Backup cache path exists but is not a git repository: ${this.cachePath}`);
      }
      // A settings backup often lives in an existing dotfiles repository, and nothing here
      // ever reads a ref other than `origin/<branch>`. Transferring anything else is waste
      // that sparse checkout does not bound, because it limits the working tree and not the
      // transfer.
      if ((await this.lsRemote()).branchCommit === null) {
        // Nothing to fetch: the backup branch does not exist yet, and `--single-branch` would
        // fall back to the remote's HEAD, downloading a default branch whose history this
        // feature never reads. An empty repository with the remote attached is the same
        // starting point `resetToUnbornBranch` produces, without the transfer.
        await this.initEmptyCache();
      } else {
        // `--no-checkout` because `resetHardToRemote` checks out the configured branch next,
        // and materializing a branch here can fail on unrelated paths this platform cannot
        // create.
        await this.networkGit([
          "clone",
          "--no-checkout",
          "--single-branch",
          `--filter=${BLOB_FILTER}`,
          "--branch",
          this.options.branch,
          "--origin",
          "origin",
          this.options.repoUrl,
          this.cachePath,
        ]);
      }
    } else if (!(await this.hasOriginRemote())) {
      // A `.git` without an `origin` is an initialization that did not finish. Left alone it
      // fails the origin check below on every retry, so backups for this repository would stay
      // broken until the user deleted the cache by hand.
      await this.initEmptyCache();
    }
    // Re-applied every time rather than only at creation, so a cache made by an earlier version
    // of this code, or altered since, still reads and writes payload bytes unchanged.
    await this.pinVerbatimContent();

    const actualOrigin = (await this.localGit(["remote", "get-url", "origin"])).stdout.trim();
    if (actualOrigin !== this.options.repoUrl) {
      throw new BackupOriginMismatchError(actualOrigin, this.options.repoUrl);
    }
    // `remote.origin.pushurl` overrides the url for pushes only, so the url just checked is not
    // necessarily where a backup lands. `--all` because the key is multi-valued and a push
    // writes to every value, so reading one would let a second destination through.
    const pushUrls = (
      await this.localGit(["remote", "get-url", "--push", "--all", "origin"])
    ).stdout
      .split(/\r?\n/)
      .map((url) => url.trim())
      .filter(Boolean);
    const unexpected = pushUrls.find((url) => url !== this.options.repoUrl);
    if (unexpected !== undefined) {
      throw new BackupOriginMismatchError(unexpected, this.options.repoUrl);
    }
    if (pushUrls.length !== 1) {
      throw new BackupOriginMismatchError(pushUrls.join(", "), this.options.repoUrl);
    }
  }

  async fetch(): Promise<string | null> {
    // Only the configured branch, for the same reason the clone is single-branch. An explicit
    // refspec is an error when the remote lacks that branch, unlike the wildcard it replaced,
    // and an empty or not-yet-created backup branch is an ordinary state here: report it as
    // unborn rather than failing the operation.
    const branch = this.options.branch;
    if ((await this.lsRemote()).branchCommit === null) {
      await this.pruneMissingRemoteBranch();
      return null;
    }
    await this.networkGit([
      "-C",
      this.cachePath,
      "fetch",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    return await this.remoteBranchCommit();
  }

  /**
   * Drops a remote-tracking ref the remote no longer has, which `--prune` did while the fetch
   * used a wildcard. Without it a cache that still holds the branch from before it was deleted
   * remotely would push that history back, recreating files the user deleted deliberately.
   * Deleting an absent ref is a no-op, so this runs whether or not the ref is there.
   */
  private async pruneMissingRemoteBranch(): Promise<void> {
    // Not caught: `update-ref -d` already succeeds when the ref is absent, so a failure here is
    // a real one, such as a competing lock. Swallowing it would report the branch as unborn
    // while `resetHardToRemote` still reads the stale tracking ref and works on the backup the
    // user deleted.
    await this.localGit(["update-ref", "-d", `refs/remotes/origin/${this.options.branch}`]);
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

  /**
   * Only the managed directory is materialized. Mux reads and writes nothing else, and a
   * checkout of the whole branch fails on any path elsewhere in the repository that this
   * platform cannot create, which would block a backup whose own payload is fine.
   * `--no-cone` because the managed path is a single literal directory, not a cone pattern set.
   */
  private async applySparseCheckout(): Promise<void> {
    await this.localGit([
      "sparse-checkout",
      "set",
      "--no-cone",
      `/${escapeSparsePattern(safeRelativePath(this.options.managedPath))}/*`,
    ]);
  }

  async resetHardToRemote(): Promise<string | null> {
    await this.applySparseCheckout();
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
    // Not caught, for the same reason as the remote-tracking delete: deleting an absent ref
    // already succeeds, so the only failures left are real, and continuing past one would leave
    // the branch attached for the next commit to make the deleted history reachable again.
    await this.localGit(["update-ref", "-d", ref]);
    await this.localGit(["read-tree", "--empty"]);
    await this.localGit(["clean", "-fdx"]);
  }

  async cleanManagedPath(managedPath: string): Promise<void> {
    // -x so an ignored leftover from a preview or a blocked push cannot survive the
    // reset and be read back as if it were the remote's backup. Mux owns this path.
    await this.localGit(["clean", "-fdx", "--", safeRelativePath(managedPath)]);
  }

  async stageAndCommit(managedPath: string, message: string): Promise<string | null> {
    const target = safeRelativePath(managedPath);
    // -f because the target may be a dotfiles repo whose ignore rules match payload
    // names. Skipping one file would push a manifest that references missing content.
    await this.localGit(["add", "-A", "-f", "--", target]);
    const status = await this.porcelainStatus(target);
    if (!status) return null;

    await this.localGit([...GIT_IDENTITY_ARGS, "commit", "-m", message, "--", target]);
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

  /**
   * `-z` because the default porcelain output C-quotes any pathname that is not plain ASCII, so
   * a skill named `café.md` would be reported to the user with escapes in it, and a filename
   * containing a literal ` -> ` would be indistinguishable from a rename. With `-z` pathnames
   * are verbatim and a rename is two NUL-separated fields instead. Not trimmed: a trailing NUL
   * is the record terminator, and a pathname may legitimately end in whitespace.
   */
  async porcelainStatus(managedPath?: string): Promise<string> {
    const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
    if (managedPath) args.push("--", safeRelativePath(managedPath));
    return (await this.localGit(args)).stdout;
  }
}
