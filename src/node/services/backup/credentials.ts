import * as path from "node:path";
import type { BackupCredentialKind } from "@/common/orpc/schemas/backup";
import { execFileAsync, type ExecFileAsyncOptions } from "@/node/utils/disposableExec";

const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  GCM_INTERACTIVE: "never",
  // A push rejection is recognized by its wording. git keeps the `[rejected]` status token
  // untranslated today, so this is not load-bearing, but pinning the locale means the match
  // does not depend on that staying true.
  LC_ALL: "C",
  LANGUAGE: "C",
} as const;
const BACKUP_TOKEN_ENV = "MUX_BACKUP_TOKEN";

/**
 * A prompt for a password, a key passphrase, or host key confirmation is unanswerable behind
 * a UI button, so the ssh client is asked to fail instead of asking. The client's own command
 * line is the only place to say so, and whichever command git would have run is extended
 * rather than replaced, so a custom wrapper, key, or proxy keeps working.
 *
 * git resolves that command from four places and no more, in this precedence order (git(1),
 * confirmed against 2.54): `GIT_SSH_COMMAND`, `core.sshCommand`, `GIT_SSH`, plain `ssh`. Any
 * source left unread is a source silently discarded, so all of them are read here.
 *
 * Returns null when no flag can be added safely, leaving every variable exactly as git found
 * it. Guessing an option a client does not accept would break a working configuration, and
 * `BACKUP_GIT_TIMEOUT_MS` still bounds a client that decides to prompt.
 */
async function nonInteractiveSshCommand(
  args: readonly string[],
  options: GitCredentialOptions
): Promise<string | null> {
  const program = ambientValue(options, "GIT_SSH");
  const base =
    ambientValue(options, "GIT_SSH_COMMAND") ??
    (await configuredSshCommand(args, options)) ??
    // Unlike the other two, GIT_SSH names a program git executes directly, so a path with
    // spaces only survives becoming part of a shell command line if it is quoted.
    (program !== null ? shellQuote(program) : "ssh");
  const flag = nonInteractiveFlag(base, options);
  return flag === null ? null : `${base} ${flag}`;
}

/**
 * Git's own variant list (`GIT_SSH_VARIANT`): only OpenSSH takes `-o BatchMode=yes`, while the
 * PuTTY family spells it `-batch`, and git passes no options at all to anything else. Nothing
 * is appended for an unrecognised client for the same reason.
 */
function nonInteractiveFlag(command: string, options: GitCredentialOptions): string | null {
  switch (options.env?.GIT_SSH_VARIANT ?? process.env.GIT_SSH_VARIANT ?? sshVariant(command)) {
    case "ssh":
      return "-o BatchMode=yes";
    case "plink":
    case "putty":
    case "tortoiseplink":
      return "-batch";
    default:
      return null;
  }
}

function sshVariant(command: string): string {
  const program = /^\s*'((?:[^']|'\\'')*)'|^\s*(\S+)/.exec(command);
  const executable = (program?.[1] ?? program?.[2] ?? "").replaceAll(`'\\''`, "'");
  return path
    .basename(executable)
    .toLowerCase()
    .replace(/\.exe$/, "");
}

function ambientValue(
  options: GitCredentialOptions,
  name: "GIT_SSH_COMMAND" | "GIT_SSH"
): string | null {
  const value = options.env?.[name] ?? process.env[name];
  return value !== undefined && value.trim() !== "" ? value : null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function sshEnvOverrides(
  args: readonly string[],
  options: GitCredentialOptions
): Promise<Record<string, string | undefined>> {
  const command = await nonInteractiveSshCommand(args, options);
  return command === null ? {} : { GIT_SSH_COMMAND: command };
}

/** Reads through the caller's own `-C`, so the value git would apply is the one extended. */
async function configuredSshCommand(
  args: readonly string[],
  options: GitCredentialOptions
): Promise<string | null> {
  const repository = args[0] === "-C" && args[1] !== undefined ? ["-C", args[1]] : [];
  try {
    const result = await run("git", [...repository, "config", "--get", "core.sshCommand"], {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      env: { ...options.env, ...NON_INTERACTIVE_ENV },
    });
    return result.stdout.trim() || null;
  } catch {
    // git exits non-zero when the key is unset, which is the common case.
    return null;
  }
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
  args: readonly string[],
  options: GitCredentialOptions
): Promise<ControlledCredential[]> {
  if (isSshRepoUrl(options.repoUrl)) {
    return [
      {
        credential: "ssh",
        argsPrefix: [],
        env: await sshEnvOverrides(args, options),
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
  /unable to write|insufficient permission for adding an object|no space left on device|read-only file system|cannot open '[^']*(?:FETCH_HEAD|HEAD|index|config|packed-refs)'|unable to (?:create|open)|error: cannot (?:lock|create) ref/i;

/** Remote failures vary across curl, ssh, and Git resolver diagnostics. */
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
  // A blackholed remote may emit no diagnostic before timeout kills Git, so key on `signal`.
  if (isSignalTermination(error)) return true;
  return REMOTE_UNREACHABLE_PATTERN.test(message);
}

function isSignalTermination(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const signal = (error as Error & { signal?: unknown }).signal;
  return typeof signal === "string" && signal !== "";
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

  for (const controlled of await controlledCredentials(args, options)) {
    try {
      const result = await run("git", [...controlled.argsPrefix, ...args], {
        ...baseOptions,
        env: { ...options.env, ...NON_INTERACTIVE_ENV, ...controlled.env },
      });
      return { credential: controlled.credential, ...result };
    } catch (error) {
      if (!isAuthenticationFailure(error)) {
        // Thrown from inside the loop on purpose: another credential cannot make an
        // unreachable remote reachable, so trying the rest only delays the error.
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
        ...(await sshEnvOverrides(args, options)),
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
