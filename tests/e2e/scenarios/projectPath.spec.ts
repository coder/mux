import { electronTest as test, electronExpect as expect } from "../electronTest";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("Project Path Handling", () => {
  test("project with trailing slash displays correctly", async ({ workspace, page }) => {
    const { configRoot } = workspace;
    const srcDir = path.join(configRoot, "src");
    const sessionsDir = path.join(configRoot, "sessions");

    // Create a project path WITH trailing slash to simulate the bug
    const projectPathWithSlash = path.join(configRoot, "fixtures", "trailing-slash-project") + "/";
    const projectName = "trailing-slash-project"; // Expected extracted name
    const workspaceBranch = "test-branch";
    const workspacePath = path.join(srcDir, projectName, workspaceBranch);

    // Create directories
    fs.mkdirSync(path.dirname(projectPathWithSlash), { recursive: true });
    fs.mkdirSync(projectPathWithSlash, { recursive: true });
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Initialize git repos
    for (const repoPath of [projectPathWithSlash, workspacePath]) {
      spawnSync("git", ["init", "-q"], { cwd: repoPath });
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
      spawnSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: repoPath });
    }

    // Write config with trailing slash in project path - this tests the migration
    const configPayload = {
      projects: [[projectPathWithSlash, { workspaces: [{ path: workspacePath }] }]],
    };
    fs.writeFileSync(path.join(configRoot, "config.json"), JSON.stringify(configPayload, null, 2));

    // Create workspace session with metadata
    const workspaceId = `${projectName}-${workspaceBranch}`;
    const workspaceSessionDir = path.join(sessionsDir, workspaceId);
    fs.mkdirSync(workspaceSessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceSessionDir, "metadata.json"),
      JSON.stringify({
        id: workspaceId,
        name: workspaceBranch,
        projectName,
        projectPath: projectPathWithSlash,
      })
    );
    fs.writeFileSync(path.join(workspaceSessionDir, "chat.jsonl"), "");

    // Reload the page to pick up the new config
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Find the project in the sidebar - it should show the project name, not empty
    const navigation = page.getByRole("navigation", { name: "Projects" });
    await expect(navigation).toBeVisible();

    // The project name should be visible (extracted correctly despite trailing slash)
    // If the bug was present, we'd see an empty project name or just "/"
    await expect(navigation.getByText(projectName)).toBeVisible();

    // Verify the workspace is also visible under the project
    const projectItem = navigation.locator('[role="button"][aria-controls]').first();
    await expect(projectItem).toBeVisible();

    // Expand to see workspace
    const expandButton = projectItem.getByRole("button", { name: /expand project/i });
    if (await expandButton.isVisible()) {
      await expandButton.click();
    }

    // Workspace branch should be visible
    await expect(navigation.getByText(workspaceBranch)).toBeVisible();
  });
});
