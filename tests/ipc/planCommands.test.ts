/**
 * Integration tests for plan commands (/plan, /plan open)
 *
 * Tests:
 * - getPlanContent API returns plan file content
 * - openWorkspaceInEditor API attempts to open file with configured editor
 * - Plan file CRUD operations
 */

import * as fs from "fs/promises";
import * as path from "path";
import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import type { TestEnvironment } from "./setup";
import { createTempGitRepo, cleanupTempGitRepo, generateBranchName } from "./helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";
import { getPlanFilePath } from "../../src/common/utils/planStorage";
import { expandTilde } from "../../src/node/runtime/tildeExpansion";

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
      const workspaceName = createResult.metadata.name;
      const projectName = createResult.metadata.projectName;

      try {
        // Create a plan file
        const planPath = getPlanFilePath(workspaceName, projectName);
        const expandedPlanPath = expandTilde(planPath);
        const planDir = path.dirname(expandedPlanPath);
        await fs.mkdir(planDir, { recursive: true });

        const planContent = "# Test Plan\n\n## Step 1\n\nDo something\n\n## Step 2\n\nDo more";
        await fs.writeFile(expandedPlanPath, planContent);

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
      const workspaceName = createResult.metadata.name;
      const projectName = createResult.metadata.projectName;

      try {
        // Create an empty plan file
        const planPath = getPlanFilePath(workspaceName, projectName);
        const expandedPlanPath = expandTilde(planPath);
        const planDir = path.dirname(expandedPlanPath);
        await fs.mkdir(planDir, { recursive: true });
        await fs.writeFile(expandedPlanPath, "");

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

  describe("openInEditor", () => {
    it("should return error when workspace not found", async () => {
      const result = await env.orpc.general.openInEditor({
        workspaceId: "nonexistent-workspace-id",
        targetPath: "/some/path",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    }, 30000);
  });

  describe("listEditors", () => {
    it("should return available editors from config", async () => {
      const result = await env.orpc.general.listEditors();

      // Should have at least the default editors
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      // Each editor should have id, name, and isDefault
      for (const editor of result) {
        expect(editor).toHaveProperty("id");
        expect(editor).toHaveProperty("name");
        expect(editor).toHaveProperty("isDefault");
      }

      // Exactly one should be default
      const defaultEditors = result.filter((e) => e.isDefault);
      expect(defaultEditors.length).toBe(1);
    }, 30000);
  });
});
