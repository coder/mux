/** Exit code for process killed by SIGKILL (128 + 9) */
export const EXIT_CODE_SIGKILL = 137;

/** Exit code for process killed by SIGTERM (128 + 15) */
export const EXIT_CODE_SIGTERM = 143;

/**
 * Parse exit code from file content.
 * Returns null if content is empty or not a valid number.
 */
export function parseExitCode(content: string): number | null {
  const code = parseInt(content.trim(), 10);
  return isNaN(code) ? null : code;
}

/**
 * Shared command builders for background process management.
 * Used by both LocalRuntime and SSHRuntime for parity.
 */

/**
 * Shell-escape a string using POSIX-safe single-quote escaping.
 * Handles empty strings and embedded single quotes.
 */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Options for building the wrapper script that runs inside bash.
 */
export interface WrapperScriptOptions {
  /** Path where exit code will be written */
  exitCodePath: string;
  /** Working directory for the script */
  cwd: string;
  /** Environment variables to export */
  env?: Record<string, string>;
  /** The actual script to run */
  script: string;
}

/**
 * Build the wrapper script that captures exit code and sets up environment.
 * Pattern: trap 'echo $? > exit_code' EXIT && cd /path && export K=V && script
 */
export function buildWrapperScript(options: WrapperScriptOptions): string {
  const parts: string[] = [];

  // Set up trap first to capture exit code
  parts.push(`trap 'echo $? > ${shellQuote(options.exitCodePath)}' EXIT`);

  // Change to working directory
  parts.push(`cd ${shellQuote(options.cwd)}`);

  // Add environment variable exports
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      parts.push(`export ${key}=${shellQuote(value)}`);
    }
  }

  // Add the actual script
  parts.push(options.script);

  return parts.join(" && ");
}

/**
 * Options for building the spawn command.
 */
export interface SpawnCommandOptions {
  /** The wrapper script to execute */
  wrapperScript: string;
  /** Path for stdout redirection */
  stdoutPath: string;
  /** Path for stderr redirection */
  stderrPath: string;
  /** Path to bash executable (defaults to "bash") */
  bashPath?: string;
  /** Optional niceness value for process priority */
  niceness?: number;
  /** Whether to use setsid (default: true). Set false on Windows local. */
  useSetsid?: boolean;
  /** Function to quote paths for shell (default: shellQuote). Use expandTildeForSSH for SSH. */
  quotePath?: (path: string) => string;
}

/**
 * Build the spawn command using subshell + setsid + nohup pattern.
 *
 * Uses subshell (...) to isolate the process group so the outer shell exits immediately.
 * setsid: creates new session, process becomes group leader (enables kill -PID)
 * nohup: ignores SIGHUP (survives terminal hangup)
 *
 * Returns PID via echo $! (correct because & is inside subshell)
 */
export function buildSpawnCommand(options: SpawnCommandOptions): string {
  const bash = options.bashPath ?? "bash";
  const nicePrefix = options.niceness !== undefined ? `nice -n ${options.niceness} ` : "";
  const setsidPrefix = options.useSetsid === false ? "" : "setsid ";
  const quotePath = options.quotePath ?? shellQuote;

  return (
    `(${nicePrefix}${setsidPrefix}nohup ${bash} -c ${shellQuote(options.wrapperScript)} ` +
    `> ${quotePath(options.stdoutPath)} ` +
    `2> ${quotePath(options.stderrPath)} ` +
    `< /dev/null & echo $!)`
  );
}

/**
 * Build the terminate command for killing a process group.
 *
 * Uses negative PID to kill entire process group (setsid makes process a group leader).
 * Sends SIGTERM, waits 2 seconds, then SIGKILL if still running.
 * Writes EXIT_CODE_SIGKILL on force kill.
 */
export function buildTerminateCommand(pid: number, exitCodePath: string): string {
  const pgid = -pid;
  return (
    `kill -TERM ${pgid} 2>/dev/null || true; ` +
    `sleep 2; ` +
    `if kill -0 ${pid} 2>/dev/null; then ` +
    `kill -KILL ${pgid} 2>/dev/null || true; ` +
    `echo ${EXIT_CODE_SIGKILL} > ${shellQuote(exitCodePath)}; ` +
    `fi`
  );
}
