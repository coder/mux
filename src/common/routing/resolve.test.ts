import { describe, expect, test } from "bun:test";

import { availableRoutes, isModelAvailable, resolveRoute } from "./resolve";

const MODEL = "anthropic:claude-opus-4-6";

function createIsConfigured(configuredProviders: string[]): (provider: string) => boolean {
  const configuredSet = new Set(configuredProviders);
  return (provider: string): boolean => configuredSet.has(provider);
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

  test("falls back to direct when nothing is configured", () => {
    const resolved = resolveRoute(MODEL, ["mux-gateway", "openrouter", "direct"], {}, () => false);

    expect(resolved.routeProvider).toBe("anthropic");
    expect(resolved.routeModelId).toBe("claude-opus-4-6");
  });

  test("skips bedrock because it cannot auto-construct gateway IDs", () => {
    const resolved = resolveRoute(
      MODEL,
      ["bedrock", "direct"],
      {},
      createIsConfigured(["bedrock", "anthropic"])
    );

    expect(resolved.routeProvider).toBe("anthropic");
  });
});

describe("isModelAvailable", () => {
  test("returns true when direct route is configured", () => {
    expect(isModelAvailable(MODEL, createIsConfigured(["anthropic"]))).toBe(true);
  });

  test("returns true when gateway route is configured", () => {
    expect(isModelAvailable(MODEL, createIsConfigured(["openrouter"]))).toBe(true);
  });

  test("returns false when no route is configured", () => {
    expect(isModelAvailable(MODEL, () => false)).toBe(false);
  });
});

describe("availableRoutes", () => {
  test("returns all eligible gateways plus direct with configuration status", () => {
    const routes = availableRoutes(MODEL, createIsConfigured(["openrouter"]));

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
        route: "direct",
        displayName: "Direct (Anthropic)",
        isConfigured: false,
      },
    ]);
  });
});
