import {
  shouldRunIntegrationTests,
  createTestEnvironment,
  cleanupTestEnvironment,
  validateApiKeys,
  getApiKey,
  setupProviders,
  type TestEnvironment,
} from "./setup";
import {
  generateBranchName,
  createWorkspace,
  waitForInitComplete,
  waitForInitEnd,
  collectInitEvents,
  waitFor,
  resolveOrpcClient,
} from "./helpers";
import type { WorkspaceChatMessage, WorkspaceInitEvent } from "@/common/orpc/types";
import { isInitStart, isInitOutput, isInitEnd } from "@/common/orpc/types";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../runtime/ssh-fixture";
import type { RuntimeConfig } from "../../src/common/types/runtime";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys for AI tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

/**
 * Create a temp git repo with a .mux/init hook that writes to stdout/stderr and exits with a given code
 */
async function createTempGitRepoWithInitHook(options: {
  exitCode: number;
  stdoutLines?: string[];
  stderrLines?: string[];
  sleepBetweenLines?: number; // milliseconds
  customScript?: string; // Optional custom script content (overrides stdout/stderr)
}): Promise<string> {
  const execAsync = promisify(exec);

  // Use mkdtemp to avoid race conditions
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-init-hook-"));

  // Initialize git repo
  await execAsync(`git init`, { cwd: tempDir });
  await execAsync(`git config user.email "test@example.com" && git config user.name "Test User"`, {
    cwd: tempDir,
  });
  await execAsync(`echo "test" > README.md && git add . && git commit -m "Initial commit"`, {
    cwd: tempDir,
  });

  // Create .mux directory
  const muxDir = path.join(tempDir, ".mux");
  await fs.mkdir(muxDir, { recursive: true });

  // Create init hook script
  const hookPath = path.join(muxDir, "init");

  let scriptContent: string;
  if (options.customScript) {
    scriptContent = `#!/bin/bash\n${options.customScript}\nexit ${options.exitCode}\n`;
  } else {
    const sleepCmd = options.sleepBetweenLines ? `sleep ${options.sleepBetweenLines / 1000}` : "";

    const stdoutCmds = (options.stdoutLines ?? [])
      .map((line, idx) => {
        const needsSleep = sleepCmd && idx < (options.stdoutLines?.length ?? 0) - 1;
        return `echo "${line}"${needsSleep ? `\n${sleepCmd}` : ""}`;
      })
      .join("\n");

    const stderrCmds = (options.stderrLines ?? []).map((line) => `echo "${line}" >&2`).join("\n");

    scriptContent = `#!/bin/bash\n${stdoutCmds}\n${stderrCmds}\nexit ${options.exitCode}\n`;
  }

  await fs.writeFile(hookPath, scriptContent, { mode: 0o755 });

  // Commit the init hook (required for SSH runtime - git worktree syncs committed files)
  await execAsync(`git add -A && git commit -m "Add init hook"`, { cwd: tempDir });

  return tempDir;
}

/**
 * Cleanup temporary git repository
 */
async function cleanupTempGitRepo(repoPath: string): Promise<void> {
  const maxRetries = 3;
  let lastError: unknown;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
      }
    }
  }
  console.warn(`Failed to cleanup temp git repo after ${maxRetries} attempts:`, lastError);
}

