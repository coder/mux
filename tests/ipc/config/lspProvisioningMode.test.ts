import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";
import { cleanupTempGitRepo, createTempGitRepo, createWorkspace } from "../helpers";

describe("config.lspProvisioningMode", () => {
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

  it("defaults to manual mode", async () => {
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.lspProvisioningMode).toBe("manual");
  });

  it("persists non-default provisioning mode and clears it when reset", async () => {
    await env.orpc.config.updateLspProvisioningMode({ mode: "auto" });

    let cfg = await env.orpc.config.getConfig();
    expect(cfg.lspProvisioningMode).toBe("auto");
    expect(env.config.loadConfigOrDefault().lspProvisioningMode).toBe("auto");

    await env.orpc.config.updateLspProvisioningMode({ mode: "manual" });

    cfg = await env.orpc.config.getConfig();
    expect(cfg.lspProvisioningMode).toBe("manual");
    expect(env.config.loadConfigOrDefault().lspProvisioningMode).toBeUndefined();
  });

  it("disposes active LSP workspaces after provisioning-mode changes", async () => {
    const firstRepo = await createTempGitRepo();
    const secondRepo = await createTempGitRepo();
    tempRepos.push(firstRepo, secondRepo);

    const firstWorkspace = await createWorkspace(env, firstRepo, "lsp-provisioning-mode-a");
    const secondWorkspace = await createWorkspace(env, secondRepo, "lsp-provisioning-mode-b");
    expect(firstWorkspace.success).toBe(true);
    expect(secondWorkspace.success).toBe(true);
    if (!firstWorkspace.success || !secondWorkspace.success) {
      throw new Error("Expected workspace creation to succeed before LSP invalidation");
    }

    const disposeSpy = jest.spyOn(env.services.lspManager, "disposeWorkspace");

    await env.orpc.config.updateLspProvisioningMode({ mode: "auto" });

    expect(disposeSpy).toHaveBeenCalledTimes(2);
    expect(disposeSpy).toHaveBeenCalledWith(firstWorkspace.metadata.id);
    expect(disposeSpy).toHaveBeenCalledWith(secondWorkspace.metadata.id);
  });
});
