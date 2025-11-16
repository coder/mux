/**
 * Debug command to test git status parsing against actual workspaces.
 *
 * This reuses the EXACT same code path as production to ensure they stay in sync.
 *
 * Usage: bun debug git-status [workspace-id]
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// Import production code - script and parser stay in sync
import { GIT_STATUS_SCRIPT, parseGitStatusScriptOutput } from "@/node/utils/git/gitStatus";
import { parseGitShowBranchForStatus } from "@/node/utils/git/parseGitStatus";
import { getMuxSrcDir } from "@/common/constants/paths";

function findWorkspaces(): Array<{ id: string; path: string }> {
  const workspaces: Array<{ id: string; path: string }> = [];
  const cmuxSrcDir = getMuxSrcDir();

  try {
    const projects = readdirSync(cmuxSrcDir);
    for (const project of projects) {
      const projectPath = join(cmuxSrcDir, project);
      if (!statSync(projectPath).isDirectory()) continue;

      const branches = readdirSync(projectPath);
      for (const branch of branches) {
        const workspacePath = join(projectPath, branch);
        if (statSync(workspacePath).isDirectory()) {
          workspaces.push({
            // NOTE: Using directory name as display ID for debug purposes only.
            // This is NOT how workspace IDs are determined in production code.
            // Production workspace IDs come from metadata.json in the session dir.
            id: branch,
            path: workspacePath,
          });
        }
      }
    }
  } catch (err) {
    console.error("Failed to find workspaces:", err);
  }

  return workspaces;
}

function testGitStatus(workspaceId: string, workspacePath: string) {
  console.log("\n" + "=".repeat(80));
  console.log(`Workspace: ${workspaceId}`);
  console.log(`Path: ${workspacePath}`);
  console.log("=".repeat(80));

  try {
    // Run the git status script
    const output = execSync(GIT_STATUS_SCRIPT, {
      cwd: workspacePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    console.log("\n--- RAW OUTPUT ---");
    console.log(output);

    // Parse using production function
    const parsed = parseGitStatusScriptOutput(output);

    if (!parsed) {
      console.log("\n❌ FAILED: Could not parse script output");
      return;
    }

    const { showBranchOutput, dirtyCount } = parsed;
    const dirty = dirtyCount > 0;

    console.log("\n--- SHOW-BRANCH OUTPUT (extracted) ---");
    console.log(showBranchOutput);

    // Parse with the EXACT SAME function as production
    const parsedStatus = parseGitShowBranchForStatus(showBranchOutput);

    console.log("\n--- PARSED RESULT ---");
    if (parsedStatus) {
      console.log(
        `✅ Success: { ahead: ${parsedStatus.ahead}, behind: ${parsedStatus.behind}, dirty: ${dirty} }`
      );
    } else {
      console.log("❌ FAILED: parseGitShowBranchForStatus returned null");
    }

    // Verify with git rev-list
    console.log("\n--- VERIFICATION (git rev-list) ---");
    try {
      const primaryRegex = /---PRIMARY---\s*([^\n]+)/;
      const primaryMatch = primaryRegex.exec(output);
      const primaryBranch = primaryMatch ? primaryMatch[1].trim() : "main";

      const revList = execSync(`git rev-list --left-right --count HEAD...origin/${primaryBranch}`, {
        cwd: workspacePath,
        encoding: "utf-8",
      }).trim();

      const [ahead, behind] = revList.split(/\s+/).map((n) => parseInt(n, 10));
      console.log(`git rev-list: ahead=${ahead}, behind=${behind}`);

      if (parsedStatus && (parsedStatus.ahead !== ahead || parsedStatus.behind !== behind)) {
        console.log("⚠️  WARNING: Mismatch between show-branch parsing and rev-list!");
      }
    } catch (err: unknown) {
      const error = err as Error;
      console.log("Could not verify with git rev-list:", error.message);
    }
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string };
    console.log("\n❌ ERROR running git command:");
    console.log(error.message);
    if (error.stderr) {
      console.log("STDERR:", error.stderr);
    }
  }
}

export function gitStatusCommand(workspaceId?: string) {
  const cmuxSrcDir = getMuxSrcDir();
  console.log("🔍 Git Status Debug Tool");
  console.log("Finding workspaces in:", cmuxSrcDir);
  console.log();

  const workspaces = findWorkspaces();
  console.log(`Found ${workspaces.length} workspaces\n`);

  if (workspaces.length === 0) {
    console.log("No workspaces found! Check that ~/.cmux/src/ contains workspace directories.");
    process.exit(1);
  }

  if (workspaceId) {
    // Test specific workspace
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (!workspace) {
      console.error(`Workspace "${workspaceId}" not found`);
      console.log("\nAvailable workspaces:");
      workspaces.forEach((w) => console.log(`  - ${w.id}`));
      process.exit(1);
    }
    testGitStatus(workspace.id, workspace.path);
  } else {
    // Test first 3 workspaces
    const toTest = workspaces.slice(0, 3);
    console.log(
      `Testing ${toTest.length} workspaces (use "bun debug git-status <id>" for specific workspace)...\n`
    );

    for (const workspace of toTest) {
      testGitStatus(workspace.id, workspace.path);
    }

    console.log("\n" + "=".repeat(80));
    console.log("Available workspaces:");
    workspaces.forEach((w) => console.log(`  - ${w.id}`));
  }

  console.log("\n" + "=".repeat(80));
  console.log("Done!");
}
