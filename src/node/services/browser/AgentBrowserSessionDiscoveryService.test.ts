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
    resolveCandidatePaths?: (workspaceId: string) => Promise<string[]>;
    resolveProcessCwdFn?: (pid: number) => Promise<string | null>;
  }): AgentBrowserSessionDiscoveryService {
    return new AgentBrowserSessionDiscoveryService({
      env: { AGENT_BROWSER_SOCKET_DIR: socketDir },
      listSessionNamesFn: options?.listSessionNamesFn ?? (() => Promise.resolve([])),
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
