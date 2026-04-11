import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("config.saveConfig advisor settings", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("round-trips advisor globals and trims the model string", async () => {
    const initialConfig = await env.orpc.config.getConfig();

    expect(initialConfig.advisorModelString).toBeNull();
    expect(initialConfig.advisorMaxUsesPerTurn).toBeUndefined();

    await env.orpc.config.saveConfig({
      taskSettings: initialConfig.taskSettings,
      advisorModelString: " openai:gpt-4o ",
      advisorMaxUsesPerTurn: 4,
    });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.advisorModelString).toBe("openai:gpt-4o");
    expect(loaded.advisorMaxUsesPerTurn).toBe(4);

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.advisorModelString).toBe("openai:gpt-4o");
    expect(cfg.advisorMaxUsesPerTurn).toBe(4);
  });

  it("persists unlimited advisor mode as null", async () => {
    const initialConfig = await env.orpc.config.getConfig();

    await env.orpc.config.saveConfig({
      taskSettings: initialConfig.taskSettings,
      advisorModelString: "openai:gpt-4o",
      advisorMaxUsesPerTurn: 4,
    });

    await env.orpc.config.saveConfig({
      taskSettings: initialConfig.taskSettings,
      advisorModelString: null,
      advisorMaxUsesPerTurn: null,
    });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.advisorModelString).toBeUndefined();
    expect(loaded.advisorMaxUsesPerTurn).toBeNull();

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.advisorModelString).toBeNull();
    expect(cfg.advisorMaxUsesPerTurn).toBeNull();
  });
});
