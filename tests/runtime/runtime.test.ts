/**
 * Runtime integration tests
 *
 * Tests both LocalRuntime and SSHRuntime against the same interface contract.
 * SSH tests use a real Docker container (no mocking) for confidence.
 */

// Jest globals are available automatically - no need to import
import * as os from "os";
import * as path from "path";
import { shouldRunIntegrationTests } from "../testUtils";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "./ssh-fixture";
import { createTestRuntime, TestWorkspace, type RuntimeType } from "./test-helpers";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import type { BackgroundHandle, Runtime } from "@/node/runtime/Runtime";
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
  }, 60000); // 60s timeout for Docker operations

  afterAll(async () => {
    if (sshConfig) {
      console.log("Stopping SSH server container...");
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  // Test matrix: Run all tests for both local and SSH runtimes
  describe.each<{ type: RuntimeType }>([{ type: "local" }, { type: "ssh" }])(
    "Runtime: $type",
    ({ type }) => {
      // Helper to create runtime for this test type
      // Use a base working directory - TestWorkspace will create subdirectories as needed
      // For local runtime, use os.tmpdir() which matches where TestWorkspace creates directories
      const getBaseWorkdir = () => (type === "ssh" ? sshConfig!.workdir : os.tmpdir());
      const createRuntime = (): Runtime => createTestRuntime(type, getBaseWorkdir(), sshConfig);

      describe("exec() - Command execution", () => {
        test.concurrent("captures stdout and stderr separately", async () => {
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

        test.concurrent("returns correct exit code for failed commands", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "exit 42", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.exitCode).toBe(42);
        });

        test.concurrent("handles stdin input", async () => {
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

        test.concurrent("passes environment variables", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, 'echo "$TEST_VAR"', {
            cwd: workspace.path,
            timeout: 30,
            env: { TEST_VAR: "test-value" },
          });

          expect(result.stdout.trim()).toBe("test-value");
        });

        test.concurrent("sets NON_INTERACTIVE_ENV_VARS to prevent prompts", async () => {
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

        test.concurrent("handles empty output", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "true", { cwd: workspace.path, timeout: 30 });

          expect(result.stdout).toBe("");
          expect(result.stderr).toBe("");
          expect(result.exitCode).toBe(0);
        });

        test.concurrent("handles commands with quotes and special characters", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, 'echo "hello \\"world\\""', {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout.trim()).toBe('hello "world"');
        });

        test.concurrent("respects working directory", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "pwd", { cwd: workspace.path, timeout: 30 });

          expect(result.stdout.trim()).toContain(workspace.path);
        });
        test.concurrent(
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

      describe("readFile() - File reading", () => {
        test.concurrent("reads file contents", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Write test file
          const testContent = "Hello, World!\nLine 2\nLine 3";
          await writeFileString(runtime, `${workspace.path}/test.txt`, testContent);

          // Read it back
          const content = await readFileString(runtime, `${workspace.path}/test.txt`);

          expect(content).toBe(testContent);
        });

        test.concurrent("reads empty file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Write empty file
          await writeFileString(runtime, `${workspace.path}/empty.txt`, "");

          // Read it back
          const content = await readFileString(runtime, `${workspace.path}/empty.txt`);

          expect(content).toBe("");
        });

        test.concurrent("reads binary data correctly", async () => {
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

        test.concurrent("throws RuntimeError for non-existent file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await expect(
            readFileString(runtime, `${workspace.path}/does-not-exist.txt`)
          ).rejects.toThrow(RuntimeError);
        });

        test.concurrent("throws RuntimeError when reading a directory", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create subdirectory
          await execBuffered(runtime, `mkdir -p subdir`, { cwd: workspace.path, timeout: 30 });

          await expect(readFileString(runtime, `${workspace.path}/subdir`)).rejects.toThrow();
        });
      });

      describe("writeFile() - File writing", () => {
        test.concurrent("writes file contents", async () => {
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

        test.concurrent("overwrites existing file", async () => {
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

        test.concurrent("writes empty file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await writeFileString(runtime, `${workspace.path}/empty.txt`, "");

          const content = await readFileString(runtime, `${workspace.path}/empty.txt`);
          expect(content).toBe("");
        });

        test.concurrent("writes binary data", async () => {
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

        test.concurrent("creates parent directories if needed", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await writeFileString(runtime, `${workspace.path}/nested/dir/file.txt`, "content");

          const content = await readFileString(runtime, `${workspace.path}/nested/dir/file.txt`);
          expect(content).toBe("content");
        });

        test.concurrent("handles special characters in content", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const specialContent = 'Special chars: \n\t"quotes"\'\r\n$VAR`cmd`';
          await writeFileString(runtime, `${workspace.path}/special.txt`, specialContent);

          const content = await readFileString(runtime, `${workspace.path}/special.txt`);
          expect(content).toBe(specialContent);
        });

        test.concurrent("preserves symlinks when editing target file", async () => {
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

        test.concurrent("preserves file permissions when editing through symlink", async () => {
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
        test.concurrent("returns file metadata", async () => {
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

        test.concurrent("returns directory metadata", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await execBuffered(runtime, "mkdir subdir", { cwd: workspace.path, timeout: 30 });

          const stat = await runtime.stat(`${workspace.path}/subdir`);

          expect(stat.isDirectory).toBe(true);
        });

        test.concurrent("throws RuntimeError for non-existent path", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await expect(runtime.stat(`${workspace.path}/does-not-exist`)).rejects.toThrow(
            RuntimeError
          );
        });

        test.concurrent("returns correct size for empty file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await writeFileString(runtime, `${workspace.path}/empty.txt`, "");

          const stat = await runtime.stat(`${workspace.path}/empty.txt`);

          expect(stat.size).toBe(0);
          expect(stat.isDirectory).toBe(false);
        });
      });

      describe("Edge cases", () => {
        test.concurrent(
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

        test.concurrent("handles concurrent operations", async () => {
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

        test.concurrent("handles paths with spaces", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const path = `${workspace.path}/file with spaces.txt`;
          await writeFileString(runtime, path, "content");

          const content = await readFileString(runtime, path);
          expect(content).toBe("content");
        });

        test.concurrent("handles very long file paths", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create nested directories
          const longPath = `${workspace.path}/a/b/c/d/e/f/g/h/i/j/file.txt`;
          await writeFileString(runtime, longPath, "nested");

          const content = await readFileString(runtime, longPath);
          expect(content).toBe("nested");
        });
      });

      describe("Git operations", () => {
        test.concurrent("can initialize a git repository", async () => {
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

        test.concurrent("can create commits", async () => {
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

        test.concurrent("can create and checkout branches", async () => {
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

        test.concurrent("can handle git status in dirty workspace", async () => {
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

      describe("Environment and shell behavior", () => {
        test.concurrent("preserves multi-line output formatting", async () => {
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

        test.concurrent("handles commands with pipes", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await writeFileString(runtime, `${workspace.path}/test.txt`, "line1\nline2\nline3");

          const result = await execBuffered(runtime, "cat test.txt | grep line2", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout.trim()).toBe("line2");
        });

        test.concurrent("handles command substitution", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, 'echo "Current dir: $(basename $(pwd))"', {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout).toContain("Current dir:");
        });

        test.concurrent("handles large stdout output", async () => {
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

        test.concurrent("handles commands that produce no output but take time", async () => {
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

      describe("Error handling", () => {
        test.concurrent("handles command not found", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "nonexistentcommand", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr.toLowerCase()).toContain("not found");
        });

        test.concurrent("handles syntax errors in bash", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, "if true; then echo 'missing fi'", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.exitCode).not.toBe(0);
        });

        test.concurrent("handles permission denied errors", async () => {
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

      describe("renameWorkspace() - Workspace renaming", () => {
        test.concurrent("successfully renames workspace and updates git worktree", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Initialize a git repository
          await execBuffered(runtime, "git init", {
            cwd: workspace.path,
            timeout: 30,
          });
          await execBuffered(runtime, 'git config user.email "test@example.com"', {
            cwd: workspace.path,
            timeout: 30,
          });
          await execBuffered(runtime, 'git config user.name "Test User"', {
            cwd: workspace.path,
            timeout: 30,
          });
          await execBuffered(
            runtime,
            'echo "test" > test.txt && git add test.txt && git commit -m "initial"',
            {
              cwd: workspace.path,
              timeout: 30,
            }
          );

          // Compute srcDir and paths - runtime uses srcDir/projectName/workspaceName pattern
          const projectName =
            type === "ssh" ? path.basename(workspace.path) : path.basename(workspace.path);
          const srcDir = type === "ssh" ? "/home/testuser/workspace" : path.dirname(workspace.path);
          const getWorkspacePath = (name: string) => {
            return type === "ssh"
              ? `/home/testuser/workspace/${projectName}/${name}`
              : `${srcDir}/${projectName}/${name}`;
          };

          // Create workspace directory structure
          // - Local: Use git worktree (managed by git)
          // - SSH: Create plain directory (not a git worktree)
          const worktree1Path = getWorkspacePath("worktree-1");
          if (type === "local") {
            await execBuffered(runtime, `git worktree add -b feature-branch "${worktree1Path}"`, {
              cwd: workspace.path,
              timeout: 30,
            });
          } else {
            // SSH: Just create a directory (simulate workspace structure)
            await execBuffered(
              runtime,
              `mkdir -p "${worktree1Path}" && echo "test" > "${worktree1Path}/test.txt"`,
              {
                cwd: workspace.path,
                timeout: 30,
              }
            );
          }

          // Rename the worktree using runtime.renameWorkspace
          const result = await runtime.renameWorkspace(
            workspace.path,
            "worktree-1",
            "worktree-renamed"
          );

          if (!result.success) {
            console.error("Rename failed:", result.error);
          }
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.oldPath).toBe(worktree1Path);
            expect(result.newPath).toBe(getWorkspacePath("worktree-renamed"));

            // Verify worktree was physically renamed
            const oldPathCheck = await execBuffered(
              runtime,
              `test -d "${result.oldPath}" && echo "exists" || echo "missing"`,
              {
                cwd: workspace.path,
                timeout: 30,
              }
            );
            expect(oldPathCheck.stdout.trim()).toBe("missing");

            const newPathCheck = await execBuffered(
              runtime,
              `test -d "${result.newPath}" && echo "exists" || echo "missing"`,
              {
                cwd: workspace.path,
                timeout: 30,
              }
            );
            expect(newPathCheck.stdout.trim()).toBe("exists");

            // Verify contents were preserved
            if (type === "local") {
              // For local, verify git worktree list shows updated path
              const worktreeList = await execBuffered(runtime, "git worktree list", {
                cwd: workspace.path,
                timeout: 30,
              });
              expect(worktreeList.stdout).toContain(result.newPath);
              expect(worktreeList.stdout).not.toContain(result.oldPath);
            } else {
              // For SSH, verify the file we created still exists
              const fileCheck = await execBuffered(
                runtime,
                `test -f "${result.newPath}/test.txt" && echo "exists" || echo "missing"`,
                {
                  cwd: workspace.path,
                  timeout: 30,
                }
              );
              expect(fileCheck.stdout.trim()).toBe("exists");
            }
          }

          // Cleanup
          if (type === "local") {
            // Remove git worktree before workspace cleanup
            await execBuffered(
              runtime,
              `git worktree remove "${getWorkspacePath("worktree-renamed")}"`,
              {
                cwd: workspace.path,
                timeout: 30,
              }
            ).catch(() => {
              // Ignore errors during cleanup
            });
          } else {
            // Remove directory
            await execBuffered(runtime, `rm -rf "${getWorkspacePath("worktree-renamed")}"`, {
              cwd: workspace.path,
              timeout: 30,
            }).catch(() => {
              // Ignore errors during cleanup
            });
          }
        });

        test.concurrent("returns error when trying to rename non-existent worktree", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Initialize a git repository
          await execBuffered(runtime, "git init", {
            cwd: workspace.path,
            timeout: 30,
          });
          await execBuffered(runtime, 'git config user.email "test@example.com"', {
            cwd: workspace.path,
            timeout: 30,
          });
          await execBuffered(runtime, 'git config user.name "Test User"', {
            cwd: workspace.path,
            timeout: 30,
          });
          await execBuffered(
            runtime,
            'echo "test" > test.txt && git add test.txt && git commit -m "initial"',
            {
              cwd: workspace.path,
              timeout: 30,
            }
          );

          const projectName = path.basename(workspace.path);
          const srcDir = type === "ssh" ? "/home/testuser/workspace" : path.dirname(workspace.path);

          // Try to rename a worktree that doesn't exist
          const result = await runtime.renameWorkspace(workspace.path, "non-existent", "new-name");

          expect(result.success).toBe(false);
          if (!result.success) {
            // Error message differs between local (git worktree) and SSH (mv command)
            if (type === "local") {
              expect(result.error).toContain("Failed to rename workspace");
            } else {
              expect(result.error).toContain("Failed to rename directory");
            }
          }
        });
      });

      describe("deleteWorkspace() - Workspace deletion", () => {
        test.concurrent("successfully deletes workspace and cleans up git worktree", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Initialize a git repository
          await execBuffered(runtime, "git init", {
            cwd: workspace.path,
            timeout: 30,
          });
          await execBuffered(runtime, 'git config user.email "test@example.com"', {
            cwd: workspace.path,
            timeout: 30,
          });
          await execBuffered(runtime, 'git config user.name "Test User"', {
            cwd: workspace.path,
            timeout: 30,
          });
          await execBuffered(
            runtime,
            'echo "test" > test.txt && git add test.txt && git commit -m "initial"',
            {
              cwd: workspace.path,
              timeout: 30,
            }
          );

          // Compute srcDir and paths - runtime uses srcDir/projectName/workspaceName pattern
          const projectName =
            type === "ssh" ? path.basename(workspace.path) : path.basename(workspace.path);
          const srcDir = type === "ssh" ? "/home/testuser/workspace" : path.dirname(workspace.path);
          const getWorkspacePath = (name: string) => {
            return type === "ssh"
              ? `/home/testuser/workspace/${projectName}/${name}`
              : `${srcDir}/${projectName}/${name}`;
          };

          // Create workspace directory structure
          // - Local: Use git worktree (managed by git)
          // - SSH: Create plain directory (not a git worktree)
          const worktree1Path = getWorkspacePath("worktree-delete-test");
          if (type === "local") {
            await execBuffered(
              runtime,
              `git worktree add -b delete-test-branch "${worktree1Path}"`,
              {
                cwd: workspace.path,
                timeout: 30,
              }
            );
          } else {
            // SSH: Just create a directory (simulate workspace structure)
            await execBuffered(
              runtime,
              `mkdir -p "${worktree1Path}" && echo "test" > "${worktree1Path}/test.txt"`,
              {
                cwd: workspace.path,
                timeout: 30,
              }
            );
          }

          // Verify workspace exists before deletion
          const beforeCheck = await execBuffered(
            runtime,
            `test -d "${worktree1Path}" && echo "exists" || echo "missing"`,
            {
              cwd: workspace.path,
              timeout: 30,
            }
          );
          expect(beforeCheck.stdout.trim()).toBe("exists");

          // Delete the worktree using runtime.deleteWorkspace
          const result = await runtime.deleteWorkspace(
            workspace.path,
            "worktree-delete-test",
            false // force=false
          );

          if (!result.success) {
            console.error("Delete failed:", result.error);
          }
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.deletedPath).toBe(worktree1Path);

            // Verify workspace was physically deleted
            const afterCheck = await execBuffered(
              runtime,
              `test -d "${result.deletedPath}" && echo "exists" || echo "missing"`,
              {
                cwd: workspace.path,
                timeout: 30,
              }
            );
            expect(afterCheck.stdout.trim()).toBe("missing");

            // For local, verify git worktree list doesn't show the deleted worktree
            if (type === "local") {
              const worktreeList = await execBuffered(runtime, "git worktree list", {
                cwd: workspace.path,
                timeout: 30,
              });
              expect(worktreeList.stdout).not.toContain(result.deletedPath);
            }
          }
        });

        test.concurrent(
          "successfully force-deletes workspace with uncommitted changes (local only)",
          async () => {
            const runtime = createRuntime();
            await using workspace = await TestWorkspace.create(runtime, type);

            // Skip this test for SSH since force flag only matters for git worktrees
            if (type === "ssh") {
              return;
            }

            // Initialize a git repository
            await execBuffered(runtime, "git init", {
              cwd: workspace.path,
              timeout: 30,
            });
            await execBuffered(runtime, 'git config user.email "test@example.com"', {
              cwd: workspace.path,
              timeout: 30,
            });
            await execBuffered(runtime, 'git config user.name "Test User"', {
              cwd: workspace.path,
              timeout: 30,
            });
            await execBuffered(
              runtime,
              'echo "test" > test.txt && git add test.txt && git commit -m "initial"',
              {
                cwd: workspace.path,
                timeout: 30,
              }
            );

            const projectName = path.basename(workspace.path);
            const srcDir = path.dirname(workspace.path);
            const worktreePath = `${srcDir}/${projectName}/worktree-dirty`;

            // Create worktree and add uncommitted changes
            await execBuffered(runtime, `git worktree add -b dirty-branch "${worktreePath}"`, {
              cwd: workspace.path,
              timeout: 30,
            });
            await execBuffered(runtime, `echo "uncommitted" > "${worktreePath}/dirty.txt"`, {
              cwd: workspace.path,
              timeout: 30,
            });

            // Force delete should succeed even with uncommitted changes
            const result = await runtime.deleteWorkspace(
              workspace.path,
              "worktree-dirty",
              true // force=true
            );

            expect(result.success).toBe(true);
            if (result.success) {
              expect(result.deletedPath).toBe(worktreePath);

              // Verify workspace was deleted
              const afterCheck = await execBuffered(
                runtime,
                `test -d "${result.deletedPath}" && echo "exists" || echo "missing"`,
                {
                  cwd: workspace.path,
                  timeout: 30,
                }
              );
              expect(afterCheck.stdout.trim()).toBe("missing");
            }
          }
        );

        test.concurrent("returns error when trying to delete non-existent workspace", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Initialize a git repository (needed for local worktree commands)
          if (type === "local") {
            await execBuffered(runtime, "git init", {
              cwd: workspace.path,
              timeout: 30,
            });
            await execBuffered(runtime, 'git config user.email "test@example.com"', {
              cwd: workspace.path,
              timeout: 30,
            });
            await execBuffered(runtime, 'git config user.name "Test User"', {
              cwd: workspace.path,
              timeout: 30,
            });
            await execBuffered(
              runtime,
              'echo "test" > test.txt && git add test.txt && git commit -m "initial"',
              {
                cwd: workspace.path,
                timeout: 30,
              }
            );
          }

          const projectName = path.basename(workspace.path);
          const srcDir = type === "ssh" ? "/home/testuser/workspace" : path.dirname(workspace.path);

          // Try to delete a workspace that doesn't exist
          const result = await runtime.deleteWorkspace(workspace.path, "non-existent", false);

          // Both local and SSH deleteWorkspace are now idempotent - return success for non-existent workspaces
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.deletedPath).toBeDefined();
          }
        });
      });

      describe("spawnBackground() - Background processes", () => {
        // Generate unique IDs for each test to avoid conflicts
        const genId = () => `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Polling helpers to handle SSH latency variability
        async function waitForOutput(
          rt: Runtime,
          filePath: string,
          opts?: { timeout?: number; interval?: number }
        ): Promise<string> {
          const { timeout = 5000, interval = 100 } = opts ?? {};
          const start = Date.now();
          while (Date.now() - start < timeout) {
            const content = await readFileString(rt, filePath);
            if (content.trim()) return content;
            await new Promise((r) => setTimeout(r, interval));
          }
          return await readFileString(rt, filePath);
        }

        async function waitForExitCode(
          handle: BackgroundHandle,
          opts?: { timeout?: number; interval?: number }
        ): Promise<number | null> {
          const { timeout = 5000, interval = 100 } = opts ?? {};
          const start = Date.now();
          while (Date.now() - start < timeout) {
            const code = await handle.getExitCode();
            if (code !== null) return code;
            await new Promise((r) => setTimeout(r, interval));
          }
          return await handle.getExitCode();
        }

        test.concurrent("spawns process and captures output to file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);
          const workspaceId = genId();

          const result = await runtime.spawnBackground('echo "hello from background"', {
            cwd: workspace.path,
            workspaceId,
          });

          expect(result.success).toBe(true);
          if (!result.success) return;

          expect(result.pid).toBeGreaterThan(0);
          expect(result.handle.outputDir).toContain(workspaceId);
          expect(result.handle.outputDir).toMatch(/bg-[0-9a-f]{8}/);

          // Poll for output (handles SSH latency)
          const stdoutPath = `${result.handle.outputDir}/stdout.log`;
          const stdout = await waitForOutput(runtime, stdoutPath);
          expect(stdout.trim()).toBe("hello from background");

          await result.handle.dispose();
        });

        test.concurrent("captures exit code via trap", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);
          const workspaceId = genId();

          // Spawn a process that exits with code 42
          const result = await runtime.spawnBackground("exit 42", {
            cwd: workspace.path,
            workspaceId,
          });

          expect(result.success).toBe(true);
          if (!result.success) return;

          // Poll for exit code (handles SSH latency)
          const exitCode = await waitForExitCode(result.handle);
          expect(exitCode).toBe(42);

          await result.handle.dispose();
        });

        test.concurrent("getExitCode() returns null while process runs", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);
          const workspaceId = genId();

          // Spawn a long-running process
          const result = await runtime.spawnBackground("sleep 30", {
            cwd: workspace.path,
            workspaceId,
          });

          expect(result.success).toBe(true);
          if (!result.success) return;

          // Should be running (exit code null)
          expect(await result.handle.getExitCode()).toBe(null);

          // Terminate it
          await result.handle.terminate();

          // Poll for exit code after termination
          const exitCode = await waitForExitCode(result.handle);
          expect(exitCode).not.toBe(null);

          await result.handle.dispose();
        });

        test.concurrent("terminate() kills running process", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);
          const workspaceId = genId();

          // Spawn a process that runs indefinitely
          const result = await runtime.spawnBackground("sleep 60", {
            cwd: workspace.path,
            workspaceId,
          });

          expect(result.success).toBe(true);
          if (!result.success) return;

          // Verify it's running (exit code null)
          expect(await result.handle.getExitCode()).toBe(null);

          // Terminate
          await result.handle.terminate();

          // Poll for exit code (handles SSH latency)
          const exitCode = await waitForExitCode(result.handle);
          expect(exitCode).not.toBe(null);

          await result.handle.dispose();
        });

        test.concurrent("captures stderr to file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);
          const workspaceId = genId();

          const result = await runtime.spawnBackground('echo "error message" >&2', {
            cwd: workspace.path,
            workspaceId,
          });

          expect(result.success).toBe(true);
          if (!result.success) return;

          // Poll for output (handles SSH latency)
          const stderrPath = `${result.handle.outputDir}/stderr.log`;
          const stderr = await waitForOutput(runtime, stderrPath);
          expect(stderr.trim()).toBe("error message");

          await result.handle.dispose();
        });

        test.concurrent("respects working directory", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);
          const workspaceId = genId();

          const result = await runtime.spawnBackground("pwd", {
            cwd: workspace.path,
            workspaceId,
          });

          expect(result.success).toBe(true);
          if (!result.success) return;

          // Poll for output (handles SSH latency)
          const stdoutPath = `${result.handle.outputDir}/stdout.log`;
          const stdout = await waitForOutput(runtime, stdoutPath);
          expect(stdout.trim()).toBe(workspace.path);

          await result.handle.dispose();
        });

        test.concurrent("passes environment variables", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);
          const workspaceId = genId();

          const result = await runtime.spawnBackground('echo "secret=$MY_SECRET"', {
            cwd: workspace.path,
            workspaceId,
            env: { MY_SECRET: "hunter2" },
          });

          expect(result.success).toBe(true);
          if (!result.success) return;

          // Poll for output (handles SSH latency)
          const stdoutPath = `${result.handle.outputDir}/stdout.log`;
          const stdout = await waitForOutput(runtime, stdoutPath);
          expect(stdout.trim()).toBe("secret=hunter2");

          await result.handle.dispose();
        });
      });
    }
  );
});
