import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  BackupAuthFailedError,
  BackupRemoteUnreachableError,
  isGitHubRepoUrl,
  runGitWithCredentialLadder,
} from "./credentials";

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

  it("recognizes only GitHub hosts as eligible for a GitHub token", () => {
    expect(isGitHubRepoUrl("https://github.com/o/r.git")).toBe(true);
    expect(isGitHubRepoUrl("git@github.com:o/r.git")).toBe(true);
    expect(isGitHubRepoUrl("https://evil.example/o/r.git")).toBe(false);
    // A lookalike host must not match by suffix.
    expect(isGitHubRepoUrl("https://github.com.evil.example/o/r.git")).toBe(false);
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
    // Scoped to the repository's origin, so git cannot offer the token to another host.
    expect(argv).toContain("credential.https://example.com.helper=");
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

  it("tries the configured token when the gh account lacks access", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
printf '%s\\n' '---' >> "$GIT_LOG"
printf '%s\\n' "$@" >> "$GIT_LOG"
case "$*" in
  *gh\\ auth\\ git-credential*) echo 'remote: Permission to owner/repo.git denied' >&2; exit 128 ;;
esac
`
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["fetch", "origin"], {
        repoUrl: "https://github.com/owner/repo.git",
        token: "test-token",
        env: { GIT_LOG: logPath },
      })
    );

    // A logged-in gh account that cannot reach this repository must not make a configured
    // token unusable, so the token rung runs before ambient credentials.
    expect(result.credential).toBe("token");
    const attempts = (await fs.readFile(logPath, "utf-8")).split("---\n").filter(Boolean);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toContain("gh auth git-credential");
    expect(attempts[1]).toContain("credential.https://github.com.helper=");
  });

  it("reports an exhausted credential ladder as an authentication failure", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
echo 'fatal: Authentication failed for https://example.com/repo.git' >&2
exit 128
`
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["fetch", "origin"], {
          repoUrl: "https://example.com/repo.git",
          token: "test-token",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackupAuthFailedError);
    // The service maps any error it cannot classify to IO_ERROR, which would tell the
    // user their disk failed when their credential is what expired.
    expect((caught as BackupAuthFailedError).code).toBe("AUTH_FAILED");
  });

  it("treats a push denied by write permissions as an authentication failure", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
printf '%s\\n' '---' >> "$GIT_LOG"
printf '%s\\n' "$@" >> "$GIT_LOG"
echo 'remote: Permission to owner/repo.git denied to someone.' >&2
echo "fatal: unable to access 'https://example.com/repo.git/': The requested URL returned error: 403" >&2
exit 128
`
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["push", "origin", "HEAD:refs/heads/main"], {
          repoUrl: "https://example.com/repo.git",
          token: "test-token",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackupAuthFailedError);
    // A read-only credential passes validate and only fails here, so the ambient helper
    // still deserves a turn in case it is the one with write access.
    const attempts = (await fs.readFile(logPath, "utf-8")).split("---\n").filter(Boolean);
    expect(attempts).toHaveLength(2);
  });

  it("leaves a non-authentication ambient failure unclassified", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
case "$*" in
  *credential.helper*) echo 'Authentication failed' >&2; exit 1 ;;
esac
echo 'error: unable to write sha1 filename .git/objects/ab/cdef: Permission denied' >&2
exit 128
`
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["fetch", "origin"], {
          repoUrl: "https://example.com/repo.git",
          token: "test-token",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    // A local object-store write failure also says "Permission denied", so matching on
    // that phrase alone would blame the credential for a full or read-only disk.
    expect(caught).not.toBeInstanceOf(BackupAuthFailedError);
    expect((caught as Error).message).toContain("unable to write sha1 filename");
  });

  it("reports an unreachable remote instead of a local IO failure, and stops the ladder", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'printf "attempt\\n" >> "$GIT_LOG"',
        "echo \"fatal: unable to access 'https://nope.invalid/repo.git/': Could not resolve host: nope.invalid\" >&2",
        "exit 128",
        "",
      ].join("\n")
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["ls-remote", "https://nope.invalid/repo.git"], {
          repoUrl: "https://nope.invalid/repo.git",
          token: "test-token",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackupRemoteUnreachableError);
    expect((caught as BackupRemoteUnreachableError).code).toBe("REMOTE_UNREACHABLE");
    // Retrying an unreachable host on every remaining rung only delays the error.
    expect((await fs.readFile(logPath, "utf-8")).trim().split("\n")).toHaveLength(1);
  });

  it("blames the local cache when git cannot write FETCH_HEAD", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    // Git says "Permission denied" for a cache file it cannot write, which reads exactly like
    // a rejected credential. Retrying every rung and then telling the user to fix their
    // credentials sends them after the wrong problem.
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'printf "attempt\\n" >> "$GIT_LOG"',
        "echo \"error: cannot open '.git/FETCH_HEAD': Permission denied\" >&2",
        "exit 128",
        "",
      ].join("\n")
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["fetch", "origin"], {
          repoUrl: "https://example.com/repo.git",
          token: "test-token",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeInstanceOf(BackupAuthFailedError);
    expect((caught as Error).message).toContain("FETCH_HEAD");
    expect((await fs.readFile(logPath, "utf-8")).trim().split("\n")).toHaveLength(1);
  });

  it("blames a full disk rather than the network when a fetch reports both", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    // Writing objects while streaming means one failure can surface both diagnostics. The
    // local disk is the actionable cause, so it must win over the connection message.
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'echo "fatal: write error: No space left on device" >&2',
        'echo "fatal: connection reset by peer" >&2',
        "exit 128",
        "",
      ].join("\n")
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["fetch", "origin"], {
          repoUrl: "https://example.com/repo.git",
          token: "test-token",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeInstanceOf(BackupRemoteUnreachableError);
    expect((caught as Error).message).toContain("No space left on device");
  });

  it("keeps the ambient fallback non-interactive too", async () => {
    if (process.platform === "win32") return;
    // The controlled ssh rung fails authentication, so the ladder reaches ambient. Without
    // BatchMode there, ssh can sit waiting on a passphrase prompt nobody can answer.
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'if [ ! -f "$GIT_LOG" ]; then',
        `  printf 'controlled:%s\\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"`,
        "  echo 'Permission denied (publickey).' >&2",
        "  exit 128",
        "fi",
        `printf 'ambient:%s\\n' "$GIT_SSH_COMMAND" >> "$GIT_LOG"`,
        "",
      ].join("\n")
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
        repoUrl: "git@example.com:owner/repo.git",
        env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "ssh" },
      })
    );

    expect(result.credential).toBe("ambient");
    expect((await fs.readFile(logPath, "utf-8")).trim().split("\n")).toEqual([
      "controlled:ssh -o BatchMode=yes",
      "ambient:ssh -o BatchMode=yes",
    ]);
  });

  it("makes SSH attempts non-interactive without discarding an ssh wrapper", async () => {
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
        // Hosts such as Coder export their own ssh wrapper, and replacing it outright would
        // break the very key the wrapper exists to supply.
        env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "/opt/wrapper/ssh -i /keys/id" },
      })
    );

    expect(result.credential).toBe("ssh");
    expect((await fs.readFile(logPath, "utf-8")).trim()).toBe(
      "/opt/wrapper/ssh -i /keys/id -o BatchMode=yes"
    );
  });
});
