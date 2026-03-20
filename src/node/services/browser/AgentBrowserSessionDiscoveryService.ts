import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { DisposableProcess } from "@/node/utils/disposableExec";

const CLI_TIMEOUT_MS = 30_000;

export type AgentBrowserDiscoveredSessionStatus = "attachable" | "missing_stream";

interface AgentBrowserDiscoveredSessionBase {
  sessionName: string;
  pid: number;
  cwd: string;
}

export interface AgentBrowserDiscoveredSessionConnection extends AgentBrowserDiscoveredSessionBase {
  status: "attachable";
  streamPort: number;
}

export interface AgentBrowserMissingStreamSession extends AgentBrowserDiscoveredSessionBase {
  status: "missing_stream";
}

export type AgentBrowserDiscoveredSession =
  | AgentBrowserDiscoveredSessionConnection
  | AgentBrowserMissingStreamSession;

interface AgentBrowserSessionDiscoveryServiceOptions {
  resolveWorkspaceCandidatePathsFn: (workspaceId: string) => Promise<string[]>;
  listSessionNamesFn?: () => Promise<string[]>;
  readFileFn?: typeof fsPromises.readFile;
  realpathFn?: typeof fsPromises.realpath;
  resolveProcessCwdFn?: (pid: number) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getAgentBrowserSocketDir(env: NodeJS.ProcessEnv): string {
  const override = env.AGENT_BROWSER_SOCKET_DIR?.trim();
  if (override) {
    return override;
  }

  const xdgRuntimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (xdgRuntimeDir) {
    return path.join(xdgRuntimeDir, "agent-browser");
  }

  const homeDir = env.HOME?.trim();
  if (homeDir) {
    return path.join(homeDir, ".agent-browser");
  }

  const tmpDir = env.TMPDIR?.trim();
  return path.join(tmpDir ?? os.tmpdir(), "agent-browser");
}

function extractSessionNames(payload: unknown): string[] {
  const rawSessions = isRecord(payload) && isRecord(payload.data) ? payload.data.sessions : null;
  if (!Array.isArray(rawSessions)) {
    return [];
  }

  const sessions = rawSessions.filter((value): value is string => typeof value === "string");
  return sessions.length === rawSessions.length ? sessions : [];
}

async function listAgentBrowserSessionNames(env: NodeJS.ProcessEnv): Promise<string[]> {
  return await new Promise<string[]>((resolve) => {
    const childProcess = spawn("agent-browser", ["--json", "session", "list"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const disposableProcess = new DisposableProcess(childProcess);

    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (sessions: string[], error?: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      if (error) {
        log.debug("Agent-browser session discovery failed", { error });
      }
      resolve(sessions);
    };

    const timeoutId = setTimeout(() => {
      disposableProcess[Symbol.dispose]();
      finish([], `agent-browser session list timed out after ${CLI_TIMEOUT_MS}ms`);
    }, CLI_TIMEOUT_MS);
    timeoutId.unref?.();

    childProcess.stdout?.setEncoding("utf8");
    childProcess.stderr?.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    childProcess.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    childProcess.once("error", (error) => {
      disposableProcess[Symbol.dispose]();
      finish([], getErrorMessage(error));
    });

    childProcess.once("close", (code, signal) => {
      if (settled) {
        return;
      }

      if (code !== 0 || signal !== null) {
        disposableProcess[Symbol.dispose]();
        finish(
          [],
          stderr.trim() || `agent-browser session list exited with ${String(signal ?? code)}`
        );
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(stdout.trim());
      } catch (error) {
        disposableProcess[Symbol.dispose]();
        finish([], `agent-browser session list returned invalid JSON: ${getErrorMessage(error)}`);
        return;
      }

      disposableProcess[Symbol.dispose]();
      finish(extractSessionNames(payload));
    });
  });
}

async function resolveProcessCwd(pid: number): Promise<string | null> {
  assert(Number.isInteger(pid) && pid > 0, "resolveProcessCwd requires a positive integer pid");

  try {
    if (process.platform === "linux") {
      return await fsPromises.realpath(`/proc/${pid}/cwd`);
    }

    if (process.platform === "darwin") {
      return await new Promise<string | null>((resolve) => {
        const childProcess: ChildProcess = spawn(
          "lsof",
          ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
          {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          }
        );
        const disposableProcess = new DisposableProcess(childProcess);
        let stdout = "";

        childProcess.stdout?.setEncoding("utf8");
        childProcess.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });

        childProcess.once("error", () => {
          disposableProcess[Symbol.dispose]();
          resolve(null);
        });

        childProcess.once("close", (code) => {
          disposableProcess[Symbol.dispose]();
          if (code !== 0) {
            resolve(null);
            return;
          }

          const cwdLine = stdout
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.startsWith("n"));
          resolve(cwdLine ? cwdLine.slice(1) : null);
        });
      });
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeComparablePath(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInsideDir(dirPath: string, filePath: string): boolean {
  const relative = path.relative(dirPath, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readPositiveIntegerFile(
  readFileFn: typeof fsPromises.readFile,
  filePath: string
): Promise<number | null> {
  try {
    const raw = (await readFileFn(filePath, "utf8")).trim();
    if (!/^\d+$/.test(raw)) {
      return null;
    }

    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export class AgentBrowserSessionDiscoveryService {
  private readonly resolveWorkspaceCandidatePathsFn: AgentBrowserSessionDiscoveryServiceOptions["resolveWorkspaceCandidatePathsFn"];
  private readonly listSessionNamesFn: () => Promise<string[]>;
  private readonly readFileFn: typeof fsPromises.readFile;
  private readonly realpathFn: typeof fsPromises.realpath;
  private readonly resolveProcessCwdFn: (pid: number) => Promise<string | null>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: AgentBrowserSessionDiscoveryServiceOptions) {
    assert(
      typeof options.resolveWorkspaceCandidatePathsFn === "function",
      "AgentBrowserSessionDiscoveryService requires resolveWorkspaceCandidatePathsFn"
    );
    this.resolveWorkspaceCandidatePathsFn = options.resolveWorkspaceCandidatePathsFn;
    this.env = options.env ?? process.env;
    this.listSessionNamesFn =
      options.listSessionNamesFn ?? (() => listAgentBrowserSessionNames(this.env));
    this.readFileFn = options.readFileFn ?? fsPromises.readFile;
    this.realpathFn = options.realpathFn ?? fsPromises.realpath;
    this.resolveProcessCwdFn = options.resolveProcessCwdFn ?? resolveProcessCwd;
  }

  async listSessions(workspaceId: string): Promise<AgentBrowserDiscoveredSession[]> {
    assert(workspaceId.trim().length > 0, "listSessions requires a non-empty workspaceId");
    return await this.discoverSessions(workspaceId);
  }

  async getSessionConnection(
    workspaceId: string,
    sessionName: string
  ): Promise<AgentBrowserDiscoveredSessionConnection | null> {
    assert(workspaceId.trim().length > 0, "getSessionConnection requires a non-empty workspaceId");
    assert(sessionName.trim().length > 0, "getSessionConnection requires a non-empty sessionName");
    const sessions = await this.discoverSessions(workspaceId);
    const session = sessions.find((candidate) => candidate.sessionName === sessionName) ?? null;
    return session?.status === "attachable" ? session : null;
  }

  private async discoverSessions(workspaceId: string): Promise<AgentBrowserDiscoveredSession[]> {
    const candidatePaths = await this.resolveWorkspaceCandidatePathsFn(workspaceId);
    const comparableCandidatePaths = await this.resolveComparableCandidatePaths(candidatePaths);
    if (comparableCandidatePaths.length === 0) {
      return [];
    }

    const socketDir = getAgentBrowserSocketDir(this.env);
    const sessionNames = await this.listSessionNamesFn();
    const sessions: AgentBrowserDiscoveredSession[] = [];

    for (const sessionName of sessionNames) {
      const pid = await readPositiveIntegerFile(
        this.readFileFn,
        path.join(socketDir, `${sessionName}.pid`)
      );
      if (pid == null) {
        continue;
      }

      const cwd = await this.resolveProcessCwdFn(pid);
      if (cwd == null || cwd.trim().length === 0) {
        continue;
      }

      const comparableCwd = await this.resolveComparablePath(cwd);
      if (
        !comparableCandidatePaths.some((candidatePath) =>
          isPathInsideDir(candidatePath, comparableCwd)
        )
      ) {
        continue;
      }

      const streamPort = await readPositiveIntegerFile(
        this.readFileFn,
        path.join(socketDir, `${sessionName}.stream`)
      );
      if (streamPort == null) {
        sessions.push({ sessionName, pid, cwd, status: "missing_stream" });
        continue;
      }

      const attachableSession: AgentBrowserDiscoveredSessionConnection = {
        sessionName,
        pid,
        cwd,
        status: "attachable",
        streamPort,
      };
      sessions.push(attachableSession);
    }

    sessions.sort((a, b) => a.sessionName.localeCompare(b.sessionName));
    return sessions;
  }

  private async resolveComparableCandidatePaths(candidatePaths: string[]): Promise<string[]> {
    const resolvedPaths = await Promise.all(
      candidatePaths
        .filter((candidatePath) => candidatePath.trim().length > 0)
        .map((candidatePath) => this.resolveComparablePath(candidatePath))
    );
    return Array.from(new Set(resolvedPaths));
  }

  private async resolveComparablePath(filePath: string): Promise<string> {
    try {
      return normalizeComparablePath(await this.realpathFn(filePath));
    } catch {
      return normalizeComparablePath(filePath);
    }
  }
}
