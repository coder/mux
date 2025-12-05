/**
 * Integration tests for PROJECT_CREATE IPC handler
 *
 * Tests:
 * - Tilde expansion in project paths
 * - Path validation (existence, directory check)
 * - Prevention of adding non-existent projects
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import type { TestEnvironment } from "./setup";
import { resolveOrpcClient } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("PROJECT_CREATE IPC Handler", () => {
  test.concurrent("should expand tilde in project path and create project", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    // Create a test directory in home directory
    const testDirName = `mux-test-tilde-${Date.now()}`;
    const homeProjectPath = path.join(os.homedir(), testDirName);
    await fs.mkdir(homeProjectPath, { recursive: true });
    // Create .git directory to make it a valid git repo
    await fs.mkdir(path.join(homeProjectPath, ".git"));

    try {
      // Try to create project with tilde path
      const tildeProjectPath = `~/${testDirName}`;
      const client = resolveOrpcClient(env);
      const result = await client.projects.create({ projectPath: tildeProjectPath });

      // Should succeed
      if (!result.success) {
        throw new Error(`Expected success but got: ${result.error}`);
      }
      expect(result.data.normalizedPath).toBe(homeProjectPath);

      // Verify the project was added with expanded path (not tilde path)
      const projectsList = await client.projects.list();
      const projectPaths = projectsList.map((p: [string, unknown]) => p[0]);

      // Should contain the expanded path
      expect(projectPaths).toContain(homeProjectPath);
      // Should NOT contain the tilde path
      expect(projectPaths).not.toContain(tildeProjectPath);
    } finally {
      // Clean up test directory
      await fs.rm(homeProjectPath, { recursive: true, force: true });
      await cleanupTestEnvironment(env);
      await fs.rm(tempProjectDir, { recursive: true, force: true });
    }
  });

  test.concurrent("should reject non-existent project path", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    const nonExistentPath = "/this/path/definitely/does/not/exist/mux-test-12345";
    const client = resolveOrpcClient(env);
    const result = await client.projects.create({ projectPath: nonExistentPath });

    if (result.success) {
      throw new Error("Expected failure but got success");
    }
    expect(result.error).toContain("does not exist");

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  test.concurrent("should reject non-existent tilde path", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    const nonExistentTildePath = "~/this-directory-should-not-exist-mux-test-12345";
    const client = resolveOrpcClient(env);
    const result = await client.projects.create({ projectPath: nonExistentTildePath });

    if (result.success) {
      throw new Error("Expected failure but got success");
    }
    expect(result.error).toContain("does not exist");

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  test.concurrent("should reject file path (not a directory)", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    const testFile = path.join(tempProjectDir, "test-file.txt");
    await fs.writeFile(testFile, "test content");

    const client = resolveOrpcClient(env);
    const result = await client.projects.create({ projectPath: testFile });

    if (result.success) {
      throw new Error("Expected failure but got success");
    }
    expect(result.error).toContain("not a directory");

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  test.concurrent("should reject directory without .git", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));

    const client = resolveOrpcClient(env);
    const result = await client.projects.create({ projectPath: tempProjectDir });

    if (result.success) {
      throw new Error("Expected failure but got success");
    }
    expect(result.error).toContain("Not a git repository");

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  test.concurrent("should accept valid absolute path", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    // Create .git directory to make it a valid git repo
    await fs.mkdir(path.join(tempProjectDir, ".git"));

    const client = resolveOrpcClient(env);
    const result = await client.projects.create({ projectPath: tempProjectDir });

    if (!result.success) {
      throw new Error(`Expected success but got: ${result.error}`);
    }
    expect(result.data.normalizedPath).toBe(tempProjectDir);

    // Verify project was added
    const projectsList = await client.projects.list();
    const projectPaths = projectsList.map((p: [string, unknown]) => p[0]);
    expect(projectPaths).toContain(tempProjectDir);

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  test.concurrent("should normalize paths with .. in them", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    // Create .git directory to make it a valid git repo
    await fs.mkdir(path.join(tempProjectDir, ".git"));

    // Create a path with .. that resolves to tempProjectDir
    const pathWithDots = path.join(tempProjectDir, "..", path.basename(tempProjectDir));
    const client = resolveOrpcClient(env);
    const result = await client.projects.create({ projectPath: pathWithDots });

    if (!result.success) {
      throw new Error(`Expected success but got: ${result.error}`);
    }
    expect(result.data.normalizedPath).toBe(tempProjectDir);

    // Verify project was added with normalized path
    const projectsList = await client.projects.list();
    const projectPaths = projectsList.map((p: [string, unknown]) => p[0]);
    expect(projectPaths).toContain(tempProjectDir);

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  test.concurrent("should reject duplicate projects (same expanded path)", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    // Create .git directory to make it a valid git repo
    await fs.mkdir(path.join(tempProjectDir, ".git"));

    // Create first project
    const client = resolveOrpcClient(env);
    const result1 = await client.projects.create({ projectPath: tempProjectDir });
    expect(result1.success).toBe(true);

    // Try to create the same project with a path that has ..
    const pathWithDots = path.join(tempProjectDir, "..", path.basename(tempProjectDir));
    const result2 = await client.projects.create({ projectPath: pathWithDots });

    if (result2.success) {
      throw new Error("Expected failure but got success");
    }
    expect(result2.error).toContain("already exists");

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });
});
