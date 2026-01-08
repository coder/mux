/**
 * Smoke integration test for `mux run` CLI.
 *
 * Runs `mux run` with a real AI model to verify the end-to-end CLI flow works.
 * Uses a simple, deterministic prompt with thinking off for fast, reliable tests.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { shouldRunIntegrationTests, validateApiKeys } from "../testUtils";

const RUN_PATH = path.resolve(__dirname, "../../src/cli/run.ts");

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

interface ExecResult {
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number;
}

/**
 * Run `mux run` CLI with the given arguments.
 * Returns combined stdout/stderr and exit code.
 */
async function runMuxRun(
  args: string[],
  options: { timeoutMs?: number; cwd?: string; muxRoot?: string } = {}
): Promise<ExecResult> {
  const { timeoutMs = 60000, cwd, muxRoot } = options;

  return new Promise((resolve) => {
    const proc = spawn("bun", [RUN_PATH, ...args], {
      timeout: timeoutMs,
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        // Isolate config to avoid reading user's providers.jsonc
        ...(muxRoot ? { MUX_ROOT: muxRoot } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Close stdin immediately
    proc.stdin?.end();

    proc.on("close", (code) => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: code ?? 1 });
    });

    proc.on("error", () => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: 1 });
    });
  });
}

describeIntegration("mux run smoke tests", () => {
  let testDir: string;
  let muxRoot: string;

  beforeAll(async () => {
    // Create a temporary directory for tests
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-run-smoke-"));
    // Create isolated MUX_ROOT to avoid reading user's providers.jsonc
    muxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-root-smoke-"));

    // Initialize a git repo (mux run requires a git repo)
    const { execSync } = await import("child_process");
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: testDir, stdio: "pipe" });
    execSync("git config user.name 'Test'", { cwd: testDir, stdio: "pipe" });

    // Create a simple file and commit it
    await fs.writeFile(path.join(testDir, "README.md"), "# Test Project\n");
    execSync("git add .", { cwd: testDir, stdio: "pipe" });
    execSync("git commit -m 'Initial commit'", { cwd: testDir, stdio: "pipe" });
  });

  afterAll(async () => {
    // Clean up test directories
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
    if (muxRoot) {
      await fs.rm(muxRoot, { recursive: true, force: true });
    }
  });

  test("simple echo prompt completes successfully", async () => {
    // Use claude-haiku for speed, thinking off for determinism
    const result = await runMuxRun(
      [
        "--dir",
        testDir,
        "--model",
        "anthropic:claude-haiku-4-5",
        "--thinking",
        "off",
        "Say exactly 'HELLO_MUX_TEST' and nothing else. Do not use any tools.",
      ],
      { timeoutMs: 45000, muxRoot }
    );

    // Should exit successfully
    expect(result.exitCode).toBe(0);

    // Should contain our expected response somewhere in the output
    expect(result.output).toContain("HELLO_MUX_TEST");
  }, 60000);

  test("file creation with bash tool", async () => {
    const testFileName = `test-${Date.now()}.txt`;
    const testContent = "mux-run-integration-test";

    const result = await runMuxRun(
      [
        "--dir",
        testDir,
        "--model",
        "anthropic:claude-haiku-4-5",
        "--thinking",
        "off",
        `Create a file called "${testFileName}" with the content "${testContent}" using the bash tool. Do not explain, just create the file.`,
      ],
      { timeoutMs: 45000, muxRoot }
    );

    // Should exit successfully
    expect(result.exitCode).toBe(0);

    // Verify the file was created
    const filePath = path.join(testDir, testFileName);
    const fileExists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(true);

    if (fileExists) {
      const content = await fs.readFile(filePath, "utf-8");
      expect(content.trim()).toBe(testContent);
    }
  }, 60000);
});
