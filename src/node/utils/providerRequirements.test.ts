import { describe, expect, it } from "bun:test";

import type { ProvidersConfig } from "@/node/config";
import {
  buildProvidersFromEnv,
  hasAnyConfiguredProvider,
  resolveProviderCredentials,
} from "./providerRequirements";

describe("resolveProviderCredentials", () => {
  it("supports OpenAI Entra auth from config when baseUrl is provided", () => {
    const result = resolveProviderCredentials(
      "openai",
      {
        authMode: "entra",
        baseUrl: "https://myendpoint.openai.azure.com",
      },
      {}
    );

    expect(result).toMatchObject({
      isConfigured: true,
      authMode: "entra",
      baseUrl: "https://myendpoint.openai.azure.com",
    });
    expect(result.apiKey).toBeUndefined();
  });

  it("supports OpenAI Entra auth from environment variables", () => {
    const result = resolveProviderCredentials(
      "openai",
      {},
      {
        OPENAI_AUTH_MODE: "entra",
        OPENAI_BASE_URL: "https://env-endpoint.openai.azure.com",
      }
    );

    expect(result).toMatchObject({
      isConfigured: true,
      authMode: "entra",
      baseUrl: "https://env-endpoint.openai.azure.com",
    });
    expect(result.apiKey).toBeUndefined();
  });

  it("prioritizes API key auth over Entra mode", () => {
    const result = resolveProviderCredentials(
      "openai",
      {
        apiKey: "sk-xxx",
        authMode: "entra",
      },
      {}
    );

    expect(result).toMatchObject({
      isConfigured: true,
      apiKey: "sk-xxx",
    });
    expect(result.authMode).toBeUndefined();
  });

  it("requires baseUrl when OpenAI authMode is entra", () => {
    const result = resolveProviderCredentials(
      "openai",
      {
        authMode: "entra",
      },
      {}
    );

    expect(result).toEqual({
      isConfigured: false,
      missingRequirement: "api_key",
    });
  });

  it("ignores authMode for non-OpenAI providers", () => {
    const result = resolveProviderCredentials(
      "anthropic",
      {
        authMode: "entra",
        baseUrl: "https://anthropic.example.com",
      },
      {}
    );

    expect(result).toEqual({
      isConfigured: false,
      missingRequirement: "api_key",
    });
  });
});

describe("buildProvidersFromEnv", () => {
  it("builds OpenAI config with Entra auth when OPENAI_AUTH_MODE and OPENAI_BASE_URL are set", () => {
    const providers = buildProvidersFromEnv({
      OPENAI_AUTH_MODE: "entra",
      OPENAI_BASE_URL: "https://entra-endpoint.openai.azure.com",
    });

    expect(providers.openai).toEqual({
      authMode: "entra",
      baseUrl: "https://entra-endpoint.openai.azure.com",
    });
  });

  it("keeps existing OpenAI API key bootstrap behavior", () => {
    const providers = buildProvidersFromEnv({
      OPENAI_API_KEY: "sk-xxx",
    });

    expect(providers.openai).toEqual({ apiKey: "sk-xxx" });
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

  it("returns true for OpenAI Entra auth configuration", () => {
    const providers: ProvidersConfig = {
      openai: {
        authMode: "entra",
        baseUrl: "https://myendpoint.openai.azure.com",
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
