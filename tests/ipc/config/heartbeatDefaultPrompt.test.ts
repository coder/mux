import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("config.updateHeartbeatDefaultPrompt", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("persists a trimmed heartbeat default prompt", async () => {
    await env.orpc.config.updateHeartbeatDefaultPrompt({
      defaultPrompt: "  Review the workspace and propose the next concrete task.  ",
    });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.heartbeatDefaultPrompt).toBe(
      "Review the workspace and propose the next concrete task."
    );

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.heartbeatDefaultPrompt).toBe(
      "Review the workspace and propose the next concrete task."
    );
  });

  it("clears the heartbeat default prompt for empty or whitespace-only input", async () => {
    await env.orpc.config.updateHeartbeatDefaultPrompt({
      defaultPrompt: "Keep this around for now.",
    });
    await env.orpc.config.updateHeartbeatDefaultPrompt({
      defaultPrompt: "   ",
    });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.heartbeatDefaultPrompt).toBeUndefined();

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.heartbeatDefaultPrompt).toBeUndefined();
  });
});
