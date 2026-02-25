import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import {
  ProviderModelFactory,
  buildAIProviderRequestHeaders,
  modelCostsIncluded,
  MUX_AI_PROVIDER_USER_AGENT,
  resolveAIProviderHeaderSource,
} from "./providerModelFactory";
import { ProviderService } from "./providerService";

async function withTempConfig(
  run: (config: Config, factory: ProviderModelFactory) => Promise<void> | void
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-model-factory-"));

  try {
    const config = new Config(tmpDir);
    const providerService = new ProviderService(config);
    const factory = new ProviderModelFactory(config, providerService);
    await run(config, factory);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("ProviderModelFactory.createModel", () => {
  it("returns provider_disabled when a non-gateway provider is disabled", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
      });

      const result = await factory.createModel("openai:gpt-5");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          type: "provider_disabled",
          provider: "openai",
        });
      }
    });
  });

  it("does not return provider_disabled when provider is enabled and credentials exist", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
      });

      const result = await factory.createModel("openai:gpt-5");

      if (!result.success) {
        expect(result.error.type).not.toBe("provider_disabled");
      }
    });
  });

  it("routes allowlisted models through gateway automatically", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        muxGatewayEnabled: true,
        muxGatewayModels: ["openai:gpt-5"],
      });

      const result = await factory.createModel("openai:gpt-5");
      if (!result.success) {
        expect(result.error.type).not.toBe("provider_disabled");
      }
    });
  });
});

describe("ProviderModelFactory modelCostsIncluded", () => {
  it("marks gpt-5.3-codex as subscription-covered when routed through Codex OAuth", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          codexOauth: {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "test-account-id",
          },
        },
      });

      const result = await factory.createModel(KNOWN_MODELS.GPT_53_CODEX.id);
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(modelCostsIncluded(result.data)).toBe(true);
    });
  });

  it("does not mark gpt-5.3-codex as subscription-covered when routed through API key", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
      });

      const result = await factory.createModel(KNOWN_MODELS.GPT_53_CODEX.id);
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(modelCostsIncluded(result.data)).toBe(false);
    });
  });
});
describe("ProviderModelFactory.resolveGatewayModelString", () => {
  it("routes through gateway when provider is disabled but gateway is configured and model is allowlisted", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        muxGatewayEnabled: true,
        muxGatewayModels: ["openai:gpt-5"],
      });

      const resolved = factory.resolveGatewayModelString("openai:gpt-5", "openai:gpt-5", false);

      expect(resolved).toBe("mux-gateway:openai/gpt-5");
    });
  });

  it("keeps disabled provider blocked when gateway is not configured", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        muxGatewayEnabled: true,
        muxGatewayModels: ["openai:gpt-5"],
      });

      const resolved = factory.resolveGatewayModelString("openai:gpt-5", "openai:gpt-5", false);
      expect(resolved).toBe("openai:gpt-5");

      const result = await factory.createModel(resolved);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          type: "provider_disabled",
          provider: "openai",
        });
      }
    });
  });
});

describe("resolveAIProviderHeaderSource", () => {
  it("uses Request headers when init.headers is not provided", () => {
    const input = new Request("https://example.com", {
      headers: {
        Authorization: "Bearer test-token",
      },
    });

    const result = resolveAIProviderHeaderSource(input, undefined);
    const headers = new Headers(result);

    expect(headers.get("authorization")).toBe("Bearer test-token");
  });

  it("prefers init.headers over Request headers", () => {
    const input = new Request("https://example.com", {
      headers: {
        Authorization: "Bearer test-token",
      },
    });

    const result = resolveAIProviderHeaderSource(input, {
      headers: {
        "x-custom": "value",
      },
    });
    const headers = new Headers(result);

    expect(headers.get("x-custom")).toBe("value");
    expect(headers.get("authorization")).toBeNull();
  });

  it("returns undefined for non-Request inputs without init headers", () => {
    const result = resolveAIProviderHeaderSource("https://example.com", undefined);
    expect(result).toBeUndefined();
  });
});

describe("buildAIProviderRequestHeaders", () => {
  it("adds User-Agent when no headers exist", () => {
    const result = buildAIProviderRequestHeaders(undefined);
    expect(result.get("user-agent")).toBe(MUX_AI_PROVIDER_USER_AGENT);
  });

  it("does not overwrite an existing User-Agent", () => {
    const result = buildAIProviderRequestHeaders({ "User-Agent": "custom-agent/1.0" });
    expect(result.get("user-agent")).toBe("custom-agent/1.0");
  });

  it("preserves existing headers while injecting User-Agent", () => {
    const existing = { "x-custom": "value" };
    const existingSnapshot = { ...existing };

    const result = buildAIProviderRequestHeaders(existing);

    expect(result.get("x-custom")).toBe("value");
    expect(result.get("user-agent")).toBe(MUX_AI_PROVIDER_USER_AGENT);
    expect(existing).toEqual(existingSnapshot);
  });
});
