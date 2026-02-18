import { describe, expect, it } from "bun:test";
import type { Runtime } from "@/node/runtime/Runtime";
import { getLegacyPlanFilePath, getPlanFilePath } from "@/common/utils/planStorage";
import { copyPlanFileAcrossRuntimes } from "./helpers";

interface MockRuntimeState {
  muxHome: string;
  files: Map<string, string>;
  readAttempts: string[];
  writes: Array<{ path: string; content: string }>;
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
