import { describe, it, expect } from "bun:test";
import {
  shellQuote,
  buildWrapperScript,
  buildSpawnCommand,
  buildTerminateCommand,
  parseExitCode,
  parsePid,
} from "./backgroundCommands";

describe("backgroundCommands", () => {
  describe("shellQuote", () => {
    it("quotes empty string", () => {
      expect(shellQuote("")).toBe("''");
    });

    it("quotes simple strings and paths", () => {
      expect(shellQuote("hello")).toBe("'hello'");
      expect(shellQuote("/path/with spaces/file")).toBe("'/path/with spaces/file'");
    });

    it("escapes single quotes", () => {
      expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
      expect(shellQuote("it's a 'test'")).toBe("'it'\"'\"'s a '\"'\"'test'\"'\"''");
    });

    it("preserves special characters inside quotes", () => {
      expect(shellQuote("$HOME")).toBe("'$HOME'");
      expect(shellQuote("a && b")).toBe("'a && b'");
      expect(shellQuote("foo\nbar")).toBe("'foo\nbar'");
    });
  });

  describe("buildWrapperScript", () => {
    it("builds script with trap, cd, and user script joined by &&", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/exit_code",
        cwd: "/home/user/project",
        script: "echo hello",
      });

      expect(result).toBe(
        "trap 'echo $? > '/tmp/exit_code'' EXIT && cd '/home/user/project' && echo hello"
      );
    });

    it("includes env exports", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/exit_code",
        cwd: "/home/user",
        env: { FOO: "bar", BAZ: "qux" },
        script: "env",
      });

      expect(result).toContain("export FOO='bar'");
      expect(result).toContain("export BAZ='qux'");
    });

    it("quotes paths with spaces", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/my dir/exit_code",
        cwd: "/home/user/my project",
        script: "ls",
      });

      expect(result).toContain("'/tmp/my dir/exit_code'");
      expect(result).toContain("'/home/user/my project'");
    });

    it("escapes single quotes in env values", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/exit_code",
        cwd: "/home",
        env: { MSG: "it's a test" },
        script: "echo $MSG",
      });

      expect(result).toContain("export MSG='it'\"'\"'s a test'");
    });
  });

  describe("buildSpawnCommand", () => {
    it("uses set -m, nohup, redirections, and echoes PID", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo hello",
        stdoutPath: "/tmp/out.log",
        stderrPath: "/tmp/err.log",
      });

      expect(result).toMatch(/^\(set -m; nohup 'bash' -c /);
      expect(result).toContain("> '/tmp/out.log'");
      expect(result).toContain("2> '/tmp/err.log'");
      expect(result).toContain("< /dev/null");
      expect(result).toContain("& echo $!)");
    });

    it("includes niceness prefix when provided", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo hello",
        stdoutPath: "/tmp/out",
        stderrPath: "/tmp/err",
        niceness: 10,
      });

      expect(result).toMatch(/^\(set -m; nice -n 10 nohup/);
    });

    it("uses custom bash path (including paths with spaces)", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo hello",
        stdoutPath: "/tmp/out",
        stderrPath: "/tmp/err",
        bashPath: "/c/Program Files/Git/bin/bash.exe",
      });

      expect(result).toContain("'/c/Program Files/Git/bin/bash.exe' -c");
    });

    it("quotes the wrapper script", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo 'hello world'",
        stdoutPath: "/tmp/out",
        stderrPath: "/tmp/err",
      });

      expect(result).toContain("-c 'echo '\"'\"'hello world'\"'\"''");
    });
  });

  describe("buildTerminateCommand", () => {
    it("sends SIGTERM then SIGKILL to process group using negative PID", () => {
      const result = buildTerminateCommand(1234, "/tmp/exit_code");

      expect(result).toContain("kill -15 -1234 2>/dev/null || true");
      expect(result).toContain("sleep 2");
      expect(result).toContain("kill -0 -1234");
      expect(result).toContain("kill -9 -1234 2>/dev/null || true");
      expect(result).toContain("echo 137 >"); // SIGKILL exit code
      expect(result).toContain("echo 143 >"); // SIGTERM exit code (written after process exits)
    });

    it("quotes exit code path with spaces", () => {
      const result = buildTerminateCommand(1234, "/tmp/my dir/exit_code");

      expect(result).toContain("'/tmp/my dir/exit_code'");
    });

    it("uses custom quotePath function for SSH tilde expansion", () => {
      const expandTilde = (p: string) => (p.startsWith("~/") ? `"$HOME/${p.slice(2)}"` : `"${p}"`);
      const result = buildTerminateCommand(1234, "~/mux/exit_code", expandTilde);

      expect(result).toContain('"$HOME/mux/exit_code"');
    });
  });

  describe("parseExitCode", () => {
    it("parses valid exit codes with whitespace", () => {
      expect(parseExitCode("0")).toBe(0);
      expect(parseExitCode("  137\n")).toBe(137);
      expect(parseExitCode("\t42\t")).toBe(42);
    });

    it("returns null for empty or non-numeric input", () => {
      expect(parseExitCode("")).toBeNull();
      expect(parseExitCode("   ")).toBeNull();
      expect(parseExitCode("abc")).toBeNull();
    });
  });

  describe("parsePid", () => {
    it("parses valid PID with whitespace", () => {
      expect(parsePid("1234")).toBe(1234);
      expect(parsePid("  1234\n")).toBe(1234);
    });

    it("returns null for invalid input", () => {
      expect(parsePid("")).toBeNull();
      expect(parsePid("   ")).toBeNull();
      expect(parsePid("abc")).toBeNull();
      expect(parsePid("-1")).toBeNull();
      expect(parsePid("0")).toBeNull();
    });
  });
});
