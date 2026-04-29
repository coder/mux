import * as path from "node:path";
import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";
import { cleanupTempGitRepo, createTempGitRepo, createWorkspace } from "../helpers";

describe("projects.setTrust", () => {
  let env: TestEnvironment;
  const tempRepos: string[] = [];

  beforeEach(async () => {
    env = await createTestEnvironment();
  });

  afterEach(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
    await Promise.all(tempRepos.splice(0).map((repoPath) => cleanupTempGitRepo(repoPath)));
  });

  it("disposes only workspaces for the project whose trust changed", async () => {
    const firstRepo = await createTempGitRepo();
    const secondRepo = await createTempGitRepo();
    tempRepos.push(firstRepo, secondRepo);

    const firstWorkspace = await createWorkspace(env, firstRepo, "lsp-trust-a");
    const secondWorkspace = await createWorkspace(env, secondRepo, "lsp-trust-b");
    expect(firstWorkspace.success).toBe(true);
    expect(secondWorkspace.success).toBe(true);
    if (!firstWorkspace.success || !secondWorkspace.success) {
      throw new Error("Expected workspace creation to succeed before LSP invalidation");
    }

    const disposeSpy = jest.spyOn(env.services.lspManager, "disposeWorkspace");

    await env.orpc.projects.setTrust({
      projectPath: `${firstRepo}${path.sep}`,
      trusted: false,
    });

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy).toHaveBeenCalledWith(firstWorkspace.metadata.id);
    expect(disposeSpy).not.toHaveBeenCalledWith(secondWorkspace.metadata.id);
  });
});
