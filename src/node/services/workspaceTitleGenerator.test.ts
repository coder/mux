import { describe, it, expect } from "bun:test";
import { getPreferredNameModel } from "./workspaceTitleGenerator";
import type { Config } from "@/node/config";

describe("workspaceTitleGenerator", () => {
  it("getPreferredNameModel returns null when no providers configured", () => {
    // Save and clear env vars
    const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const savedAnthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    try {
      const mockConfig = {
        loadProvidersConfig: () => null,
      } as unknown as Config;

      expect(getPreferredNameModel(mockConfig)).toBeNull();
    } finally {
      // Restore env vars
      if (savedAnthropicKey) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
      if (savedAnthropicToken) process.env.ANTHROPIC_AUTH_TOKEN = savedAnthropicToken;
    }
  });

  it("getPreferredNameModel prefers anthropic when configured", () => {
    const mockConfig = {
      loadProvidersConfig: () => ({
        anthropic: { apiKey: "test-key" },
      }),
    } as unknown as Config;

    const model = getPreferredNameModel(mockConfig);
    expect(model).toContain("anthropic");
  });

  it("getPreferredNameModel falls back to openai when anthropic not configured", () => {
    // Save and clear env vars
    const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const savedAnthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    try {
      const mockConfig = {
        loadProvidersConfig: () => ({
          openai: { apiKey: "test-key" },
        }),
      } as unknown as Config;

      const model = getPreferredNameModel(mockConfig);
      expect(model).toContain("openai");
    } finally {
      // Restore env vars
      if (savedAnthropicKey) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
      if (savedAnthropicToken) process.env.ANTHROPIC_AUTH_TOKEN = savedAnthropicToken;
    }
  });
});
