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
import { GIT_STATUS_SCRIPT, parseGitStatusScriptOutput } from "@/common/utils/git/gitStatus";
import { getMuxSrcDir } from "@/common/constants/paths";

function findWorkspaces(): Array<{ id: string; path: string }> {
  const workspaces: Array<{ id: string; path: string }> = [];
  const muxSrcDir = getMuxSrcDir();

  try {
    const projects = readdirSync(muxSrcDir);
    for (const project of projects) {
      const projectPath = join(muxSrcDir, project);
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

    const {
      primaryBranch,
      ahead,
      behind,
      dirtyCount,
      outgoingAdditions,
      outgoingDeletions,
      incomingAdditions,
      incomingDeletions,
    } = parsed;
    const dirty = dirtyCount > 0;

    console.log("\n--- PARSED RESULT ---");
    console.log(
      `✅ Success: { base: ${primaryBranch}, ahead: ${ahead}, behind: ${behind}, dirty: ${dirty}, outgoing: +${outgoingAdditions}/-${outgoingDeletions}, incoming: +${incomingAdditions}/-${incomingDeletions} }`
    );

    // Verify with git rev-list
    console.log("\n--- VERIFICATION (git rev-list) ---");
    try {
      const revList = execSync(`git rev-list --left-right --count HEAD...origin/${primaryBranch}`, {
        cwd: workspacePath,
        encoding: "utf-8",
      }).trim();

      const [verifyAhead, verifyBehind] = revList.split(/\s+/).map((n) => parseInt(n, 10));
      console.log(`git rev-list: ahead=${verifyAhead}, behind=${verifyBehind}`);

      if (verifyAhead !== ahead || verifyBehind !== behind) {
        console.log("⚠️  WARNING: Mismatch between script output and rev-list!");
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
  const muxSrcDir = getMuxSrcDir();
  console.log("🔍 Git Status Debug Tool");
  console.log("Finding workspaces in:", muxSrcDir);
  console.log();

  const workspaces = findWorkspaces();
  console.log(`Found ${workspaces.length} workspaces\n`);

  if (workspaces.length === 0) {
    console.log("No workspaces found! Check that ~/.mux/src/ contains workspace directories.");
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
