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
      // The ambient rung reads core.sshCommand unless GIT_SSH_COMMAND is already set, so this
      // answers that probe the way git does for an unset key: non-zero, and not an attempt.
      `#!/bin/sh
case "$*" in
  *core.sshCommand*) exit 1 ;;
esac
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
      // The ambient rung reads core.sshCommand unless GIT_SSH_COMMAND is already set, so this
      // answers that probe the way git does for an unset key: non-zero, and not an attempt.
      `#!/bin/sh
case "$*" in
  *core.sshCommand*) exit 1 ;;
esac
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
    expect((await fs.readFile(logPath, "utf-8")).trim().split("\n")).toHaveLength(1);
  });

  it("reports a stalled remote when the timeout kills git without a diagnostic", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    // A blackholed remote emits no diagnostic, so timeout classification must key on `signal`.
    // `exec sleep` prevents an orphaned child from keeping the stdio pipes open after that signal.
    await writeExecutable(path.join(binDir, "git"), "#!/bin/sh\nexec sleep 30\n");

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["ls-remote", "https://blackhole.example/repo.git"], {
          repoUrl: "https://blackhole.example/repo.git",
          token: "test-token",
          timeoutMs: 250,
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackupRemoteUnreachableError);
  });

  it("blames the local cache when git cannot write FETCH_HEAD", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
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

  it("extends a wrapper configured in core.sshCommand rather than replacing it", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "config" ]; then',
        "  printf '/opt/wrapper/ssh -i /keys/id\\n'",
        "  exit 0",
        "fi",
        `printf '%s\\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"`,
        "",
      ].join("\n")
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
        repoUrl: "git@example.com:owner/repo.git",
        // Empty rather than absent, so an ambient GIT_SSH_COMMAND cannot win. GIT_SSH is
        // set to prove git config outranks it.
        env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "", GIT_SSH: "/opt/ignored/ssh" },
      })
    );

    expect(result.credential).toBe("ssh");
    expect((await fs.readFile(logPath, "utf-8")).trim()).toBe(
      "/opt/wrapper/ssh -i /keys/id -o BatchMode=yes"
    );
  });

  it("extends a GIT_SSH program, quoting it into the command line", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "config" ]; then',
        "  exit 1",
        "fi",
        `printf '%s\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"`,
        "",
      ].join("\n")
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
        repoUrl: "git@example.com:owner/repo.git",
        env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "", GIT_SSH: "/opt/wrap dir/ssh" },
      })
    );

    expect(result.credential).toBe("ssh");
    // git executes GIT_SSH directly, so its path survives becoming a command line only
    // when quoted. Unquoted, a shell would read `dir/ssh` as the first argument.
    expect((await fs.readFile(logPath, "utf-8")).trim()).toBe(
      "'/opt/wrap dir/ssh' -o BatchMode=yes"
    );
  });

  it("uses the flag the configured ssh client accepts, or none at all", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "config" ]; then',
        "  exit 1",
        "fi",
        `printf '%s\\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"`,
        "",
      ].join("\n")
    );

    async function commandFor(env: Record<string, string>): Promise<string> {
      await fs.rm(logPath, { force: true });
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
          repoUrl: "git@example.com:owner/repo.git",
          env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "", ...env },
        })
      );
      return (await fs.readFile(logPath, "utf-8")).trim();
    }

    // PuTTY spells the option differently, and appending OpenSSH's would make plink reject
    // its own arguments.
    expect(await commandFor({ GIT_SSH: "/c/PuTTY/plink.exe" })).toBe("'/c/PuTTY/plink.exe' -batch");
    expect(await commandFor({ GIT_SSH_VARIANT: "tortoiseplink", GIT_SSH: "/c/tp" })).toBe(
      "'/c/tp' -batch"
    );
    // An unrecognised client takes no option: git passes it none either, and a wrong one
    // would break a wrapper that works today. The command is left exactly as configured.
    expect(await commandFor({ GIT_SSH_COMMAND: "/opt/coder/coder gitssh --" })).toBe(
      "/opt/coder/coder gitssh --"
    );
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
