/**
 * Tests that Orchestrator stays selectable in the agent picker regardless of plan file state.
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

describe("agents.list orchestrator availability", () => {
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

  it("keeps orchestrator uiSelectable with no plan, an empty plan, and a non-empty plan", async () => {
    const branchName = generateBranchName("agents-orchestrator-selectable");
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

    async function expectOrchestratorSelectable(): Promise<void> {
      const agents = await env.orpc.agents.list({ workspaceId });
      const orchestrator = agents.find((agent) => agent.id === "orchestrator");
      expect(orchestrator).toBeTruthy();
      expect(orchestrator?.uiSelectable).toBe(true);
    }

    try {
      await fs.rm(planPath, { force: true });
      await expectOrchestratorSelectable();

      await fs.mkdir(path.dirname(planPath), { recursive: true });
      await fs.writeFile(planPath, "");
      await expectOrchestratorSelectable();

      await fs.writeFile(planPath, "# Plan\n");
      await expectOrchestratorSelectable();
    } finally {
      await fs.rm(planPath, { force: true });
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 30_000);
});
