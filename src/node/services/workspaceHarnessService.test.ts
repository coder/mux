import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { Config } from "@/node/config";

import { WorkspaceHarnessService } from "./workspaceHarnessService";

function getWorkspacePath(args: {
  srcDir: string;
  projectName: string;
  workspaceName: string;
}): string {
  return path.join(args.srcDir, args.projectName, args.workspaceName);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("WorkspaceHarnessService (journal)", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-harness-journal-test-"));
    config = new Config(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function setupWorkspace(): Promise<{
    workspaceId: string;
    workspaceName: string;
    workspacePath: string;
  }> {
    const projectPath = "/fake/project";
    const workspaceId = "ws-id";
    const workspaceName = "branch";

    const workspacePath = getWorkspacePath({
      srcDir: config.srcDir,
      projectName: "project",
      workspaceName,
    });
    await fs.mkdir(workspacePath, { recursive: true });

    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });

    return { workspaceId, workspaceName, workspacePath };
  }

  it("creates a journal file when writing harness config", async () => {
    const { workspaceId, workspaceName, workspacePath } = await setupWorkspace();

    const service = new WorkspaceHarnessService(config);
    await service.setHarnessForWorkspace(workspaceId, {
      version: 1,
      checklist: [],
      gates: [],
      loop: {},
    });

    const journalPath = path.join(workspacePath, ".mux", "harness", `${workspaceName}.progress.md`);

    expect(await pathExists(journalPath)).toBe(true);

    const contents = await fs.readFile(journalPath, "utf-8");
    expect(contents).toContain("# Harness journal (append-only)");
    expect(contents).toContain("## Entry template");
    expect(contents).toContain(`.mux/harness/${workspaceName}.jsonc`);
  });

  it("does not overwrite an existing journal file", async () => {
    const { workspaceId, workspaceName, workspacePath } = await setupWorkspace();

    const service = new WorkspaceHarnessService(config);
    await service.setHarnessForWorkspace(workspaceId, {
      version: 1,
      checklist: [],
      gates: [],
      loop: {},
    });

    const journalPath = path.join(workspacePath, ".mux", "harness", `${workspaceName}.progress.md`);

    await fs.writeFile(journalPath, "CUSTOM\n", "utf-8");

    await service.updateProgressFile(workspaceId);
    await service.setHarnessForWorkspace(workspaceId, {
      version: 1,
      checklist: [{ id: "item-1", title: "Do something", status: "todo" }],
      gates: [],
      loop: {},
    });

    const after = await fs.readFile(journalPath, "utf-8");
    expect(after).toBe("CUSTOM\n");
  });
});
