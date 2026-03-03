import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContainerManager, type ProjectWorkspaceEntry } from "./containerManager";

describe("ContainerManager", () => {
  let rootDir: string;
  let srcBaseDir: string;
  let manager: ContainerManager;

  beforeEach(async () => {
    rootDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "container-manager-")));
    srcBaseDir = path.join(rootDir, "src");
    await fs.mkdir(srcBaseDir, { recursive: true });
    manager = new ContainerManager(srcBaseDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function createWorkspaceDir(
    projectName: string,
    markerContent: string
  ): Promise<ProjectWorkspaceEntry> {
    const workspacePath = path.join(rootDir, `${projectName}-workspace`);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "marker.txt"), markerContent, "utf8");

    return {
      projectName,
      workspacePath,
    };
  }

  it("createContainer creates symlinks to each project workspace", async () => {
    const projectWorkspaces = [
      await createWorkspaceDir("alpha", "alpha marker"),
      await createWorkspaceDir("beta", "beta marker"),
    ];

    const containerPath = await manager.createContainer("shared-workspace", projectWorkspaces);

    expect(containerPath).toBe(manager.getContainerPath("shared-workspace"));

    for (const projectWorkspace of projectWorkspaces) {
      const linkPath = path.join(containerPath, projectWorkspace.projectName);
      expect(await fs.realpath(linkPath)).toBe(await fs.realpath(projectWorkspace.workspacePath));
      expect(await fs.readFile(path.join(linkPath, "marker.txt"), "utf8")).toBe(
        `${projectWorkspace.projectName} marker`
      );
    }
  });

  it("removeContainer deletes container but preserves target directories", async () => {
    const projectWorkspace = await createWorkspaceDir("alpha", "alpha marker");
    const containerPath = await manager.createContainer("shared-workspace", [projectWorkspace]);

    await manager.removeContainer("shared-workspace");

    await expect(fs.access(containerPath)).rejects.toThrow();
    await expect(
      fs.readFile(path.join(projectWorkspace.workspacePath, "marker.txt"), "utf8")
    ).resolves.toBe("alpha marker");
  });

  it("removeContainer is idempotent", async () => {
    await manager.removeContainer("shared-workspace");
    await expect(manager.removeContainer("shared-workspace")).resolves.toBeUndefined();
  });

  it("createContainer rejects duplicate project names", async () => {
    const alphaWorkspace = await createWorkspaceDir("alpha", "alpha marker");
    const duplicateWorkspace = await createWorkspaceDir("alpha-2", "alpha duplicate marker");

    await expect(
      manager.createContainer("shared-workspace", [
        alphaWorkspace,
        {
          projectName: alphaWorkspace.projectName,
          workspacePath: duplicateWorkspace.workspacePath,
        },
      ])
    ).rejects.toThrow("Duplicate project names in multi-project workspace");
  });

  it("getContainerPath returns deterministic path under _workspaces", () => {
    expect(manager.getContainerPath("shared-workspace")).toBe(
      path.join(srcBaseDir, "_workspaces", "shared-workspace")
    );
  });
});
