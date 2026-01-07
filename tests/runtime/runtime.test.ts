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
 * - WorktreeRuntime: src/node/runtime/WorktreeRuntime.test.ts
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
import { createTestRuntime, TestWorkspace, type RuntimeType } from "./test-fixtures/test-helpers";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import type { Runtime } from "@/node/runtime/Runtime";
import { RuntimeError } from "@/node/runtime/Runtime";

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
          expect(result.error).toBeDefined();
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
      test.concurrent("forks from the source workspace's current branch", async () => {
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

        // initWorkspace should be able to run on a forked repo without trying to re-sync.
        // (The absence of a .mux/init hook means it will complete immediately.)
        const initResult = await runtime.initWorkspace({
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

    // Shared no-op logger for workspace operations
    const noopInitLogger = {
      logStep: () => {},
      logStdout: () => {},
      logStderr: () => {},
      logComplete: () => {},
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

            // createWorkspace only stores container name; initWorkspace actually creates it
            const initResult = await runtime.initWorkspace({
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
  });
});
