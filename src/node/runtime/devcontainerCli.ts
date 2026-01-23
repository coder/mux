/**
 * Devcontainer CLI helper - wraps `devcontainer` CLI commands.
 *
 * This module provides async functions for devcontainer operations:
 * - checkVersion: verify CLI is installed and get version
 * - up: build/start container with streaming logs
 * - exec: execute commands inside the container
 * - down: stop and remove the container
 */
import { spawn } from "child_process";
import type { InitLogger } from "./Runtime";
import { LineBuffer } from "./initHook";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";

type DevcontainerUpOutcome = "success" | "error";

export interface DevcontainerUpResultLine {
  outcome: DevcontainerUpOutcome;
  containerId?: string;
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
  message?: string;
  description?: string;
}

interface _DevcontainerLogLine {
  type?: string;
  level?: number;
  text?: string;
  channel?: string;
  timestamp?: number;
  startTimestamp?: number;
  name?: string;
  status?: string;
}

export type DevcontainerStdoutParse =
  | { kind: "result"; result: DevcontainerUpResultLine }
  | { kind: "log"; text: string }
  | { kind: "raw"; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDevcontainerUpOutcome(value: unknown): value is DevcontainerUpOutcome {
  return value === "success" || value === "error";
}

function isDevcontainerUpResult(value: unknown): value is DevcontainerUpResultLine {
  if (!isRecord(value)) return false;
  return isDevcontainerUpOutcome(value.outcome);
}

function extractDevcontainerLogText(value: Record<string, unknown>): string | null {
  const text = typeof value.text === "string" ? value.text : undefined;
  if (text) {
    const level = typeof value.level === "number" ? value.level : 0;
    const channel = typeof value.channel === "string" ? value.channel : "";
    const type = typeof value.type === "string" ? value.type : "";
    const isError = channel === "error" || type === "error";
    if (level >= 2 || isError) {
      return text;
    }
    return null;
  }

  const name = typeof value.name === "string" ? value.name : undefined;
  if (name) {
    return name;
  }

  return null;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

export function parseDevcontainerStdoutLine(line: string): DevcontainerStdoutParse | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) {
    return { kind: "raw", text: line };
  }

  const parsed = parseJsonLine(trimmed);
  if (!parsed) {
    return { kind: "raw", text: line };
  }

  if (isDevcontainerUpResult(parsed)) {
    return { kind: "result", result: parsed };
  }

  if (isRecord(parsed)) {
    const text = extractDevcontainerLogText(parsed);
    if (text) {
      return { kind: "log", text };
    }
  }

  return null;
}

export function formatDevcontainerUpError(
  result: DevcontainerUpResultLine,
  stderrSummary?: string
): string {
  const messageParts = [result.message, result.description].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  if (messageParts.length > 0) {
    return `devcontainer up failed: ${messageParts.join(" - ")}`;
  }

  if (stderrSummary && stderrSummary.trim().length > 0) {
    return `devcontainer up failed: ${stderrSummary.trim()}`;
  }

  return "devcontainer up failed";
}

export function shouldCleanupDevcontainer(result: DevcontainerUpResultLine): boolean {
  return (
    result.outcome === "error" &&
    typeof result.containerId === "string" &&
    result.containerId.trim().length > 0
  );
}
/** Output from `devcontainer up` command */
export interface DevcontainerUpResult {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

/** Devcontainer CLI availability info */
export interface DevcontainerCliInfo {
  available: true;
  version: string;
}

/** devcontainer up options */
export interface DevcontainerUpOptions {
  workspaceFolder: string;
  configPath?: string;
  initLogger: InitLogger;
  abortSignal?: AbortSignal;
  /** Additional mount flags (for credential sharing) */
  additionalMounts?: string[];
  /** Additional remote env vars */
  remoteEnv?: Record<string, string>;
  /** Timeout in milliseconds (default: 30 minutes) */
  timeoutMs?: number;
}

/** devcontainer exec options */
export interface DevcontainerExecOptions {
  workspaceFolder: string;
  configPath?: string;
  command: string;
  /** Working directory inside container */
  cwd?: string;
  /** Environment variables to pass */
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

const SENSITIVE_REMOTE_ENV_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

function redactRemoteEnvArgs(args: string[]): string[] {
  const redacted = [...args];
  for (let i = 0; i < redacted.length - 1; i += 1) {
    if (redacted[i] !== "--remote-env") continue;
    const entry = redacted[i + 1] ?? "";
    const [key] = entry.split("=");
    if (SENSITIVE_REMOTE_ENV_KEYS.has(key)) {
      redacted[i + 1] = `${key}=<redacted>`;
    }
  }
  return redacted;
}
const DEFAULT_UP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_STDERR_BUFFER_LENGTH = 8_000; // 8KB cap for error summaries
const DEFAULT_CLEANUP_TIMEOUT_MS = 60_000; // 1 minute

async function removeDevcontainerContainer(containerId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const proc = spawn("docker", ["rm", "-f", containerId], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEFAULT_CLEANUP_TIMEOUT_MS,
    });

