import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { DisposableProcess } from "@/node/utils/disposableExec";
import {
  AgentBrowserBinaryNotFoundError,
  AgentBrowserUnsupportedPlatformError,
  AgentBrowserVendoredPackageNotFoundError,
  resolveAgentBrowserBinary,
} from "@/node/services/agentBrowserLauncher";

const CLI_TIMEOUT_MS = 30_000;
const VENDORED_BROWSER_RECOVERY_HINT =
  "Reinstall Mux, or run bun install in the repo if you're developing locally.";
const MISSING_BROWSER_BINARY_ERROR =
  "Vendored agent-browser binary disappeared before launch. Reinstall Mux, or run bun install in the repo if you're developing locally.";

interface RawCliResultSuccess {
  ok: true;
  stdout: string;
  stderr: string;
}

interface RawCliResultFailure {
  ok: false;
  error: string;
}

export type RawCliResult = RawCliResultSuccess | RawCliResultFailure;

export interface AgentBrowserCliCommandOptions {
  inFlightProcesses?: Set<ChildProcess>;
  spawnFn?: typeof spawn;
  resolveAgentBrowserBinaryFn?: () => string;
  env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getAgentBrowserLauncherError(error: unknown): string | null {
  if (error instanceof AgentBrowserUnsupportedPlatformError) {
    return `${error.message} ${VENDORED_BROWSER_RECOVERY_HINT}`;
  }

  if (
    error instanceof AgentBrowserBinaryNotFoundError ||
    error instanceof AgentBrowserVendoredPackageNotFoundError
  ) {
    return `${error.message} ${VENDORED_BROWSER_RECOVERY_HINT}`;
  }

  return null;
}

function formatCliCommandFailure(
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null
): string {
  return (
    stderr.trim() ||
    (signal !== null
      ? `CLI command exited via signal ${signal}`
      : `CLI command failed with exit code ${code ?? "unknown"}`)
  );
}

function isMissingBrowserSessionError(error: string): boolean {
  return /session not found|no session/i.test(error);
}

function extractCliSessionNames(data: unknown): string[] | null {
  const rawSessions = isRecord(data) && isRecord(data.data) ? data.data.sessions : null;
  if (!Array.isArray(rawSessions)) {
    return null;
  }

  const sessions = rawSessions.filter((session): session is string => typeof session === "string");
  return sessions.length === rawSessions.length ? sessions : null;
}

export async function runAgentBrowserCliCommand(
  sessionId: string,
  args: string[],
  timeoutMs = CLI_TIMEOUT_MS,
  options?: AgentBrowserCliCommandOptions
): Promise<RawCliResult> {
  assert(sessionId.trim().length > 0, "runAgentBrowserCliCommand requires a non-empty sessionId");
  assert(args.length > 0, "runAgentBrowserCliCommand requires at least one CLI arg");

  const resolveAgentBrowserBinaryFn =
    options?.resolveAgentBrowserBinaryFn ?? resolveAgentBrowserBinary;

  let agentBrowserBinary: string;
  try {
    agentBrowserBinary = resolveAgentBrowserBinaryFn();
  } catch (error) {
    const launcherError = getAgentBrowserLauncherError(error);
    if (launcherError !== null) {
      return { ok: false, error: launcherError };
    }
    throw error;
  }

  const spawnFn = options?.spawnFn ?? spawn;
  const childProcess = spawnFn(agentBrowserBinary, ["--json", "--session", sessionId, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(options?.env != null ? { env: options.env } : {}),
  });
  const disposableProcess = new DisposableProcess(childProcess);
  options?.inFlightProcesses?.add(childProcess);

  return await new Promise<RawCliResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: RawCliResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      options?.inFlightProcesses?.delete(childProcess);
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      disposableProcess[Symbol.dispose]();
      finish({ ok: false, error: `CLI command timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    childProcess.stdout?.setEncoding("utf8");
    childProcess.stderr?.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    childProcess.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    childProcess.on("error", (error) => {
      const spawnError = error as NodeJS.ErrnoException;
      disposableProcess[Symbol.dispose]();
      finish({
        ok: false,
        error: spawnError.code === "ENOENT" ? MISSING_BROWSER_BINARY_ERROR : error.message,
      });
    });

    childProcess.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      if (code !== 0 || signal !== null) {
        finish({ ok: false, error: formatCliCommandFailure(stderr, code, signal) });
        return;
      }

      finish({ ok: true, stdout, stderr });
    });
  });
}

export async function runAgentBrowserCliJsonCommand(
  sessionId: string,
  args: string[],
  timeoutMs = CLI_TIMEOUT_MS,
  options?: AgentBrowserCliCommandOptions
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const result = await runAgentBrowserCliCommand(sessionId, args, timeoutMs, options);
  if (!result.ok) {
    return result;
  }

  const trimmedStdout = result.stdout.trim();
  if (trimmedStdout.length === 0) {
    return { ok: false, error: "Unexpected CLI output" };
  }

  let parsedOutput: unknown;
  try {
    parsedOutput = JSON.parse(trimmedStdout);
  } catch {
    return { ok: false, error: "Unexpected CLI output" };
  }

  if (isRecord(parsedOutput) && parsedOutput.success === false) {
    return {
      ok: false,
      error: typeof parsedOutput.error === "string" ? parsedOutput.error : "Unexpected CLI output",
    };
  }

  return { ok: true, data: parsedOutput };
}

export async function hasAgentBrowserSession(
  sessionId: string,
  timeoutMs = CLI_TIMEOUT_MS,
  options?: AgentBrowserCliCommandOptions
): Promise<boolean> {
  assert(sessionId.trim().length > 0, "hasAgentBrowserSession requires a non-empty sessionId");

  try {
    const result = await runAgentBrowserCliJsonCommand(sessionId, ["session", "list"], timeoutMs, {
      inFlightProcesses: options?.inFlightProcesses,
      spawnFn: options?.spawnFn,
      resolveAgentBrowserBinaryFn: options?.resolveAgentBrowserBinaryFn,
      env: options?.env,
    });
    if (!result.ok) {
      return false;
    }

    const sessions = extractCliSessionNames(result.data);
    return sessions?.includes(sessionId) ?? false;
  } catch {
    return false;
  }
}

export async function openAgentBrowserSession(
  sessionId: string,
  initialUrl: string,
  options?: AgentBrowserCliCommandOptions & {
    timeoutMs?: number;
    streamPort?: number;
  }
): Promise<{ success: true } | { success: false; error: string }> {
  assert(sessionId.trim().length > 0, "openAgentBrowserSession requires a non-empty sessionId");
  assert(initialUrl.trim().length > 0, "openAgentBrowserSession requires a non-empty initialUrl");

  const env =
    options?.streamPort != null
      ? {
          ...process.env,
          ...(options.env ?? {}),
          AGENT_BROWSER_STREAM_PORT: String(options.streamPort),
        }
      : options?.env;

  const result = await runAgentBrowserCliJsonCommand(
    sessionId,
    ["open", initialUrl],
    options?.timeoutMs,
    {
      inFlightProcesses: options?.inFlightProcesses,
      spawnFn: options?.spawnFn,
      resolveAgentBrowserBinaryFn: options?.resolveAgentBrowserBinaryFn,
      env,
    }
  );

  return result.ok ? { success: true } : { success: false, error: result.error };
}

export async function closeAgentBrowserSession(
  sessionId: string,
  timeoutMs = CLI_TIMEOUT_MS,
  options?: AgentBrowserCliCommandOptions
): Promise<{ success: boolean; error?: string }> {
  assert(sessionId.trim().length > 0, "closeAgentBrowserSession requires a non-empty sessionId");

  try {
    const result = await runAgentBrowserCliCommand(sessionId, ["close"], timeoutMs, {
      spawnFn: options?.spawnFn,
      resolveAgentBrowserBinaryFn: options?.resolveAgentBrowserBinaryFn,
      env: options?.env,
    });
    if (!result.ok) {
      if (isMissingBrowserSessionError(result.error)) {
        return { success: true };
      }

      return { success: false, error: result.error };
    }

    const trimmedStdout = result.stdout.trim();
    if (trimmedStdout.length === 0) {
      return { success: true };
    }

    try {
      const parsedOutput: unknown = JSON.parse(trimmedStdout);
      if (isRecord(parsedOutput) && parsedOutput.success === false) {
        return {
          success: false,
          error:
            typeof parsedOutput.error === "string" ? parsedOutput.error : "close reported failure",
        };
      }
    } catch {
      // Treat non-JSON close output as success; close may emit plain text on success.
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
