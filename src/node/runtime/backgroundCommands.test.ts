import { describe, it, expect } from "bun:test";
import {
  shellQuote,
  buildWrapperScript,
  buildSpawnCommand,
  buildTerminateCommand,
  parseExitCode,
  EXIT_CODE_SIGKILL,
  EXIT_CODE_SIGTERM,
  parsePidPgid,
} from "./backgroundCommands";

describe("backgroundCommands", () => {
  describe("shellQuote", () => {
    it("should quote empty string", () => {
      expect(shellQuote("")).toBe("''");
    });

    it("should quote simple string", () => {
      expect(shellQuote("hello")).toBe("'hello'");
    });

    it("should escape single quotes", () => {
      expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
    });

    it("should handle multiple single quotes", () => {
      expect(shellQuote("it's a 'test'")).toBe("'it'\"'\"'s a '\"'\"'test'\"'\"''");
    });

    it("should handle special characters without escaping", () => {
      // Single quotes protect everything except single quotes themselves
      expect(shellQuote("$HOME")).toBe("'$HOME'");
      expect(shellQuote("a && b")).toBe("'a && b'");
      expect(shellQuote("foo\nbar")).toBe("'foo\nbar'");
    });

    it("should handle paths with spaces", () => {
      expect(shellQuote("/path/with spaces/file")).toBe("'/path/with spaces/file'");
    });
  });

  describe("buildWrapperScript", () => {
    it("should build script with trap, cd, and user script", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/exit_code",
        cwd: "/home/user/project",
        script: "echo hello",
      });

      expect(result).toBe(
        "trap 'echo $? > '/tmp/exit_code'' EXIT && " + "cd '/home/user/project' && " + "echo hello"
      );
    });

    it("should include env exports when provided", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/exit_code",
        cwd: "/home/user",
        env: { FOO: "bar", BAZ: "qux" },
        script: "env",
      });

      expect(result).toContain("export FOO='bar'");
      expect(result).toContain("export BAZ='qux'");
    });

    it("should handle paths with spaces", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/my dir/exit_code",
        cwd: "/home/user/my project",
        script: "ls",
      });

      expect(result).toContain("'/tmp/my dir/exit_code'");
      expect(result).toContain("'/home/user/my project'");
    });

    it("should escape single quotes in env values", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/exit_code",
        cwd: "/home",
        env: { MSG: "it's a test" },
        script: "echo $MSG",
      });

      expect(result).toContain("export MSG='it'\"'\"'s a test'");
    });

    it("should join parts with &&", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/ec",
        cwd: "/",
        script: "true",
      });

      // Should have trap && cd && script
      const parts = result.split(" && ");
      expect(parts.length).toBe(3);
      expect(parts[0]).toMatch(/^trap/);
      expect(parts[1]).toMatch(/^cd/);
      expect(parts[2]).toBe("true");
    });
  });

  describe("buildSpawnCommand", () => {
    it("should use set -m and nohup pattern", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo hello",
        stdoutPath: "/tmp/stdout.log",
        stderrPath: "/tmp/stderr.log",
      });

      // set -m enables job control for process group isolation
      // bash path is quoted to handle paths with spaces (e.g., Windows Git Bash)
      expect(result).toMatch(/^\(set -m; nohup 'bash' -c /);
    });

    it("should include niceness prefix when provided", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo hello",
        stdoutPath: "/tmp/stdout.log",
        stderrPath: "/tmp/stderr.log",
        niceness: 10,
      });

      expect(result).toMatch(/^\(set -m; nice -n 10 nohup/);
    });

    it("should not include niceness prefix when not provided", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo hello",
        stdoutPath: "/tmp/stdout.log",
        stderrPath: "/tmp/stderr.log",
      });

      expect(result).not.toContain("nice");
    });

    it("should use custom bash path when provided", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo hello",
        stdoutPath: "/tmp/stdout.log",
        stderrPath: "/tmp/stderr.log",
        bashPath: "/usr/local/bin/bash",
      });

      // bash path is quoted
      expect(result).toContain("'/usr/local/bin/bash' -c");
    });

    it("should handle bash path with spaces (Windows Git Bash)", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo hello",
        stdoutPath: "/tmp/stdout.log",
        stderrPath: "/tmp/stderr.log",
        bashPath: "/c/Program Files/Git/bin/bash.exe",
      });

      // Path with spaces must be quoted to work correctly
      expect(result).toContain("'/c/Program Files/Git/bin/bash.exe' -c");
    });

    it("should redirect stdout and stderr", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo hello",
        stdoutPath: "/tmp/out.log",
        stderrPath: "/tmp/err.log",
      });

      expect(result).toContain("> '/tmp/out.log'");
      expect(result).toContain("2> '/tmp/err.log'");
    });

    it("should redirect stdin from /dev/null", () => {
      const result = buildSpawnCommand({
        wrapperScript: "cat",
        stdoutPath: "/tmp/out",
        stderrPath: "/tmp/err",
      });

      expect(result).toContain("< /dev/null");
    });

    it("should use set -m for process group isolation and PGID lookup", () => {
      const result = buildSpawnCommand({
        wrapperScript: "sleep 60",
        stdoutPath: "/tmp/out",
        stderrPath: "/tmp/err",
      });

      // set -m enables job control so backgrounded process gets its own PGID
      expect(result).toMatch(/^\(set -m;/);
      // PGID lookup for verification: ps → /proc → PID
      expect(result).toContain("PGID=$(ps -o pgid= -p $! 2>/dev/null | tr -d ' ')");
      expect(result).toContain("PGID=$(cat /proc/$!/pgid 2>/dev/null)");
      expect(result).toContain("PGID=$!");
      expect(result).toContain('echo "$! $PGID")');
      expect(result).not.toContain("setsid");
    });

    it("should quote the wrapper script", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo 'hello world'",
        stdoutPath: "/tmp/out",
        stderrPath: "/tmp/err",
      });

      // The wrapper script should be quoted
      expect(result).toContain("-c 'echo '\"'\"'hello world'\"'\"''");
    });
  });

  describe("buildTerminateCommand", () => {
    it("should use negative PID for process group", () => {
      const result = buildTerminateCommand(1234, "/tmp/exit_code");

      expect(result).toContain("kill -15 -1234");
      expect(result).toContain("kill -9 -1234");
    });

    it("should check process status with positive PID", () => {
      const result = buildTerminateCommand(1234, "/tmp/exit_code");

      // kill -0 checks if process exists (uses positive PID)
      expect(result).toContain("kill -0 1234");
    });

    it("should include SIGTERM then SIGKILL pattern", () => {
      const result = buildTerminateCommand(1234, "/tmp/exit_code");

      // Should send TERM first
      expect(result).toMatch(/kill -15.*sleep 2.*kill -9/);
    });

    it("should write exit code 137 on force kill", () => {
      const result = buildTerminateCommand(1234, "/tmp/exit_code");

      expect(result).toContain("echo 137 > '/tmp/exit_code'");
    });

    it("should suppress errors with 2>/dev/null", () => {
      const result = buildTerminateCommand(1234, "/tmp/exit_code");

      // Both kill commands should suppress errors
      expect(result).toMatch(/kill -15 -1234 2>\/dev\/null/);
      expect(result).toMatch(/kill -9 -1234 2>\/dev\/null/);
    });

    it("should continue on error with || true", () => {
      const result = buildTerminateCommand(1234, "/tmp/exit_code");

      expect(result).toContain("|| true");
    });

    it("should quote exit code path", () => {
      const result = buildTerminateCommand(1234, "/tmp/my dir/exit_code");

      expect(result).toContain("'/tmp/my dir/exit_code'");
    });

    it("should use custom quotePath function when provided", () => {
      // Simulate expandTildeForSSH behavior (returns double-quoted string)
      const customQuote = (p: string) => `"${p}"`;
      const result = buildTerminateCommand(1234, "/tmp/exit_code", customQuote);

      expect(result).toContain('"/tmp/exit_code"');
      expect(result).not.toContain("'/tmp/exit_code'");
    });

    it("should handle tilde paths with custom quotePath", () => {
      // Simulate expandTildeForSSH("~/mux/exit_code") → "$HOME/mux/exit_code"
      const expandTilde = (p: string) => (p.startsWith("~/") ? `"$HOME/${p.slice(2)}"` : `"${p}"`);
      const result = buildTerminateCommand(1234, "~/mux/exit_code", expandTilde);

      expect(result).toContain('"$HOME/mux/exit_code"');
    });
  });

  describe("parseExitCode", () => {
    it("should parse valid exit code", () => {
      expect(parseExitCode("0")).toBe(0);
      expect(parseExitCode("1")).toBe(1);
      expect(parseExitCode("137")).toBe(137);
    });

    it("should handle whitespace", () => {
      expect(parseExitCode("  0  ")).toBe(0);
      expect(parseExitCode("137\n")).toBe(137);
      expect(parseExitCode("\t42\t")).toBe(42);
    });

    it("should return null for empty string", () => {
      expect(parseExitCode("")).toBeNull();
      expect(parseExitCode("   ")).toBeNull();
    });

    it("should return null for non-numeric input", () => {
      expect(parseExitCode("abc")).toBeNull();
    });

    it("should parse leading numbers (parseInt behavior)", () => {
      // parseInt("12abc", 10) returns 12 - this is standard JS behavior
      expect(parseExitCode("12abc")).toBe(12);
    });
  });

  describe("exit code constants", () => {
    it("should have correct SIGKILL exit code", () => {
      expect(EXIT_CODE_SIGKILL).toBe(137); // 128 + 9
    });

    it("should have correct SIGTERM exit code", () => {
      expect(EXIT_CODE_SIGTERM).toBe(143); // 128 + 15
    });
  });

  // Windows/MSYS2 path handling tests
  // These verify that POSIX-converted paths work correctly in shell commands
  describe("Windows POSIX path handling", () => {
    describe("buildWrapperScript with POSIX-converted paths", () => {
      it("works with POSIX-style paths from toPosixPath", () => {
        // Simulates paths after toPosixPath conversion on Windows:
        // C:\Users\test\exit_code → /c/Users/test/exit_code
        const result = buildWrapperScript({
          exitCodePath: "/c/Users/test/bg-123/exit_code",
          cwd: "/c/Projects/myapp",
          script: "npm start",
        });

        expect(result).toContain("cd '/c/Projects/myapp'");
        expect(result).toContain("'/c/Users/test/bg-123/exit_code'");
      });

      it("handles POSIX paths with spaces (Program Files)", () => {
        const result = buildWrapperScript({
          exitCodePath: "/c/Program Files/mux/exit_code",
          cwd: "/c/Program Files/project",
          script: "node server.js",
        });

        expect(result).toContain("cd '/c/Program Files/project'");
        expect(result).toContain("'/c/Program Files/mux/exit_code'");
      });
    });

    describe("buildSpawnCommand with POSIX-converted paths", () => {
      it("works with POSIX-style paths for redirection", () => {
        const result = buildSpawnCommand({
          wrapperScript: "echo test",
          stdoutPath: "/c/temp/mux-bashes/stdout.log",
          stderrPath: "/c/temp/mux-bashes/stderr.log",
        });

        expect(result).toContain("> '/c/temp/mux-bashes/stdout.log'");
        expect(result).toContain("2> '/c/temp/mux-bashes/stderr.log'");
      });

      it("handles paths with spaces in POSIX format", () => {
        const result = buildSpawnCommand({
          wrapperScript: "echo test",
          stdoutPath: "/c/Users/John Doe/AppData/Local/Temp/mux-bashes/stdout.log",
          stderrPath: "/c/Users/John Doe/AppData/Local/Temp/mux-bashes/stderr.log",
        });

        expect(result).toContain("'/c/Users/John Doe/AppData/Local/Temp/mux-bashes/stdout.log'");
        expect(result).toContain("'/c/Users/John Doe/AppData/Local/Temp/mux-bashes/stderr.log'");
      });

      it("handles quoted bash path with spaces (Git Bash default location)", () => {
        const result = buildSpawnCommand({
          wrapperScript: "echo test",
          stdoutPath: "/c/temp/stdout.log",
          stderrPath: "/c/temp/stderr.log",
          bashPath: "/c/Program Files/Git/bin/bash.exe",
        });

        // Bash path should be quoted
        expect(result).toContain("'/c/Program Files/Git/bin/bash.exe'");
      });
    });

    describe("buildTerminateCommand with POSIX paths", () => {
      it("works with POSIX-style exit code path", () => {
        const result = buildTerminateCommand(1234, "/c/temp/mux-bashes/bg-abc/exit_code");

        expect(result).toContain("'/c/temp/mux-bashes/bg-abc/exit_code'");
      });
    });
  });
});

describe("parsePidPgid", () => {
  it("should parse valid PID and PGID", () => {
    expect(parsePidPgid("1234 5678")).toEqual({ pid: 1234, pgid: 5678 });
  });

  it("should handle whitespace variations", () => {
    expect(parsePidPgid("  1234   5678  ")).toEqual({ pid: 1234, pgid: 5678 });
    expect(parsePidPgid("1234\t5678")).toEqual({ pid: 1234, pgid: 5678 });
  });

  it("should return null for invalid PID", () => {
    expect(parsePidPgid("abc 5678")).toBeNull();
    expect(parsePidPgid("-1 5678")).toBeNull();
    expect(parsePidPgid("0 5678")).toBeNull();
  });

  it("should fall back PGID to PID if PGID is invalid", () => {
    expect(parsePidPgid("1234")).toEqual({ pid: 1234, pgid: 1234 });
    expect(parsePidPgid("1234 abc")).toEqual({ pid: 1234, pgid: 1234 });
  });

  it("should return null for empty string", () => {
    expect(parsePidPgid("")).toBeNull();
    expect(parsePidPgid("   ")).toBeNull();
  });
});
