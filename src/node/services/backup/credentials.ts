import type { BackupCredentialKind } from "@/common/orpc/schemas/backup";
import { execFileAsync, type ExecFileAsyncOptions } from "@/node/utils/disposableExec";

const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  GCM_INTERACTIVE: "never",
} as const;
const BACKUP_TOKEN_ENV = "MUX_BACKUP_TOKEN";

/**
 * `BatchMode=yes` is what keeps ssh from asking for a password, a key passphrase, or host
 * key confirmation (`ssh_config(5)`), which a backup running behind a UI button can never
 * answer: it would just hang Validate, Preview, or Push forever. A command line `-o` beats
 * ssh_config, and an ambient `GIT_SSH_COMMAND` is extended rather than replaced so a custom
 * ssh wrapper still gets used.
 */
function nonInteractiveSshCommand(env: Record<string, string | undefined> | undefined): string {
  const ambient = env?.GIT_SSH_COMMAND ?? process.env.GIT_SSH_COMMAND;
  const base = ambient !== undefined && ambient.trim() !== "" ? ambient : "ssh";
  return `${base} -o BatchMode=yes`;
}
const TOKEN_HELPER = '!f(){ echo username=x-access-token; echo "password=$MUX_BACKUP_TOKEN"; };f';

export type BackupCredential = BackupCredentialKind;

export class BackupRemoteUnreachableError extends Error {
  readonly code = "REMOTE_UNREACHABLE";

  constructor(cause: unknown) {
    super("Could not reach the backup repository. Check the URL and your network connection.", {
      cause,
    });
    this.name = "BackupRemoteUnreachableError";
  }
}

export class BackupAuthFailedError extends Error {
  readonly code = "AUTH_FAILED";

  constructor(cause: unknown) {
    super(
      "Could not authenticate to the backup repository. Check your SSH key, `gh auth login`, or GH_TOKEN.",
      { cause }
    );
    this.name = "BackupAuthFailedError";
  }
}

export interface GitCredentialOptions extends ExecFileAsyncOptions {
  repoUrl: string;
  token?: string;
}

export interface GitCredentialResult {
  credential: BackupCredential;
  stdout: string;
  stderr: string;
}

interface ControlledCredential {
  credential: Exclude<BackupCredential, "ambient">;
  argsPrefix: string[];
  env: Record<string, string | undefined>;
}

function repoHost(repoUrl: string): string | null {
  try {
    return new URL(repoUrl).hostname || null;
  } catch {
    const sshMatch = /^(?:[^@]+@)?([^:/]+):/.exec(repoUrl);
    return sshMatch?.[1] ?? null;
  }
}

/** GH_TOKEN authenticates GitHub, so only a GitHub host may be offered it. */
export function isGitHubRepoUrl(repoUrl: string): boolean {
  const host = repoHost(repoUrl)?.toLowerCase();
  if (!host) return false;
  const enterpriseHost = process.env.GH_HOST?.toLowerCase();
  return (
    host === "github.com" ||
    host.endsWith(".github.com") ||
    (enterpriseHost !== undefined && host === enterpriseHost)
  );
}

function isSshRepoUrl(repoUrl: string): boolean {
  return (
    repoUrl.startsWith("ssh://") ||
    (!repoUrl.includes("://") && /^(?:[^@]+@)?[^:/]+:/.test(repoUrl))
  );
}

async function run(
  file: string,
  args: string[],
  options: ExecFileAsyncOptions
): Promise<{ stdout: string; stderr: string }> {
  using process = execFileAsync(file, args, options);
  return await process.result;
}

