import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  AgentBrowserSessionDiscoveryService,
  type AgentBrowserDiscoveredSession,
} from "./AgentBrowserSessionDiscoveryService";

async function writeSessionFiles(
  socketDir: string,
  sessionName: string,
  options: { pid?: string; streamPort?: string }
): Promise<void> {
  if (options.pid != null) {
    await writeFile(path.join(socketDir, `${sessionName}.pid`), `${options.pid}\n`, "utf8");
  }
  if (options.streamPort != null) {
    await writeFile(
      path.join(socketDir, `${sessionName}.stream`),
      `${options.streamPort}\n`,
      "utf8"
    );
  }
}

describe("AgentBrowserSessionDiscoveryService", () => {
  let tempDir: string;
  let socketDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "mux-agent-browser-discovery-"));
    socketDir = path.join(tempDir, "socket-dir");
    await mkdir(socketDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createService(options?: {
    listSessionNamesFn?: () => Promise<string[]>;
    getSessionStreamStatusFn?:
      | ((sessionName: string) => Promise<{ enabled: boolean; port: number | null } | null>)
      | undefined;
    enableSessionStreamingFn?:
      | ((sessionName: string) => Promise<{ port: number } | null>)
      | undefined;
    resolveCandidatePaths?: (workspaceId: string) => Promise<string[]>;
    resolveProcessCwdFn?: (pid: number) => Promise<string | null>;
  }): AgentBrowserSessionDiscoveryService {
    return new AgentBrowserSessionDiscoveryService({
      env: { AGENT_BROWSER_SOCKET_DIR: socketDir },
      listSessionNamesFn: options?.listSessionNamesFn ?? (() => Promise.resolve([])),
      getSessionStreamStatusFn: options?.getSessionStreamStatusFn,
      enableSessionStreamingFn: options?.enableSessionStreamingFn,
      resolveWorkspaceCandidatePathsFn:
        options?.resolveCandidatePaths ?? (() => Promise.resolve([path.join(tempDir, "project")])),
      resolveProcessCwdFn: options?.resolveProcessCwdFn ?? (() => Promise.resolve(null)),
    });
  }

  test("lists matching attachable sessions in deterministic order", async () => {
    const projectPath = path.join(tempDir, "project");
    await mkdir(projectPath, { recursive: true });
    await writeSessionFiles(socketDir, "beta", { pid: "200", streamPort: "9200" });
    await writeSessionFiles(socketDir, "alpha", { pid: "100", streamPort: "9100" });

    const resolveProcessCwdFn = mock((pid: number) =>
      Promise.resolve(pid === 100 || pid === 200 ? projectPath : null)
    );
    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["beta", "alpha"]),
      resolveCandidatePaths: () => Promise.resolve([projectPath]),
      resolveProcessCwdFn,
    });

    expect(await service.listSessions("workspace-1")).toEqual<AgentBrowserDiscoveredSession[]>([
      {
        sessionName: "alpha",
        pid: 100,
        cwd: projectPath,
        status: "attachable",
        streamPort: 9100,
      },
      {
        sessionName: "beta",
        pid: 200,
        cwd: projectPath,
        status: "attachable",
        streamPort: 9200,
      },
    ]);

    expect(await service.getSessionConnection("workspace-1", "beta")).toEqual({
      sessionName: "beta",
      pid: 200,
      cwd: projectPath,
      status: "attachable",
      streamPort: 9200,
    });
  });

  test("accepts sessions started from a workspace cwd nested under the project path", async () => {
    const projectPath = path.join(tempDir, "project");
    const workspacePath = path.join(projectPath, "workspace-a");
    await mkdir(workspacePath, { recursive: true });
    await writeSessionFiles(socketDir, "workspace-session", { pid: "300", streamPort: "9300" });

    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["workspace-session"]),
      resolveCandidatePaths: () => Promise.resolve([projectPath]),
      resolveProcessCwdFn: () => Promise.resolve(workspacePath),
    });

    expect(await service.listSessions("workspace-1")).toEqual([
      {
        sessionName: "workspace-session",
        pid: 300,
        cwd: workspacePath,
        status: "attachable",
        streamPort: 9300,
      },
    ]);
  });

  test("returns missing_stream sessions when cwd matches but no stream port file exists", async () => {
    const projectPath = path.join(tempDir, "project");
    await mkdir(projectPath, { recursive: true });
    await writeSessionFiles(socketDir, "nostream", { pid: "300" });

    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["nostream"]),
      resolveCandidatePaths: () => Promise.resolve([projectPath]),
      resolveProcessCwdFn: () => Promise.resolve(projectPath),
    });

    expect(await service.listSessions("workspace-1")).toEqual([
      { sessionName: "nostream", pid: 300, cwd: projectPath, status: "missing_stream" },
    ]);
    expect(await service.getSessionConnection("workspace-1", "nostream")).toBeNull();
  });

  test("ensureSessionAttachable returns attachable sessions without calling stream commands", async () => {
    const projectPath = path.join(tempDir, "project");
    await mkdir(projectPath, { recursive: true });
    await writeSessionFiles(socketDir, "attachable", { pid: "301", streamPort: "9301" });

    const getSessionStreamStatusFn = mock(() =>
      Promise.resolve<{ enabled: boolean; port: number | null } | null>(null)
    );
    const enableSessionStreamingFn = mock(() => Promise.resolve<{ port: number } | null>(null));
    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["attachable"]),
      getSessionStreamStatusFn,
      enableSessionStreamingFn,
      resolveCandidatePaths: () => Promise.resolve([projectPath]),
      resolveProcessCwdFn: () => Promise.resolve(projectPath),
    });

    expect(await service.ensureSessionAttachable("workspace-1", "attachable")).toEqual({
      sessionName: "attachable",
      pid: 301,
      cwd: projectPath,
      status: "attachable",
      streamPort: 9301,
    });
    expect(getSessionStreamStatusFn).not.toHaveBeenCalled();
    expect(enableSessionStreamingFn).not.toHaveBeenCalled();
  });

  test("ensureSessionAttachable enables missing_stream sessions on demand", async () => {
    const projectPath = path.join(tempDir, "project");
    await mkdir(projectPath, { recursive: true });
    await writeSessionFiles(socketDir, "nostream", { pid: "302" });

    const statuses = [
      { enabled: false, port: null },
      { enabled: true, port: 12345 },
    ];
    const getSessionStreamStatusFn = mock(() => Promise.resolve(statuses.shift() ?? null));
    const enableSessionStreamingFn = mock(() => Promise.resolve({ port: 12345 }));
    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["nostream"]),
      getSessionStreamStatusFn,
      enableSessionStreamingFn,
      resolveCandidatePaths: () => Promise.resolve([projectPath]),
      resolveProcessCwdFn: () => Promise.resolve(projectPath),
    });

    expect(await service.ensureSessionAttachable("workspace-1", "nostream")).toEqual({
      sessionName: "nostream",
      pid: 302,
      cwd: projectPath,
      status: "attachable",
      streamPort: 12345,
    });
    expect(getSessionStreamStatusFn).toHaveBeenCalledTimes(2);
    expect(enableSessionStreamingFn).toHaveBeenCalledTimes(1);
  });

  test("ensureSessionAttachable reuses CLI-reported streaming without enabling again", async () => {
    const projectPath = path.join(tempDir, "project");
    await mkdir(projectPath, { recursive: true });
    await writeSessionFiles(socketDir, "nostream", { pid: "303" });

    const getSessionStreamStatusFn = mock(() =>
      Promise.resolve<{ enabled: boolean; port: number | null } | null>({
        enabled: true,
        port: 9999,
      })
    );
    const enableSessionStreamingFn = mock(() => Promise.resolve<{ port: number } | null>(null));
    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["nostream"]),
      getSessionStreamStatusFn,
      enableSessionStreamingFn,
      resolveCandidatePaths: () => Promise.resolve([projectPath]),
      resolveProcessCwdFn: () => Promise.resolve(projectPath),
    });

    expect(await service.ensureSessionAttachable("workspace-1", "nostream")).toEqual({
      sessionName: "nostream",
      pid: 303,
      cwd: projectPath,
      status: "attachable",
      streamPort: 9999,
    });
    expect(getSessionStreamStatusFn).toHaveBeenCalledTimes(1);
    expect(enableSessionStreamingFn).not.toHaveBeenCalled();
  });

  test("ensureSessionAttachable throws when enabling streaming fails", async () => {
    const projectPath = path.join(tempDir, "project");
    await mkdir(projectPath, { recursive: true });
    await writeSessionFiles(socketDir, "nostream", { pid: "304" });

    const getSessionStreamStatusFn = mock(() =>
      Promise.resolve<{ enabled: boolean; port: number | null } | null>({
        enabled: false,
        port: null,
      })
    );
    const enableSessionStreamingFn = mock(() => Promise.resolve<{ port: number } | null>(null));
    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["nostream"]),
      getSessionStreamStatusFn,
      enableSessionStreamingFn,
      resolveCandidatePaths: () => Promise.resolve([projectPath]),
      resolveProcessCwdFn: () => Promise.resolve(projectPath),
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(service.ensureSessionAttachable("workspace-1", "nostream")).rejects.toThrow(
      'Failed to enable streaming for session "nostream"'
    );
    expect(getSessionStreamStatusFn).toHaveBeenCalledTimes(1);
    expect(enableSessionStreamingFn).toHaveBeenCalledTimes(1);
  });

  test("ensureSessionAttachable throws a retryable error when discovery returns no sessions", async () => {
    const getSessionStreamStatusFn = mock(() =>
      Promise.resolve<{ enabled: boolean; port: number | null } | null>(null)
    );
    const enableSessionStreamingFn = mock(() => Promise.resolve<{ port: number } | null>(null));
    const service = createService({
      listSessionNamesFn: () => Promise.resolve([]),
      getSessionStreamStatusFn,
      enableSessionStreamingFn,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(service.ensureSessionAttachable("workspace-1", "missing")).rejects.toThrow(
      'Session "missing" is unavailable (no sessions discovered for workspace "workspace-1")'
    );
    expect(getSessionStreamStatusFn).not.toHaveBeenCalled();
    expect(enableSessionStreamingFn).not.toHaveBeenCalled();
  });

  test("ensureSessionAttachable throws a terminal not found error when other sessions were discovered", async () => {
    const projectPath = path.join(tempDir, "project");
    await mkdir(projectPath, { recursive: true });
    await writeSessionFiles(socketDir, "other-session", { pid: "306", streamPort: "9306" });

    const getSessionStreamStatusFn = mock(() =>
      Promise.resolve<{ enabled: boolean; port: number | null } | null>(null)
    );
    const enableSessionStreamingFn = mock(() => Promise.resolve<{ port: number } | null>(null));
    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["other-session"]),
      getSessionStreamStatusFn,
      enableSessionStreamingFn,
      resolveCandidatePaths: () => Promise.resolve([projectPath]),
      resolveProcessCwdFn: () => Promise.resolve(projectPath),
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(service.ensureSessionAttachable("workspace-1", "missing")).rejects.toThrow(
      'Session "missing" not found for workspace "workspace-1"'
    );
    expect(getSessionStreamStatusFn).not.toHaveBeenCalled();
    expect(enableSessionStreamingFn).not.toHaveBeenCalled();
  });

  test("ensureSessionAttachable throws when streaming cannot be verified after enabling", async () => {
    const projectPath = path.join(tempDir, "project");
    await mkdir(projectPath, { recursive: true });
    await writeSessionFiles(socketDir, "nostream", { pid: "305" });

    const getSessionStreamStatusFn = mock(() =>
      Promise.resolve<{ enabled: boolean; port: number | null } | null>(null)
    );
    const enableSessionStreamingFn = mock(() => Promise.resolve({ port: 12345 }));
    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["nostream"]),
      getSessionStreamStatusFn,
      enableSessionStreamingFn,
      resolveCandidatePaths: () => Promise.resolve([projectPath]),
      resolveProcessCwdFn: () => Promise.resolve(projectPath),
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(service.ensureSessionAttachable("workspace-1", "nostream")).rejects.toThrow(
      'Failed to verify streaming for session "nostream" after enabling (requested port 12345)'
    );
    expect(getSessionStreamStatusFn).toHaveBeenCalledTimes(2);
    expect(enableSessionStreamingFn).toHaveBeenCalledTimes(1);
  });

  test("returns no sessions when cwd does not match any candidate path", async () => {
    const projectPath = path.join(tempDir, "project");
    await mkdir(projectPath, { recursive: true });
    await writeSessionFiles(socketDir, "other", { pid: "100", streamPort: "9100" });

    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["other"]),
      resolveCandidatePaths: () => Promise.resolve([projectPath]),
      resolveProcessCwdFn: () => Promise.resolve(path.join(tempDir, "different-project")),
    });

    expect(await service.listSessions("workspace-1")).toEqual([]);
  });

  test("skips dead pid sessions when cwd cannot be resolved", async () => {
    await writeSessionFiles(socketDir, "dead", { pid: "404", streamPort: "9300" });

    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["dead"]),
      resolveProcessCwdFn: () => Promise.resolve(null),
    });

    expect(await service.listSessions("workspace-1")).toEqual([]);
  });

  test("treats malformed stream files as missing_stream for otherwise-live sessions", async () => {
    const projectPath = path.join(tempDir, "project");
    await mkdir(projectPath, { recursive: true });
    await writeSessionFiles(socketDir, "bad-pid", { pid: "not-a-number", streamPort: "9100" });
    await writeSessionFiles(socketDir, "bad-port", { pid: "400", streamPort: "NaN" });

    const service = createService({
      listSessionNamesFn: () => Promise.resolve(["bad-pid", "bad-port"]),
      resolveCandidatePaths: () => Promise.resolve([projectPath]),
      resolveProcessCwdFn: () => Promise.resolve(projectPath),
    });

    expect(await service.listSessions("workspace-1")).toEqual([
      { sessionName: "bad-port", pid: 400, cwd: projectPath, status: "missing_stream" },
    ]);
  });
});
