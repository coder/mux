import { describe, expect, it } from "bun:test";
import type { ExecOptions, ExecStream, FileStat, Runtime } from "@/node/runtime/Runtime";
import { getLegacyPlanFilePath, getPlanFilePath } from "@/common/utils/planStorage";
import { shellQuote } from "@/common/utils/shell";
import { copyPlanFileAcrossRuntimes, movePlanFile, readPlanFile } from "./helpers";

interface MockRuntimeState {
  muxHome: string;
  files: Map<string, string>;
  readAttempts: string[];
  writes: Array<{ path: string; content: string }>;
  execCalls: Array<{ command: string; options: ExecOptions }>;
  resolvedPaths: Map<string, string>;
}

function createRuntimeState(
  muxHome: string,
  initialFiles: Record<string, string> = {}
): MockRuntimeState {
  return {
    muxHome,
    files: new Map(Object.entries(initialFiles)),
    readAttempts: [],
    writes: [],
    execCalls: [],
    resolvedPaths: new Map(),
  };
}

function createTextStream(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

function createExecStream(stdout = "", stderr = "", exitCode = 0, duration = 0): ExecStream {
  return {
    stdout: createTextStream(stdout),
    stderr: createTextStream(stderr),
    stdin: new WritableStream<Uint8Array>({
      write(_chunk) {
        return Promise.resolve();
      },
      close() {
        return Promise.resolve();
      },
    }),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(duration),
  };
}

function toFileStat(content: string): FileStat {
  return {
    size: content.length,
    modifiedTime: new Date(0),
    isDirectory: false,
  };
}

function createMockRuntime(state: MockRuntimeState): Runtime {
  return {
    getMuxHome: () => state.muxHome,
    readFile: (path: string) => {
      state.readAttempts.push(path);
      const content = state.files.get(path);
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return createTextStream(content);
    },
    writeFile: (path: string) => {
      const decoder = new TextDecoder("utf-8");
      let content = "";

      return new WritableStream<Uint8Array>({
        write(chunk) {
          content += decoder.decode(chunk, { stream: true });
        },
        close() {
          content += decoder.decode();
          state.files.set(path, content);
          state.writes.push({ path, content });
        },
      });
    },
    exec: (command: string, options: ExecOptions) => {
      state.execCalls.push({ command, options });
      return Promise.resolve(createExecStream());
    },
    stat: (path: string) => {
      const content = state.files.get(path);
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve(toFileStat(content));
    },
    resolvePath: (path: string) => {
      const resolvedPath = state.resolvedPaths.get(path);
      if (resolvedPath !== undefined) {
        return Promise.resolve(resolvedPath);
      }
      return Promise.resolve(path);
    },
  } as unknown as Runtime;
}

describe("copyPlanFileAcrossRuntimes", () => {
  const sourceWorkspaceName = "source-workspace";
  const sourceWorkspaceId = "source-workspace-id";
  const targetWorkspaceName = "target-workspace";
  const projectName = "demo-project";
  const sourceMuxHome = "/source-mux";
  const targetMuxHome = "/target-mux";

  it("reads from source runtime and writes to target runtime", async () => {
    const sourcePath = getPlanFilePath(sourceWorkspaceName, projectName, sourceMuxHome);
    const legacyPath = getLegacyPlanFilePath(sourceWorkspaceId);
    const targetPath = getPlanFilePath(targetWorkspaceName, projectName, targetMuxHome);
    const sourceContent = "# source plan\n";

    const sourceState = createRuntimeState(sourceMuxHome, {
      [sourcePath]: sourceContent,
      // If this is read instead of sourcePath, this assertion would fail.
      [legacyPath]: "# legacy plan\n",
    });
    const targetState = createRuntimeState(targetMuxHome);

    await copyPlanFileAcrossRuntimes(
      createMockRuntime(sourceState),
      createMockRuntime(targetState),
      sourceWorkspaceName,
      sourceWorkspaceId,
      targetWorkspaceName,
      projectName
    );

    expect(sourceState.readAttempts).toEqual([sourcePath]);
    expect(sourceState.writes).toEqual([]);
    expect(targetState.readAttempts).toEqual([]);
    expect(targetState.writes).toEqual([{ path: targetPath, content: sourceContent }]);
    expect(targetState.files.get(targetPath)).toBe(sourceContent);
  });

  it("falls back to legacy source path when the new source path is missing", async () => {
    const sourcePath = getPlanFilePath(sourceWorkspaceName, projectName, sourceMuxHome);
    const legacyPath = getLegacyPlanFilePath(sourceWorkspaceId);
    const targetPath = getPlanFilePath(targetWorkspaceName, projectName, targetMuxHome);
    const legacyContent = "# legacy plan\n";

    const sourceState = createRuntimeState(sourceMuxHome, {
      [legacyPath]: legacyContent,
    });
    const targetState = createRuntimeState(targetMuxHome);

    await copyPlanFileAcrossRuntimes(
      createMockRuntime(sourceState),
      createMockRuntime(targetState),
      sourceWorkspaceName,
      sourceWorkspaceId,
      targetWorkspaceName,
      projectName
    );

    expect(sourceState.readAttempts).toEqual([sourcePath, legacyPath]);
    expect(targetState.writes).toEqual([{ path: targetPath, content: legacyContent }]);
    expect(targetState.files.get(targetPath)).toBe(legacyContent);
  });

  it("silently no-ops when source plan is missing at both new and legacy paths", async () => {
    const sourcePath = getPlanFilePath(sourceWorkspaceName, projectName, sourceMuxHome);
    const legacyPath = getLegacyPlanFilePath(sourceWorkspaceId);
    const targetPath = getPlanFilePath(targetWorkspaceName, projectName, targetMuxHome);

    const sourceState = createRuntimeState(sourceMuxHome);
    const targetState = createRuntimeState(targetMuxHome);

    await copyPlanFileAcrossRuntimes(
      createMockRuntime(sourceState),
      createMockRuntime(targetState),
      sourceWorkspaceName,
      sourceWorkspaceId,
      targetWorkspaceName,
      projectName
    );

    expect(sourceState.readAttempts).toEqual([sourcePath, legacyPath]);
    expect(targetState.writes).toEqual([]);
    expect(targetState.files.has(targetPath)).toBe(false);
  });
});

describe("readPlanFile", () => {
  it("resolves paths before building the quoted migration command", async () => {
    const workspaceName = "workspace-a1b2";
    const projectName = "demo-project";
    const workspaceId = "legacy-workspace-id";
    const muxHome = "~/.mux";
    const legacyContent = "# legacy plan\n";

    const planPath = getPlanFilePath(workspaceName, projectName, muxHome);
    const legacyPath = getLegacyPlanFilePath(workspaceId);
    const planDir = planPath.substring(0, planPath.lastIndexOf("/"));

    const resolvedPlanPath = "/home/dev/.mux/plans/demo-project/workspace-a1b2.md";
    const resolvedPlanDir = "/home/dev/.mux/plans/demo-project";
    const resolvedLegacyPath = "/home/dev/.mux/plans/legacy-workspace-id.md";

    const state = createRuntimeState(muxHome, {
      [legacyPath]: legacyContent,
    });

    state.resolvedPaths.set(planPath, resolvedPlanPath);
    state.resolvedPaths.set(planDir, resolvedPlanDir);
    state.resolvedPaths.set(legacyPath, resolvedLegacyPath);

    const result = await readPlanFile(
      createMockRuntime(state),
      workspaceName,
      projectName,
      workspaceId
    );

    expect(result).toEqual({
      content: legacyContent,
      exists: true,
      path: resolvedPlanPath,
    });
    expect(state.readAttempts).toEqual([planPath, legacyPath]);
    expect(state.execCalls).toHaveLength(1);
    expect(state.execCalls[0]?.command).toBe(
      `mkdir -p ${shellQuote(resolvedPlanDir)} && mv ${shellQuote(resolvedLegacyPath)} ${shellQuote(resolvedPlanPath)}`
    );
    expect(state.execCalls[0]?.options).toMatchObject({ cwd: "/tmp", timeout: 5 });
    expect(state.execCalls[0]?.command.includes("'~")).toBe(false);
  });
});

describe("movePlanFile", () => {
  it("uses resolved absolute paths when constructing the mv command", async () => {
    const oldWorkspaceName = "old-workspace";
    const newWorkspaceName = "new-workspace";
    const projectName = "demo-project";
    const muxHome = "~/.mux";

    const oldPath = getPlanFilePath(oldWorkspaceName, projectName, muxHome);
    const newPath = getPlanFilePath(newWorkspaceName, projectName, muxHome);
    const resolvedOldPath = "/home/dev/.mux/plans/demo-project/old-workspace.md";
    const resolvedNewPath = "/home/dev/.mux/plans/demo-project/new-workspace.md";

    const state = createRuntimeState(muxHome, {
      [oldPath]: "# old plan\n",
    });

    state.resolvedPaths.set(oldPath, resolvedOldPath);
    state.resolvedPaths.set(newPath, resolvedNewPath);

    await movePlanFile(createMockRuntime(state), oldWorkspaceName, newWorkspaceName, projectName);

    expect(state.execCalls).toHaveLength(1);
    expect(state.execCalls[0]?.command).toBe(
      `mv ${shellQuote(resolvedOldPath)} ${shellQuote(resolvedNewPath)}`
    );
    expect(state.execCalls[0]?.options).toMatchObject({ cwd: "/tmp", timeout: 5 });
  });
});