async function hasAuthenticatedGh(host: string, options: ExecFileAsyncOptions): Promise<boolean> {
  try {
    await run("gh", ["auth", "status", "--hostname", host], {
      ...options,
      env: { ...options.env, ...NON_INTERACTIVE_ENV },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every controlled rung worth trying, in order. `gh` comes before an explicit token because
 * it needs no configuration, but both are kept: the logged-in `gh` account may simply lack
 * access to this repository, and falling straight through to ambient credentials would make
 * a perfectly good configured token unusable just because someone else is logged into `gh`.
 */
async function controlledCredentials(
  options: GitCredentialOptions
): Promise<ControlledCredential[]> {
  if (isSshRepoUrl(options.repoUrl)) {
    return [
      {
        credential: "ssh",
        argsPrefix: [],
        env: { GIT_SSH_COMMAND: nonInteractiveSshCommand(options.env) },
      },
    ];
  }

  const host = repoHost(options.repoUrl);
  if (!host) return [];
  const rungs: ControlledCredential[] = [];

  if (await hasAuthenticatedGh(host, options)) {
    rungs.push({
      credential: "gh",
      argsPrefix: ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"],
      env: {},
    });
  }

  if (options.token) {
    rungs.push({
      credential: "token",
      // Scope the helper to the repository's own origin so a redirect or a submodule
      // on another host cannot make git offer this token to it.
      argsPrefix: [
        "-c",
        "credential.helper=",
        "-c",
        `credential.${new URL(options.repoUrl).origin}.helper=${TOKEN_HELPER}`,
      ],
      env: { [BACKUP_TOKEN_ENV]: options.token },
    });
  }

  return rungs;
}

/**
 * Push denials count, not just fetch denials: `ls-remote` only proves read access, so a
 * read-only credential first shows up as a rejected push. Matching those here also lets
 * the ladder retry with the ambient helper, which may hold a writable credential.
 */
const AUTH_FAILURE_PATTERN =
  /authentication failed|could not read (?:username|password)|permission denied|permission to [^\n]*denied|publickey|access denied|repository not found|terminal prompts disabled|invalid username or (?:password|token)|returned error: 40[13]|authentication is required/i;

/**
 * Local object-store failures also say "Permission denied", so they are excluded first.
 * Without this, a full or read-only disk would be reported as an expired credential and
 * would waste an ambient retry.
 */
const LOCAL_FILESYSTEM_FAILURE_PATTERN =
  /unable to write|insufficient permission for adding an object|no space left on device|read-only file system/i;

/**
 * Reaching the remote fails through curl, ssh, or git's own resolver depending on the
 * transport, so the wording varies. Only checked once a failure is known not to be an
 * authentication problem, which keeps credential classification unchanged.
 */
const REMOTE_UNREACHABLE_PATTERN =
  /could not resolve (?:host|hostname|proxy)|name or service not known|temporary failure in name resolution|connection (?:refused|timed out|reset)|network is (?:unreachable|down)|no route to host|failed to connect to|couldn't connect to server|operation timed out|returned error: 5\d\d|service unavailable|bad gateway|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i;

function isAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (LOCAL_FILESYSTEM_FAILURE_PATTERN.test(message)) return false;
  return AUTH_FAILURE_PATTERN.test(message);
}

function isRemoteUnreachable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (LOCAL_FILESYSTEM_FAILURE_PATTERN.test(message)) return false;
  return REMOTE_UNREACHABLE_PATTERN.test(message);
}

export async function runGitWithCredentialLadder(
  args: string[],
  options: GitCredentialOptions
): Promise<GitCredentialResult> {
  const baseOptions: ExecFileAsyncOptions = {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onStderrData: options.onStderrData,
  };

  for (const controlled of await controlledCredentials(options)) {
    try {
      const result = await run("git", [...controlled.argsPrefix, ...args], {
        ...baseOptions,
        env: { ...options.env, ...NON_INTERACTIVE_ENV, ...controlled.env },
      });
      return { credential: controlled.credential, ...result };
    } catch (error) {
      if (!isAuthenticationFailure(error)) {
        // A remote we cannot reach will not become reachable on the next rung, so this both
        // classifies the failure and stops the ladder early.
        if (isRemoteUnreachable(error)) throw new BackupRemoteUnreachableError(error);
        throw error;
      }
    }
  }

  try {
    const result = await run("git", args, {
      ...baseOptions,
      // The ambient rung deliberately drops the controlled rungs' credential wiring, but it
      // must not drop their non-interactivity: an ssh remote reached here would otherwise
      // prompt for a passphrase and hang the operation.
      env: {
        ...options.env,
        ...NON_INTERACTIVE_ENV,
        GIT_SSH_COMMAND: nonInteractiveSshCommand(options.env),
      },
    });
    return { credential: "ambient", ...result };
  } catch (error) {
    // Every rung has now failed. A raw git error carries a numeric exit code, which the
    // service cannot distinguish from a local filesystem failure.
    if (isAuthenticationFailure(error)) throw new BackupAuthFailedError(error);
    if (isRemoteUnreachable(error)) throw new BackupRemoteUnreachableError(error);
    throw error;
  }
}
