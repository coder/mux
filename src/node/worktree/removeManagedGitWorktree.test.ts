import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as disposableExec from "@/node/utils/disposableExec";
import { GIT_NO_HOOKS_ENV } from "@/node/utils/gitNoHooksEnv";
import { removeManagedGitWorktree } from "./removeManagedGitWorktree";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

function createMockExecResult(
  result: Promise<{ stdout: string; stderr: string }>
): ReturnType<typeof disposableExec.execFileAsync> {
  void result.catch(noop);
  return {
    result,
    get promise() {
      return result;
    },
    child: {},
    [Symbol.dispose]: noop,
  } as unknown as ReturnType<typeof disposableExec.execFileAsync>;
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fs.promises
    .access(targetPath)
    .then(() => true)
    .catch(() => false);
}

describe("removeManagedGitWorktree", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    mock.restore();

    await Promise.all(
      tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true }))
    );
  });

  async function createTempRoot(): Promise<string> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mux-remove-managed-worktree-"));
    tempDirs.push(tempRoot);
    return tempRoot;
  }

  it("falls back to recursive removal when git rejects a multi-project container path", async () => {
    const tempRoot = await createTempRoot();
    const projectPath = path.join(tempRoot, "project");
    const worktreePath = path.join(tempRoot, "_workspaces", "workspace-name");
    const nestedCheckoutPath = path.join(worktreePath, "project-a");
    await mkdir(nestedCheckoutPath, { recursive: true });
    await writeFile(path.join(nestedCheckoutPath, "README.md"), "nested checkout");

    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
      (file, args, options) => {
        expect(file).toBe("git");
        expect(options).toEqual({ env: GIT_NO_HOOKS_ENV });

        if (args[3] === "remove") {
          expect(args).toEqual(["-C", projectPath, "worktree", "remove", "--force", worktreePath]);
          return createMockExecResult(Promise.reject(new Error("fatal: not a working tree")));
        }

        expect(args).toEqual(["-C", projectPath, "worktree", "prune"]);
        return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
      }
    );

    await removeManagedGitWorktree(projectPath, worktreePath);

    expect(execFileAsyncSpy).toHaveBeenCalledTimes(2);
    expect(await pathExists(worktreePath)).toBe(false);
  });
});
