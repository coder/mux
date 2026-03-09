/**
 * Runtime interface contract tests
 *
 * Tests shared Runtime interface behavior (exec, readFile, writeFile, stat, etc.)
 * using a matrix of local (WorktreeRuntime) and SSH runtimes.
 *
 * SSH tests use a real Docker container (no mocking) for confidence.
 *
 * Note: Workspace management tests (renameWorkspace, deleteWorkspace) are colocated
 * with their runtime implementations:
 * - WorktreeManager: src/node/worktree/WorktreeManager.test.ts
 * - SSHRuntime: src/node/runtime/SSHRuntime.test.ts
 */

// Jest globals are available automatically - no need to import
import * as os from "os";
// shouldRunIntegrationTests checks TEST_INTEGRATION env var
function shouldRunIntegrationTests(): boolean {
  return process.env.TEST_INTEGRATION === "1" || process.env.TEST_INTEGRATION === "true";
}
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "./test-fixtures/ssh-fixture";
import {
  createTestRuntime,
  TestWorkspace,
  noopInitLogger,
  type RuntimeType,
} from "./test-fixtures/test-helpers";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import type { Runtime } from "@/node/runtime/Runtime";
import { RuntimeError } from "@/node/runtime/Runtime";
import { computeBaseRepoPath, type SSHRuntime } from "@/node/runtime/SSHRuntime";
import { createSSHTransport } from "@/node/runtime/transports";
import { runFullInit } from "@/node/runtime/runtimeFactory";
import { sshConnectionPool } from "@/node/runtime/sshConnectionPool";
import { ssh2ConnectionPool } from "@/node/runtime/SSH2ConnectionPool";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// SSH server config (shared across all tests)
let sshConfig: SSHServerConfig | undefined;

