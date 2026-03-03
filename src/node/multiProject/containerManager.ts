import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";

export interface ProjectWorkspaceEntry {
  projectName: string;
  workspacePath: string;
}

export class ContainerManager {
  constructor(private srcBaseDir: string) {}

  private get containerBase(): string {
    return path.join(this.srcBaseDir, "_workspaces");
  }

  getContainerPath(workspaceName: string): string {
    return path.join(this.containerBase, workspaceName);
  }

  async createContainer(
    workspaceName: string,
    projectWorkspaces: ProjectWorkspaceEntry[]
  ): Promise<string> {
    // Assert no duplicate project names — would cause symlink collisions.
    const names = projectWorkspaces.map((projectWorkspace) => projectWorkspace.projectName);
    const uniqueNames = new Set(names);
    assert(
      uniqueNames.size === names.length,
      `Duplicate project names in multi-project workspace: ${names.join(", ")}`
    );

    const containerPath = this.getContainerPath(workspaceName);
    await fs.mkdir(containerPath, { recursive: true });

    for (const projectWorkspace of projectWorkspaces) {
      const linkPath = path.join(containerPath, projectWorkspace.projectName);
      // Validate target exists before symlinking.
      await fs.access(projectWorkspace.workspacePath);
      await fs.symlink(projectWorkspace.workspacePath, linkPath);
    }

    return containerPath;
  }

  async removeContainer(workspaceName: string): Promise<void> {
    const containerPath = this.getContainerPath(workspaceName);
    // force: true keeps this idempotent (no error if already removed).
    await fs.rm(containerPath, { recursive: true, force: true });
  }
}
