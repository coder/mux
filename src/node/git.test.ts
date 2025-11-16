import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createWorktree, listLocalBranches, detectDefaultTrunkBranch } from "./git";
import { Config } from "./config";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

// eslint-disable-next-line local/no-unsafe-child-process -- Test file needs direct exec access for setup
const execAsync = promisify(exec);

describe("createWorktree", () => {
  let tempGitRepo: string;
  let config: Config;
  let defaultTrunk: string;

  beforeAll(async () => {
    // Create a temporary git repository for testing
    tempGitRepo = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-git-test-"));
    await execAsync(`git init`, { cwd: tempGitRepo });
    await execAsync(`git config user.email "test@example.com"`, { cwd: tempGitRepo });
    await execAsync(`git config user.name "Test User"`, { cwd: tempGitRepo });
    await execAsync(`git config commit.gpgsign false`, { cwd: tempGitRepo });
    await execAsync(`echo "test" > README.md`, { cwd: tempGitRepo });
    await execAsync(`git add .`, { cwd: tempGitRepo });
    await execAsync(`git commit -m "Initial commit"`, { cwd: tempGitRepo });

    // Create a branch with a slash in the name (like "docs/bash-timeout-ux")
    await execAsync(`git branch docs/bash-timeout-ux`, { cwd: tempGitRepo });

    // Create a config instance for testing
    const testConfigPath = path.join(tempGitRepo, "test-config.json");
    config = new Config(testConfigPath);

    defaultTrunk = await detectDefaultTrunkBranch(tempGitRepo);
  });

  afterAll(async () => {
    // Cleanup temp repo
    try {
      await fs.rm(tempGitRepo, { recursive: true, force: true });
    } catch (error) {
      console.warn("Failed to cleanup temp git repo:", error);
    }
  });

  test("should correctly detect branch does not exist when name is prefix of existing branch", async () => {
    // This tests the bug fix: "docs" is a prefix of "docs/bash-timeout-ux"
    // The old code would use .includes() which would match "remotes/origin/docs/bash-timeout-ux"
    // and incorrectly think "docs" exists, then try: git worktree add <path> "docs"
    // which fails with "invalid reference: docs"
    //
    // The fixed code correctly detects "docs" doesn't exist and tries: git worktree add -b "docs" <path>
    // However, Git itself won't allow creating "docs" when "docs/bash-timeout-ux" exists
    // due to ref namespace conflicts, so this will fail with a different, more informative error.
    const result = await createWorktree(config, tempGitRepo, "docs", {
      trunkBranch: defaultTrunk,
    });

    // Should fail, but with a ref lock error (not "invalid reference")
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot lock ref");
    expect(result.error).toContain("docs/bash-timeout-ux");

    // The old buggy code would have failed with "invalid reference: docs"
    expect(result.error).not.toContain("invalid reference");
  });

  test("should use existing branch when exact match exists", async () => {
    // Create a branch first
    await execAsync(`git branch existing-branch`, { cwd: tempGitRepo });

    const result = await createWorktree(config, tempGitRepo, "existing-branch", {
      trunkBranch: defaultTrunk,
    });

    // Should succeed by using the existing branch
    expect(result.success).toBe(true);
    expect(result.path).toBeDefined();

    // Verify the worktree was created
    const { stdout } = await execAsync(`git worktree list`, { cwd: tempGitRepo });
    expect(stdout).toContain("existing-branch");
  });

  test("listLocalBranches should return sorted branch names", async () => {
    const uniqueSuffix = Date.now().toString(36);
    const newBranches = [`zz-${uniqueSuffix}`, `aa-${uniqueSuffix}`, `mid/${uniqueSuffix}`];

    for (const branch of newBranches) {
      await execAsync(`git branch ${branch}`, { cwd: tempGitRepo });
    }

    const branches = await listLocalBranches(tempGitRepo);

    for (const branch of newBranches) {
      expect(branches).toContain(branch);
    }

    for (let i = 1; i < branches.length; i += 1) {
      expect(branches[i - 1].localeCompare(branches[i])).toBeLessThanOrEqual(0);
    }
  });
});
