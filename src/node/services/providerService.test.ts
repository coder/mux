import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import { writeFile } from "node:fs/promises";
import * as os from "os";
import * as path from "path";
import type { ProviderModelEntry } from "@/common/orpc/types";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { Config } from "@/node/config";
import { log } from "@/node/services/log";
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

async function withTempPolicyProviderService(
  policy: unknown,
  run: (
    config: Config,
    service: ProviderService,
    policyService: PolicyService
  ) => Promise<void> | void
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
  const policyPath = path.join(tmpDir, "policy.json");
  const prevPolicyFileEnv = process.env.MUX_POLICY_FILE;
  let policyService: PolicyService | null = null;

  try {
    const config = new Config(tmpDir);
    await writeFile(policyPath, JSON.stringify(policy), "utf-8");
    process.env.MUX_POLICY_FILE = policyPath;

    policyService = new PolicyService(config);
    await policyService.initialize();
    const service = new ProviderService(config, policyService);
    await run(config, service, policyService);
  } finally {
    policyService?.dispose();
    if (prevPolicyFileEnv === undefined) {
      delete process.env.MUX_POLICY_FILE;
    } else {
      process.env.MUX_POLICY_FILE = prevPolicyFileEnv;
    }
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

  it("surfaces keyless custom OpenAI-compatible providers", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        "local-vllm": {
          providerType: "openai-compatible",
          displayName: "Local vLLM",
          baseUrl: "http://localhost:8000/v1",
        },
      });

      const cfg = service.getConfig();

      expect(cfg["local-vllm"]).toEqual({
        apiKeySet: false,
        apiKeyIsOpRef: undefined,
        apiKeyOpRef: undefined,
        apiKeyOpLabel: undefined,
        apiKeyFile: undefined,
        apiKeySource: "keyless",
        baseUrl: "http://localhost:8000/v1",
        models: [],
        displayName: "Local vLLM",
        providerType: "openai-compatible",
        isCustom: true,
        isEnabled: true,
        isConfigured: true,
      });
    });
  });

  it("surfaces disabled custom providers as unconfigured", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        "local-vllm": {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
          enabled: false,
        },
      });

      const cfg = service.getConfig();

      expect(cfg["local-vllm"].isCustom).toBe(true);
      expect(cfg["local-vllm"].isEnabled).toBe(false);
      expect(cfg["local-vllm"].isConfigured).toBe(false);
    });
  });

  it("omits unknown provider keys without a custom providerType", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        "future-provider": {
          apiKey: "sk-future",
          baseUrl: "https://future.example/v1",
        },
      });

      const cfg = service.getConfig();

      expect(Object.prototype.hasOwnProperty.call(cfg, "future-provider")).toBe(false);
    });
  });

  it("keeps built-in providers alongside custom providers", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
        "local-vllm": {
          providerType: "openai-compatible",
          baseURL: "http://localhost:8000/v1",
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.apiKeySet).toBe(true);
      expect(cfg.openai.isConfigured).toBe(true);
      expect(cfg["local-vllm"].baseUrl).toBe("http://localhost:8000/v1");
      expect(cfg["local-vllm"].isConfigured).toBe(true);
      expect(service.list()).toContain("local-vllm");
    });
  });

  it("prefers shadowed custom provider config over a built-in provider id", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          providerType: "openai-compatible",
          displayName: "Shadowed OpenAI",
          baseUrl: "http://localhost:8000/v1",
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.isCustom).toBe(true);
      expect(cfg.openai.displayName).toBe("Shadowed OpenAI");
      expect(cfg.openai.apiKeySource).toBe("keyless");
      expect(service.list().filter((provider) => provider === "openai")).toHaveLength(1);
    });
  });

  it("logs shadowed custom provider ids once per detected set", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        openai: {
          providerType: "openai-compatible",
          displayName: "Shadowed OpenAI",
          baseUrl: "http://localhost:8000/v1",
        },
      });
      const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);

      try {
        service.list();
        service.getConfig();
        service.getConfig();
        expect(warnSpy).toHaveBeenCalledTimes(1);

        service.notifyConfigChanged();
        service.getConfig();
        service.list();
        expect(warnSpy).toHaveBeenCalledTimes(2);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("filters custom providers by enforced provider policy", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [
          { id: "openai" },
          {
            id: "local-vllm",
            base_url: "http://policy.local/v1",
            model_access: ["llama-3"],
          },
        ],
      },
      (config, service) => {
        config.saveProvidersConfig({
          "local-vllm": {
            providerType: "openai-compatible",
            baseUrl: "http://localhost:8000/v1",
            models: ["llama-3", "mistral"],
          },
          "another-custom": {
            providerType: "openai-compatible",
            baseUrl: "http://localhost:8001/v1",
            models: ["other-model"],
          },
        });

        const cfg = service.getConfig();
        expect(cfg.openai).toBeDefined();
        expect(cfg["local-vllm"].baseUrl).toBe("http://policy.local/v1");
        expect(cfg["local-vllm"].models).toEqual(["llama-3"]);
        expect(cfg["another-custom"]).toBeUndefined();
        expect(service.list()).toContain("local-vllm");
        expect(service.list()).not.toContain("another-custom");

        const result = service.setModels("another-custom", ["other-model"]);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("not allowed by policy");
        }
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

describe("ProviderService custom provider mutations", () => {
  it("rejects adding a built-in provider id", () => {
    withTempConfig((config, service) => {
      const result = service.addCustomOpenAICompatibleProvider({
        provider: "openai",
        baseUrl: "https://api.example.com/v1",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("built_in_provider");
      }
      expect(config.loadProvidersConfig()).toBeNull();
    });
  });

  it("rejects invalid custom provider ids with the validation reason", () => {
    withTempConfig((config, service) => {
      const result = service.addCustomOpenAICompatibleProvider({
        provider: "Bad Provider",
        baseUrl: "https://api.example.com/v1",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("invalid_provider_id");
        expect(result.error.reason).toContain("whitespace");
      }
      expect(config.loadProvidersConfig()).toBeNull();
    });
  });

  it("rejects duplicate custom provider ids", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        "local-vllm": {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
        },
      });

      const result = service.addCustomOpenAICompatibleProvider({
        provider: "local-vllm",
        baseUrl: "https://api.example.com/v1",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("duplicate_provider");
      }
    });
  });

  for (const baseUrl of ["", "   ", "not a url", "ftp://api.example.com/v1"] as const) {
    it(`rejects invalid base URL ${JSON.stringify(baseUrl)}`, () => {
      withTempConfig((config, service) => {
        const result = service.addCustomOpenAICompatibleProvider({
          provider: "local-vllm",
          baseUrl,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("invalid_base_url");
        }
        expect(config.loadProvidersConfig()).toBeNull();
      });
    });
  }

  it("adds a custom OpenAI-compatible provider and returns provider info", () => {
    withTempConfig((config, service) => {
      const result = service.addCustomOpenAICompatibleProvider({
        provider: " local-vllm ",
        displayName: " Local vLLM ",
        baseUrl: " http://localhost:8000/v1 ",
        apiKey: " sk-local ",
        apiKeyFile: " /tmp/local-vllm-key ",
        models: [
          " llama-3 ",
          { id: " mixtral ", contextWindowTokens: 32_768, mappedToModel: " openai/gpt-4o " },
          { id: " mixtral ", contextWindowTokens: 16_384 },
          { id: " " },
        ] as unknown as ProviderModelEntry[],
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(result.error.message);
      }

      expect(result.data).toMatchObject({
        apiKeySet: true,
        isCustom: true,
        displayName: "Local vLLM",
        providerType: "openai-compatible",
        isEnabled: true,
        isConfigured: true,
        baseUrl: "http://localhost:8000/v1",
      });
      expect(result.data.models).toEqual([
        "llama-3",
        { id: "mixtral", contextWindowTokens: 32_768, mappedToModel: "openai/gpt-4o" },
      ]);

      expect(config.loadProvidersConfig()?.["local-vllm"]).toEqual({
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
        enabled: true,
        displayName: "Local vLLM",
        apiKey: "sk-local",
        apiKeyFile: "/tmp/local-vllm-key",
        models: [
          "llama-3",
          { id: "mixtral", contextWindowTokens: 32_768, mappedToModel: "openai/gpt-4o" },
        ],
      });
    });
  });

  it("rejects provider ids denied by enforced policy", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "openai" }],
      },
      (config, service) => {
        const result = service.addCustomOpenAICompatibleProvider({
          provider: "local-vllm",
          baseUrl: "http://localhost:8000/v1",
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("policy_denied");
        }
        expect(config.loadProvidersConfig()).toBeNull();
      }
    );
  });

  it("rejects forced base URL mismatches from enforced policy", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "local-vllm", base_url: "http://policy.local/v1" }],
      },
      (config, service) => {
        const result = service.addCustomOpenAICompatibleProvider({
          provider: "local-vllm",
          baseUrl: "http://localhost:8000/v1",
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("policy_denied");
        }
        expect(config.loadProvidersConfig()).toBeNull();
      }
    );
  });

  it("rejects initial models denied by enforced policy", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "local-vllm", model_access: ["llama-3"] }],
      },
      (config, service) => {
        const result = service.addCustomOpenAICompatibleProvider({
          provider: "local-vllm",
          baseUrl: "http://localhost:8000/v1",
          models: ["llama-3", "mixtral"],
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("policy_denied");
        }
        expect(config.loadProvidersConfig()).toBeNull();
      }
    );
  });

  it("rejects removing a built-in provider id", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.removeCustomProvider("openai");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("built_in_provider");
      }
      expect(config.loadProvidersConfig()).toBeNull();
    });
  });

  it("rejects removing a built-in providers config entry without a custom discriminator", async () => {
    await withTempConfigAsync(async (config, service) => {
      config.saveProvidersConfig({
        openai: { apiKey: "sk-test" },
      });

      const result = await service.removeCustomProvider("openai");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("built_in_provider");
      }
      expect(config.loadProvidersConfig()?.openai?.apiKey).toBe("sk-test");
    });
  });

  it("removes a shadowed built-in custom provider from providers config", async () => {
    await withTempConfigAsync(async (config, service) => {
      config.saveProvidersConfig({
        openai: {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
        },
      });
      await config.saveConfig({
        ...config.loadConfigOrDefault(),
        defaultModel: "openai:gpt-4.1",
      });

      const result = await service.removeCustomProvider("openai");

      expect(result.success).toBe(true);
      expect(config.loadProvidersConfig()?.openai).toBeUndefined();
      expect(config.loadConfigOrDefault().defaultModel).toBeUndefined();
    });
  });

  it("rejects removing unknown providers", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.removeCustomProvider("local-vllm");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("unknown_provider");
      }
      expect(config.loadProvidersConfig()).toBeNull();
    });
  });

  it("rejects removing non-custom provider entries", async () => {
    await withTempConfigAsync(async (config, service) => {
      config.saveProvidersConfig({
        "future-provider": {
          baseUrl: "https://future.example/v1",
        },
      });

      const result = await service.removeCustomProvider("future-provider");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("not_custom_provider");
      }
      expect(config.loadProvidersConfig()?.["future-provider"]).toEqual({
        baseUrl: "https://future.example/v1",
      });
    });
  });

  it("removes a valid custom provider from providers config", async () => {
    await withTempConfigAsync(async (config, service) => {
      config.saveProvidersConfig({
        openai: { apiKey: "sk-test" },
        "local-vllm": {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
        },
        "other-custom": {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8001/v1",
        },
      });

      const result = await service.removeCustomProvider("local-vllm");

      expect(result.success).toBe(true);
      const providersConfig = config.loadProvidersConfig();
      expect(providersConfig?.["local-vllm"]).toBeUndefined();
      expect(providersConfig?.openai?.apiKey).toBe("sk-test");
      expect(providersConfig?.["other-custom"]?.baseUrl).toBe("http://localhost:8001/v1");
    });
  });

  it("does not repair app config if provider deletion fails", async () => {
    await withTempConfigAsync(async (config, service) => {
      config.saveProvidersConfig({
        "local-vllm": {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
        },
      });
      await config.saveConfig({
        ...config.loadConfigOrDefault(),
        defaultModel: "local-vllm:qwen3-coder",
      });
      const saveProvidersConfigSpy = spyOn(config, "saveProvidersConfig");
      saveProvidersConfigSpy.mockImplementationOnce(() => {
        throw new Error("disk is read-only");
      });

      try {
        const result = await service.removeCustomProvider("local-vllm");

        expect(result.success).toBe(false);
        expect(config.loadConfigOrDefault().defaultModel).toBe("local-vllm:qwen3-coder");
        expect(config.loadProvidersConfig()?.["local-vllm"]).toBeDefined();
      } finally {
        saveProvidersConfigSpy.mockRestore();
      }
    });
  });

  it("reports partial success and notifies when config repair fails after deletion", async () => {
    await withTempConfigAsync(async (config, service) => {
      config.saveProvidersConfig({
        "local-vllm": {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
        },
      });
      await config.saveConfig({
        ...config.loadConfigOrDefault(),
        defaultModel: "local-vllm:qwen3-coder",
      });
      let configChangedCount = 0;
      const unsubscribe = service.onConfigChanged(() => {
        configChangedCount += 1;
      });
      const editConfigSpy = spyOn(config, "editConfig");
      editConfigSpy.mockImplementationOnce(() => {
        throw new Error("config write failed");
      });

      try {
        const result = await service.removeCustomProvider("local-vllm");

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("config_repair_failed");
        }
        expect(config.loadProvidersConfig()?.["local-vllm"]).toBeUndefined();
        expect(config.loadConfigOrDefault().defaultModel).toBe("local-vllm:qwen3-coder");
        expect(configChangedCount).toBe(1);
      } finally {
        editConfigSpy.mockRestore();
        unsubscribe();
      }
    });
  });

  it("repairs durable app config references when removing a custom provider", async () => {
    await withTempConfigAsync(async (config, service) => {
      const provider = "local-vllm";
      config.saveProvidersConfig({
        openai: { apiKey: "sk-test" },
        [provider]: {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
        },
        "other-custom": {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8001/v1",
        },
      });
      await writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify(
          {
            projects: [
              [
                "/tmp/project",
                {
                  workspaces: [
                    {
                      path: "/tmp/project/workspace-a",
                      id: "workspace-a",
                      aiSettings: {
                        model: `${provider}:workspace-model`,
                        thinkingLevel: "high",
                      },
                      aiSettingsByAgent: {
                        exec: { model: `${provider}:workspace-agent`, thinkingLevel: "medium" },
                        plan: { model: "openai:gpt-5", thinkingLevel: "low" },
                      },
                    },
                    {
                      path: "/tmp/project/workspace-b",
                      id: "workspace-b",
                      aiSettings: {
                        model: "openai:gpt-5",
                        thinkingLevel: "low",
                      },
                      aiSettingsByAgent: {
                        exec: { model: `${provider}:only-agent`, thinkingLevel: "medium" },
                      },
                    },
                    {
                      path: "/tmp/project/workspace-c",
                      id: "workspace-c",
                      aiSettingsByAgent: {
                        exec: { model: "other-custom:model", thinkingLevel: "medium" },
                      },
                    },
                  ],
                },
              ],
            ],
            defaultModel: `${provider}:llama-3`,
            hiddenModels: [`${provider}:hidden`, "openai:gpt-5", "other-custom:model"],
            routeOverrides: {
              [`${provider}:llama-3`]: "direct",
              "openai:gpt-5": provider,
              "openai:gpt-4": "openai",
              "other-custom:model": "other-custom",
            },
            agentAiDefaults: {
              exec: {
                modelString: `${provider}:agent-model`,
                thinkingLevel: "high",
                enabled: false,
                advisorEnabled: true,
              },
              plan: { modelString: "openai:gpt-5", thinkingLevel: "medium" },
              review: { modelString: `${provider}:review-agent`, thinkingLevel: "low" },
              explore: { modelString: "other-custom:model", thinkingLevel: "medium" },
            },
            subagentAiDefaults: {
              review: { modelString: `${provider}:review-agent`, thinkingLevel: "low" },
              explore: { modelString: "other-custom:model", thinkingLevel: "medium" },
            },
          },
          null,
          2
        ),
        "utf-8"
      );

      const result = await service.removeCustomProvider(provider);

      expect(result.success).toBe(true);

      const freshConfig = new Config(config.rootDir);
      const providersConfig = freshConfig.loadProvidersConfig();
      expect(providersConfig?.[provider]).toBeUndefined();
      expect(providersConfig?.openai?.apiKey).toBe("sk-test");
      expect(providersConfig?.["other-custom"]?.baseUrl).toBe("http://localhost:8001/v1");

      const appConfig = freshConfig.loadConfigOrDefault();
      expect(appConfig.defaultModel).toBeUndefined();
      expect(appConfig.hiddenModels).toEqual(["openai:gpt-5", "other-custom:model"]);
      expect(appConfig.routeOverrides).toEqual({
        "openai:gpt-4": "openai",
        "other-custom:model": "other-custom",
      });
      expect(appConfig.agentAiDefaults?.exec).toEqual({
        thinkingLevel: "high",
        enabled: false,
        advisorEnabled: true,
      });
      expect(appConfig.agentAiDefaults?.plan).toEqual({
        modelString: "openai:gpt-5",
        thinkingLevel: "medium",
      });
      expect(appConfig.subagentAiDefaults?.review).toEqual({ thinkingLevel: "low" });
      expect(appConfig.subagentAiDefaults?.explore).toEqual({
        modelString: "other-custom:model",
        thinkingLevel: "medium",
      });

      const project = appConfig.projects.get("/tmp/project");
      expect(project).toBeDefined();
      if (!project) {
        throw new Error("Expected seeded project to reload");
      }
      expect(project.workspaces[0].aiSettings).toEqual({
        model: WORKSPACE_DEFAULTS.model,
        thinkingLevel: "high",
      });
      expect(project.workspaces[0].aiSettingsByAgent).toEqual({
        exec: { model: WORKSPACE_DEFAULTS.model, thinkingLevel: "medium" },
        plan: { model: "openai:gpt-5", thinkingLevel: "low" },
      });
      expect(project.workspaces[1].aiSettings).toEqual({
        model: "openai:gpt-5",
        thinkingLevel: "low",
      });
      expect(project.workspaces[1].aiSettingsByAgent).toEqual({
        exec: { model: WORKSPACE_DEFAULTS.model, thinkingLevel: "medium" },
      });
      expect(project.workspaces[2].aiSettingsByAgent).toEqual({
        exec: { model: "other-custom:model", thinkingLevel: "medium" },
      });
    });
  });

  it("preserves workspace thinking level when repairing a removed provider model", async () => {
    await withTempConfigAsync(async (config, service) => {
      const provider = "local-vllm";
      config.saveProvidersConfig({
        [provider]: {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
        },
      });
      await writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [
            [
              "/tmp/project",
              {
                workspaces: [
                  {
                    path: "/tmp/project/workspace-a",
                    id: "workspace-a",
                    aiSettings: {
                      model: `${provider}:workspace-model`,
                      thinkingLevel: "high",
                    },
                  },
                ],
              },
            ],
          ],
        })
      );

      const result = await service.removeCustomProvider(provider);

      expect(result.success).toBe(true);
      const freshConfig = new Config(config.rootDir).loadConfigOrDefault();
      const workspace = freshConfig.projects.get("/tmp/project")?.workspaces[0];
      expect(workspace?.aiSettings).toEqual({
        model: WORKSPACE_DEFAULTS.model,
        thinkingLevel: "high",
      });
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

  it("rejects baseURL edits when policy forces a base URL", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "openai", base_url: "https://forced.openai.test" }],
      },
      async (_config, service) => {
        const result = await service.setConfig("openai", ["baseURL"], "https://other.openai.test");

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("base URL is locked by policy");
        }
      }
    );
  });

  it("rejects invalid ids when setConfig creates an OpenAI-compatible provider", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.setConfig("bad provider", ["providerType"], "openai-compatible");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid custom provider id");
      }
      expect(config.loadProvidersConfig()?.["bad provider"]).toBeUndefined();
    });
  });

  it("rejects custom providers as route override targets", () => {
    withTempConfig((config, service) => {
      config.saveProvidersConfig({
        "local-vllm": {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
        },
      });

      const result = service.validateRouteOverrides({ "openai:gpt-5": "local-vllm" });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Custom providers are direct-only");
        expect(result.error).toContain("local-vllm");
      }
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
