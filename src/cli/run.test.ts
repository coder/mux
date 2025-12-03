/**
 * Integration tests for `mux run` CLI command.
 *
 * These tests verify the CLI interface without actually running agent sessions.
 * They test argument parsing, help output, and error handling.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { spawn } from "child_process";
import * as path from "path";

const CLI_PATH = path.resolve(__dirname, "index.ts");
const RUN_PATH = path.resolve(__dirname, "run.ts");

interface ExecResult {
  stdout: string;
  stderr: string;
  output: string; // combined stdout + stderr
  exitCode: number;
}

async function runCli(args: string[], timeoutMs = 5000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn("bun", [CLI_PATH, ...args], {
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: "1" },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: code ?? 1 });
    });

    proc.on("error", () => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: 1 });
    });
  });
}

/**
 * Run run.ts directly with stdin closed to avoid hanging.
 * Passes empty stdin to simulate non-TTY invocation without input.
 */
async function runRunDirect(args: string[], timeoutMs = 5000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn("bun", [RUN_PATH, ...args], {
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Close stdin immediately to prevent hanging on stdin.read()
    proc.stdin?.end();

    proc.on("close", (code) => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: code ?? 1 });
    });

    proc.on("error", () => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: 1 });
    });
  });
}

describe("mux CLI", () => {
  beforeAll(() => {
    // Verify CLI files exist
    expect(Bun.file(CLI_PATH).size).toBeGreaterThan(0);
    expect(Bun.file(RUN_PATH).size).toBeGreaterThan(0);
  });

  describe("top-level", () => {
    test("--help shows usage", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: mux");
      expect(result.stdout).toContain("Mux - AI agent orchestration");
      expect(result.stdout).toContain("run");
      expect(result.stdout).toContain("server");
    });

    test("--version shows version info", async () => {
      const result = await runCli(["--version"]);
      expect(result.exitCode).toBe(0);
      // Version format: vX.Y.Z-N-gHASH (HASH)
      expect(result.stdout).toMatch(/v\d+\.\d+\.\d+/);
    });

    test("unknown command shows error", async () => {
      const result = await runCli(["nonexistent"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown command");
    });
  });

  describe("mux run", () => {
    test("--help shows all options", async () => {
      const result = await runCli(["run", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: mux run");
      expect(result.stdout).toContain("--dir");
      expect(result.stdout).toContain("--model");
      expect(result.stdout).toContain("--runtime");
      expect(result.stdout).toContain("--mode");
      expect(result.stdout).toContain("--thinking");
      expect(result.stdout).toContain("--timeout");
      expect(result.stdout).toContain("--json");
      expect(result.stdout).toContain("--quiet");
      expect(result.stdout).toContain("--workspace-id");
      expect(result.stdout).toContain("--config-root");
    });

    test("shows default model as opus", async () => {
      const result = await runCli(["run", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("anthropic:claude-opus-4-5");
    });

    test("no message shows error", async () => {
      const result = await runRunDirect([]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("No message provided");
    });

    test("invalid thinking level shows error", async () => {
      const result = await runRunDirect(["--thinking", "extreme", "test message"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid thinking level");
    });

    test("invalid mode shows error", async () => {
      const result = await runRunDirect(["--mode", "chaos", "test message"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid mode");
    });

    test("invalid timeout shows error", async () => {
      const result = await runRunDirect(["--timeout", "abc", "test message"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid timeout");
    });

    test("nonexistent directory shows error", async () => {
      const result = await runRunDirect([
        "--dir",
        "/nonexistent/path/that/does/not/exist",
        "test message",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.output.length).toBeGreaterThan(0);
    });
  });

  describe("mux server", () => {
    test("--help shows all options", async () => {
      const result = await runCli(["server", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: mux server");
      expect(result.stdout).toContain("--host");
      expect(result.stdout).toContain("--port");
      expect(result.stdout).toContain("--auth-token");
      expect(result.stdout).toContain("--add-project");
    });
  });
});
