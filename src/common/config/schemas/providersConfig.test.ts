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

  describe("modelParameters", () => {
    it("accepts valid per-model and wildcard overrides", () => {
      const valid = {
        openai: {
          modelParameters: {
            "gpt-5": { max_output_tokens: 1024, temperature: 0.4 },
            "*": { top_p: 0.9 },
          },
        },
      };

      expect(ProvidersConfigSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects negative max_output_tokens", () => {
      const invalid = {
        openai: {
          modelParameters: {
            "gpt-5": { max_output_tokens: -1 },
          },
        },
      };

      expect(ProvidersConfigSchema.safeParse(invalid).success).toBe(false);
    });

    it("rejects temperature values above 2", () => {
      const invalid = {
        openai: {
          modelParameters: {
            "gpt-5": { temperature: 3 },
          },
        },
      };

      expect(ProvidersConfigSchema.safeParse(invalid).success).toBe(false);
    });

    it("rejects top_p values above 1", () => {
      const invalid = {
        openai: {
          modelParameters: {
            "gpt-5": { top_p: 1.5 },
          },
        },
      };

      expect(ProvidersConfigSchema.safeParse(invalid).success).toBe(false);
    });

    it("passes through unknown override keys", () => {
      const valid = {
        openai: {
          modelParameters: {
            "gpt-5": { transforms: ["middle-out"] },
          },
        },
      };

      const parsed = ProvidersConfigSchema.safeParse(valid);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.openai?.modelParameters?.["gpt-5"]).toEqual({
          transforms: ["middle-out"],
        });
      }
    });

    it("allows provider configs without modelParameters", () => {
      const valid = {
        openai: { apiKey: "sk-openai-123" },
      };

      expect(ProvidersConfigSchema.safeParse(valid).success).toBe(true);
    });
  });
});
