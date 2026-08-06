import type { BackupCredentialKind } from "@/common/orpc/schemas/backup";
import { execFileAsync, type ExecFileAsyncOptions } from "@/node/utils/disposableExec";
import { SSH_PROTOCOL_SCHEMES } from "@/constants/git";

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

/**
 * The leading program of an ssh command line: a quoted path in either style, or a bare token.
 * Double quotes matter because that is how a Windows `core.sshCommand` spells a path with
 * spaces, and both the variant check and the flag insertion read this same boundary. Getting it
 * wrong is not just a missed variant: an option inserted at the wrong offset lands inside the
 * path and git fails outright.
 */
const SSH_PROGRAM_TOKEN = /^\s*'((?:[^']|'\\'')*)'|^\s*"((?:[^"\\]|\\.)*)"|^\s*((?:[^\s\\]|\\.)+)/;

/**
 * A shell runs `FOO=bar ssh` with `ssh` as the program, so an assignment prefix is not the
 * executable. Skipped rather than parsed: naming it the program both hides the variant and puts
 * the inserted option before `ssh`, where it becomes another assignment instead of a flag.
 */
const SHELL_ASSIGNMENT_PREFIX = /^\s*[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"]*)/;

function sshProgram(command: string): { executable: string; end: number } | null {
  let offset = 0;
  for (;;) {
    const assignment = SHELL_ASSIGNMENT_PREFIX.exec(command.slice(offset));
    if (assignment === null) break;
    offset += assignment[0].length;
  }
  const match = SSH_PROGRAM_TOKEN.exec(command.slice(offset));
  if (match === null) return null;
  const [, singleQuoted, doubleQuoted, bare] = match;
  const executable =
    singleQuoted !== undefined
      ? singleQuoted.replaceAll(`'\\''`, "'")
      : doubleQuoted !== undefined
        ? // Only escaped quotes and backslashes are decoded. Decoding every backslash would eat
          // the separators in `"C:\Program Files\OpenSSH\ssh.exe"`, which is the spelling this
          // quoting exists to support.
          doubleQuoted.replaceAll(/\\(["\\])/g, "$1")
        : // Unquoted, a shell escapes whitespace with a backslash, but an unquoted Windows path
          // uses backslashes as separators and this config is read on any host. Decoding only
          // escaped whitespace and backslash keeps `/opt/OpenSSH\ Tools/ssh` and `C:\a\ssh.exe`.
          (bare?.replaceAll(/\\([\s\\])/g, "$1") ?? "");
  return { executable, end: offset + match.index + match[0].length };
}

const DOS_DRIVE_PREFIX = /^[A-Za-z]:/;

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
  return flag === null ? null : insertNonInteractiveFlag(base, flag);
}

/**
 * Placed before the configured command's own options, not after: OpenSSH keeps the first value
 * it obtains for an option (verified with `ssh -G -o BatchMode=no -o BatchMode=yes`, which
 * reports `batchmode no`), so appending leaves a configured `BatchMode=no` in force and lets a
 * prompt block until the git timeout.
 */
function insertNonInteractiveFlag(command: string, flag: string): string {
  const program = sshProgram(command);
  if (program === null) return `${flag} ${command}`;
  return `${command.slice(0, program.end)} ${flag}${command.slice(program.end)}`;
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
  // Split on both separators rather than `path.basename`: a `core.sshCommand` written on Windows
  // is read verbatim wherever the config is used, and basename only knows the host's separator.
  const executable = sshProgram(command)?.executable ?? "";
  const program = executable.split(/[\\/]/).pop() ?? "";
  return program.toLowerCase().replace(/\.exe$/, "");
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
      env: { ...options.env, ...NON_INTERACTIVE_ENV, ...GIT_SCOPE_ENV_UNSET },
    });
    return result.stdout.trim() || null;
  } catch {
    // git exits non-zero when the key is unset, which is the common case.
    return null;
  }
}
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
      "Could not authenticate to the backup repository. Check your SSH key or `gh auth login`.",
      { cause }
    );
    this.name = "BackupAuthFailedError";
  }
}

