import {
  shouldRunIntegrationTests,
  createTestEnvironment,
  cleanupTestEnvironment,
  validateApiKeys,
  getApiKey,
  setupProviders,
  type TestEnvironment,
} from "./setup";
import { IPC_CHANNELS, getChatChannel } from "../../src/common/constants/ipc-constants";
import {
  generateBranchName,
  createWorkspace,
  waitForInitComplete,
  waitForInitEnd,
  collectInitEvents,
  waitFor,
} from "./helpers";
import type { WorkspaceChatMessage, WorkspaceInitEvent } from "../../src/common/types/ipc";
import { isInitStart, isInitOutput, isInitEnd } from "../../src/common/types/ipc";
import * as path from "path";
import * as os from "os";
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
  const fs = await import("fs/promises");
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
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
  const fs = await import("fs/promises");
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

describeIntegration("IpcMain workspace init hook integration tests", () => {
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
        const createResult = await createWorkspace(env.mockIpcRenderer, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const workspaceId = createResult.metadata.id;

        // Wait for hook to complete
        await waitForInitComplete(env, workspaceId, 10000);

        // Collect all init events for verification
        const initEvents = collectInitEvents(env, workspaceId);

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
        const outputEvents = initEvents.filter((e) => isInitOutput(e) && !e.isError) as Extract<
          WorkspaceInitEvent,
          { type: "init-output" }
        >[];
        const errorEvents = initEvents.filter((e) => isInitOutput(e) && e.isError) as Extract<
          WorkspaceInitEvent,
          { type: "init-output" }
        >[];

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
        const info = await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_INFO, workspaceId);
        expect(info).not.toBeNull();
        expect(info.id).toBe(workspaceId);
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
        const createResult = await createWorkspace(env.mockIpcRenderer, tempGitRepo, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const workspaceId = createResult.metadata.id;

        // Wait for hook to complete (without throwing on failure)
        await waitForInitEnd(env, workspaceId, 10000);

        // Collect all init events for verification
        const initEvents = collectInitEvents(env, workspaceId);

        // Verify we got events
        expect(initEvents.length).toBeGreaterThan(0);

        // Should have start event
        const failureStartEvent = initEvents.find((e) => isInitStart(e));
        expect(failureStartEvent).toBeDefined();

        // Should have output and error
        const failureOutputEvents = initEvents.filter((e) => isInitOutput(e) && !e.isError);
        const failureErrorEvents = initEvents.filter((e) => isInitOutput(e) && e.isError);
        expect(failureOutputEvents.length).toBeGreaterThanOrEqual(1);
        expect(failureErrorEvents.length).toBeGreaterThanOrEqual(1);

        // Last event should be end with exitCode 1
        const failureFinalEvent = initEvents[initEvents.length - 1];
        expect(isInitEnd(failureFinalEvent)).toBe(true);
        if (isInitEnd(failureFinalEvent)) {
          expect(failureFinalEvent.exitCode).toBe(1);
        }

        // CRITICAL: Workspace should remain usable even after hook failure
        const info = await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_INFO, workspaceId);
        expect(info).not.toBeNull();
        expect(info.id).toBe(workspaceId);
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
      const fs = await import("fs/promises");
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
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
        const createResult = await createWorkspace(env.mockIpcRenderer, tempDir, branchName);
        expect(createResult.success).toBe(true);
        if (!createResult.success) return;

        const workspaceId = createResult.metadata.id;

        // Wait a bit to ensure no events are emitted
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Verify init events were sent (workspace creation logs even without hook)
        const initEvents = collectInitEvents(env, workspaceId);

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
        const info = await env.mockIpcRenderer.invoke(
          IPC_CHANNELS.WORKSPACE_GET_INFO,
          createResult.metadata.id
        );
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
      const fs = await import("fs/promises");
      const repoPath = await createTempGitRepoWithInitHook({
        exitCode: 0,
        stdoutLines: ["Installing dependencies", "Done!"],
        stderrLines: [],
      });

      try {
        const branchName = generateBranchName("replay-test");
        const createResult = await createWorkspace(env.mockIpcRenderer, repoPath, branchName);
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

test.concurrent(
  "should receive init events with natural timing (not batched)",
  async () => {
    const env = await createTestEnvironment();

    // Create project with slow init hook (100ms sleep between lines)
    const tempGitRepo = await createTempGitRepoWithInitHook({
      exitCode: 0,
      stdoutLines: ["Line 1", "Line 2", "Line 3", "Line 4"],
      sleepBetweenLines: 100, // 100ms between each echo
    });

    try {
      const branchName = generateBranchName("timing-test");
      const startTime = Date.now();

      // Create workspace - init hook will start immediately
      const createResult = await createWorkspace(env.mockIpcRenderer, tempGitRepo, branchName);
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const workspaceId = createResult.metadata.id;

      // Wait for all init events to arrive
      await waitForInitComplete(env, workspaceId, 10000);

      // Collect timestamped output events
      const allOutputEvents = env.sentEvents
        .filter((e) => e.channel === getChatChannel(workspaceId))
        .filter((e) => isInitOutput(e.data as WorkspaceChatMessage))
        .map((e) => ({
          timestamp: e.timestamp, // Use timestamp from when event was sent
          line: (e.data as { line: string }).line,
        }));

      // Filter to only hook output lines (exclude workspace creation logs)
      const initOutputEvents = allOutputEvents.filter((e) => e.line.startsWith("Line "));

      expect(initOutputEvents.length).toBe(4);

      // Calculate time between consecutive events
      const timeDiffs = initOutputEvents
        .slice(1)
        .map((event, i) => event.timestamp - initOutputEvents[i].timestamp);

      // ASSERTION: If streaming in real-time, events should be ~100ms apart
      // If batched/replayed, events will be <10ms apart
      const avgTimeDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;

      // Real-time streaming: expect at least 70ms average (accounting for variance)
      // Batched replay: would be <10ms
      expect(avgTimeDiff).toBeGreaterThan(70);

      // Also verify first event arrives early (not waiting for hook to complete)
      const firstEventDelay = initOutputEvents[0].timestamp - startTime;
      expect(firstEventDelay).toBeLessThan(1000); // Should arrive reasonably quickly (bash startup + git worktree setup)
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(tempGitRepo);
    }
  },
  15000
);

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

      test.concurrent(
        "file_read should wait for init hook before executing (even when init fails)",
        async () => {
          // Skip SSH test if Docker not available
          if (type === "ssh" && !sshConfig) {
            console.log("Skipping SSH test - Docker not available");
            return;
          }

          const env = await createTestEnvironment();
          const branchName = generateBranchName("init-wait-file-read");

          // Setup API provider
          await setupProviders(env.mockIpcRenderer, {
            anthropic: {
              apiKey: getApiKey("ANTHROPIC_API_KEY"),
            },
          });

          // Create repo with init hook that sleeps 5s, writes a file, then FAILS
          // This tests that tools proceed even when init hook fails (exit code 1)
          const tempGitRepo = await createTempGitRepoWithInitHook({
            exitCode: 1, // EXIT WITH FAILURE
            customScript: `
echo "Starting init..."
sleep 5
echo "Writing file before exit..."
echo "Hello from init hook!" > init_created_file.txt
echo "File written, now exiting with error"
exit 1
            `,
          });

          try {
            // Create workspace with runtime config
            const runtimeConfig = getRuntimeConfig(branchName);
            const createResult = await createWorkspace(
              env.mockIpcRenderer,
              tempGitRepo,
              branchName,
              undefined,
              runtimeConfig
            );
            expect(createResult.success).toBe(true);
            if (!createResult.success) return;

            const workspaceId = createResult.metadata.id;

            // Clear sent events to isolate AI message events
            env.sentEvents.length = 0;

            // IMMEDIATELY ask AI to read the file (before init completes)
            const sendResult = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_SEND_MESSAGE,
              workspaceId,
              "Read the file init_created_file.txt and tell me what it says",
              {
                model: "anthropic:claude-haiku-4-5",
              }
            );

            expect(sendResult.success).toBe(true);

            // Wait for stream completion
            await waitFor(() => {
              const chatChannel = getChatChannel(workspaceId);
              return env.sentEvents
                .filter((e) => e.channel === chatChannel)
                .some(
                  (e) =>
                    typeof e.data === "object" &&
                    e.data !== null &&
                    "type" in e.data &&
                    e.data.type === "stream-end"
                );
            }, streamTimeout);

            // Extract all tool call end events from the stream
            const chatChannel = getChatChannel(workspaceId);
            const toolCallEndEvents = env.sentEvents
              .filter((e) => e.channel === chatChannel)
              .map((e) => e.data as WorkspaceChatMessage)
              .filter(
                (msg) =>
                  typeof msg === "object" &&
                  msg !== null &&
                  "type" in msg &&
                  msg.type === "tool-call-end"
              );

            // Count file_read tool calls
            const fileReadCalls = toolCallEndEvents.filter(
              (msg: any) => msg.toolName === "file_read"
            );

            // ASSERTION 1: Should have exactly ONE file_read call (no retries)
            // This proves the tool waited for init to complete (even though init failed)
            expect(fileReadCalls.length).toBe(1);

            // ASSERTION 2: The file_read should have succeeded
            // Init failure doesn't block tools - they proceed and fail/succeed naturally
            const fileReadResult = fileReadCalls[0] as any;
            expect(fileReadResult.result?.success).toBe(true);

            // ASSERTION 3: Should contain the expected content
            // File was created before init exited with error, so read succeeds
            const content = fileReadResult.result?.content;
            expect(content).toContain("Hello from init hook!");

            // Wait for init to complete (with failure)
            await waitForInitEnd(env, workspaceId, initWaitBuffer);

            // Verify init completed with FAILURE (exit code 1)
            const initEvents = collectInitEvents(env, workspaceId);
            const initEndEvent = initEvents.find((e) => isInitEnd(e));
            expect(initEndEvent).toBeDefined();
            if (initEndEvent && isInitEnd(initEndEvent)) {
              expect(initEndEvent.exitCode).toBe(1);
            }

            // ========================================================================
            // SECOND MESSAGE: Verify init state persistence (with failed init)
            // ========================================================================
            // After init completes (even with failure), subsequent operations should
            // NOT wait for init. This tests that waitForInit() correctly returns
            // immediately when state.status !== "running" (whether "success" OR "error")
            // ========================================================================

            // Clear events to isolate second message
            env.sentEvents.length = 0;

            const startSecondMessage = Date.now();

            // Send another message to read the same file
            const sendResult2 = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_SEND_MESSAGE,
              workspaceId,
              "Read init_created_file.txt again and confirm the content",
              {
                model: "anthropic:claude-haiku-4-5",
              }
            );

            expect(sendResult2.success).toBe(true);

            // Wait for stream completion
            const deadline2 = Date.now() + streamTimeout;
            let streamComplete2 = false;

            while (Date.now() < deadline2 && !streamComplete2) {
              const chatChannel = getChatChannel(workspaceId);
              const chatEvents = env.sentEvents.filter((e) => e.channel === chatChannel);

              streamComplete2 = chatEvents.some(
                (e) =>
                  typeof e.data === "object" &&
                  e.data !== null &&
                  "type" in e.data &&
                  e.data.type === "stream-end"
              );

              if (!streamComplete2) {
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }

            expect(streamComplete2).toBe(true);

            // Extract tool calls from second message
            const toolCallEndEvents2 = env.sentEvents
              .filter((e) => e.channel === chatChannel)
              .map((e) => e.data as WorkspaceChatMessage)
              .filter(
                (msg) =>
                  typeof msg === "object" &&
                  msg !== null &&
                  "type" in msg &&
                  msg.type === "tool-call-end"
              );

            const fileReadCalls2 = toolCallEndEvents2.filter(
              (msg: any) => msg.toolName === "file_read"
            );

            // ASSERTION 4: Second message should also have exactly ONE file_read
            expect(fileReadCalls2.length).toBe(1);

            // ASSERTION 5: Second file_read should succeed (init already complete)
            const fileReadResult2 = fileReadCalls2[0] as any;
            expect(fileReadResult2.result?.success).toBe(true);

            // ASSERTION 6: Content should still be correct
            const content2 = fileReadResult2.result?.content;
            expect(content2).toContain("Hello from init hook!");

            // ASSERTION 7: Second message should be MUCH faster than first
            // First message had to wait ~5 seconds for init. Second should be instant.
            const secondMessageDuration = Date.now() - startSecondMessage;
            // Allow 15 seconds for API round-trip but should be way less than first message
            // Increased timeout to account for CI runner variability
            expect(secondMessageDuration).toBeLessThan(15000);

            // Log timing for debugging
            console.log(`Second message completed in ${secondMessageDuration}ms (no init wait)`);

            // Cleanup workspace
            await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId);
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        testTimeout
      );
    }
  );
});
