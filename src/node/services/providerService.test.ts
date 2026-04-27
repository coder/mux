import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ProviderModelEntry } from "@/common/orpc/types";
import { Config } from "@/node/config";
import { PolicyService } from "@/node/services/policyService";
import { ProviderService } from "./providerService";

function withTempConfig(run: (config: Config, service: ProviderService) => void): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
  try {
    const config = new Config(tmpDir);
    const service = new ProviderService(config);
    run(config, service);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function withTempConfigAsync(
  run: (config: Config, service: ProviderService) => Promise<void>
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
  try {
    const config = new Config(tmpDir);
    const service = new ProviderService(config);
    await run(config, service);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

function withProviderEnv(
  updates: Partial<Record<(typeof PROVIDER_ENV_KEYS)[number], string>>,
  run: () => void
): void {
  const previous = new Map<string, string | undefined>();
  for (const key of PROVIDER_ENV_KEYS) {
    previous.set(key, process.env[key]);
    const nextValue = updates[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }

  try {
    run();
  } finally {
    for (const key of PROVIDER_ENV_KEYS) {
      const previousValue = previous.get(key);
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}

describe("ProviderService.getConfig", () => {
  it("surfaces valid OpenAI serviceTier", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          serviceTier: "flex",
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.apiKeySet).toBe(true);
      expect(cfg.openai.isEnabled).toBe(true);
      expect(cfg.openai.serviceTier).toBe("flex");
      expect(Object.prototype.hasOwnProperty.call(cfg.openai, "serviceTier")).toBe(true);
    });
  });

  it("omits invalid OpenAI serviceTier", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          // Intentionally invalid
          serviceTier: "fast",
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.apiKeySet).toBe(true);
      expect(cfg.openai.isEnabled).toBe(true);
      expect(cfg.openai.serviceTier).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(cfg.openai, "serviceTier")).toBe(false);
    });
  });

  it("surfaces valid OpenAI wireFormat", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          wireFormat: "chatCompletions",
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.wireFormat).toBe("chatCompletions");
      expect(Object.prototype.hasOwnProperty.call(cfg.openai, "wireFormat")).toBe(true);
    });
  });

  it("omits invalid OpenAI wireFormat", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          wireFormat: "graphql",
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.wireFormat).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(cfg.openai, "wireFormat")).toBe(false);
    });
  });

  it("surfaces store: false for OpenAI", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          store: false,
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.store).toBe(false);
    });
  });

  it("omits store when not set for OpenAI", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
      });

      const cfg = service.getConfig();

      expect(Object.prototype.hasOwnProperty.call(cfg.openai, "store")).toBe(false);
    });
  });

  it("surfaces non-secret op:// API key references", () => {
    withTempConfig((config, service) => {
      const opRef = "op://Personal/Anthropic/credential";
      config.saveProvidersConfig({
        anthropic: {
          apiKey: opRef,
        },
      });

      const cfg = service.getConfig();

      expect(cfg.anthropic.apiKeySet).toBe(true);
      expect(cfg.anthropic.apiKeyIsOpRef).toBe(true);
      expect(cfg.anthropic.apiKeyOpRef).toBe(opRef);
    });
  });

  it("marks providers disabled when enabled is false", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.apiKeySet).toBe(true);
      expect(cfg.openai.isEnabled).toBe(false);
      expect(cfg.openai.isConfigured).toBe(false);
    });
  });

  it("marks mux-gateway disabled when muxGatewayEnabled is false in main config", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
        },
      });

      const defaultMainConfig = config.loadConfigOrDefault();
      const loadConfigSpy = spyOn(config, "loadConfigOrDefault");
      loadConfigSpy.mockReturnValue({
        ...defaultMainConfig,
        muxGatewayEnabled: false,
      });

      try {
        const cfg = service.getConfig();

        expect(cfg["mux-gateway"].couponCodeSet).toBe(true);
        expect(cfg["mux-gateway"].isEnabled).toBe(false);
        expect(cfg["mux-gateway"].isConfigured).toBe(false);
      } finally {
        loadConfigSpy.mockRestore();
      }
    });
  });

  it("treats disabled OpenAI as unconfigured even when Codex OAuth tokens are stored", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          enabled: false,
          codexOauth: {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.codexOauthSet).toBe(true);
      expect(cfg.openai.isEnabled).toBe(false);
      expect(cfg.openai.isConfigured).toBe(false);
    });
  });

  it("returns env sourced OpenAI base URL without saving it as baseUrl", () => {
    withProviderEnv(
      {
        OPENAI_API_KEY: "sk-env",
        OPENAI_BASE_URL: "https://env.openai.test",
      },
      () => {
        withTempConfig((_config, service) => {
          const cfg = service.getConfig();

          expect(cfg.openai.isConfigured).toBe(true);
          expect(cfg.openai.apiKeySource).toBe("env");
          expect(cfg.openai.baseUrl).toBeUndefined();
          expect(cfg.openai.baseUrlSource).toBe("env");
          expect(cfg.openai.baseUrlResolved).toBe("https://env.openai.test");
        });
      }
    );
  });

  it("returns env sourced base URL metadata when OpenAI API key is missing", () => {
    withProviderEnv(
      {
        OPENAI_BASE_URL: "https://env.openai.test",
      },
      () => {
        withTempConfig((_config, service) => {
          const cfg = service.getConfig();

          expect(cfg.openai.isConfigured).toBe(false);
          expect(cfg.openai.apiKeySource).toBeUndefined();
          expect(cfg.openai.baseUrl).toBeUndefined();
          expect(cfg.openai.baseUrlSource).toBe("env");
          expect(cfg.openai.baseUrlResolved).toBe("https://env.openai.test");
        });
      }
    );
  });

  it("returns legacy baseURL config as editable baseUrl", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          baseURL: "https://legacy.openai.test",
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.baseUrl).toBe("https://legacy.openai.test");
      expect(cfg.openai.baseUrlSource).toBe("config");
      expect(cfg.openai.baseUrlResolved).toBe("https://legacy.openai.test");
    });
  });

  it("returns config sourced Anthropic base URL ahead of env", () => {
    withProviderEnv(
      {
        ANTHROPIC_API_KEY: "sk-ant-env",
        ANTHROPIC_BASE_URL: "https://env.anthropic.test",
      },
      () => {
        withTempConfig((config, service) => {
          config.saveProvidersConfig({
            anthropic: {
              apiKey: "sk-ant-config",
              baseUrl: "https://config.anthropic.test",
            },
          });

          const cfg = service.getConfig();

          expect(cfg.anthropic.isConfigured).toBe(true);
          expect(cfg.anthropic.apiKeySource).toBe("config");
          expect(cfg.anthropic.baseUrl).toBe("https://config.anthropic.test");
          expect(cfg.anthropic.baseUrlSource).toBe("config");
          expect(cfg.anthropic.baseUrlResolved).toBe("https://config.anthropic.test");
        });
      }
    );
  });

  it("does not label forced base URL as env sourced", () => {
    withProviderEnv(
      {
        OPENAI_API_KEY: "sk-env",
        OPENAI_BASE_URL: "https://env.openai.test",
      },
      () => {
        withTempConfig((config) => {
          const policyService = new PolicyService(config);
          const isEnforcedSpy = spyOn(policyService, "isEnforced").mockReturnValue(true);
          const isProviderAllowedSpy = spyOn(policyService, "isProviderAllowed").mockReturnValue(
            true
          );
          const getForcedBaseUrlSpy = spyOn(policyService, "getForcedBaseUrl").mockReturnValue(
            "https://forced.openai.test"
          );
          const getEffectivePolicySpy = spyOn(policyService, "getEffectivePolicy").mockReturnValue(
            null
          );
          const service = new ProviderService(config, policyService);

          try {
            const cfg = service.getConfig();

            expect(cfg.openai.baseUrl).toBe("https://forced.openai.test");
            expect(cfg.openai.baseUrlSource).toBeUndefined();
            expect(cfg.openai.baseUrlResolved).toBeUndefined();
          } finally {
            isEnforcedSpy.mockRestore();
            isProviderAllowedSpy.mockRestore();
            getForcedBaseUrlSpy.mockRestore();
            getEffectivePolicySpy.mockRestore();
          }
        });
      }
    );
  });
});

