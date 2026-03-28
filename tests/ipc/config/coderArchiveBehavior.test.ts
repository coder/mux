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
    expect(cfg.deleteWorktreeOnArchive).toBe(false);
  });

  it("persists keep behavior", async () => {
    await env.orpc.config.updateCoderPrefs({
      coderWorkspaceArchiveBehavior: "keep",
      deleteWorktreeOnArchive: true,
    });
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.coderWorkspaceArchiveBehavior).toBe("keep");

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.stopCoderWorkspaceOnArchive).toBe(false);
    expect(loaded.deleteWorktreeOnArchive).toBe(true);
  });

  it("persists stop behavior", async () => {
    await env.orpc.config.updateCoderPrefs({
      coderWorkspaceArchiveBehavior: "stop",
      deleteWorktreeOnArchive: false,
    });
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.coderWorkspaceArchiveBehavior).toBe("stop");
  });

  it("persists delete behavior", async () => {
    await env.orpc.config.updateCoderPrefs({
      coderWorkspaceArchiveBehavior: "delete",
      deleteWorktreeOnArchive: false,
    });
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.coderWorkspaceArchiveBehavior).toBe("delete");
  });
});
