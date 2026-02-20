import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ProviderModelEntry } from "@/common/orpc/types";
import { Config } from "@/node/config";
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
  it("stores enabled=false without deleting existing credentials", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          baseUrl: "https://api.openai.com/v1",
        },
      });

      const disableResult = service.setConfig("openai", ["enabled"], "false");
      expect(disableResult.success).toBe(true);

      const afterDisable = config.loadProvidersConfig();
      expect(afterDisable?.openai?.apiKey).toBe("sk-test");
      expect(afterDisable?.openai?.baseUrl).toBe("https://api.openai.com/v1");
      expect(afterDisable?.openai?.enabled).toBe(false);

      const enableResult = service.setConfig("openai", ["enabled"], "");
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
});
