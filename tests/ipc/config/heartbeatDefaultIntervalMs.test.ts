import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("config.updateHeartbeatDefaultIntervalMs", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("persists a heartbeat default interval", async () => {
    const intervalMs = 45 * 60 * 1000;

    await env.orpc.config.updateHeartbeatDefaultIntervalMs({ intervalMs });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.heartbeatDefaultIntervalMs).toBe(intervalMs);

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.heartbeatDefaultIntervalMs).toBe(intervalMs);
  });

  it("clears the heartbeat default interval when null is provided", async () => {
    await env.orpc.config.updateHeartbeatDefaultIntervalMs({ intervalMs: 45 * 60 * 1000 });
    await env.orpc.config.updateHeartbeatDefaultIntervalMs({ intervalMs: null });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.heartbeatDefaultIntervalMs).toBeUndefined();

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.heartbeatDefaultIntervalMs).toBeUndefined();
  });
});
