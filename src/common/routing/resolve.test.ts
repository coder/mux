import { describe, expect, test } from "bun:test";

import { availableRoutes, isModelAvailable, resolveRoute } from "./resolve";

const MODEL = "anthropic:claude-opus-4-6";
const OPENAI_MODEL = "openai:gpt-5.4";

function createIsConfigured(configuredProviders: string[]): (provider: string) => boolean {
  const configuredSet = new Set(configuredProviders);
  return (provider: string): boolean => configuredSet.has(provider);
}

function isModelAvailableForRoutes(options: {
  modelId: string;
  configuredProviders: string[];
  routePriority: string[];
  routeOverrides?: Record<string, string>;
}): boolean {
  return isModelAvailable(
    options.modelId,
    options.routePriority,
    options.routeOverrides ?? {},
    createIsConfigured(options.configuredProviders)
  );
}

describe("resolveRoute", () => {
  test("walks route priority: mux-gateway, then openrouter, then direct", () => {
    const routePriority = ["mux-gateway", "openrouter", "direct"];

    const firstConfigured = resolveRoute(
      MODEL,
      routePriority,
      {},
      createIsConfigured(["mux-gateway", "openrouter", "anthropic"])
    );
    expect(firstConfigured.routeProvider).toBe("mux-gateway");
    expect(firstConfigured.routeModelId).toBe("anthropic/claude-opus-4-6");

    const secondConfigured = resolveRoute(
      MODEL,
      routePriority,
      {},
      createIsConfigured(["openrouter", "anthropic"])
    );
    expect(secondConfigured.routeProvider).toBe("openrouter");
    expect(secondConfigured.routeModelId).toBe("anthropic/claude-opus-4-6");

    const thirdConfigured = resolveRoute(
      MODEL,
      routePriority,
      {},
      createIsConfigured(["anthropic"])
    );
    expect(thirdConfigured.routeProvider).toBe("anthropic");
    expect(thirdConfigured.routeModelId).toBe("claude-opus-4-6");
  });

  test("routes OpenAI models through GitHub Copilot without adding a prefix", () => {
    const resolved = resolveRoute(
      OPENAI_MODEL,
      ["github-copilot", "direct"],
      {},
      createIsConfigured(["github-copilot", "openai"])
    );

    expect(resolved.routeProvider).toBe("github-copilot");
    expect(resolved.routeModelId).toBe("gpt-5.4");
  });

  test("supports per-model override to specific gateway", () => {
    const resolved = resolveRoute(
      MODEL,
      ["mux-gateway", "direct"],
      { [MODEL]: "openrouter" },
      createIsConfigured(["openrouter", "mux-gateway", "anthropic"])
    );

    expect(resolved.routeProvider).toBe("openrouter");
    expect(resolved.routeModelId).toBe("anthropic/claude-opus-4-6");
  });

  test("supports per-model override to GitHub Copilot for OpenAI models", () => {
    const resolved = resolveRoute(
      OPENAI_MODEL,
      ["direct"],
      { [OPENAI_MODEL]: "github-copilot" },
      createIsConfigured(["github-copilot"])
    );

    expect(resolved.routeProvider).toBe("github-copilot");
    expect(resolved.routeModelId).toBe("gpt-5.4");
  });

  test("direct override still resolves directly when origin is configured", () => {
    const resolved = resolveRoute(
      MODEL,
      ["mux-gateway", "openrouter"],
      { [MODEL]: "direct" },
      createIsConfigured(["mux-gateway", "openrouter", "anthropic"])
    );

    expect(resolved.routeProvider).toBe("anthropic");
    expect(resolved.routeModelId).toBe("claude-opus-4-6");
  });

  test("direct override falls through when origin is not configured", () => {
    const resolved = resolveRoute(
      MODEL,
      ["mux-gateway", "openrouter", "direct"],
      { [MODEL]: "direct" },
      createIsConfigured(["mux-gateway", "openrouter"])
    );

    expect(resolved.routeProvider).toBe("mux-gateway");
    expect(resolved.routeModelId).toBe("anthropic/claude-opus-4-6");
  });

  test("origin-name override falls through when origin is not configured", () => {
    const resolved = resolveRoute(
      MODEL,
      ["openrouter", "direct"],
      { [MODEL]: "anthropic" },
      createIsConfigured(["openrouter"])
    );

    expect(resolved.routeProvider).toBe("openrouter");
    expect(resolved.routeModelId).toBe("anthropic/claude-opus-4-6");
  });

  test("falls through priority list when override gateway is unconfigured", () => {
    const resolved = resolveRoute(
      MODEL,
      ["mux-gateway", "direct"],
      { [MODEL]: "openrouter" },
      createIsConfigured(["mux-gateway", "anthropic"])
    );

    expect(resolved.routeProvider).toBe("mux-gateway");
  });

  test('matches "direct" route entry when origin is configured', () => {
    const resolved = resolveRoute(
      MODEL,
      ["direct", "openrouter"],
      {},
      createIsConfigured(["anthropic", "openrouter"])
    );

    expect(resolved.routeProvider).toBe("anthropic");
    expect(resolved.routeModelId).toBe("claude-opus-4-6");
  });

  test("falls through when GitHub Copilot cannot route the model origin", () => {
    const resolved = resolveRoute(
      MODEL,
      ["github-copilot", "direct"],
      {},
      createIsConfigured(["github-copilot", "anthropic"])
    );

    expect(resolved.routeProvider).toBe("anthropic");
    expect(resolved.routeModelId).toBe("claude-opus-4-6");
  });

  test("falls back to direct when nothing is configured", () => {
    const resolved = resolveRoute(MODEL, ["mux-gateway", "openrouter", "direct"], {}, () => false);

    expect(resolved.routeProvider).toBe("anthropic");
    expect(resolved.routeModelId).toBe("claude-opus-4-6");
  });

  test("routes Anthropic models through Bedrock with dot-separated format", () => {
    const resolved = resolveRoute(
      MODEL,
      ["bedrock", "direct"],
      {},
      createIsConfigured(["bedrock", "anthropic"])
    );

    expect(resolved.routeProvider).toBe("bedrock");
    expect(resolved.routeModelId).toBe("anthropic.claude-opus-4-6");
  });
});

