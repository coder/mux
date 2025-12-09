/**
 * Integration tests for plan commands (/plan, /plan open)
 *
 * Tests:
 * - getPlanContent API returns plan file content
 * - openInEditor API attempts to open file with configured editor
 * - Plan file CRUD operations
 */

import * as fs from "fs/promises";
import * as path from "path";
import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import type { TestEnvironment } from "./setup";
import { createTempGitRepo, cleanupTempGitRepo, generateBranchName } from "./helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";
import { getPlanFilePath } from "../../src/common/utils/planStorage";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Plan Commands Integration", () => {
  let env: TestEnvironment;
  let repoPath: string;

  beforeAll(async () => {
    env = await createTestEnvironment();
    repoPath = await createTempGitRepo();
  }, 30000);

  afterAll(async () => {
    if (repoPath) {
      await cleanupTempGitRepo(repoPath);
    }
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  describe("getPlanContent", () => {
    it("should return error when no plan file exists", async () => {
      const branchName = generateBranchName("plan-no-file");
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Failed to create workspace");

      const workspaceId = createResult.metadata.id;

      try {
        const result = await env.orpc.workspace.getPlanContent({ workspaceId });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("not found");
        }
      } finally {
        await env.orpc.workspace.remove({ workspaceId });
      }
    }, 30000);

    it("should return plan content when plan file exists", async () => {
      const branchName = generateBranchName("plan-with-file");
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Failed to create workspace");

      const workspaceId = createResult.metadata.id;

      try {
        // Create a plan file
        const planPath = getPlanFilePath(workspaceId);
        const planDir = path.dirname(planPath);
        await fs.mkdir(planDir, { recursive: true });

        const planContent = "# Test Plan\n\n## Step 1\n\nDo something\n\n## Step 2\n\nDo more";
        await fs.writeFile(planPath, planContent);

        const result = await env.orpc.workspace.getPlanContent({ workspaceId });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.content).toBe(planContent);
          expect(result.data.path).toBe(planPath);
        }
      } finally {
        await env.orpc.workspace.remove({ workspaceId });
      }
    }, 30000);

    it("should handle empty plan file", async () => {
      const branchName = generateBranchName("plan-empty");
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Failed to create workspace");

      const workspaceId = createResult.metadata.id;

      try {
        // Create an empty plan file
        const planPath = getPlanFilePath(workspaceId);
        const planDir = path.dirname(planPath);
        await fs.mkdir(planDir, { recursive: true });
        await fs.writeFile(planPath, "");

        const result = await env.orpc.workspace.getPlanContent({ workspaceId });

        // Empty file should still be returned (not an error)
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.content).toBe("");
        }
      } finally {
        await env.orpc.workspace.remove({ workspaceId });
      }
    }, 30000);
  });

  describe("canOpenInEditor", () => {
    it("should return method based on available editors", async () => {
      // Save original env vars
      const originalVisual = process.env.VISUAL;
      const originalEditor = process.env.EDITOR;

      try {
        // Clear VISUAL and EDITOR to test discovery
        delete process.env.VISUAL;
        delete process.env.EDITOR;

        const result = await env.orpc.general.canOpenInEditor();

        // In CI without editors, method depends on what's discoverable
        expect(result).toHaveProperty("method");
        expect(["visual", "editor", "gui-fallback", "terminal-fallback", "none"]).toContain(
          result.method
        );

        // If an editor was found, editor field should be set
        if (result.method !== "none") {
          expect(result.editor).toBeDefined();
        }
      } finally {
        // Restore env vars
        if (originalVisual !== undefined) {
          process.env.VISUAL = originalVisual;
        }
        if (originalEditor !== undefined) {
          process.env.EDITOR = originalEditor;
        }
      }
    }, 30000);

    it("should return method=editor when EDITOR is set", async () => {
      // Save original env vars
      const originalVisual = process.env.VISUAL;
      const originalEditor = process.env.EDITOR;

      try {
        // Set EDITOR, clear VISUAL (VISUAL takes priority)
        delete process.env.VISUAL;
        process.env.EDITOR = "vim";

        const result = await env.orpc.general.canOpenInEditor();

        expect(result.method).toBe("editor");
        expect(result.editor).toBe("vim");
      } finally {
        // Restore env vars
        if (originalVisual !== undefined) {
          process.env.VISUAL = originalVisual;
        } else {
          delete process.env.VISUAL;
        }
        if (originalEditor !== undefined) {
          process.env.EDITOR = originalEditor;
        } else {
          delete process.env.EDITOR;
        }
      }
    }, 30000);

    it("should return method=visual when VISUAL is set", async () => {
      // Save original env vars
      const originalVisual = process.env.VISUAL;
      const originalEditor = process.env.EDITOR;

      try {
        // Set VISUAL (takes priority over EDITOR)
        process.env.VISUAL = "code";
        process.env.EDITOR = "vim";

        const result = await env.orpc.general.canOpenInEditor();

        expect(result.method).toBe("visual");
        expect(result.editor).toBe("code");
      } finally {
        // Restore env vars
        if (originalVisual !== undefined) {
          process.env.VISUAL = originalVisual;
        } else {
          delete process.env.VISUAL;
        }
        if (originalEditor !== undefined) {
          process.env.EDITOR = originalEditor;
        } else {
          delete process.env.EDITOR;
        }
      }
    }, 30000);
  });

  describe("openInEditor", () => {
    it("should return result without throwing", async () => {
      const branchName = generateBranchName("plan-open-test");
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Failed to create workspace");

      const workspaceId = createResult.metadata.id;

      try {
        // Create a plan file
        const planPath = getPlanFilePath(workspaceId);
        const planDir = path.dirname(planPath);
        await fs.mkdir(planDir, { recursive: true });
        await fs.writeFile(planPath, "# Test Plan");

        // Check if any editor is available first
        const canEdit = await env.orpc.general.canOpenInEditor();

        const result = await env.orpc.general.openInEditor({
          filePath: planPath,
          workspaceId,
        });

        // Should return a result (success or failure) without throwing
        expect(result).toBeDefined();

        // If no editor available, should return error
        if (canEdit.method === "none") {
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toBe("No editor available");
          }
        }
      } finally {
        await env.orpc.workspace.remove({ workspaceId });
      }
    }, 30000);
  });
});
