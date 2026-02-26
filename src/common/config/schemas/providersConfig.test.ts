import { describe, expect, it } from "bun:test";

import { ProvidersConfigSchema } from "./providersConfig";

describe("ProvidersConfigSchema", () => {
  it("validates a valid providers config with anthropic key", () => {
    const valid = {
      anthropic: { apiKey: "sk-ant-123", cacheTtl: "5m" },
    };

    expect(ProvidersConfigSchema.safeParse(valid).success).toBe(true);
  });

  it("validates openrouter routing config", () => {
    const valid = {
      openrouter: { apiKey: "or-123", order: "quality", allow_fallbacks: true },
    };

    expect(ProvidersConfigSchema.safeParse(valid).success).toBe(true);
  });

  it("validates bedrock region config", () => {
    const valid = {
      bedrock: { region: "us-east-1", accessKeyId: "AKIA..." },
    };

    expect(ProvidersConfigSchema.safeParse(valid).success).toBe(true);
  });

  it("allows unknown provider keys via catchall", () => {
    const valid = {
      "custom-provider": { apiKey: "key", baseUrl: "http://localhost:8080" },
    };

    expect(ProvidersConfigSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects invalid cacheTtl for anthropic", () => {
    const invalid = {
      anthropic: { cacheTtl: "invalid" },
    };

    expect(ProvidersConfigSchema.safeParse(invalid).success).toBe(false);
  });
});
