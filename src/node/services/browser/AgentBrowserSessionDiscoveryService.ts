import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { DisposableProcess } from "@/node/utils/disposableExec";
import { isPathInsideDir } from "@/node/utils/pathUtils";

const CLI_TIMEOUT_MS = 30_000;
const PROCESS_CWD_TIMEOUT_MS = 5_000;

const WINDOWS_PROCESS_CWD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targetPid = [int]$args[0]
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ProcessCurrentDirectoryReader {
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PEB_PARTIAL {
        public byte InheritedAddressSpace;
        public byte ReadImageFileExecOptions;
        public byte BeingDebugged;
        public byte BitField;
        public IntPtr Mutant;
        public IntPtr ImageBaseAddress;
        public IntPtr Ldr;
        public IntPtr ProcessParameters;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UNICODE_STRING {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CURDIR {
        public UNICODE_STRING DosPath;
        public IntPtr Handle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RTL_USER_PROCESS_PARAMETERS {
        public uint MaximumLength;
        public uint Length;
        public uint Flags;
        public uint DebugFlags;
        public IntPtr ConsoleHandle;
        public uint ConsoleFlags;
        public IntPtr StandardInput;
        public IntPtr StandardOutput;
        public IntPtr StandardError;
        public CURDIR CurrentDirectory;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadProcessMemory(
        IntPtr processHandle,
        IntPtr baseAddress,
        byte[] buffer,
        int size,
        out IntPtr bytesRead
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation,
        int processInformationLength,
        out int returnLength
    );

    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_READ = 0x0010;

    public static string TryGetCurrentDirectory(int pid) {
        IntPtr processHandle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (processHandle == IntPtr.Zero) {
            return null;
        }

        try {
            PROCESS_BASIC_INFORMATION processInfo = new PROCESS_BASIC_INFORMATION();
            int returnLength;
            int status = NtQueryInformationProcess(
                processHandle,
                0,
                ref processInfo,
                Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)),
                out returnLength
            );
            if (status != 0) {
                return null;
            }

            PEB_PARTIAL peb = ReadStruct<PEB_PARTIAL>(processHandle, processInfo.PebBaseAddress);
            if (peb.ProcessParameters == IntPtr.Zero) {
                return null;
            }

            RTL_USER_PROCESS_PARAMETERS parameters = ReadStruct<RTL_USER_PROCESS_PARAMETERS>(
                processHandle,
                peb.ProcessParameters
            );
            if (parameters.CurrentDirectory.DosPath.Length == 0 ||
                parameters.CurrentDirectory.DosPath.Buffer == IntPtr.Zero) {
                return null;
            }

            return ReadUnicodeString(processHandle, parameters.CurrentDirectory.DosPath);
        } catch {
            return null;
        } finally {
            CloseHandle(processHandle);
        }
    }

    private static T ReadStruct<T>(IntPtr processHandle, IntPtr address) where T : struct {
        int size = Marshal.SizeOf(typeof(T));
        byte[] buffer = new byte[size];
        IntPtr bytesRead;
        if (!ReadProcessMemory(processHandle, address, buffer, size, out bytesRead) ||
            bytesRead.ToInt64() < size) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        GCHandle pinned = GCHandle.Alloc(buffer, GCHandleType.Pinned);
        try {
            return (T)Marshal.PtrToStructure(pinned.AddrOfPinnedObject(), typeof(T));
        } finally {
            pinned.Free();
        }
    }

    private static string ReadUnicodeString(IntPtr processHandle, UNICODE_STRING unicodeString) {
        byte[] buffer = new byte[unicodeString.Length];
        IntPtr bytesRead;
        if (!ReadProcessMemory(
            processHandle,
            unicodeString.Buffer,
            buffer,
            buffer.Length,
            out bytesRead
        )) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        return Encoding.Unicode.GetString(buffer);
    }
}
"@

$result = [ProcessCurrentDirectoryReader]::TryGetCurrentDirectory($targetPid)
if ($null -ne $result) {
    [Console]::Out.Write($result)
}
`;

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

interface StreamStatusResult {
  enabled: boolean;
  port: number | null;
}

interface AgentBrowserSessionDiscoveryServiceOptions {
  resolveWorkspaceCandidatePathsFn: (workspaceId: string) => Promise<string[]>;
  listSessionNamesFn?: () => Promise<string[]>;
  getSessionStreamStatusFn?: (sessionName: string) => Promise<StreamStatusResult | null>;
  enableSessionStreamingFn?: (sessionName: string) => Promise<{ port: number } | null>;
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

function parsePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

async function runAgentBrowserJsonCommand(
  env: NodeJS.ProcessEnv,
  args: string[],
  commandDescription: string
): Promise<unknown> {
  return await new Promise<unknown>((resolve) => {
    const childProcess = spawn("agent-browser", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const disposableProcess = new DisposableProcess(childProcess);

    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (result: unknown, error?: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      if (error) {
        log.debug(commandDescription, { error });
      }
      disposableProcess[Symbol.dispose]();
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      finish(null, `${commandDescription} timed out after ${CLI_TIMEOUT_MS}ms`);
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
      finish(null, getErrorMessage(error));
    });

    childProcess.once("close", (code, signal) => {
      if (settled) {
        return;
      }

      if (code !== 0 || signal !== null) {
        finish(
          null,
          stderr.trim() || `${commandDescription} exited with ${String(signal ?? code)}`
        );
        return;
      }

      try {
        finish(JSON.parse(stdout.trim()));
      } catch (error) {
        finish(null, `${commandDescription} returned invalid JSON: ${getErrorMessage(error)}`);
      }
    });
  });
}

async function getSessionStreamStatus(
  env: NodeJS.ProcessEnv,
  sessionName: string
): Promise<StreamStatusResult | null> {
  assert(sessionName.trim().length > 0, "getSessionStreamStatus requires a non-empty sessionName");

  const payload = await runAgentBrowserJsonCommand(
    env,
    ["--json", "--session", sessionName, "stream", "status"],
    `agent-browser stream status for session ${sessionName}`
  );
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (data == null || typeof data.enabled !== "boolean") {
    return null;
  }

  const port = data.port == null ? null : parsePositiveInteger(data.port);
  if (data.port != null && port == null) {
    return null;
  }

  if (data.enabled && port == null) {
    return null;
  }

  if (!data.enabled && port != null) {
    return null;
  }

  return { enabled: data.enabled, port };
}

async function enableSessionStreaming(
  env: NodeJS.ProcessEnv,
  sessionName: string
): Promise<{ port: number } | null> {
  assert(sessionName.trim().length > 0, "enableSessionStreaming requires a non-empty sessionName");

  const payload = await runAgentBrowserJsonCommand(
    env,
    ["--json", "--session", sessionName, "stream", "enable"],
    `agent-browser stream enable for session ${sessionName}`
  );
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (data == null) {
    return null;
  }

  if (data.enabled != null && data.enabled !== true) {
    return null;
  }

  const port = parsePositiveInteger(data.port);
  if (port == null) {
    return null;
  }

  return { port };
}

async function runCommandForSinglePath(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const childProcess: ChildProcess = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const disposableProcess = new DisposableProcess(childProcess);
    let settled = false;
    let stdout = "";

    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      disposableProcess[Symbol.dispose]();
      resolve(value);
    };

    const timeoutId = setTimeout(() => {
      finish(null);
    }, timeoutMs);
    timeoutId.unref?.();

    childProcess.stdout?.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    childProcess.once("error", () => {
      finish(null);
    });

    childProcess.once("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }

      const trimmedOutput = stdout.trim();
      finish(trimmedOutput.length > 0 ? trimmedOutput : null);
    });
  });
}

async function resolveDarwinProcessCwd(pid: number): Promise<string | null> {
  const stdout = await runCommandForSinglePath(
    "lsof",
    ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
    PROCESS_CWD_TIMEOUT_MS
  );
  if (stdout == null) {
    return null;
  }

  const cwdLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("n"));
  return cwdLine ? cwdLine.slice(1) : null;
}

async function resolveWindowsProcessCwd(pid: number): Promise<string | null> {
  return await runCommandForSinglePath(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_PROCESS_CWD_SCRIPT,
      String(pid),
    ],
    PROCESS_CWD_TIMEOUT_MS
  );
}

async function resolveProcessCwd(pid: number): Promise<string | null> {
  assert(Number.isInteger(pid) && pid > 0, "resolveProcessCwd requires a positive integer pid");

  try {
    if (process.platform === "linux") {
      return await fsPromises.realpath(`/proc/${pid}/cwd`);
    }

    if (process.platform === "darwin") {
      return await resolveDarwinProcessCwd(pid);
    }

    if (process.platform === "win32") {
      return await resolveWindowsProcessCwd(pid);
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
  private readonly getSessionStreamStatusFn: (
    sessionName: string
  ) => Promise<StreamStatusResult | null>;
  private readonly enableSessionStreamingFn: (
    sessionName: string
  ) => Promise<{ port: number } | null>;
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
    this.getSessionStreamStatusFn =
      options.getSessionStreamStatusFn ??
      ((sessionName) => getSessionStreamStatus(this.env, sessionName));
    this.enableSessionStreamingFn =
      options.enableSessionStreamingFn ??
      ((sessionName) => enableSessionStreaming(this.env, sessionName));
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

  async ensureSessionAttachable(
    workspaceId: string,
    sessionName: string
  ): Promise<AgentBrowserDiscoveredSessionConnection> {
    assert(
      workspaceId.trim().length > 0,
      "ensureSessionAttachable requires a non-empty workspaceId"
    );
    assert(
      sessionName.trim().length > 0,
      "ensureSessionAttachable requires a non-empty sessionName"
    );

    const sessions = await this.discoverSessions(workspaceId);
    const session = sessions.find((candidate) => candidate.sessionName === sessionName) ?? null;
    if (session == null) {
      if (sessions.length === 0) {
        throw new Error(
          `Session "${sessionName}" is unavailable (no sessions discovered for workspace "${workspaceId}")`
        );
      }
      throw new Error(`Session "${sessionName}" not found for workspace "${workspaceId}"`);
    }

    if (session.status === "attachable") {
      return session;
    }

    assert(
      session.status === "missing_stream",
      "Expected missing_stream session when enabling streaming"
    );

    const existingStreamStatus = await this.getSessionStreamStatusFn(sessionName);
    if (existingStreamStatus?.enabled === true) {
      assert(
        existingStreamStatus.port != null && existingStreamStatus.port > 0,
        `Enabled stream status for session "${sessionName}" must include a positive port`
      );
      return {
        ...session,
        status: "attachable",
        streamPort: existingStreamStatus.port,
      };
    }

    const enabledStream = await this.enableSessionStreamingFn(sessionName);
    if (enabledStream == null) {
      throw new Error(`Failed to enable streaming for session "${sessionName}"`);
    }

    assert(
      Number.isInteger(enabledStream.port) && enabledStream.port > 0,
      `Enabled stream for session "${sessionName}" must return a positive port`
    );

    const verifiedStreamStatus = await this.getSessionStreamStatusFn(sessionName);
    if (verifiedStreamStatus?.enabled !== true || verifiedStreamStatus.port == null) {
      throw new Error(
        `Failed to verify streaming for session "${sessionName}" after enabling (requested port ${enabledStream.port})`
      );
    }

    return {
      ...session,
      status: "attachable",
      streamPort: verifiedStreamStatus.port,
    };
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
