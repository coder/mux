import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  resolveCoderAgentMount,
  resolveGitdirMount,
  resolveHostCredentialEnv,
} from "./credentialForwarding";

describe("resolveGitdirMount", () => {
  const tempDirs: string[] = [];

  async function createTempDir(prefix: string): Promise<string> {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fsPromises.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("returns a bind mount for worktree gitdir parent .git", async () => {
    const workspacePath = await createTempDir("mux-worktree-ws-");
    const projectPath = await createTempDir("mux-worktree-project-");
    const gitdirPath = path.join(projectPath, ".git", "worktrees", "mybranch");
    const dotGitDir = path.join(projectPath, ".git");

    await fsPromises.mkdir(gitdirPath, { recursive: true });
    await fsPromises.writeFile(
      path.join(workspacePath, ".git"),
      `gitdir: ${gitdirPath}\n`,
      "utf-8"
    );

    expect(resolveGitdirMount(workspacePath)).toEqual({
      source: dotGitDir,
      target: dotGitDir,
    });
  });

  it("returns null when .git is a directory", async () => {
    const workspacePath = await createTempDir("mux-repo-");

    await fsPromises.mkdir(path.join(workspacePath, ".git"));

    expect(resolveGitdirMount(workspacePath)).toBeNull();
  });

  it("returns null when .git does not exist", async () => {
    const workspacePath = await createTempDir("mux-no-git-");

    expect(resolveGitdirMount(workspacePath)).toBeNull();
  });

  it("returns null when gitdir path does not match worktrees layout", async () => {
    const workspacePath = await createTempDir("mux-random-gitdir-");

    await fsPromises.writeFile(
      path.join(workspacePath, ".git"),
      "gitdir: /some/random/path\n",
      "utf-8"
    );

    expect(resolveGitdirMount(workspacePath)).toBeNull();
  });
});

describe("resolveHostCredentialEnv", () => {
  const trackedEnvKeys = [
    "GIT_ASKPASS",
    "CODER_AGENT_TOKEN",
    "GIT_SSH_COMMAND",
    "MUX_TEST_UNRELATED_ENV",
  ] as const;

  let originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    originalValues = new Map(trackedEnvKeys.map((key) => [key, process.env[key]]));
    process.env.GIT_ASKPASS = "/usr/bin/coder";
    process.env.CODER_AGENT_TOKEN = "tok123";
    process.env.MUX_TEST_UNRELATED_ENV = "ignore-me";
  });

  afterEach(() => {
    for (const key of trackedEnvKeys) {
      const value = originalValues.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("includes matching credential variables and excludes unrelated keys", () => {
    const env = resolveHostCredentialEnv();

    expect(env).toMatchObject({
      GIT_ASKPASS: "/usr/bin/coder",
      CODER_AGENT_TOKEN: "tok123",
    });
    expect(env).not.toHaveProperty("HOME");
    expect(env).not.toHaveProperty("PATH");
    expect(env).not.toHaveProperty("MUX_TEST_UNRELATED_ENV");
  });

  it("excludes empty string values", () => {
    process.env.GIT_SSH_COMMAND = "";

    const env = resolveHostCredentialEnv();

    expect(env).not.toHaveProperty("GIT_SSH_COMMAND");
  });
});

describe("resolveCoderAgentMount", () => {
  afterEach(() => {
    mock.restore();
  });

  it("returns null when /.coder-agent does not exist", () => {
    spyOn(fs, "existsSync").mockReturnValue(false);

    expect(resolveCoderAgentMount()).toBeNull();
  });

  it("returns a bind mount when /.coder-agent exists", () => {
    spyOn(fs, "existsSync").mockImplementation(
      (candidatePath) => String(candidatePath) === "/.coder-agent"
    );

    expect(resolveCoderAgentMount()).toEqual({
      source: "/.coder-agent",
      target: "/.coder-agent",
    });
  });
});