describeIntegration("Runtime integration tests", () => {
  beforeAll(async () => {
    // Check if Docker is available (required for SSH tests)
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for runtime integration tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    // Start SSH server (shared across all tests for speed)
    console.log("Starting SSH server container...");
    sshConfig = await startSSHServer();
    console.log(`SSH server ready on port ${sshConfig.port}`);
  }, 120000); // 120s timeout for Docker build/start operations

  afterAll(async () => {
    if (sshConfig) {
      console.log("Stopping SSH server container...");
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  // Reset SSH connection pool state before each test to prevent backoff from one
  // test affecting subsequent tests.
  beforeEach(() => {
    sshConnectionPool.clearAllHealth();
    ssh2ConnectionPool.clearAllHealth();
  });

  // Test matrix: Run all tests for local, SSH, and Docker runtimes
  describe.each<{ type: RuntimeType }>([{ type: "local" }, { type: "ssh" }, { type: "docker" }])(
    "Runtime: $type",
    ({ type }) => {
      // Helper to create runtime for this test type
      // Use a base working directory - TestWorkspace will create subdirectories as needed
      // For local runtime, use os.tmpdir() which matches where TestWorkspace creates directories
      const getBaseWorkdir = () => {
        if (type === "ssh") {
          return sshConfig!.workdir;
        }
        if (type === "docker") {
          return "/src";
        }
        return os.tmpdir();
      };

      // DockerRuntime is slower than local/ssh, and the integration job has a hard
      // time budget. Keep the Docker coverage focused on the core Runtime contract.
      //
      // NOTE: Avoid assigning `describe.skip` or `test.skip` to variables. Bun's Jest
      // compatibility can lose the skip semantics when these functions are detached.
      function describeIf(shouldRun: boolean) {
        return (...args: Parameters<typeof describe>) => {
          if (shouldRun) {
            describe(...args);
          } else {
            describe.skip(...args);
          }
        };
      }

      // Running these runtime contract tests with test.concurrent can easily overwhelm
      // the docker/ssh fixtures in CI and cause the overall integration job to hit its
      // 10-minute timeout. Keep runtime tests deterministic by running them sequentially
      // for remote runtimes.
      const testForRuntime = type === "local" ? test.concurrent : test;
      function testIf(shouldRun: boolean) {
        return (...args: Parameters<typeof test>) => {
          if (shouldRun) {
            testForRuntime(...args);
          } else {
            test.skip(...args);
          }
        };
      }

      const isRemote = type !== "local";

      const describeLocalOnly = describeIf(type === "local");
      const describeNonDocker = describeIf(type !== "docker");
      const testLocalOnly = testIf(!isRemote);
      const testDockerOnly = testIf(type === "docker");
      const createRuntime = (): Runtime =>
        createTestRuntime(
          type,
          getBaseWorkdir(),
          sshConfig,
          type === "docker"
            ? { image: "mux-ssh-test", containerName: sshConfig!.containerId }
            : undefined
        );

      describe("exec() - Command execution", () => {
        testForRuntime("captures stdout and stderr separately", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, 'echo "output" && echo "error" >&2', {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout.trim()).toBe("output");
          expect(result.stderr.trim()).toBe("error");
          expect(result.exitCode).toBe(0);
          expect(result.duration).toBeGreaterThan(0);
        });

        testForRuntime("returns correct exit code for failed commands", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "exit 42", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.exitCode).toBe(42);
        });

        testLocalOnly("handles stdin input", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "cat", {
            cwd: workspace.path,
            timeout: 30,
            stdin: "hello from stdin",
          });

          expect(result.stdout).toBe("hello from stdin");
          expect(result.exitCode).toBe(0);
        });

        testForRuntime("passes environment variables", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, 'echo "$TEST_VAR"', {
            cwd: workspace.path,
            timeout: 30,
            env: { TEST_VAR: "test-value" },
          });

          expect(result.stdout.trim()).toBe("test-value");
        });

        testForRuntime("sets NON_INTERACTIVE_ENV_VARS to prevent prompts", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Verify GIT_TERMINAL_PROMPT is set to 0 (prevents credential prompts)
          const result = await execBuffered(
            runtime,
            'echo "GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT GIT_EDITOR=$GIT_EDITOR"',
            { cwd: workspace.path, timeout: 30 }
          );

          expect(result.stdout).toContain("GIT_TERMINAL_PROMPT=0");
          expect(result.stdout).toContain("GIT_EDITOR=true");
        });

        testForRuntime("handles empty output", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "true", { cwd: workspace.path, timeout: 30 });

          expect(result.stdout).toBe("");
          expect(result.stderr).toBe("");
          expect(result.exitCode).toBe(0);
        });

        testLocalOnly("handles commands with quotes and special characters", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, 'echo "hello \\"world\\""', {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout.trim()).toBe('hello "world"');
        });

        testForRuntime("respects working directory", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "pwd", { cwd: workspace.path, timeout: 30 });

          expect(result.stdout.trim()).toContain(workspace.path);
        });
        testLocalOnly(
          "handles timeout correctly",
          async () => {
            const runtime = createRuntime();
            await using workspace = await TestWorkspace.create(runtime, type);

            // Command that sleeps longer than timeout
            const startTime = performance.now();
            const result = await execBuffered(runtime, "sleep 10", {
              cwd: workspace.path,
              timeout: 1, // 1 second timeout
            });
            const duration = performance.now() - startTime;

            // Exit code should be EXIT_CODE_TIMEOUT (-998)
            expect(result.exitCode).toBe(-998);
            // Should complete in around 1 second, not 10 seconds
            // Allow some margin for overhead (especially on SSH)
            expect(duration).toBeLessThan(3000); // 3 seconds max
            expect(duration).toBeGreaterThan(500); // At least 0.5 seconds
          },
          15000
        ); // 15 second timeout for test (includes workspace creation overhead)
      });

      describe("ensureReady() - Runtime readiness", () => {
        testForRuntime("returns ready for running runtime", async () => {
          const runtime = createRuntime();
          const result = await runtime.ensureReady();
          expect(result).toEqual({ ready: true });
        });

        testDockerOnly(
          "starts stopped container and returns ready",
          async () => {
            // Create a dedicated container for this test (not the shared SSH container)
            // so stopping it doesn't affect other tests
            const { execSync } = await import("child_process");
            const { DockerRuntime } = await import("@/node/runtime/DockerRuntime");
            const containerName = `mux-docker-ready-test-${Date.now()}`;

            // Start a fresh container (no --rm so we can stop/start it)
            execSync(`docker run -d --name ${containerName} mux-ssh-test sleep infinity`, {
              timeout: 60000,
            });

            try {
              // Stop the container
              execSync(`docker stop ${containerName}`, { timeout: 30000 });

              // Verify it's stopped
              const stoppedState = execSync(
                `docker inspect --format='{{.State.Running}}' ${containerName}`,
                { encoding: "utf-8", timeout: 10000 }
              );
              expect(stoppedState.trim()).toBe("false");

              // ensureReady() should start it
              const runtime = new DockerRuntime({
                image: "mux-ssh-test",
                containerName,
              });
              const result = await runtime.ensureReady();
              expect(result).toEqual({ ready: true });

              // Verify container is running again
              const inspectOutput = execSync(
                `docker inspect --format='{{.State.Running}}' ${containerName}`,
                { encoding: "utf-8", timeout: 10000 }
              );
              expect(inspectOutput.trim()).toBe("true");
            } finally {
              // Clean up: stop and remove the test container
              try {
                execSync(`docker rm -f ${containerName}`, { timeout: 30000 });
              } catch {
                // Ignore cleanup errors
              }
            }
          },
          90000
        );

        testDockerOnly("returns error for non-existent container", async () => {
          // Create a DockerRuntime pointing to a container that doesn't exist
          const { DockerRuntime } = await import("@/node/runtime/DockerRuntime");
          const runtime = new DockerRuntime({
            image: "ubuntu:22.04",
            containerName: "mux-nonexistent-container-12345",
          });

          const result = await runtime.ensureReady();
          expect(result.ready).toBe(false);
          if (!result.ready) {
            expect(result.error).toBeDefined();
          }
        });
      });

      describe("resolvePath() - Path resolution", () => {
        testForRuntime("expands ~ to the home directory", async () => {
          const runtime = createRuntime();

          const resolved = await runtime.resolvePath("~");

          if (type === "ssh") {
            expect(resolved).toBe("/home/testuser");
          } else if (type === "docker") {
            expect(resolved).toBe("/root");
          } else {
            expect(resolved).toBe(os.homedir());
          }
        });

        testForRuntime("expands ~/path by prefixing the home directory", async () => {
          const runtime = createRuntime();

          const home = await runtime.resolvePath("~");
          const resolved = await runtime.resolvePath("~/mux");

          expect(resolved).toBe(`${home}/mux`);
        });
      });

      describe("readFile() - File reading", () => {
        testForRuntime("reads file contents", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Write test file
          const testContent = "Hello, World!\nLine 2\nLine 3";
          await writeFileString(runtime, `${workspace.path}/test.txt`, testContent);

          // Read it back
          const content = await readFileString(runtime, `${workspace.path}/test.txt`);

          expect(content).toBe(testContent);
        });

        testForRuntime("reads empty file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Write empty file
          await writeFileString(runtime, `${workspace.path}/empty.txt`, "");

          // Read it back
          const content = await readFileString(runtime, `${workspace.path}/empty.txt`);

          expect(content).toBe("");
        });

        testLocalOnly("reads binary data correctly", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create binary file with specific bytes
          const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253]);
          const writer = runtime.writeFile(`${workspace.path}/binary.dat`).getWriter();
          await writer.write(binaryData);
          await writer.close();

          // Read it back
          const stream = runtime.readFile(`${workspace.path}/binary.dat`);
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }

          // Concatenate chunks
          const readData = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
          let offset = 0;
          for (const chunk of chunks) {
            readData.set(chunk, offset);
            offset += chunk.length;
          }

          expect(readData).toEqual(binaryData);
        });

        testForRuntime("throws RuntimeError for non-existent file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await expect(
            readFileString(runtime, `${workspace.path}/does-not-exist.txt`)
          ).rejects.toThrow(RuntimeError);
        });

        testForRuntime("throws RuntimeError when reading a directory", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create subdirectory
          await execBuffered(runtime, `mkdir -p subdir`, { cwd: workspace.path, timeout: 30 });

          await expect(readFileString(runtime, `${workspace.path}/subdir`)).rejects.toThrow();
        });
      });

      describe("writeFile() - File writing", () => {
        testForRuntime("writes file contents", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const content = "Test content\nLine 2";
          await writeFileString(runtime, `${workspace.path}/output.txt`, content);

          // Verify by reading back
          const result = await execBuffered(runtime, "cat output.txt", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout).toBe(content);
        });

        testForRuntime("overwrites existing file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const path = `${workspace.path}/overwrite.txt`;

          // Write initial content
          await writeFileString(runtime, path, "original");

          // Overwrite
          await writeFileString(runtime, path, "new content");

          // Verify
          const content = await readFileString(runtime, path);
          expect(content).toBe("new content");
        });

        testForRuntime("writes empty file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await writeFileString(runtime, `${workspace.path}/empty.txt`, "");

          const content = await readFileString(runtime, `${workspace.path}/empty.txt`);
          expect(content).toBe("");
        });

        testLocalOnly("writes binary data", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253]);
          const writer = runtime.writeFile(`${workspace.path}/binary.dat`).getWriter();
          await writer.write(binaryData);
          await writer.close();

          // Verify with wc -c (byte count)
          const result = await execBuffered(runtime, "wc -c < binary.dat", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout.trim()).toBe("6");
        });

        testForRuntime("creates parent directories if needed", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await writeFileString(runtime, `${workspace.path}/nested/dir/file.txt`, "content");

          const content = await readFileString(runtime, `${workspace.path}/nested/dir/file.txt`);
          expect(content).toBe("content");
        });

        testForRuntime("handles special characters in content", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const specialContent = 'Special chars: \n\t"quotes"\'\r\n$VAR`cmd`';
          await writeFileString(runtime, `${workspace.path}/special.txt`, specialContent);

          const content = await readFileString(runtime, `${workspace.path}/special.txt`);
          expect(content).toBe(specialContent);
        });

        testDockerOnly("preserves symlinks when editing target file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create a target file
          const targetPath = `${workspace.path}/target.txt`;
          await writeFileString(runtime, targetPath, "original content");

          // Create a symlink to the target
          const linkPath = `${workspace.path}/link.txt`;
          const result = await execBuffered(runtime, `ln -s target.txt link.txt`, {
            cwd: workspace.path,
            timeout: 30,
          });
          expect(result.exitCode).toBe(0);

          // Verify symlink was created
          const lsResult = await execBuffered(runtime, "ls -la link.txt", {
            cwd: workspace.path,
            timeout: 30,
          });
          expect(lsResult.stdout).toContain("->");
          expect(lsResult.stdout).toContain("target.txt");

          // Edit the file via the symlink
          await writeFileString(runtime, linkPath, "new content");

          // Verify the symlink is still a symlink (not replaced with a file)
          const lsAfter = await execBuffered(runtime, "ls -la link.txt", {
            cwd: workspace.path,
            timeout: 30,
          });
          expect(lsAfter.stdout).toContain("->");
          expect(lsAfter.stdout).toContain("target.txt");

          // Verify both the symlink and target have the new content
          const linkContent = await readFileString(runtime, linkPath);
          expect(linkContent).toBe("new content");

          const targetContent = await readFileString(runtime, targetPath);
          expect(targetContent).toBe("new content");
        });

        testDockerOnly("preserves file permissions when editing through symlink", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create a target file with specific permissions (755)
          const targetPath = `${workspace.path}/target.txt`;
          await writeFileString(runtime, targetPath, "original content");

          // Set permissions to 755
          const chmodResult = await execBuffered(runtime, "chmod 755 target.txt", {
            cwd: workspace.path,
            timeout: 30,
          });
          expect(chmodResult.exitCode).toBe(0);

          // Verify initial permissions
          const statBefore = await execBuffered(runtime, "stat -c '%a' target.txt", {
            cwd: workspace.path,
            timeout: 30,
          });
          expect(statBefore.stdout.trim()).toBe("755");

          // Create a symlink to the target
          const linkPath = `${workspace.path}/link.txt`;
          const lnResult = await execBuffered(runtime, "ln -s target.txt link.txt", {
            cwd: workspace.path,
            timeout: 30,
          });
          expect(lnResult.exitCode).toBe(0);

          // Edit the file via the symlink
          await writeFileString(runtime, linkPath, "new content");

          // Verify permissions are preserved
          const statAfter = await execBuffered(runtime, "stat -c '%a' target.txt", {
            cwd: workspace.path,
            timeout: 30,
          });
          expect(statAfter.stdout.trim()).toBe("755");

          // Verify content was updated
          const content = await readFileString(runtime, targetPath);
          expect(content).toBe("new content");
        });
      });

      describe("stat() - File metadata", () => {
        testForRuntime("returns file metadata", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const content = "Test content";
          await writeFileString(runtime, `${workspace.path}/test.txt`, content);

          const stat = await runtime.stat(`${workspace.path}/test.txt`);

          expect(stat.size).toBe(content.length);
          expect(stat.isDirectory).toBe(false);
          // Check modifiedTime is a valid date (use getTime() to avoid Jest Date issues)
          expect(typeof stat.modifiedTime.getTime).toBe("function");
          expect(stat.modifiedTime.getTime()).toBeGreaterThan(0);
          expect(stat.modifiedTime.getTime()).toBeLessThanOrEqual(Date.now());
        });

        testForRuntime("returns directory metadata", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await execBuffered(runtime, "mkdir subdir", { cwd: workspace.path, timeout: 30 });

          const stat = await runtime.stat(`${workspace.path}/subdir`);

          expect(stat.isDirectory).toBe(true);
        });

        testForRuntime("throws RuntimeError for non-existent path", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await expect(runtime.stat(`${workspace.path}/does-not-exist`)).rejects.toThrow(
            RuntimeError
          );
        });

        testForRuntime("returns correct size for empty file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await writeFileString(runtime, `${workspace.path}/empty.txt`, "");

          const stat = await runtime.stat(`${workspace.path}/empty.txt`);

          expect(stat.size).toBe(0);
          expect(stat.isDirectory).toBe(false);
        });
      });

      describeLocalOnly("Edge cases", () => {
        testForRuntime(
          "handles large files efficiently",
          async () => {
            const runtime = createRuntime();
            await using workspace = await TestWorkspace.create(runtime, type);

            // Create 1MB file
            const largeContent = "x".repeat(1024 * 1024);
            await writeFileString(runtime, `${workspace.path}/large.txt`, largeContent);

            const content = await readFileString(runtime, `${workspace.path}/large.txt`);

            expect(content.length).toBe(1024 * 1024);
            expect(content).toBe(largeContent);
          },
          30000
        );

        testLocalOnly("handles concurrent operations", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Run multiple file operations concurrently
          const operations = Array.from({ length: 10 }, async (_, i) => {
            const path = `${workspace.path}/concurrent-${i}.txt`;
            await writeFileString(runtime, path, `content-${i}`);
            const content = await readFileString(runtime, path);
            expect(content).toBe(`content-${i}`);
          });

          await Promise.all(operations);
        });

        testForRuntime("handles paths with spaces", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const path = `${workspace.path}/file with spaces.txt`;
          await writeFileString(runtime, path, "content");

          const content = await readFileString(runtime, path);
          expect(content).toBe("content");
        });

        testForRuntime("handles very long file paths", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create nested directories
          const longPath = `${workspace.path}/a/b/c/d/e/f/g/h/i/j/file.txt`;
          await writeFileString(runtime, longPath, "nested");

          const content = await readFileString(runtime, longPath);
          expect(content).toBe("nested");
        });
      });

      describeNonDocker("Git operations", () => {
        testForRuntime("can initialize a git repository", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Initialize git repo
          const result = await execBuffered(runtime, "git init", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.exitCode).toBe(0);

          // Verify .git directory exists
          const stat = await runtime.stat(`${workspace.path}/.git`);
          expect(stat.isDirectory).toBe(true);
        });

        testForRuntime("can create commits", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Initialize git and configure user
          await execBuffered(
            runtime,
            `git init && git config user.email "test@example.com" && git config user.name "Test User"`,
            { cwd: workspace.path, timeout: 30 }
          );

          // Create a file and commit
          await writeFileString(runtime, `${workspace.path}/test.txt`, "initial content");
          await execBuffered(runtime, `git add test.txt && git commit -m "Initial commit"`, {
            cwd: workspace.path,
            timeout: 30,
          });

          // Verify commit exists
          const logResult = await execBuffered(runtime, "git log --oneline", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(logResult.stdout).toContain("Initial commit");
        });

        testForRuntime("can create and checkout branches", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Setup git repo
          await execBuffered(
            runtime,
            `git init && git config user.email "test@example.com" && git config user.name "Test"`,
            { cwd: workspace.path, timeout: 30 }
          );

          // Create initial commit
          await writeFileString(runtime, `${workspace.path}/file.txt`, "content");
          await execBuffered(runtime, `git add file.txt && git commit -m "init"`, {
            cwd: workspace.path,
            timeout: 30,
          });

          // Create and checkout new branch
          await execBuffered(runtime, "git checkout -b feature-branch", {
            cwd: workspace.path,
            timeout: 30,
          });

          // Verify branch
          const branchResult = await execBuffered(runtime, "git branch --show-current", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(branchResult.stdout.trim()).toBe("feature-branch");
        });

        testForRuntime("can handle git status in dirty workspace", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Setup git repo with commit
          await execBuffered(
            runtime,
            `git init && git config user.email "test@example.com" && git config user.name "Test"`,
            { cwd: workspace.path, timeout: 30 }
          );
          await writeFileString(runtime, `${workspace.path}/file.txt`, "original");
          await execBuffered(runtime, `git add file.txt && git commit -m "init"`, {
            cwd: workspace.path,
            timeout: 30,
          });

          // Make changes
          await writeFileString(runtime, `${workspace.path}/file.txt`, "modified");

          // Check status
          const statusResult = await execBuffered(runtime, "git status --short", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(statusResult.stdout).toContain("M file.txt");
        });
      });

      describeNonDocker("Environment and shell behavior", () => {
        testForRuntime("preserves multi-line output formatting", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, 'echo "line1\nline2\nline3"', {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout).toContain("line1");
          expect(result.stdout).toContain("line2");
          expect(result.stdout).toContain("line3");
        });

        testForRuntime("handles commands with pipes", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await writeFileString(runtime, `${workspace.path}/test.txt`, "line1\nline2\nline3");

          const result = await execBuffered(runtime, "cat test.txt | grep line2", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout.trim()).toBe("line2");
        });

        testForRuntime("handles command substitution", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, 'echo "Current dir: $(basename $(pwd))"', {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout).toContain("Current dir:");
        });

        testForRuntime("handles large stdout output", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Generate large output (1000 lines)
          const result = await execBuffered(runtime, "seq 1 1000", {
            cwd: workspace.path,
            timeout: 30,
          });

          const lines = result.stdout.trim().split("\n");
          expect(lines.length).toBe(1000);
          expect(lines[0]).toBe("1");
          expect(lines[999]).toBe("1000");
        });

        testForRuntime("handles commands that produce no output but take time", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "sleep 0.1", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toBe("");
          expect(result.duration).toBeGreaterThanOrEqual(100);
        });
      });

      describeLocalOnly("Error handling", () => {
        testForRuntime("handles command not found", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "nonexistentcommand", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr.toLowerCase()).toContain("not found");
        });

        testForRuntime("handles syntax errors in bash", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "if true; then echo 'missing fi'", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.exitCode).not.toBe(0);
        });

        testForRuntime("handles permission denied errors", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create file without execute permission and try to execute it
          await writeFileString(runtime, `${workspace.path}/script.sh`, "#!/bin/sh\necho test");
          await execBuffered(runtime, "chmod 644 script.sh", {
            cwd: workspace.path,
            timeout: 30,
          });

          const result = await execBuffered(runtime, "./script.sh", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr.toLowerCase()).toContain("permission denied");
        });
      });
    }
  );

  /**
   * SSHRuntime-specific workspace operation tests
   * WorktreeRuntime workspace tests are covered by the matrix above
   *
   * Note: SSHRuntime.getWorkspacePath uses srcBaseDir + projectName + workspaceName.
   * The projectPath argument is only used to extract the project name (basename).
   * So the actual workspace path is: /home/testuser/workspace/{projectName}/{workspaceName}
   */
  describe("SSHRuntime workspace operations", () => {
    const testForRuntime = test;
    const srcBaseDir = "/home/testuser/workspace";
    const createSSHRuntime = (): Runtime => createTestRuntime("ssh", srcBaseDir, sshConfig);

    describe("renameWorkspace", () => {
      testForRuntime("successfully renames directory", async () => {
        const runtime = createSSHRuntime();
        // Use unique project name to avoid conflicts with concurrent tests
        const projectName = `rename-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        // projectPath is used to extract project name - can be any path ending with projectName
        const projectPath = `/some/path/${projectName}`;

        // The runtime will construct paths as: srcBaseDir/projectName/workspaceName
        const oldWorkspacePath = `${srcBaseDir}/${projectName}/worktree-1`;
        const newWorkspacePath = `${srcBaseDir}/${projectName}/worktree-renamed`;

        // Create the workspace directory structure where the runtime expects it
        await execBuffered(
          runtime,
          `mkdir -p "${oldWorkspacePath}" && echo "test" > "${oldWorkspacePath}/test.txt"`,
          { cwd: "/home/testuser", timeout: 30 }
        );

        // Rename the workspace
        const result = await runtime.renameWorkspace(projectPath, "worktree-1", "worktree-renamed");

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.oldPath).toBe(oldWorkspacePath);
          expect(result.newPath).toBe(newWorkspacePath);

          // Verify old path no longer exists
          const oldCheck = await execBuffered(
            runtime,
            `test -d "${result.oldPath}" && echo "exists" || echo "missing"`,
            { cwd: "/home/testuser", timeout: 30 }
          );
          expect(oldCheck.stdout.trim()).toBe("missing");

          // Verify new path exists with content
          const newCheck = await execBuffered(
            runtime,
            `test -f "${result.newPath}/test.txt" && echo "exists" || echo "missing"`,
            { cwd: "/home/testuser", timeout: 30 }
          );
          expect(newCheck.stdout.trim()).toBe("exists");
        }

        // Cleanup
        await execBuffered(runtime, `rm -rf "${srcBaseDir}/${projectName}"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
      });

      testForRuntime("returns error when trying to rename non-existent directory", async () => {
        const runtime = createSSHRuntime();
        const projectName = `nonexist-rename-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;

        // Try to rename a directory that doesn't exist
        const result = await runtime.renameWorkspace(projectPath, "non-existent", "new-name");

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("Failed to rename directory");
        }
      });
    });

    describe("forkWorkspace", () => {
      test("forks from the source workspace's current branch", async () => {
        const runtime = createSSHRuntime();
        const projectName = `fork-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;

        const sourceWorkspaceName = "source";
        const newWorkspaceName = "forked";

        const sourceWorkspacePath = `${srcBaseDir}/${projectName}/${sourceWorkspaceName}`;
        const newWorkspacePath = `${srcBaseDir}/${projectName}/${newWorkspaceName}`;

        // Create a source workspace repo with a non-trunk branch checked out.
        await execBuffered(
          runtime,
          [
            `mkdir -p "${sourceWorkspacePath}"`,
            `cd "${sourceWorkspacePath}"`,
            `git init`,
            `git config user.email "test@example.com"`,
            `git config user.name "Test"`,
            `echo "root" > root.txt`,
            `git add root.txt`,
            `git commit -m "root"`,
            `git checkout -b feature`,
            `echo "feature" > feature.txt`,
            `git add feature.txt`,
            `git commit -m "feature"`,
            `echo "untracked" > untracked.txt`,
            `echo "local-change" >> feature.txt`,
          ].join(" && "),
          { cwd: "/home/testuser", timeout: 30 }
        );

        // Sanity check the source branch.
        const sourceBranchCheck = await execBuffered(
          runtime,
          `git -C "${sourceWorkspacePath}" branch --show-current`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(sourceBranchCheck.stdout.trim()).toBe("feature");

        const initLogger = {
          logStep(_message: string) {},
          logStdout(_line: string) {},
          logStderr(_line: string) {},
          logComplete(_exitCode: number) {},
        };

        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName,
          newWorkspaceName,
          initLogger,
        });

        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;

        expect(forkResult.workspacePath).toBe(newWorkspacePath);
        expect(forkResult.sourceBranch).toBe("feature");

        const newBranchCheck = await execBuffered(
          runtime,
          `git -C "${newWorkspacePath}" branch --show-current`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(newBranchCheck.stdout.trim()).toBe(newWorkspaceName);

        // Verify the new workspace is based on the source branch commit.
        const fileCheck = await execBuffered(
          runtime,
          `test -f "${newWorkspacePath}/feature.txt" && echo "exists" || echo "missing"`,
          { cwd: "/home/testuser", timeout: 30 }
        );

        expect(fileCheck.stdout.trim()).toBe("exists");

        // Fork should preserve uncommitted working tree changes from the source workspace.
        const untrackedCheck = await execBuffered(
          runtime,
          `test -f "${newWorkspacePath}/untracked.txt" && echo "exists" || echo "missing"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(untrackedCheck.stdout.trim()).toBe("exists");

        const modifiedCheck = await execBuffered(
          runtime,
          `grep -q "local-change" "${newWorkspacePath}/feature.txt" && echo "present" || echo "missing"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(modifiedCheck.stdout.trim()).toBe("present");

        // runFullInit (and thus initWorkspace) should be able to run on a forked repo
        // without trying to re-sync. (The absence of a .mux/init hook means it will
        // complete immediately.)
        const initResult = await runFullInit(runtime, {
          projectPath,
          branchName: newWorkspaceName,
          trunkBranch: "feature",
          workspacePath: newWorkspacePath,
          initLogger,
        });
        expect(initResult.success).toBe(true);

        // Cleanup
        await execBuffered(runtime, `rm -rf "${srcBaseDir}/${projectName}"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
      });
    });

    describe("deleteWorkspace", () => {
      testForRuntime("successfully deletes directory", async () => {
        const runtime = createSSHRuntime();
        const projectName = `delete-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;
        const workspacePath = `${srcBaseDir}/${projectName}/worktree-delete-test`;

        // Create the workspace directory structure where the runtime expects it
        await execBuffered(
          runtime,
          `mkdir -p "${workspacePath}" && echo "test" > "${workspacePath}/test.txt"`,
          { cwd: "/home/testuser", timeout: 30 }
        );

        // Verify workspace exists
        const beforeCheck = await execBuffered(
          runtime,
          `test -d "${workspacePath}" && echo "exists" || echo "missing"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(beforeCheck.stdout.trim()).toBe("exists");

        // Delete the workspace (force=true since it's not a git repo)
        const result = await runtime.deleteWorkspace(projectPath, "worktree-delete-test", true);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.deletedPath).toBe(workspacePath);

          // Verify workspace was deleted
          const afterCheck = await execBuffered(
            runtime,
            `test -d "${result.deletedPath}" && echo "exists" || echo "missing"`,
            { cwd: "/home/testuser", timeout: 30 }
          );
          expect(afterCheck.stdout.trim()).toBe("missing");
        }

        // Cleanup
        await execBuffered(runtime, `rm -rf "${srcBaseDir}/${projectName}"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
      });

      testForRuntime("returns success for non-existent directory (idempotent)", async () => {
        const runtime = createSSHRuntime();
        const projectName = `nonexist-delete-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;

        // Try to delete a workspace that doesn't exist
        const result = await runtime.deleteWorkspace(projectPath, "non-existent", false);

        // Should be idempotent - return success for non-existent workspaces
        expect(result.success).toBe(true);
      });
    });
  });

  /**
   * SSHRuntime worktree-based workspace operations
   *
   * Tests the shared bare base repo + git worktree approach for SSH workspaces.
   * When a base repo (.mux-base.git) exists, fork/init/delete/rename use git worktree
   * commands instead of full directory copies. Legacy workspaces (no base repo) still work.
   */
  describe("SSHRuntime worktree operations", () => {
    const srcBaseDir = "/home/testuser/workspace";
    const createSSHRuntime = (): SSHRuntime =>
      createTestRuntime("ssh", srcBaseDir, sshConfig) as SSHRuntime;

    test("computeBaseRepoPath returns correct path", async () => {
      const result = computeBaseRepoPath(srcBaseDir, "/some/path/my-project");
      expect(result).toBe(`${srcBaseDir}/my-project/.mux-base.git`);
    }, 10000);

    test("forkWorkspace uses worktree when base repo exists", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-fork-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const baseRepoPath = `${srcBaseDir}/${projectName}/.mux-base.git`;
      const sourceWorkspacePath = `${srcBaseDir}/${projectName}/source`;
      const newWorkspaceName = "forked-wt";
      const newWorkspacePath = `${srcBaseDir}/${projectName}/${newWorkspaceName}`;

      try {
        // 1. Create a bare base repo and populate it with a commit.
        await execBuffered(
          runtime,
          [
            `mkdir -p "${srcBaseDir}/${projectName}"`,
            `git init --bare "${baseRepoPath}"`,
            // Create a temp repo, commit, and push to the bare repo.
            `TMPCLONE=$(mktemp -d)`,
            `git clone "${baseRepoPath}" "$TMPCLONE/work"`,
            `cd "$TMPCLONE/work"`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "base content" > base.txt`,
            `git add base.txt`,
            `git commit -m "initial"`,
            `git push origin HEAD:main`,
            `rm -rf "$TMPCLONE"`,
          ].join(" && "),
          { cwd: "/home/testuser", timeout: 30 }
        );

        // 2. Create the source workspace as a worktree of the base repo.
        await execBuffered(
          runtime,
          `git -C "${baseRepoPath}" worktree add "${sourceWorkspacePath}" -b source main`,
          { cwd: "/home/testuser", timeout: 30 }
        );

        // Verify source workspace has the content.
        const sourceCheck = await execBuffered(
          runtime,
          `test -f "${sourceWorkspacePath}/base.txt" && echo "exists" || echo "missing"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(sourceCheck.stdout.trim()).toBe("exists");

        // 3. Fork the workspace — should use the fast worktree path.
        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName: "source",
          newWorkspaceName,
          initLogger: noopInitLogger,
        });

        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        expect(forkResult.workspacePath).toBe(newWorkspacePath);
        expect(forkResult.sourceBranch).toBe("source");

        // 4. Verify the forked workspace is a worktree (.git is a file, not directory).
        const gitTypeCheck = await execBuffered(
          runtime,
          `test -f "${newWorkspacePath}/.git" && echo "file" || (test -d "${newWorkspacePath}/.git" && echo "dir" || echo "missing")`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(gitTypeCheck.stdout.trim()).toBe("file");

        // 5. Verify the worktree has the correct branch and files.
        const branchCheck = await execBuffered(
          runtime,
          `git -C "${newWorkspacePath}" branch --show-current`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(branchCheck.stdout.trim()).toBe(newWorkspaceName);

        const fileCheck = await execBuffered(runtime, `cat "${newWorkspacePath}/base.txt"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
        expect(fileCheck.stdout.trim()).toBe("base content");

        // 6. Verify the worktree is listed in the base repo.
        const worktreeList = await execBuffered(runtime, `git -C "${baseRepoPath}" worktree list`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
        expect(worktreeList.stdout).toContain(newWorkspaceName);
      } finally {
        // Cleanup: remove all worktrees and the project directory.
        await execBuffered(runtime, `rm -rf "${srcBaseDir}/${projectName}"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
      }
    }, 60000);

    test("forkWorkspace falls back to cp -R -P when no base repo exists (legacy)", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-legacy-fork-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const sourceWorkspacePath = `${srcBaseDir}/${projectName}/legacy-source`;
      const newWorkspaceName = "legacy-forked";
      const newWorkspacePath = `${srcBaseDir}/${projectName}/${newWorkspaceName}`;

      try {
        // Create a legacy workspace (standalone git clone, no base repo).
        await execBuffered(
          runtime,
          [
            `mkdir -p "${sourceWorkspacePath}"`,
            `cd "${sourceWorkspacePath}"`,
            `git init`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "legacy content" > legacy.txt`,
            `git add legacy.txt`,
            `git commit -m "legacy initial"`,
            `git checkout -b legacy-branch`,
          ].join(" && "),
          { cwd: "/home/testuser", timeout: 30 }
        );

        // Verify no base repo exists.
        const baseCheck = await execBuffered(
          runtime,
          `test -d "${srcBaseDir}/${projectName}/.mux-base.git" && echo "exists" || echo "missing"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(baseCheck.stdout.trim()).toBe("missing");

        // Fork should use the legacy cp -R -P path.
        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName: "legacy-source",
          newWorkspaceName,
          initLogger: noopInitLogger,
        });

        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        expect(forkResult.sourceBranch).toBe("legacy-branch");

        // Verify the forked workspace is a full clone (.git is a directory, not a file).
        const gitTypeCheck = await execBuffered(
          runtime,
          `test -d "${newWorkspacePath}/.git" && echo "dir" || echo "not-dir"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(gitTypeCheck.stdout.trim()).toBe("dir");

        // Verify content was copied.
        const fileCheck = await execBuffered(runtime, `cat "${newWorkspacePath}/legacy.txt"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
        expect(fileCheck.stdout.trim()).toBe("legacy content");
      } finally {
        await execBuffered(runtime, `rm -rf "${srcBaseDir}/${projectName}"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
      }
    }, 60000);

    test("forkWorkspace falls back to cp when base repo exists but source branch is missing from it", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-mixed-fork-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const baseRepoPath = `${srcBaseDir}/${projectName}/.mux-base.git`;
      const sourceWorkspacePath = `${srcBaseDir}/${projectName}/legacy-ws`;
      const newWorkspaceName = "forked-mixed";
      const newWorkspacePath = `${srcBaseDir}/${projectName}/${newWorkspaceName}`;

      try {
        // 1. Create a bare base repo with a commit on 'main' (simulates a previous initWorkspace).
        await execBuffered(
          runtime,
          [
            `mkdir -p "${srcBaseDir}/${projectName}"`,
            `git init --bare "${baseRepoPath}"`,
            `TMPCLONE=$(mktemp -d)`,
            `git clone "${baseRepoPath}" "$TMPCLONE/work"`,
            `cd "$TMPCLONE/work"`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "base" > base.txt`,
            `git add base.txt`,
            `git commit -m "initial"`,
            `git push origin HEAD:main`,
            `rm -rf "$TMPCLONE"`,
          ].join(" && "),
          { cwd: "/home/testuser", timeout: 30 }
        );

        // 2. Create a legacy workspace (full clone) with a branch that does NOT exist in the base repo.
        await execBuffered(
          runtime,
          [
            `mkdir -p "${sourceWorkspacePath}"`,
            `cd "${sourceWorkspacePath}"`,
            `git init`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "legacy content" > legacy.txt`,
            `git add legacy.txt`,
            `git commit -m "legacy commit"`,
            `git checkout -b only-on-legacy`,
          ].join(" && "),
          { cwd: "/home/testuser", timeout: 30 }
        );

        // Confirm base repo exists (so forkWorkspace will try the worktree path first).
        const baseCheck = await execBuffered(
          runtime,
          `test -d "${baseRepoPath}" && echo "exists" || echo "missing"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(baseCheck.stdout.trim()).toBe("exists");

        // 3. Fork the legacy workspace — should fall back to cp since "only-on-legacy"
        //    doesn't exist in the base repo.
        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName: "legacy-ws",
          newWorkspaceName,
          initLogger: noopInitLogger,
        });

        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        expect(forkResult.sourceBranch).toBe("only-on-legacy");

        // 4. Verify the forked workspace is a full clone (cp -R -P path), not a worktree.
        const gitTypeCheck = await execBuffered(
          runtime,
          `test -d "${newWorkspacePath}/.git" && echo "dir" || echo "not-dir"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(gitTypeCheck.stdout.trim()).toBe("dir");

        // 5. Verify content was copied.
        const fileCheck = await execBuffered(runtime, `cat "${newWorkspacePath}/legacy.txt"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
        expect(fileCheck.stdout.trim()).toBe("legacy content");
      } finally {
        await execBuffered(runtime, `rm -rf "${srcBaseDir}/${projectName}"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
      }
    }, 60000);

    test("deleteWorkspace removes worktree and cleans up base repo metadata", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-delete-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const baseRepoPath = `${srcBaseDir}/${projectName}/.mux-base.git`;
      const workspaceName = "to-delete";
      const workspacePath = `${srcBaseDir}/${projectName}/${workspaceName}`;

      try {
        // Create bare base repo with a commit.
        await execBuffered(
          runtime,
          [
            `mkdir -p "${srcBaseDir}/${projectName}"`,
            `git init --bare "${baseRepoPath}"`,
            `TMPCLONE=$(mktemp -d)`,
            `git clone "${baseRepoPath}" "$TMPCLONE/work"`,
            `cd "$TMPCLONE/work"`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "x" > x.txt && git add x.txt && git commit -m "init"`,
            `git push origin HEAD:main`,
            `rm -rf "$TMPCLONE"`,
          ].join(" && "),
          { cwd: "/home/testuser", timeout: 30 }
        );

        // Create a worktree workspace.
        await execBuffered(
          runtime,
          `git -C "${baseRepoPath}" worktree add "${workspacePath}" -b ${workspaceName} main`,
          { cwd: "/home/testuser", timeout: 30 }
        );

        // Verify it exists as a worktree.
        const beforeCheck = await execBuffered(
          runtime,
          `test -f "${workspacePath}/.git" && echo "worktree" || echo "not-worktree"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(beforeCheck.stdout.trim()).toBe("worktree");

        // Delete the workspace.
        const deleteResult = await runtime.deleteWorkspace(
          projectPath,
          workspaceName,
          true // force
        );

        expect(deleteResult.success).toBe(true);

        // Verify directory is gone.
        const afterCheck = await execBuffered(
          runtime,
          `test -d "${workspacePath}" && echo "exists" || echo "missing"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(afterCheck.stdout.trim()).toBe("missing");

        // Verify worktree metadata is cleaned up in the base repo.
        const worktreeList = await execBuffered(runtime, `git -C "${baseRepoPath}" worktree list`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
        expect(worktreeList.stdout).not.toContain(workspaceName);
      } finally {
        await execBuffered(runtime, `rm -rf "${srcBaseDir}/${projectName}"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
      }
    }, 60000);

    test("deleteWorkspace still works for legacy full-clone workspaces", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-del-legacy-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const workspacePath = `${srcBaseDir}/${projectName}/legacy-ws`;

      try {
        // Create a legacy workspace (standalone git clone, .git is a directory).
        await execBuffered(
          runtime,
          [
            `mkdir -p "${workspacePath}"`,
            `cd "${workspacePath}"`,
            `git init`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "x" > x.txt && git add x.txt && git commit -m "init"`,
          ].join(" && "),
          { cwd: "/home/testuser", timeout: 30 }
        );

        const deleteResult = await runtime.deleteWorkspace(projectPath, "legacy-ws", true);
        expect(deleteResult.success).toBe(true);

        const afterCheck = await execBuffered(
          runtime,
          `test -d "${workspacePath}" && echo "exists" || echo "missing"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(afterCheck.stdout.trim()).toBe("missing");
      } finally {
        await execBuffered(runtime, `rm -rf "${srcBaseDir}/${projectName}"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
      }
    }, 60000);

    test("renameWorkspace uses git worktree move for worktree-based workspaces", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-rename-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const baseRepoPath = `${srcBaseDir}/${projectName}/.mux-base.git`;
      const oldWorkspacePath = `${srcBaseDir}/${projectName}/old-name`;
      const newWorkspacePath = `${srcBaseDir}/${projectName}/new-name`;

      try {
        // Set up bare base repo with a commit.
        await execBuffered(
          runtime,
          [
            `mkdir -p "${srcBaseDir}/${projectName}"`,
            `git init --bare "${baseRepoPath}"`,
            `TMPCLONE=$(mktemp -d)`,
            `git clone "${baseRepoPath}" "$TMPCLONE/work"`,
            `cd "$TMPCLONE/work"`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "x" > x.txt && git add x.txt && git commit -m "init"`,
            `git push origin HEAD:main`,
            `rm -rf "$TMPCLONE"`,
          ].join(" && "),
          { cwd: "/home/testuser", timeout: 30 }
        );

        // Create a worktree workspace.
        await execBuffered(
          runtime,
          `git -C "${baseRepoPath}" worktree add "${oldWorkspacePath}" -b old-name main`,
          { cwd: "/home/testuser", timeout: 30 }
        );

        // Rename the workspace.
        const result = await runtime.renameWorkspace(projectPath, "old-name", "new-name");

        expect(result.success).toBe(true);
        if (!result.success) return;

        // Verify old path doesn't exist and new path does.
        const oldCheck = await execBuffered(
          runtime,
          `test -d "${oldWorkspacePath}" && echo "exists" || echo "missing"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(oldCheck.stdout.trim()).toBe("missing");

        const newCheck = await execBuffered(
          runtime,
          `test -f "${newWorkspacePath}/.git" && echo "worktree" || echo "not-worktree"`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(newCheck.stdout.trim()).toBe("worktree");

        // Verify the worktree is tracked at the new path (not the old path).
        // Note: git worktree move changes the path but NOT the branch name, so
        // `git worktree list` shows `/new-name [old-name]`. Check path only.
        const worktreeList = await execBuffered(runtime, `git -C "${baseRepoPath}" worktree list`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
        expect(worktreeList.stdout).toContain("/new-name");
        expect(worktreeList.stdout).not.toContain("/old-name");
      } finally {
        await execBuffered(runtime, `rm -rf "${srcBaseDir}/${projectName}"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
      }
    }, 60000);
  });

  /**
   * Verify that syncProjectToRemote does NOT import stale refs/remotes/origin/*
   * from the local machine's bundle into the shared bare base repo.
   *
   * This is the root cause of the "1.5k commits behind" bug: the local machine's
   * tracking refs (e.g. refs/remotes/origin/main) are included in the bundle
   * and imported into the base repo, giving worktrees a wildly wrong behind count.
   */
  describe("SSHRuntime sync does not import stale remote tracking refs", () => {
    const srcBaseDir = "/home/testuser/workspace";
    const createSSHRuntime = (): SSHRuntime =>
      createTestRuntime("ssh", srcBaseDir, sshConfig) as SSHRuntime;

    test("initWorkspace does not populate refs/remotes/origin in the base repo from the bundle", async () => {
      const runtime = createSSHRuntime();

      // projectName must match the basename of the local project path so that
      // getBaseRepoPath(localProjectPath) resolves to the expected baseRepoPath.
      const projectName = `sync-no-remotes-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const branchName = "test-ws";
      const workspacePath = `${srcBaseDir}/${projectName}/${branchName}`;
      const baseRepoPath = `${srcBaseDir}/${projectName}/.mux-base.git`;

      const { execSync } = await import("child_process");
      try {
        // Create a local git repo with a stale refs/remotes/origin/main.
        // This simulates a developer's local project that hasn't fetched in a while.
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "content" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
            // Create a fake stale origin/main tracking ref.
            // In a real project this comes from `git fetch origin`.
            `git update-ref refs/remotes/origin/main HEAD`,
            `git update-ref refs/remotes/origin/stale-branch HEAD`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        // Verify the local repo has remote tracking refs.
        const localRefs = execSync(`git -C "${localProjectPath}" for-each-ref refs/remotes/`, {
          encoding: "utf8",
        });
        expect(localRefs).toContain("refs/remotes/origin/main");
        expect(localRefs).toContain("refs/remotes/origin/stale-branch");

        try {
          // initWorkspace triggers syncProjectToRemote (since workspace doesn't exist yet),
          // which creates the base repo, bundles the local project, and imports refs.
          const initResult = await runtime.initWorkspace({
            projectPath: localProjectPath,
            branchName,
            trunkBranch: "main",
            workspacePath,
            initLogger: noopInitLogger,
          });
          // Show the error message if initWorkspace failed — don't just say true/false.
          if (!initResult.success) {
            throw new Error(`initWorkspace failed: ${initResult.error}`);
          }

          // The base repo should have bundle branches in refs/mux-bundle/* (staging
          // namespace) and NOT in refs/heads/* (which would collide with worktrees)
          // or refs/remotes/origin/* (stale local tracking refs).
          const baseRefs = await execBuffered(
            runtime,
            `git -C "${baseRepoPath}" for-each-ref --format='%(refname)' refs/`,
            { cwd: "/home/testuser", timeout: 30 }
          );

          // Bundle branches should be in the staging namespace.
          expect(baseRefs.stdout).toContain("refs/mux-bundle/main");

          // Should NOT have stale remote tracking refs from the bundle.
          expect(baseRefs.stdout).not.toContain("refs/remotes/origin/main");
          expect(baseRefs.stdout).not.toContain("refs/remotes/origin/stale-branch");
        } finally {
          await execBuffered(runtime, `rm -rf "${srcBaseDir}/${projectName}"`, {
            cwd: "/home/testuser",
            timeout: 30,
          });
        }
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
      }
    }, 120000);
  });

  /**
   * Regression test: creating a second workspace must not fail when the
   * bundle contains a branch that's already checked out in a worktree.
   *
   * Before the refs/mux-bundle/* staging namespace fix, syncing the bundle
   * on the second initWorkspace would fail with:
   *   "refusing to fetch into branch 'refs/heads/ws-a' checked out at '...'"
   */
  describe("SSHRuntime sync does not collide with checked-out worktree branches", () => {
    const srcBaseDir = "/home/testuser/workspace";
    const createSSHRuntime = (): SSHRuntime =>
      createTestRuntime("ssh", srcBaseDir, sshConfig) as SSHRuntime;

    test("second initWorkspace succeeds when first worktree's branch exists in bundle", async () => {
      const runtime = createSSHRuntime();
      const projectName = `sync-collision-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const wsAName = "ws-a";
      const wsBName = "ws-b";
      const wsAPath = `${srcBaseDir}/${projectName}/${wsAName}`;
      const wsBPath = `${srcBaseDir}/${projectName}/${wsBName}`;
      const baseRepoPath = `${srcBaseDir}/${projectName}/.mux-base.git`;

      const { execSync } = await import("child_process");

      try {
        // Create a local git repo with two branches — simulates a project
        // where the user already has both workspace branches locally.
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "content" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
            `git branch ${wsAName}`,
            `git branch ${wsBName}`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        // 1. Init workspace A — creates the base repo, syncs bundle, creates worktree.
        const initA = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: wsAName,
          trunkBranch: "main",
          workspacePath: wsAPath,
          initLogger: noopInitLogger,
        });
        if (!initA.success) {
          throw new Error(`initWorkspace A failed: ${initA.error}`);
        }

        // Verify workspace A exists as a worktree with ws-a checked out.
        const wsACheck = await execBuffered(
          runtime,
          `test -f "${wsAPath}/.git" && git -C "${wsAPath}" branch --show-current`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(wsACheck.stdout.trim()).toBe(wsAName);

        // 2. Init workspace B — re-syncs the bundle (which includes refs/heads/ws-a).
        //    Before the staging namespace fix, this failed with:
        //    "refusing to fetch into branch 'refs/heads/ws-a' checked out at '<wsAPath>'"
        const initB = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: wsBName,
          trunkBranch: "main",
          workspacePath: wsBPath,
          initLogger: noopInitLogger,
        });
        if (!initB.success) {
          throw new Error(`initWorkspace B failed: ${initB.error}`);
        }

        // Verify workspace B exists as a worktree with ws-b checked out.
        const wsBCheck = await execBuffered(
          runtime,
          `test -f "${wsBPath}/.git" && git -C "${wsBPath}" branch --show-current`,
          { cwd: "/home/testuser", timeout: 30 }
        );
        expect(wsBCheck.stdout.trim()).toBe(wsBName);

        // Both worktrees should be tracked in the base repo.
        const worktreeList = await execBuffered(runtime, `git -C "${baseRepoPath}" worktree list`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
        expect(worktreeList.stdout).toContain(wsAName);
        expect(worktreeList.stdout).toContain(wsBName);
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
        await execBuffered(runtime, `rm -rf "${srcBaseDir}/${projectName}"`, {
          cwd: "/home/testuser",
          timeout: 30,
        });
      }
    }, 120000);
  });

  /**
   * DockerRuntime-specific workspace operation tests
   *
   * Tests container lifecycle: create, delete, idempotent delete
   */
  describe("DockerRuntime workspace operations", () => {
    const testForDocker = shouldRunIntegrationTests() ? test : test.skip;

    // Helper to run docker commands on host
    const dockerCommand = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
      const { spawn } = await import("child_process");
      return new Promise((resolve) => {
        const proc = spawn("bash", ["-c", cmd]);
        let stdout = "";
        proc.stdout.on("data", (data) => (stdout += data.toString()));
        proc.on("close", (code) => resolve({ stdout, exitCode: code ?? 0 }));
      });
    };

    describe("createWorkspace + deleteWorkspace", () => {
      testForDocker(
        "creates container and deletes it",
        async () => {
          const { DockerRuntime, getContainerName } = await import("@/node/runtime/DockerRuntime");
          const projectName = `docker-lifecycle-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          const workspaceName = "test-ws";
          const projectPath = `/tmp/${projectName}`;
          const containerName = getContainerName(projectPath, workspaceName);

          // initWorkspace requires a git repo to bundle - create a minimal one with "main" branch
          await dockerCommand(`mkdir -p ${projectPath}`);
          await dockerCommand(
            `cd ${projectPath} && git init -b main && git config user.email "test@test.com" && git config user.name "Test" && echo "test" > README.md && git add . && git commit -m "init"`
          );

          const runtime = new DockerRuntime({ image: "mux-ssh-test" });

          try {
            // Create workspace
            const createResult = await runtime.createWorkspace({
              projectPath,
              branchName: workspaceName,
              trunkBranch: "main",
              directoryName: workspaceName,
              initLogger: noopInitLogger,
            });

            expect(createResult.success).toBe(true);
            if (!createResult.success) return;

            // createWorkspace only stores container name; runFullInit (postCreateSetup + initWorkspace) creates it
            const initResult = await runFullInit(runtime, {
              projectPath,
              branchName: workspaceName,
              trunkBranch: "main",
              workspacePath: createResult.workspacePath!,
              initLogger: noopInitLogger,
            });
            expect(initResult.success).toBe(true);
            if (!initResult.success) return;

            // Verify container exists and is running
            const inspectResult = await dockerCommand(
              `docker inspect ${containerName} --format='{{.State.Running}}'`
            );
            expect(inspectResult.exitCode).toBe(0);
            expect(inspectResult.stdout.trim()).toBe("true");

            // Delete workspace
            const deleteResult = await runtime.deleteWorkspace(projectPath, workspaceName, true);
            expect(deleteResult.success).toBe(true);

            // Verify container no longer exists
            const afterInspect = await dockerCommand(`docker inspect ${containerName} 2>&1`);
            expect(afterInspect.exitCode).not.toBe(0);
          } finally {
            // Clean up temp git repo and any leftover container
            await dockerCommand(`rm -rf ${projectPath}`);
            await dockerCommand(`docker rm -f ${containerName} 2>/dev/null || true`);
          }
        },
        60000
      );
    });

    describe("deleteWorkspace", () => {
      testForDocker("returns success for non-existent container (idempotent)", async () => {
        const { DockerRuntime } = await import("@/node/runtime/DockerRuntime");
        const projectName = `docker-nonexist-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/tmp/${projectName}`;

        const runtime = new DockerRuntime({ image: "ubuntu:22.04" });

        // Try to delete a workspace that doesn't exist
        const result = await runtime.deleteWorkspace(projectPath, "non-existent", false);

        // Should be idempotent - return success for non-existent containers
        expect(result.success).toBe(true);
      });
    });

    describe("forkWorkspace", () => {
      testForDocker(
        "forks into a valid container workspace and supports runFullInit on the fork",
        async () => {
          const { DockerRuntime, getContainerName } = await import("@/node/runtime/DockerRuntime");
          const projectName = `docker-fork-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          const projectPath = `/tmp/${projectName}`;
          const sourceWorkspaceName = "source";
          const newWorkspaceName = "forked";
          const sourceContainerName = getContainerName(projectPath, sourceWorkspaceName);
          const forkContainerName = getContainerName(projectPath, newWorkspaceName);

          const runtime = new DockerRuntime({ image: "mux-ssh-test" });

          await dockerCommand(`mkdir -p ${projectPath}`);

          try {
            // Create a running source workspace container with a feature branch checked out.
            await dockerCommand(
              `docker run -d --name ${sourceContainerName} mux-ssh-test sleep infinity`
            );
            await dockerCommand(`docker exec ${sourceContainerName} mkdir -p /src`);
            await dockerCommand(
              `docker exec ${sourceContainerName} bash -c "cd /src && git init -b ${sourceWorkspaceName} && git config user.email test@test.com && git config user.name Test && echo root > root.txt && git add root.txt && git commit -m root && git checkout -b feature && echo feature > feature.txt && git add feature.txt && git commit -m feature"`
            );

            const forkResult = await runtime.forkWorkspace({
              projectPath,
              sourceWorkspaceName,
              newWorkspaceName,
              initLogger: noopInitLogger,
            });

            expect(forkResult.success).toBe(true);
            if (!forkResult.success) return;

            expect(forkResult.workspacePath).toBe("/src");
            expect(forkResult.sourceBranch).toBe("feature");

            if (!forkResult.workspacePath || !forkResult.sourceBranch) {
              throw new Error(
                "Expected successful Docker fork to include workspacePath and sourceBranch"
              );
            }

            expect(runtime.getContainerName()).toBe(forkContainerName);

            const runningCheck = await dockerCommand(
              `docker inspect ${forkContainerName} --format='{{.State.Running}}'`
            );
            expect(runningCheck.exitCode).toBe(0);
            expect(runningCheck.stdout.trim()).toBe("true");

            const gitDirCheck = await dockerCommand(
              `docker exec ${forkContainerName} test -d /src/.git && echo ok`
            );
            expect(gitDirCheck.exitCode).toBe(0);

            const branchCheck = await dockerCommand(
              `docker exec ${forkContainerName} git -C /src rev-parse --abbrev-ref HEAD`
            );
            expect(branchCheck.exitCode).toBe(0);
            expect(branchCheck.stdout.trim()).toBe(newWorkspaceName);

            const featureFileCheck = await dockerCommand(
              `docker exec ${forkContainerName} test -f /src/feature.txt && echo ok`
            );
            expect(featureFileCheck.exitCode).toBe(0);

            const initResult = await runFullInit(runtime, {
              projectPath,
              branchName: newWorkspaceName,
              trunkBranch: forkResult.sourceBranch,
              workspacePath: forkResult.workspacePath,
              initLogger: noopInitLogger,
            });
            expect(initResult.success).toBe(true);
          } finally {
            await dockerCommand(`rm -rf ${projectPath}`);
            await dockerCommand(`docker rm -f ${sourceContainerName} 2>/dev/null || true`);
            await dockerCommand(`docker rm -f ${forkContainerName} 2>/dev/null || true`);
          }
        },
        60000
      );
    });

    describe("initWorkspace skips setup for running containers (fork scenario)", () => {
      testForDocker(
        "skips container creation when container is already running",
        async () => {
          const { DockerRuntime, getContainerName } = await import("@/node/runtime/DockerRuntime");
          const projectName = `docker-skip-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          const workspaceName = "test-skip-ws";
          const projectPath = `/tmp/${projectName}`;
          const containerName = getContainerName(projectPath, workspaceName);

          // Create a minimal git repo for the project
          await dockerCommand(`mkdir -p ${projectPath}`);
          await dockerCommand(
            `cd ${projectPath} && git init -b main && git config user.email "test@test.com" && git config user.name "Test" && echo "test" > README.md && git add . && git commit -m "init"`
          );

          // Instantiate runtime with containerName directly (simulates existing forked workspace)
          const runtime = new DockerRuntime({ image: "mux-ssh-test", containerName });
          const loggedSteps: string[] = [];
          const initLogger = {
            logStep: (msg: string) => loggedSteps.push(msg),
            logStdout: () => {},
            logStderr: () => {},
            logComplete: () => {},
          };

          try {
            // Pre-create a running container (simulating successful fork)
            await dockerCommand(
              `docker run -d --name ${containerName} mux-ssh-test sleep infinity`
            );
            // Also create /src with the git repo inside, on the correct branch
            await dockerCommand(`docker exec ${containerName} mkdir -p /src`);
            await dockerCommand(
              `docker exec ${containerName} bash -c "cd /src && git init -b ${workspaceName} && git config user.email test@test.com && git config user.name Test && echo test > README.md && git add . && git commit -m init"`
            );

            // Call runFullInit - postCreateSetup should detect running container and skip setup
            const initResult = await runFullInit(runtime, {
              projectPath,
              branchName: workspaceName,
              trunkBranch: "main",
              workspacePath: "/src",
              initLogger,
            });

            expect(initResult.success).toBe(true);
            // Should log the skip message, not "Creating container from..."
            expect(loggedSteps).toContain(
              "Container already running (from fork), running init hook..."
            );
            expect(loggedSteps).not.toContain(expect.stringContaining("Creating container from"));
          } finally {
            await dockerCommand(`rm -rf ${projectPath}`);
            await dockerCommand(`docker rm -f ${containerName} 2>/dev/null || true`);
          }
        },
        60000
      );

      testForDocker(
        "does not delete forked container when init hook fails",
        async () => {
          const { DockerRuntime, getContainerName } = await import("@/node/runtime/DockerRuntime");
          const projectName = `docker-nodel-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          const workspaceName = "test-nodel-ws";
          const projectPath = `/tmp/${projectName}`;
          const containerName = getContainerName(projectPath, workspaceName);

          // Create a minimal git repo with a FAILING init hook
          await dockerCommand(`mkdir -p ${projectPath}/.mux`);
          await dockerCommand(
            `cd ${projectPath} && git init -b main && git config user.email "test@test.com" && git config user.name "Test" && echo "test" > README.md`
          );
          await dockerCommand(`echo '#!/bin/bash\nexit 1' > ${projectPath}/.mux/init`);
          await dockerCommand(`chmod +x ${projectPath}/.mux/init`);
          await dockerCommand(
            `cd ${projectPath} && git add . && git commit -m "init with failing hook"`
          );

          // Instantiate runtime with containerName directly (simulates existing forked workspace)
          const runtime = new DockerRuntime({ image: "mux-ssh-test", containerName });

          try {
            // Pre-create a running container (simulating successful fork)
            await dockerCommand(
              `docker run -d --name ${containerName} mux-ssh-test sleep infinity`
            );
            // Create git repo with the failing init hook inside container
            await dockerCommand(`docker exec ${containerName} mkdir -p /src/.mux`);
            await dockerCommand(
              `docker exec ${containerName} bash -c "cd /src && git init -b ${workspaceName} && git config user.email test@test.com && git config user.name Test && echo test > README.md"`
            );
            await dockerCommand(
              `docker exec ${containerName} bash -c "echo '#!/bin/bash\nexit 1' > /src/.mux/init && chmod +x /src/.mux/init"`
            );
            await dockerCommand(
              `docker exec ${containerName} bash -c "cd /src && git add . && git commit -m init"`
            );

            // Call runFullInit - init hook will fail but init should still succeed
            // (hook failures are non-fatal per docs/hooks/init.mdx)
            const initResult = await runFullInit(runtime, {
              projectPath,
              branchName: workspaceName,
              trunkBranch: "main",
              workspacePath: "/src",
              initLogger: noopInitLogger,
            });

            // Init should succeed even though hook failed (non-fatal)
            expect(initResult.success).toBe(true);

            // Container should still exist
            const inspectResult = await dockerCommand(
              `docker inspect ${containerName} --format='{{.State.Running}}'`
            );
            expect(inspectResult.exitCode).toBe(0);
            expect(inspectResult.stdout.trim()).toBe("true");
          } finally {
            await dockerCommand(`rm -rf ${projectPath}`);
            await dockerCommand(`docker rm -f ${containerName} 2>/dev/null || true`);
          }
        },
        60000
      );
    });
  });

  /**
   * CoderSSHRuntime-specific tests
   *
   * Tests Coder-specific behavior like fork config updates.
   * Uses the same SSH fixture since CoderSSHRuntime extends SSHRuntime.
   */
  describe("CoderSSHRuntime workspace operations", () => {
    const srcBaseDir = "/home/testuser/src";

    // Create a CoderSSHRuntime with mock CoderService
    const createCoderSSHRuntime = async () => {
      const { CoderSSHRuntime } = await import("@/node/runtime/CoderSSHRuntime");
      const { CoderService } = await import("@/node/services/coderService");

      // Mock CoderService with methods that CoderSSHRuntime may call
      const mockCoderService = {
        getWorkspaceStatus: () =>
          Promise.resolve({ kind: "running" as const, status: "running" as const }),
      } as unknown as InstanceType<typeof CoderService>;

      const config = {
        host: "testuser@localhost",
        srcBaseDir,
        identityFile: sshConfig!.privateKeyPath,
        port: sshConfig!.port,
        coder: {
          workspaceName: "test-coder-ws",
          template: "test-template",
          existingWorkspace: false,
        },
      };
      const transport = createSSHTransport(config, false);
      return new CoderSSHRuntime(config, transport, mockCoderService);
    };

    describe("forkWorkspace", () => {
      test("marks both source and fork with existingWorkspace=true", async () => {
        const runtime = await createCoderSSHRuntime();
        const projectName = `coder-fork-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;

        const sourceWorkspaceName = "source";
        const newWorkspaceName = "forked";
        const sourceWorkspacePath = `${srcBaseDir}/${projectName}/${sourceWorkspaceName}`;

        // Create a source workspace repo
        await execBuffered(
          runtime,
          [
            `mkdir -p "${sourceWorkspacePath}"`,
            `cd "${sourceWorkspacePath}"`,
            `git init`,
            `git config user.email "test@example.com"`,
            `git config user.name "Test"`,
            `echo "root" > root.txt`,
            `git add root.txt`,
            `git commit -m "root"`,
          ].join(" && "),
          { cwd: "/home/testuser", timeout: 30 }
        );

        const initLogger = {
          logStep(_message: string) {},
          logStdout(_line: string) {},
          logStderr(_line: string) {},
          logComplete(_exitCode: number) {},
        };

        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName,
          newWorkspaceName,
          initLogger,
        });

        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;

        // Both configs should have existingWorkspace=true
        expect(forkResult.forkedRuntimeConfig).toBeDefined();
        expect(forkResult.sourceRuntimeConfig).toBeDefined();

        if (
          forkResult.forkedRuntimeConfig?.type === "ssh" &&
          forkResult.sourceRuntimeConfig?.type === "ssh"
        ) {
          expect(forkResult.forkedRuntimeConfig.coder?.existingWorkspace).toBe(true);
          expect(forkResult.sourceRuntimeConfig.coder?.existingWorkspace).toBe(true);
        } else {
          throw new Error("Expected SSH runtime configs with coder field");
        }
      }, 60000);

      test("postCreateSetup after fork does not call coder create", async () => {
        const { CoderSSHRuntime } = await import("@/node/runtime/CoderSSHRuntime");
        const { CoderService } = await import("@/node/services/coderService");

        // Track whether createWorkspace was called
        let createWorkspaceCalled = false;
        const mockCoderService = {
          createWorkspace: async function* () {
            createWorkspaceCalled = true;
            yield "should not happen";
          },
          ensureMuxCoderSSHConfig: async () => {
            // This SHOULD be called - it's safe and idempotent
          },
          getWorkspaceStatus: () =>
            Promise.resolve({ kind: "running" as const, status: "running" as const }),
          waitForStartupScripts: async function* () {
            // Yield nothing - workspace is already running
          },
        } as unknown as InstanceType<typeof CoderService>;

        const config = {
          host: "testuser@localhost",
          srcBaseDir,
          identityFile: sshConfig!.privateKeyPath,
          port: sshConfig!.port,
          coder: {
            workspaceName: "test-coder-ws",
            template: "test-template",
            existingWorkspace: false, // Source was mux-created
          },
        };
        const transport = createSSHTransport(config, false);
        const runtime = new CoderSSHRuntime(config, transport, mockCoderService);

        const projectName = `coder-fork-postcreate-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;
        const sourceWorkspaceName = "source";
        const newWorkspaceName = "forked";
        const sourceWorkspacePath = `${srcBaseDir}/${projectName}/${sourceWorkspaceName}`;
        const forkedWorkspacePath = `${srcBaseDir}/${projectName}/${newWorkspaceName}`;

        // Create a source workspace repo
        await execBuffered(
          runtime,
          [
            `mkdir -p "${sourceWorkspacePath}"`,
            `cd "${sourceWorkspacePath}"`,
            `git init`,
            `git config user.email "test@example.com"`,
            `git config user.name "Test"`,
            `echo "root" > root.txt`,
            `git add root.txt`,
            `git commit -m "root"`,
          ].join(" && "),
          { cwd: "/home/testuser", timeout: 30 }
        );

        const initLogger = {
          logStep(_message: string) {},
          logStdout(_line: string) {},
          logStderr(_line: string) {},
          logComplete(_exitCode: number) {},
        };

        // Fork the workspace
        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName,
          newWorkspaceName,
          initLogger,
        });
        expect(forkResult.success).toBe(true);

        // Now run postCreateSetup on the SAME runtime instance (simulating what
        // workspaceService does after fork - it runs init on the forked workspace)
        await runtime.postCreateSetup({
          projectPath,
          branchName: newWorkspaceName,
          trunkBranch: sourceWorkspaceName,
          workspacePath: forkedWorkspacePath,
          initLogger,
        });

        // The key assertion: createWorkspace should NOT have been called
        // because forkWorkspace() should have set existingWorkspace=true
        expect(createWorkspaceCalled).toBe(false);
      }, 60000);
    });
  });
});