describe("ProviderService model normalization", () => {
  it("normalizes malformed model entries when reading config", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          models: [
            "  gpt-5  ",
            { id: "custom-model", contextWindowTokens: 128_000 },
            { id: "custom-model", contextWindowTokens: 64_000 },
            { id: "no-context", contextWindowTokens: 0 },
            { id: "" },
            42,
          ] as unknown as ProviderModelEntry[],
        },
      });

      const cfg = service.getConfig();
      expect(cfg.openai.models).toEqual([
        "gpt-5",
        { id: "custom-model", contextWindowTokens: 128_000 },
        "no-context",
      ]);
    });
  });

  it("normalizes malformed model entries before persisting", () => {
    withTempConfig((config, service) => {
      const result = service.setModels("openai", [
        "  gpt-5  ",
        { id: "custom-model", contextWindowTokens: 100_000 },
        { id: "custom-model", contextWindowTokens: 64_000 },
        { id: "no-context", contextWindowTokens: 0 },
        { id: "" },
        42,
      ] as unknown as ProviderModelEntry[]);

      expect(result.success).toBe(true);
      const providersConfig = config.loadProvidersConfig();
      expect(providersConfig?.openai?.models).toEqual([
        "gpt-5",
        { id: "custom-model", contextWindowTokens: 100_000 },
        "no-context",
      ]);
    });
  });
});

