/**
 * Integration tests for project creation flow.
 *
 * Tests cover:
 * - Bare project names resolve to ~/.mux/projects/<name>
 * - Absolute paths work as before
 * - Tilde paths work as before
 * - Directories are auto-created
 *
 * We test the backend behavior directly since:
 * - Radix Dialog portals are flaky in happy-dom
 * - The critical behavior is path resolution and directory creation
 */

import * as fs from "fs";
import * as path from "path";

import { shouldRunIntegrationTests } from "../testUtils";
import { cleanupTestEnvironment, createTestEnvironment, type TestEnvironment } from "../ipc/setup";
import { getMuxHome, getMuxProjectsDir } from "../../src/common/constants/paths";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Project Creation", () => {
  let env: TestEnvironment;
  let createdProjectPaths: string[] = [];

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    // Clean up any created projects
    for (const projectPath of createdProjectPaths) {
      try {
        await env.orpc.projects.remove({ projectPath });
      } catch {
        // Ignore errors during cleanup
      }
      // Also remove the directory if it exists in the test MUX_ROOT
      try {
        fs.rmSync(projectPath, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
    await cleanupTestEnvironment(env);
  });

  test("bare project name resolves to ~/.mux/projects/<name>", async () => {
    const bareName = `test-bare-${Date.now()}`;

    const result = await env.orpc.projects.create({ projectPath: bareName });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const expectedPath = path.join(getMuxProjectsDir(), bareName);
    expect(result.data.normalizedPath).toBe(expectedPath);

    // Track for cleanup
    createdProjectPaths.push(result.data.normalizedPath);

    // Verify directory was created
    expect(fs.existsSync(result.data.normalizedPath)).toBe(true);
    expect(fs.statSync(result.data.normalizedPath).isDirectory()).toBe(true);
  }, 30_000);

  test("absolute path is used directly", async () => {
    // Create a temp directory path inside MUX_ROOT for test isolation
    const absolutePath = path.join(getMuxHome(), "test-projects", `test-absolute-${Date.now()}`);

    const result = await env.orpc.projects.create({ projectPath: absolutePath });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.normalizedPath).toBe(absolutePath);

    // Track for cleanup
    createdProjectPaths.push(result.data.normalizedPath);

    // Verify directory was created
    expect(fs.existsSync(result.data.normalizedPath)).toBe(true);
  }, 30_000);

  test("tilde path expands to home directory", async () => {
    const tildeSubpath = `test-tilde-${Date.now()}`;
    const tildePath = `~/.mux/test-projects/${tildeSubpath}`;

    const result = await env.orpc.projects.create({ projectPath: tildePath });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Should expand ~ to MUX_HOME (respects MUX_ROOT in tests)
    const expectedPath = path.join(getMuxHome(), "test-projects", tildeSubpath);
    expect(result.data.normalizedPath).toBe(expectedPath);

    // Track for cleanup
    createdProjectPaths.push(result.data.normalizedPath);

    // Verify directory was created
    expect(fs.existsSync(result.data.normalizedPath)).toBe(true);
  }, 30_000);

  test("duplicate project path returns error", async () => {
    const bareName = `test-dup-${Date.now()}`;

    // Create first
    const result1 = await env.orpc.projects.create({ projectPath: bareName });
    expect(result1.success).toBe(true);
    if (!result1.success) return;

    createdProjectPaths.push(result1.data.normalizedPath);

    // Try to create again
    const result2 = await env.orpc.projects.create({ projectPath: bareName });
    expect(result2.success).toBe(false);
    if (result2.success) return;

    expect(result2.error).toBe("Project already exists");
  }, 30_000);

  test("empty path returns error", async () => {
    const result = await env.orpc.projects.create({ projectPath: "" });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error).toBe("Project path cannot be empty");
  }, 30_000);
});
