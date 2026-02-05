import type { TestEnvironment } from "./setup";
import { cleanupTestEnvironment, createTestEnvironment } from "./setup";

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

  it("persists model preferences and allows clearing preferredCompactionModel", async () => {
    await env.orpc.config.updateModelPreferences({
      defaultModel: "openai:gpt-4o",
      hiddenModels: ["openai:gpt-4o-mini"],
      preferredCompactionModel: "openai:gpt-4o",
    });

    const loaded1 = env.config.loadConfigOrDefault();
    expect(loaded1.defaultModel).toBe("openai:gpt-4o");
    expect(loaded1.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
    expect(loaded1.preferredCompactionModel).toBe("openai:gpt-4o");

    await env.orpc.config.updateModelPreferences({ preferredCompactionModel: "" });

    const loaded2 = env.config.loadConfigOrDefault();
    expect(loaded2.preferredCompactionModel).toBeUndefined();
    expect(loaded2.defaultModel).toBe("openai:gpt-4o");
    expect(loaded2.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
  });
});
