import { describe, expect, test } from "bun:test";

import type { ProvidersConfigMap } from "@/common/orpc/types";
import { isModelServableWithProvidersConfig } from "./modelAvailability";

const MODEL = "anthropic:claude-haiku-4-5";

function providers(entry: { isConfigured: boolean; isEnabled?: boolean }): ProvidersConfigMap {
  return { anthropic: entry } as unknown as ProvidersConfigMap;
}

describe("isModelServableWithProvidersConfig", () => {
  test("serves a model whose direct provider is configured", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: ["direct"],
        providersConfig: providers({ isConfigured: true }),
      })
    ).toBe(true);
  });

  test("rejects a model whose provider is not configured", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: ["direct"],
        providersConfig: providers({ isConfigured: false }),
      })
    ).toBe(false);
  });

  test("a disabled provider does not count as configured", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: ["direct"],
        providersConfig: providers({ isConfigured: true, isEnabled: false }),
      })
    ).toBe(false);
  });

  test("a configured provider outside the route priority list cannot serve", () => {
    // Availability must honor route priority (matching a real send), not just
    // "some provider somewhere is configured".
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: [],
        providersConfig: providers({ isConfigured: true }),
      })
    ).toBe(false);
  });

  test("route priority defaults to direct when omitted", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        providersConfig: providers({ isConfigured: true }),
      })
    ).toBe(true);
  });
});