describe("ProviderService.setConfig", () => {
  it("seeds first-time mux-gateway defaults without GPT-5.2 Codex", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.setConfig("mux-gateway", ["couponCode"], "gateway-token");
      expect(result.success).toBe(true);

      const providersConfig = config.loadProvidersConfig();
      expect(providersConfig?.["mux-gateway"]?.models).toEqual([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-opus-4-7",
        "openai/gpt-5.5",
      ]);
      expect(providersConfig?.["mux-gateway"]?.models).not.toContain("openai/gpt-5.2-codex");
    });
  });

  it("removes legacy baseURL alias when editing canonical baseUrl", async () => {
    await withTempConfigAsync(async (config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          baseURL: "https://legacy.openai.test",
        },
      });

      const updateResult = await service.setConfig(
        "openai",
        ["baseUrl"],
        "https://canonical.openai.test"
      );
      expect(updateResult.success).toBe(true);
      expect(config.loadProvidersConfig()?.openai?.baseURL).toBeUndefined();
      expect(config.loadProvidersConfig()?.openai?.baseUrl).toBe("https://canonical.openai.test");

      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          baseURL: "https://legacy.openai.test",
        },
      });

      const clearResult = await service.setConfig("openai", ["baseUrl"], "");
      expect(clearResult.success).toBe(true);
      expect(config.loadProvidersConfig()?.openai?.baseURL).toBeUndefined();
      expect(config.loadProvidersConfig()?.openai?.baseUrl).toBeUndefined();
    });
  });

  it("stores enabled=false without deleting existing credentials", async () => {
    await withTempConfigAsync(async (config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          baseUrl: "https://api.openai.com/v1",
        },
      });

      const disableResult = await service.setConfig("openai", ["enabled"], "false");
      expect(disableResult.success).toBe(true);

      const afterDisable = config.loadProvidersConfig();
      expect(afterDisable?.openai?.apiKey).toBe("sk-test");
      expect(afterDisable?.openai?.baseUrl).toBe("https://api.openai.com/v1");
      expect(afterDisable?.openai?.enabled).toBe(false);

      const enableResult = await service.setConfig("openai", ["enabled"], "");
      expect(enableResult.success).toBe(true);

      const afterEnable = config.loadProvidersConfig();
      expect(afterEnable?.openai?.apiKey).toBe("sk-test");
      expect(afterEnable?.openai?.baseUrl).toBe("https://api.openai.com/v1");
      expect(afterEnable?.openai?.enabled).toBeUndefined();
    });
  });

  it("surfaces valid Anthropic cacheTtl", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
    try {
      const config = new Config(tmpDir);
      config.saveProvidersConfig({
        anthropic: {
          apiKey: "sk-ant-test",
          cacheTtl: "1h",
        },
      });

      const service = new ProviderService(config);
      const cfg = service.getConfig();

      expect(cfg.anthropic.apiKeySet).toBe(true);
      expect(cfg.anthropic.cacheTtl).toBe("1h");
      expect(Object.prototype.hasOwnProperty.call(cfg.anthropic, "cacheTtl")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("omits invalid Anthropic cacheTtl", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
    try {
      const config = new Config(tmpDir);
      config.saveProvidersConfig({
        anthropic: {
          apiKey: "sk-ant-test",
          // Intentionally invalid
          cacheTtl: "24h",
        },
      });

      const service = new ProviderService(config);
      const cfg = service.getConfig();

      expect(cfg.anthropic.apiKeySet).toBe(true);
      expect(cfg.anthropic.cacheTtl).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(cfg.anthropic, "cacheTtl")).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("surfaces disableBetaFeatures: true for Anthropic", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        anthropic: { apiKey: "sk-ant-test", disableBetaFeatures: true },
      });

      const cfg = service.getConfig();

      expect(cfg.anthropic.disableBetaFeatures).toBe(true);
    });
  });

  it("omits disableBetaFeatures when not set for Anthropic", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        anthropic: { apiKey: "sk-ant-test" },
      });

      const cfg = service.getConfig();

      expect(Object.prototype.hasOwnProperty.call(cfg.anthropic, "disableBetaFeatures")).toBe(
        false
      );
    });
  });
});

