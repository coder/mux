import { mkdtemp, rm, writeFile } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

import { GIT_FETCH_SCRIPT } from "./gitStatus";

describe("GIT_FETCH_SCRIPT", () => {
  test("fetches when remote ref moves to a commit already present locally", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mux-git-fetch-"));
    const originDir = path.join(tempDir, "origin.git");
    const workspaceDir = path.join(tempDir, "workspace");

    const run = (cmd: string, cwd?: string) =>
      execSync(cmd, { cwd, stdio: "pipe" }).toString().trim();

    try {
      // Initialize bare remote and clone it
      run(`git init --bare ${originDir}`);
      run(`git clone ${originDir} ${workspaceDir}`);

      // Basic git identity configuration
      run('git config user.email "test@example.com"', workspaceDir);
      run('git config user.name "Test User"', workspaceDir);
      run("git config commit.gpgsign false", workspaceDir);

      // Seed main with an initial commit
      await writeFile(path.join(workspaceDir, "README.md"), "init\n");
      run("git add README.md", workspaceDir);
      run('git commit -m "init"', workspaceDir);
      run("git branch -M main", workspaceDir);
      run("git push -u origin main", workspaceDir);

      // Ensure remote HEAD points to main for deterministic primary branch detection
      run("git symbolic-ref HEAD refs/heads/main", originDir);

      // Create a commit on a feature branch (object exists locally)
      run("git checkout -b feature", workspaceDir);
      await writeFile(path.join(workspaceDir, "feature.txt"), "feature\n");
      run("git add feature.txt", workspaceDir);
      run('git commit -m "feature"', workspaceDir);
      const featureSha = run("git rev-parse feature", workspaceDir);

      // Push the feature branch so the remote has the object but main stays old
      run("git push origin feature", workspaceDir);

      // Move remote main to the feature commit without updating local tracking ref
      run(`git update-ref refs/heads/main ${featureSha}`, originDir);

      const localBefore = run("git rev-parse origin/main", workspaceDir);
      expect(localBefore).not.toBe(featureSha);

      // Run the optimized fetch script (should update origin/main)
      run(GIT_FETCH_SCRIPT, workspaceDir);

      const localAfter = run("git rev-parse origin/main", workspaceDir);
      expect(localAfter).toBe(featureSha);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20000);
});
