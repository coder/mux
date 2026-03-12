import { describe, expect, it } from "bun:test";

import type { ProvidersConfig } from "@/node/config";
import { hasAnyConfiguredProvider, isProviderAutoRouteEligible } from "./providerRequirements";

describe("isProviderAutoRouteEligible", () => {
  it("returns false for bedrock when only a region is configured", () => {
    expect(isProviderAutoRouteEligible("bedrock", { region: "us-east-1" }, {})).toBe(false);
  });

  it("returns true for bedrock when config includes a credential pair", () => {
    expect(
      isProviderAutoRouteEligible(
        "bedrock",
        { region: "us-east-1", accessKeyId: "x", secretAccessKey: "y" },
        {}
      )
    ).toBe(true);
  });

  it("returns false for bedrock when env only exposes a region", () => {
    expect(isProviderAutoRouteEligible("bedrock", {}, { AWS_REGION: "us-east-1" })).toBe(false);
  });

  it("returns true for bedrock when env exposes region and credential pair", () => {
    expect(
      isProviderAutoRouteEligible(
        "bedrock",
        {},
        {
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "x",
          AWS_SECRET_ACCESS_KEY: "y",
        }
      )
    ).toBe(true);
  });

  it("returns false for disabled non-bedrock providers even when configured", () => {
    expect(
      isProviderAutoRouteEligible("mux-gateway", { couponCode: "x", enabled: false }, {})
    ).toBe(false);
  });

  it("returns true for non-bedrock providers when enabled is omitted", () => {
    expect(isProviderAutoRouteEligible("mux-gateway", { couponCode: "x" }, {})).toBe(true);
  });

  it("returns true for non-bedrock providers when explicitly enabled", () => {
    expect(isProviderAutoRouteEligible("mux-gateway", { couponCode: "x", enabled: true }, {})).toBe(
      true
    );
  });
});

describe("hasAnyConfiguredProvider", () => {
  it("returns false for null or empty config", () => {
    expect(hasAnyConfiguredProvider(null)).toBe(false);
    expect(hasAnyConfiguredProvider({})).toBe(false);
  });

  it("returns true when a provider has an API key", () => {
    const providers: ProvidersConfig = {
      anthropic: { apiKey: "sk-ant-test" },
    };

    expect(hasAnyConfiguredProvider(providers)).toBe(true);
  });

  it("returns true for OpenAI Codex OAuth-only configuration", () => {
    const providers: ProvidersConfig = {
      openai: {
        codexOauth: {
          type: "oauth",
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "acct_123",
        },
      },
    };

    expect(hasAnyConfiguredProvider(providers)).toBe(true);
  });

  it("returns true for keyless providers with explicit config", () => {
    const providers: ProvidersConfig = {
      ollama: {
        baseUrl: "http://localhost:11434/api",
      },
    };

    expect(hasAnyConfiguredProvider(providers)).toBe(true);
  });
});