describe("ProviderService denied keyPath segments", () => {
  for (const deniedSegment of ["__proto__", "prototype", "constructor"] as const) {
    it(`setConfigValue rejects ${deniedSegment} in keyPath`, async () => {
      await withTempConfigAsync(async (config, service) => {
        const result = await service.setConfigValue(
          "openai",
          ["auth", deniedSegment, "token"],
          "sk-test"
        );

        expect(result).toEqual({
          success: false,
          error: `Denied key path segment: "${deniedSegment}"`,
        });
        expect(config.loadProvidersConfig()).toBeNull();
      });
    });
  }

  it("setConfig rejects __proto__ in keyPath", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.setConfig("openai", ["auth", "__proto__", "token"], "sk-test");

      expect(result).toEqual({
        success: false,
        error: 'Denied key path segment: "__proto__"',
      });
      expect(config.loadProvidersConfig()).toBeNull();
    });
  });
});

describe("ProviderService gateway lifecycle", () => {
  it("auto-inserts gateway into routePriority when configured", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["direct"],
      });

      const result = await service.setConfig("mux-gateway", ["couponCode"], "gateway-token");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["mux-gateway", "direct"]);
    });
  });

  it("does not auto-insert configured-but-disabled gateways into routePriority", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["direct"],
      });
      config.saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
        },
      });

      const result = await service.setConfig("mux-gateway", ["enabled"], false);

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["direct"]);
    });
  });

  it("auto-removes gateway from routePriority when disabled", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["mux-gateway", "direct"],
      });
      config.saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
        },
      });

      const result = await service.setConfig("mux-gateway", ["enabled"], false);

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["direct"]);
    });
  });

  it("does not auto-insert bedrock into routePriority when only region is configured", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["direct"],
      });

      const result = await service.setConfig("bedrock", ["region"], "us-east-1");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["direct"]);
    });
  });

  it("preserves manual bedrock routePriority entry when only region is configured", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["bedrock", "direct"],
      });
      config.saveProvidersConfig({
        bedrock: { region: "us-east-1" },
      });

      // Updating the region should not remove the manually added bedrock route,
      // even though Bedrock is not auto-route-eligible without auth signals.
      const result = await service.setConfig("bedrock", ["region"], "us-west-2");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toContain("bedrock");
    });
  });

  it("removes bedrock from routePriority when fully deconfigured", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["bedrock", "direct"],
      });
      config.saveProvidersConfig({
        bedrock: { region: "us-east-1" },
      });

      // Clearing the region leaves Bedrock fully deconfigured — should remove.
      const result = await service.setConfig("bedrock", ["region"], "");

      expect(result.success).toBe(true);
      const updatedPriority = config.loadConfigOrDefault().routePriority ?? ["direct"];
      expect(updatedPriority).not.toContain("bedrock");
    });
  });

  it("removes bedrock from routePriority when explicitly disabled", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["bedrock", "direct"],
      });
      config.saveProvidersConfig({
        bedrock: { region: "us-east-1" },
      });

      const result = await service.setConfig("bedrock", ["enabled"], false);

      expect(result.success).toBe(true);
      const updatedPriority = config.loadConfigOrDefault().routePriority ?? ["direct"];
      expect(updatedPriority).not.toContain("bedrock");
    });
  });

  it("clears legacy muxGatewayEnabled: false when adding gateway to routePriority", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        muxGatewayEnabled: false,
        routePriority: ["direct"],
      });

      const result = await service.setConfig("mux-gateway", ["couponCode"], "token");

      expect(result.success).toBe(true);
      const updatedConfig = config.loadConfigOrDefault();
      expect(updatedConfig.routePriority).toEqual(["mux-gateway", "direct"]);
      expect(updatedConfig.muxGatewayEnabled).toBeUndefined();
    });
  });

  it("preserves user order when inserting a second gateway before direct", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["mux-gateway", "direct"],
      });
      config.saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
        },
      });

      const result = await service.setConfig("openrouter", ["apiKey"], "sk-or-test");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual([
        "mux-gateway",
        "openrouter",
        "direct",
      ]);
    });
  });

  it("appends gateway when direct is absent from routePriority", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["mux-gateway"],
      });
      config.saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
        },
      });

      const result = await service.setConfig("openrouter", ["apiKey"], "sk-or-test");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["mux-gateway", "openrouter"]);
    });
  });

  it("auto-removes gateway from routePriority when deconfigured", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["mux-gateway", "direct"],
      });
      config.saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
        },
      });

      const result = await service.setConfig("mux-gateway", ["couponCode"], "");

      expect(result.success).toBe(true);
      const updatedPriority = config.loadConfigOrDefault().routePriority ?? ["direct"];
      expect(updatedPriority).not.toContain("mux-gateway");
    });
  });

  it("clears stale muxGatewayEnabled: false when gateway is already in routePriority", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        muxGatewayEnabled: false,
        routePriority: ["mux-gateway", "direct"],
      });

      const result = await service.setConfig("mux-gateway", ["couponCode"], "test-token");

      expect(result.success).toBe(true);
      const updatedConfig = config.loadConfigOrDefault();
      expect(updatedConfig.routePriority).toEqual(["mux-gateway", "direct"]);
      expect(updatedConfig.muxGatewayEnabled).toBeUndefined();
      expect(service.getConfig()["mux-gateway"].isEnabled).toBe(true);
    });
  });

  it("does not duplicate gateway already in routePriority", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["mux-gateway", "direct"],
      });

      const result = await service.setConfig("mux-gateway", ["couponCode"], "gateway-token");

      expect(result.success).toBe(true);
      const updatedPriority = config.loadConfigOrDefault().routePriority ?? [];
      expect(updatedPriority.filter((provider) => provider === "mux-gateway")).toHaveLength(1);
    });
  });

  it("does not modify routePriority for direct providers", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["direct"],
      });
      const initialRoutePriority = config.loadConfigOrDefault().routePriority;

      const result = await service.setConfig("anthropic", ["apiKey"], "sk-ant-test");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(initialRoutePriority);
    });
  });

  it("setConfigValue also triggers lifecycle", async () => {
    await withTempConfigAsync(async (config, service) => {
      const existingConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...existingConfig,
        routePriority: ["direct"],
      });

      const result = await service.setConfigValue("mux-gateway", ["couponCode"], "gateway-token");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["mux-gateway", "direct"]);
    });
  });
});