export interface GitCredentialOptions extends ExecFileAsyncOptions {
  repoUrl: string;
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

function isSshRepoUrl(repoUrl: string): boolean {
  const schemeEnd = repoUrl.indexOf("://");
  if (schemeEnd >= 0) {
    return SSH_PROTOCOL_SCHEMES.has(`${repoUrl.slice(0, schemeEnd).toLowerCase()}:`);
  }
  // Windows only, mirroring git's own `has_dos_drive_prefix`: elsewhere git reads `C:/repo`
  // as scp-like and really does dial host `C`, so excluding a drive prefix on every platform
  // would drop the ssh rung from a remote that needs it.
  if (process.platform === "win32" && DOS_DRIVE_PREFIX.test(repoUrl)) return false;
  return /^(?:[^@]+@)?[^:/]+:/.test(repoUrl);
}

async function run(
  file: string,
  args: string[],
  options: ExecFileAsyncOptions
): Promise<{ stdout: string; stderr: string }> {
  using process = execFileAsync(file, args, options);
  return await process.result;
}

/**
 * gh reads these before its own stored login (`gh help environment`), so an inherited
 * variable would quietly turn the gh rung back into a token pathway. The rung exists to
 * reuse the CLI's stored login and nothing else; stripping the probe too keeps the rung
 * from being offered on the strength of a token alone. The ambient rung inherits the
 * host environment untouched on purpose: there git runs exactly as the user's own git
 * would, with credential wiring Mux neither adds nor removes.
 */
const GH_TOKEN_ENV_UNSET = {
  GH_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
  GH_ENTERPRISE_TOKEN: undefined,
  GITHUB_ENTERPRISE_TOKEN: undefined,
} as const;

/**
 * Two families git trusts ahead of everything the config rebuild controls, both exported
 * into hook and alias subprocesses, which is where Mux inherits them from. The repository
 * selectors are read ahead of `-C` and discovery (git(1), "The Git Repository"): with
 * `GIT_WORK_TREE` set, `git -C <cache> clean -fdx -- mux` deletes `mux/` under that tree
 * instead of the cache. The config carriers add command-scope runtime configuration
 * (`git -c` exports them to hooks), so an inherited `url.*.pushInsteadOf` would redirect a
 * push while the checked stored url stays intact; git reads the `GIT_CONFIG_KEY_<n>` family
 * only up to `GIT_CONFIG_COUNT`, so unsetting the count disables every pair. Every git the
 * backup feature runs addresses the cache explicitly, so none of these are meaningful here
 * and all are stripped. `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` stay: git does not export
 * them, so a set value is the user's own environment, trusted like the files it names.
 * None of this is credential wiring, so the ambient rung strips it too.
 */
export const GIT_SCOPE_ENV_UNSET = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_NAMESPACE: undefined,
  GIT_CONFIG: undefined,
  GIT_CONFIG_COUNT: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
} as const;

async function hasAuthenticatedGh(host: string, options: ExecFileAsyncOptions): Promise<boolean> {
  try {
    await run("gh", ["auth", "status", "--hostname", host], {
      ...options,
      env: { ...options.env, ...NON_INTERACTIVE_ENV, ...GH_TOKEN_ENV_UNSET },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every controlled rung worth trying, in order. There is deliberately no token rung: Mux
 * must never store or accept an OAuth token or PAT for backups, so authentication is only
 * ever delegated to credentials that already live on the host (an SSH agent or key, the
 * GitHub CLI's own login, or whatever ambient helper git falls back to).
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
      env: { ...GH_TOKEN_ENV_UNSET },
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
        env: {
          ...options.env,
          ...NON_INTERACTIVE_ENV,
          ...GIT_SCOPE_ENV_UNSET,
          ...controlled.env,
        },
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
        ...GIT_SCOPE_ENV_UNSET,
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