    proc.on("error", () => {
      resolve();
    });

    proc.on("close", () => {
      resolve();
    });
  });
}
const VERSION_CHECK_TIMEOUT_MS = 10_000; // 10 seconds

/**
 * Check if devcontainer CLI is installed and get version.
 */
export async function checkDevcontainerCliVersion(): Promise<DevcontainerCliInfo | null> {
  return new Promise((resolve) => {
    const proc = spawn("devcontainer", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: VERSION_CHECK_TIMEOUT_MS,
    });

    let stdout = "";
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on("error", () => {
      resolve(null);
    });

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve({ available: true, version: stdout.trim() });
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Run `devcontainer up` with streaming logs.
 * Parses the JSON output to extract container info.
 */
export async function devcontainerUp(
  options: DevcontainerUpOptions
): Promise<DevcontainerUpResult> {
  const {
    workspaceFolder,
    configPath,
    initLogger,
    abortSignal,
    additionalMounts,
    remoteEnv,
    timeoutMs = DEFAULT_UP_TIMEOUT_MS,
  } = options;

  const baseArgs = ["up", "--log-format", "json", "--workspace-folder", workspaceFolder];

  if (configPath) {
    baseArgs.push("--config", configPath);
  }

  // Add mounts for credential sharing
  if (additionalMounts) {
    for (const mount of additionalMounts) {
      baseArgs.push("--mount", mount);
    }
  }

  // Add remote env vars
  if (remoteEnv) {
    for (const [key, value] of Object.entries(remoteEnv)) {
      baseArgs.push("--remote-env", `${key}=${value}`);
    }
  }

  const runUp = (args: string[]): Promise<DevcontainerUpResult> => {
    const logArgs = redactRemoteEnvArgs(args);
    initLogger.logStep(`Running: devcontainer ${logArgs.join(" ")}`);

    return new Promise((resolve, reject) => {
      const proc = spawn("devcontainer", args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        cwd: workspaceFolder,
      });

      let settled = false;
      let lastResultLine: DevcontainerUpResultLine | null = null;
      let stderrBuffer = "";
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const settleSuccess = (result: DevcontainerUpResult) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        resolve(result);
      };

      const appendStderrSummary = (text: string) => {
        if (stderrBuffer.length >= MAX_STDERR_BUFFER_LENGTH) return;
        const next = `${text}\n`;
        stderrBuffer = (stderrBuffer + next).slice(0, MAX_STDERR_BUFFER_LENGTH);
      };
      const settleError = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        reject(error);
      };

      const stdoutLineBuffer = new LineBuffer((line) => {
        const parsed = parseDevcontainerStdoutLine(line);
        if (!parsed) return;
        if (parsed.kind === "result") {
          lastResultLine = parsed.result;
          return;
        }
        if (parsed.kind === "log") {
          initLogger.logStdout(parsed.text);
          return;
        }
        initLogger.logStdout(parsed.text);
      });

      const stderrLineBuffer = new LineBuffer((line) => {
        const parsed = parseDevcontainerStdoutLine(line);
        if (parsed?.kind === "result") {
          lastResultLine ??= parsed.result;
          return;
        }
        const summaryText = parsed ? parsed.text : line;
        appendStderrSummary(summaryText);
        if (!parsed) return;
        initLogger.logStdout(parsed.text);
      });

      proc.stdout?.on("data", (data: Buffer) => {
        stdoutLineBuffer.append(data.toString());
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderrLineBuffer.append(data.toString());
      });

      const abortHandler = () => {
        proc.kill("SIGTERM");
        settleError(new Error("devcontainer up aborted"));
      };

      if (timeoutMs && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          proc.kill("SIGTERM");
          settleError(new Error(`devcontainer up timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      abortSignal?.addEventListener("abort", abortHandler);

      const finalizeError = async (message: string, result?: DevcontainerUpResultLine | null) => {
        if (result && shouldCleanupDevcontainer(result)) {
          try {
            await removeDevcontainerContainer(result.containerId ?? "");
          } catch (cleanupError) {
            log.debug("Failed to remove devcontainer container", {
              cleanupError,
              containerId: result.containerId,
            });
          }
        }
        settleError(new Error(message));
      };

      proc.on("error", (err) => {
        abortSignal?.removeEventListener("abort", abortHandler);
        stdoutLineBuffer.flush();
        stderrLineBuffer.flush();
        settleError(new Error(`devcontainer up failed: ${getErrorMessage(err)}`));
      });

      proc.on("close", (code) => {
        const handleClose = async () => {
          abortSignal?.removeEventListener("abort", abortHandler);
          stdoutLineBuffer.flush();
          stderrLineBuffer.flush();

          if (settled) return;

          const stderrSummary = stderrBuffer.trim();

          if (lastResultLine) {
            if (lastResultLine.outcome === "success") {
              if (
                !lastResultLine.containerId ||
                !lastResultLine.remoteUser ||
                !lastResultLine.remoteWorkspaceFolder
              ) {
                await finalizeError(
                  "devcontainer up output missing required fields",
                  lastResultLine
                );
                return;
              }

              settleSuccess({
                containerId: lastResultLine.containerId,
                remoteUser: lastResultLine.remoteUser,
                remoteWorkspaceFolder: lastResultLine.remoteWorkspaceFolder,
              });
              return;
            }

            await finalizeError(
              formatDevcontainerUpError(lastResultLine, stderrSummary),
              lastResultLine
            );
            return;
          }

          if (code !== 0) {
            const suffix = stderrSummary.length > 0 ? `: ${stderrSummary}` : "";
            settleError(new Error(`devcontainer up exited with code ${String(code)}${suffix}`));
            return;
          }

          const suffix = stderrSummary.length > 0 ? `: ${stderrSummary}` : "";
          settleError(new Error(`devcontainer up did not produce result output${suffix}`));
        };

        void handleClose();
      });
    });
  };

  return runUp(baseArgs);
}

/**
 * Execute a command inside the devcontainer.
 * Returns stdout as a string.
 */
export async function devcontainerExec(
  options: DevcontainerExecOptions
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { workspaceFolder, configPath, command, cwd, env, abortSignal, timeoutMs } = options;

  const args = ["exec", "--workspace-folder", workspaceFolder];

  if (configPath) {
    args.push("--config", configPath);
  }

  // Add environment variables
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      args.push("--remote-env", `${key}=${value}`);
    }
  }

  // Build the command with cd if cwd specified
  let fullCommand = command;
  if (cwd) {
    // Use bash -c to handle cd + command
    fullCommand = `cd ${JSON.stringify(cwd)} && ${command}`;
  }

  // The command goes after --
  args.push("--", "bash", "-c", fullCommand);

  return new Promise((resolve, reject) => {
    const proc = spawn("devcontainer", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      cwd: workspaceFolder,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const abortHandler = () => {
      proc.kill("SIGTERM");
      settleReject(new Error("devcontainer exec aborted"));
    };

    const clearAbortHandler = () => {
      abortSignal?.removeEventListener("abort", abortHandler);
    };

    const settleResolve = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      clearAbortHandler();
      resolve({ stdout, stderr, exitCode });
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      clearAbortHandler();
      reject(error);
    };

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    abortSignal?.addEventListener("abort", abortHandler);

    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        proc.kill("SIGTERM");
        settleReject(new Error(`devcontainer exec timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.on("error", (err) => {
      settleReject(new Error(`devcontainer exec failed: ${getErrorMessage(err)}`));
    });

    proc.on("close", (code) => {
      settleResolve(code ?? -1);
    });
  });
}

/**
 * Get the container ID for a devcontainer workspace.
 * Returns null if no container exists.
 */
export async function getDevcontainerContainerId(
  workspaceFolder: string,
  _configPath?: string,
  timeoutMs = 10_000
): Promise<string | null> {
  // The devcontainer CLI labels containers with the workspace folder path
  // We can use `devcontainer read-configuration` or docker labels to find it
  // For now, use docker ps with label filter
  const labelValue = workspaceFolder;

  return new Promise((resolve) => {
    const proc = spawn(
      "docker",
      ["ps", "-q", "--filter", `label=devcontainer.local_folder=${labelValue}`],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      }
    );

    let stdout = "";
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on("error", () => {
      resolve(null);
    });

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        // Return first container ID (there should only be one)
        resolve(stdout.trim().split("\n")[0]);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Get the container name for a devcontainer workspace.
 * Returns null if no container exists.
 *
 * Note: VS Code devcontainer deep links require the container NAME (not ID).
 * The devcontainer CLI only returns container ID, so we query Docker directly.
 */
export async function getDevcontainerContainerName(
  workspaceFolder: string,
  timeoutMs = 10_000
): Promise<string | null> {
  // The devcontainer CLI labels containers with the workspace folder path
  const labelValue = workspaceFolder;

  return new Promise((resolve) => {
    const proc = spawn(
      "docker",
      ["ps", "--format", "{{.Names}}", "--filter", `label=devcontainer.local_folder=${labelValue}`],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      }
    );

    let stdout = "";
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on("error", () => {
      resolve(null);
    });

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        // Return first container name (there should only be one)
        resolve(stdout.trim().split("\n")[0]);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Stop and remove the devcontainer (best-effort cleanup).
 * Does not throw on failure - container may not exist.
 *
 * Note: `devcontainer down` is not yet implemented in the CLI (as of v0.81.1),
 * so we use docker commands directly with the container label.
 */
export async function devcontainerDown(
  workspaceFolder: string,
  _configPath?: string,
  timeoutMs = 60_000
): Promise<void> {
  const containerId = await getDevcontainerContainerId(workspaceFolder);
  if (!containerId) {
    // No container to stop
    return;
  }

  return new Promise((resolve) => {
    // Stop and remove the container
    const proc = spawn("docker", ["rm", "-f", containerId], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    proc.on("error", () => {
      // Best-effort - don't fail if can't run
      resolve();
    });

    proc.on("close", () => {
      resolve();
    });
  });
}