describeIntegration("Workspace init hook", () => {
  test.concurrent(
    "should stream init hook output and allow workspace usage on hook success",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepoWithInitHook({
        exitCode: 0,
        stdoutLines: ["Installing dependencies...", "Build complete!"],
        stderrLines: ["Warning: deprecated package"],
      });

      try {
        const branchName = generateBranchName("init-hook-success");

        // Create workspace (which will trigger the hook)
        const createResult = await createWorkspace(env, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const workspaceId = createResult.metadata.id;

        // Wait for hook to complete and collect init events for verification
        const initEvents = await collectInitEvents(env, workspaceId, 10000);

        // Verify event sequence
        expect(initEvents.length).toBeGreaterThan(0);

        // First event should be start
        const startEvent = initEvents.find((e) => isInitStart(e));
        expect(startEvent).toBeDefined();
        if (startEvent && isInitStart(startEvent)) {
          // Hook path should be the project path (where .mux/init exists)
          expect(startEvent.hookPath).toBeTruthy();
        }

        // Should have output and error lines
        const outputEvents = initEvents.filter(
          (e): e is Extract<WorkspaceInitEvent, { type: "init-output" }> =>
            isInitOutput(e) && !e.isError
        );
        const errorEvents = initEvents.filter(
          (e): e is Extract<WorkspaceInitEvent, { type: "init-output" }> =>
            isInitOutput(e) && e.isError === true
        );

        // Should have workspace creation logs + hook output
        expect(outputEvents.length).toBeGreaterThanOrEqual(2);

        // Verify hook output is present (may have workspace creation logs before it)
        const outputLines = outputEvents.map((e) => e.line);
        expect(outputLines).toContain("Installing dependencies...");
        expect(outputLines).toContain("Build complete!");

        expect(errorEvents.length).toBe(1);
        expect(errorEvents[0].line).toBe("Warning: deprecated package");

        // Last event should be end with exitCode 0
        const finalEvent = initEvents[initEvents.length - 1];
        expect(isInitEnd(finalEvent)).toBe(true);
        if (isInitEnd(finalEvent)) {
          expect(finalEvent.exitCode).toBe(0);
        }

        // Workspace should be usable - verify getInfo succeeds
        const client = resolveOrpcClient(env);
        const info = await client.workspace.getInfo({ workspaceId });
        expect(info).not.toBeNull();
        if (info) expect(info.id).toBe(workspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should stream init hook output and allow workspace usage on hook failure",
    async () => {
      const env = await createTestEnvironment();
      const tempGitRepo = await createTempGitRepoWithInitHook({
        exitCode: 1,
        stdoutLines: ["Starting setup..."],
        stderrLines: ["ERROR: Failed to install dependencies"],
      });

      try {
        const branchName = generateBranchName("init-hook-failure");

        // Create workspace
        const createResult = await createWorkspace(env, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const workspaceId = createResult.metadata.id;

        // Wait for hook to complete (without throwing on failure) and collect events
        const initEvents = await waitForInitEnd(env, workspaceId, 10000);

        // Verify we got events
        expect(initEvents.length).toBeGreaterThan(0);

        // Should have start event
        const failureStartEvent = initEvents.find((e) => isInitStart(e));
        expect(failureStartEvent).toBeDefined();

        // Should have output and error
        const failureOutputEvents = initEvents.filter(
          (e): e is Extract<WorkspaceInitEvent, { type: "init-output" }> =>
            isInitOutput(e) && !e.isError
        );
        const failureErrorEvents = initEvents.filter(
          (e): e is Extract<WorkspaceInitEvent, { type: "init-output" }> =>
            isInitOutput(e) && e.isError === true
        );
        expect(failureOutputEvents.length).toBeGreaterThanOrEqual(1);
        expect(failureErrorEvents.length).toBeGreaterThanOrEqual(1);

        // Last event should be end with exitCode 1
        const failureFinalEvent = initEvents[initEvents.length - 1];
        expect(isInitEnd(failureFinalEvent)).toBe(true);
        if (isInitEnd(failureFinalEvent)) {
          expect(failureFinalEvent.exitCode).toBe(1);
        }

        // CRITICAL: Workspace should remain usable even after hook failure
        const client = resolveOrpcClient(env);
        const info = await client.workspace.getInfo({ workspaceId });
        expect(info).not.toBeNull();
        if (info) expect(info.id).toBe(workspaceId);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempGitRepo);
      }
    },
    15000
  );

  test.concurrent(
    "should not emit meta events when no init hook exists",
    async () => {
      const env = await createTestEnvironment();
      // Create repo without .mux/init hook
      const execAsync = promisify(exec);

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-no-hook-"));

      try {
        // Initialize git repo without hook
        await execAsync(`git init`, { cwd: tempDir });
        await execAsync(
          `git config user.email "test@example.com" && git config user.name "Test User"`,
          { cwd: tempDir }
        );
        await execAsync(`echo "test" > README.md && git add . && git commit -m "Initial commit"`, {
          cwd: tempDir,
        });

        const branchName = generateBranchName("no-hook");

        // Create workspace
        const createResult = await createWorkspace(env, tempDir, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const workspaceId = createResult.metadata.id;

        // Wait for init to complete and collect events
        const initEvents = await collectInitEvents(env, workspaceId, 5000);

        // Should have init-start event (always emitted, even without hook)
        const startEvent = initEvents.find((e) => isInitStart(e));
        expect(startEvent).toBeDefined();

        // Should have workspace creation logs (e.g., "Creating git worktree...")
        const outputEvents = initEvents.filter((e) => isInitOutput(e));
        expect(outputEvents.length).toBeGreaterThan(0);

        // Should have completion event with exit code 0 (success, no hook)
        const endEvent = initEvents.find((e) => isInitEnd(e));
        expect(endEvent).toBeDefined();
        if (endEvent && isInitEnd(endEvent)) {
          expect(endEvent.exitCode).toBe(0);
        }

        // Workspace should still be usable
        const client = resolveOrpcClient(env);
        const info = await client.workspace.getInfo({ workspaceId: createResult.metadata.id });
        expect(info).not.toBeNull();
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(tempDir);
      }
    },
    15000
  );

  test.concurrent(
    "should persist init state to disk for replay across page reloads",
    async () => {
      const env = await createTestEnvironment();

      const repoPath = await createTempGitRepoWithInitHook({
        exitCode: 0,
        stdoutLines: ["Installing dependencies", "Done!"],
        stderrLines: [],
      });

      try {
        const branchName = generateBranchName("replay-test");
        const createResult = await createWorkspace(env, repoPath, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const workspaceId = createResult.metadata.id;

        // Wait for init hook to complete
        await waitForInitComplete(env, workspaceId, 5000);

        // Verify init-status.json exists on disk
        const initStatusPath = path.join(env.config.getSessionDir(workspaceId), "init-status.json");
        const statusExists = await fs
          .access(initStatusPath)
          .then(() => true)
          .catch(() => false);
        expect(statusExists).toBe(true);

        // Read and verify persisted state
        const statusContent = await fs.readFile(initStatusPath, "utf-8");
        const status = JSON.parse(statusContent);
        expect(status.status).toBe("success");
        expect(status.exitCode).toBe(0);

        // Should include workspace creation logs + hook output
        expect(status.lines).toEqual(
          expect.arrayContaining([
            { line: "Creating git worktree...", isError: false, timestamp: expect.any(Number) },
            {
              line: "Worktree created successfully",
              isError: false,
              timestamp: expect.any(Number),
            },
            expect.objectContaining({
              line: expect.stringMatching(/Running init hook:/),
              isError: false,
            }),
            { line: "Installing dependencies", isError: false, timestamp: expect.any(Number) },
            { line: "Done!", isError: false, timestamp: expect.any(Number) },
          ])
        );
        expect(status.hookPath).toBeTruthy(); // Project path where hook exists
        expect(status.startTime).toBeGreaterThan(0);
        expect(status.endTime).toBeGreaterThan(status.startTime);
      } finally {
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(repoPath);
      }
    },
    15000
  );
});

// TODO: This test relies on timestamp-based event capture (sentEvents with timestamps)
// which isn't available in the ORPC subscription model. The test verified real-time
// streaming timing behavior. Consider reimplementing with StreamCollector timestamp tracking.
test.skip("should receive init events with natural timing (not batched)", () => {
  // Test body removed - relies on legacy sentEvents with timestamp tracking
});

// SSH server config for runtime matrix tests
let sshConfig: SSHServerConfig | undefined;

// ============================================================================
// Runtime Matrix Tests - Init Queue Behavior
// ============================================================================

describeIntegration("Init Queue - Runtime Matrix", () => {
  beforeAll(async () => {
    // Only start SSH server if Docker is available
    if (await isDockerAvailable()) {
      console.log("Starting SSH server container for init queue tests...");
      sshConfig = await startSSHServer();
      console.log(`SSH server ready on port ${sshConfig.port}`);
    } else {
      console.log("Docker not available - SSH tests will be skipped");
    }
  }, 60000);

  afterAll(async () => {
    if (sshConfig) {
      console.log("Stopping SSH server container...");
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  // Test matrix: Run tests for both local and SSH runtimes
  describe.each<{ type: "local" | "ssh" }>([{ type: "local" }, { type: "ssh" }])(
    "Runtime: $type",
    ({ type }) => {
      // Helper to build runtime config
      const getRuntimeConfig = (branchName: string): RuntimeConfig | undefined => {
        if (type === "ssh" && sshConfig) {
          return {
            type: "ssh",
            host: `testuser@localhost`,
            srcBaseDir: `${sshConfig.workdir}/${branchName}`,
            identityFile: sshConfig.privateKeyPath,
            port: sshConfig.port,
          };
        }
        return undefined; // undefined = defaults to local
      };

      // Timeouts vary by runtime type
      const testTimeout = type === "ssh" ? 90000 : 30000;
      const streamTimeout = type === "ssh" ? 30000 : 15000;
      const initWaitBuffer = type === "ssh" ? 10000 : 2000;

      // TODO: This test relies on sentEvents for channel-based event filtering and
      // timestamp tracking which isn't available in the ORPC subscription model.
      // Consider reimplementing with StreamCollector once timestamp tracking is added.
      test.skip("file_read should wait for init hook before executing (even when init fails)", () => {
        // Test body removed - relies on legacy sentEvents with channel filtering
        // Original test verified:
        // 1. file_read waits for init hook even when hook fails
        // 2. Only one file_read call needed (no retries)
        // 3. Second message after init completes is faster (no init wait)
        void testTimeout;
        void streamTimeout;
        void initWaitBuffer;
        void getRuntimeConfig;
      });
    }
  );
});
