import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGitWithCredentialLadder } from "./credentials";

async function withPath<T>(binDir: string, run: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    return await run();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, "utf-8");
  await fs.chmod(filePath, 0o755);
}

describe("runGitWithCredentialLadder", () => {
  let tempDir: string;
  let binDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-credentials-"));
    binDir = path.join(tempDir, "bin");
    logPath = path.join(tempDir, "git.log");
    await fs.mkdir(binDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("uses an authenticated gh helper before ambient credentials", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
printf '%s\n' "$@" > "$GIT_LOG"
printf 'prompt=%s,%s,%s\n' "$GIT_TERMINAL_PROMPT" "$GH_PROMPT_DISABLED" "$GCM_INTERACTIVE" >> "$GIT_LOG"
`
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "https://github.com/example/repo.git"], {
        repoUrl: "https://github.com/example/repo.git",
        env: {
          GIT_LOG: logPath,
          GIT_TERMINAL_PROMPT: "1",
          GH_PROMPT_DISABLED: "0",
          GCM_INTERACTIVE: "always",
        },
      })
    );

    expect(result.credential).toBe("gh");
    const log = await fs.readFile(logPath, "utf-8");
    expect(log).toContain("credential.helper=\n");
    expect(log).toContain("credential.helper=!gh auth git-credential");
    expect(log).toContain("prompt=0,1,never");
  });

  it("passes an explicit token through env and never argv", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
printf '%s\n' "$@" > "$GIT_LOG"
printf 'token=%s\n' "$MUX_BACKUP_TOKEN" >> "$GIT_LOG"
`
    );
    const token = "github_pat_this-token-must-not-be-in-argv";

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "https://example.com/repo.git"], {
        repoUrl: "https://example.com/repo.git",
        token,
        env: { GIT_LOG: logPath },
      })
    );

    expect(result.credential).toBe("token");
    const log = await fs.readFile(logPath, "utf-8");
    const [argv = "", envLine = ""] = log.split("token=");
    expect(argv).toContain("password=$MUX_BACKUP_TOKEN");
    expect(argv).not.toContain(token);
    expect(envLine.trim()).toBe(token);
  });

  it("retries authentication failures without controlled credential overrides", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
printf '%s\n' '---' >> "$GIT_LOG"
printf '%s\n' "$@" >> "$GIT_LOG"
case "$*" in
  *credential.helper*) echo 'Authentication failed' >&2; exit 1 ;;
esac
`
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["fetch", "origin"], {
        repoUrl: "https://example.com/repo.git",
        token: "test-token",
        env: { GIT_LOG: logPath },
      })
    );

    expect(result.credential).toBe("ambient");
    const attempts = (await fs.readFile(logPath, "utf-8")).split("---\n").filter(Boolean);
    expect(attempts).toHaveLength(2);
    const first = attempts[0];
    const second = attempts[1];
    if (first === undefined || second === undefined) throw new Error("Expected two git attempts");
    expect(first).toContain("credential.helper=");
    expect(second).toBe("fetch\norigin\n");
  });

  it("makes SSH controlled attempts non-interactive", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
printf '%s\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"
`
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
        repoUrl: "git@example.com:owner/repo.git",
        env: { GIT_LOG: logPath },
      })
    );

    expect(result.credential).toBe("ssh");
    expect((await fs.readFile(logPath, "utf-8")).trim()).toBe("ssh -o BatchMode=yes");
  });
});