describe("isModelAvailable", () => {
  test("returns true when direct route is configured", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["anthropic"],
        routePriority: ["direct"],
      })
    ).toBe(true);
  });

  test("returns true when gateway route is configured", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["openrouter"],
        routePriority: ["openrouter", "direct"],
      })
    ).toBe(true);
  });

  test("returns true when Bedrock can route the model", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["bedrock"],
        routePriority: ["bedrock", "direct"],
      })
    ).toBe(true);
  });

  test("returns true when GitHub Copilot can route an OpenAI model", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: OPENAI_MODEL,
        configuredProviders: ["github-copilot"],
        routePriority: ["github-copilot", "direct"],
      })
    ).toBe(true);
  });

  test("returns false when a configured gateway is absent from routePriority", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["openrouter"],
        routePriority: ["direct"],
      })
    ).toBe(false);
  });

  test("returns true when an override selects a configured gateway outside routePriority", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["openrouter"],
        routePriority: ["direct"],
        routeOverrides: { [MODEL]: "openrouter" },
      })
    ).toBe(true);
  });

  test("falls through an unconfigured override to a viable priority route", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: ["bedrock"],
        routePriority: ["bedrock", "direct"],
        routeOverrides: { [MODEL]: "openrouter" },
      })
    ).toBe(true);
  });

  test("returns false when no route is configured", () => {
    expect(
      isModelAvailableForRoutes({
        modelId: MODEL,
        configuredProviders: [],
        routePriority: ["mux-gateway", "openrouter", "direct"],
      })
    ).toBe(false);
  });
});

describe("availableRoutes", () => {
  test("includes GitHub Copilot for OpenAI models when configured", () => {
    const routes = availableRoutes(OPENAI_MODEL, createIsConfigured(["github-copilot"]));

    expect(routes).toEqual([
      {
        route: "mux-gateway",
        displayName: "Mux Gateway",
        isConfigured: false,
      },
      {
        route: "openrouter",
        displayName: "OpenRouter",
        isConfigured: false,
      },
      {
        route: "github-copilot",
        displayName: "GitHub Copilot",
        isConfigured: true,
      },
      {
        route: "direct",
        displayName: "Direct (OpenAI)",
        isConfigured: false,
      },
    ]);
  });

  test("returns all eligible gateways plus direct with configuration status", () => {
    const routes = availableRoutes(MODEL, createIsConfigured(["openrouter", "bedrock"]));

    expect(routes).toEqual([
      {
        route: "mux-gateway",
        displayName: "Mux Gateway",
        isConfigured: false,
      },
      {
        route: "openrouter",
        displayName: "OpenRouter",
        isConfigured: true,
      },
      {
        route: "bedrock",
        displayName: "Bedrock",
        isConfigured: true,
      },
      {
        route: "direct",
        displayName: "Direct (Anthropic)",
        isConfigured: false,
      },
    ]);
  });
});
