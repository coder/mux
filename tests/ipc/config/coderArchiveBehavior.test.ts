import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("config.coderArchiveBehavior", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await createTestEnvironment();
  });

  afterEach(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("returns default stop behavior", async () => {
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.coderWorkspaceArchiveBehavior).toBe("stop");
    expect(cfg.worktreeArchiveBehavior).toBe("keep");
  });

  it("persists keep behavior", async () => {
    await env.orpc.config.updateCoderPrefs({
      coderWorkspaceArchiveBehavior: "keep",
      worktreeArchiveBehavior: "delete",
    });
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.coderWorkspaceArchiveBehavior).toBe("keep");

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.stopCoderWorkspaceOnArchive).toBe(false);
    expect(loaded.worktreeArchiveBehavior).toBe("delete");
    expect(loaded.deleteWorktreeOnArchive).toBe(true);
  });

  it("persists stop behavior", async () => {
    await env.orpc.config.updateCoderPrefs({
      coderWorkspaceArchiveBehavior: "stop",
      worktreeArchiveBehavior: "keep",
    });
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.coderWorkspaceArchiveBehavior).toBe("stop");
  });

  it("persists delete behavior", async () => {
    await env.orpc.config.updateCoderPrefs({
      coderWorkspaceArchiveBehavior: "delete",
      worktreeArchiveBehavior: "snapshot",
    });
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.coderWorkspaceArchiveBehavior).toBe("delete");
    expect(cfg.worktreeArchiveBehavior).toBe("snapshot");
  });
});
