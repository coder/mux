/**
 * Tests that agents can declare UI requirements (e.g. a non-empty plan file)
 * that gate whether they are selectable in the agent picker.
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  generateBranchName,
  trustProject,
} from "../helpers";
import { detectDefaultTrunkBranch } from "../../../src/node/git";
import { getPlanFilePath } from "../../../src/common/utils/planStorage";
import { expandTilde } from "../../../src/node/runtime/tildeExpansion";

describe("agents.list plan requirements", () => {
  let env: TestEnvironment;
  let repoPath: string;

  let homeDir: string;
  let prevHome: string | undefined;

  beforeAll(async () => {
    // Isolate plan file reads/writes under a temp HOME so tests don't touch ~/.mux.
    prevHome = process.env.HOME;
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-home-"));
    process.env.HOME = homeDir;

    env = await createTestEnvironment();
    repoPath = await createTempGitRepo();
    await trustProject(env, repoPath);
  }, 30_000);

  afterAll(async () => {
    if (repoPath) {
      await cleanupTempGitRepo(repoPath);
    }
    if (env) {
      await cleanupTestEnvironment(env);
    }

    if (homeDir) {
      await fs.rm(homeDir, { recursive: true, force: true });
    }

    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  });

  it("gates orchestrator uiSelectable on a non-empty plan file", async () => {
    const branchName = generateBranchName("agents-plan-requires");
    const trunkBranch = await detectDefaultTrunkBranch(repoPath);

    const createResult = await env.orpc.workspace.create({
      projectPath: repoPath,
      branchName,
      trunkBranch,
    });

    expect(createResult.success).toBe(true);
    if (!createResult.success) {
      throw new Error("Failed to create workspace");
    }

    const workspaceId = createResult.metadata.id;
    const workspaceName = createResult.metadata.name;
    const projectName = createResult.metadata.projectName;

    const planPath = expandTilde(getPlanFilePath(workspaceName, projectName));

    try {
      // No plan file yet -> orchestrator is discoverable but not selectable.
      const listNoPlan = await env.orpc.agents.list({ workspaceId });
      const orchestratorNoPlan = listNoPlan.find((a) => a.id === "orchestrator");
      expect(orchestratorNoPlan).toBeTruthy();
      expect(orchestratorNoPlan?.uiSelectable).toBe(false);

      // Empty plan file still shouldn't satisfy the requirement.
      await fs.mkdir(path.dirname(planPath), { recursive: true });
      await fs.writeFile(planPath, "");

      const listEmptyPlan = await env.orpc.agents.list({ workspaceId });
      const orchestratorEmptyPlan = listEmptyPlan.find((a) => a.id === "orchestrator");
      expect(orchestratorEmptyPlan).toBeTruthy();
      expect(orchestratorEmptyPlan?.uiSelectable).toBe(false);

      // Once plan file is non-empty, orchestrator becomes selectable.
      await fs.writeFile(planPath, "# Plan\n");

      const listWithPlan = await env.orpc.agents.list({ workspaceId });
      const orchestratorWithPlan = listWithPlan.find((a) => a.id === "orchestrator");
      expect(orchestratorWithPlan).toBeTruthy();
      expect(orchestratorWithPlan?.uiSelectable).toBe(true);
    } finally {
      // Best-effort cleanup.
      try {
        await fs.unlink(planPath);
      } catch {
        // ignore
      }

      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 30_000);
});
