import type { BackupCredentialKind } from "@/common/orpc/schemas/backup";
import { execFileAsync, type ExecFileAsyncOptions } from "@/node/utils/disposableExec";

const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  GCM_INTERACTIVE: "never",
} as const;
const BACKUP_TOKEN_ENV = "MUX_BACKUP_TOKEN";
const TOKEN_HELPER = '!f(){ echo username=x-access-token; echo "password=$MUX_BACKUP_TOKEN"; };f';

export type BackupCredential = BackupCredentialKind;

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

async function controlledCredential(
  options: GitCredentialOptions
): Promise<ControlledCredential | null> {
  if (isSshRepoUrl(options.repoUrl)) {
    return {
      credential: "ssh",
      argsPrefix: [],
      env: { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
    };
  }

  const host = repoHost(options.repoUrl);
  if (host && (await hasAuthenticatedGh(host, options))) {
    return {
      credential: "gh",
      argsPrefix: ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"],
      env: {},
    };
  }

  if (options.token && host) {
    return {
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
    };
  }

  return null;
}

function isAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authentication failed|could not read username|permission denied|publickey|access denied|repository not found|terminal prompts disabled/i.test(
    message
  );
}

export async function runGitWithCredentialLadder(
  args: string[],
  options: GitCredentialOptions
): Promise<GitCredentialResult> {
  const controlled = await controlledCredential(options);
  const baseOptions: ExecFileAsyncOptions = {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onStderrData: options.onStderrData,
  };

  if (controlled) {
    try {
      const result = await run("git", [...controlled.argsPrefix, ...args], {
        ...baseOptions,
        env: { ...options.env, ...NON_INTERACTIVE_ENV, ...controlled.env },
      });
      return { credential: controlled.credential, ...result };
    } catch (error) {
      if (!isAuthenticationFailure(error)) {
        throw error;
      }
    }
  }

  const result = await run("git", args, {
    ...baseOptions,
    env: { ...options.env, ...NON_INTERACTIVE_ENV },
  });
  return { credential: "ambient", ...result };
}
