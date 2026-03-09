import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("config.updateModelPreferences", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("persists model preferences", async () => {
    await env.orpc.config.updateModelPreferences({
      defaultModel: "openai:gpt-4o",
      hiddenModels: ["openai:gpt-4o-mini"],
    });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.defaultModel).toBe("openai:gpt-4o");
    expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.defaultModel).toBe("openai:gpt-4o");
    expect(cfg.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
  });
});
