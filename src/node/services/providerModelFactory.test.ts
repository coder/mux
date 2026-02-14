import { describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { LanguageModel } from "ai";
import { PROVIDER_REGISTRY } from "@/common/constants/providers";
import { Config } from "@/node/config";
import { ProviderModelFactory } from "./providerModelFactory";
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

const OPENAI_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_AUTH_MODE",
] as const;

type OpenAIEnvKey = (typeof OPENAI_ENV_KEYS)[number];

async function withOpenAIEnv(
  overrides: Partial<Record<OpenAIEnvKey, string>>,
  run: () => Promise<void>
): Promise<void> {
  const previousValues = new Map<OpenAIEnvKey, string | undefined>();

  for (const key of OPENAI_ENV_KEYS) {
    previousValues.set(key, process.env[key]);

    const nextValue = overrides[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }

  try {
    await run();
  } finally {
    for (const key of OPENAI_ENV_KEYS) {
      const previous = previousValues.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  }
}

function mockOpenAIProviderImport(): {
  state: { options?: Record<string, unknown>; modelId?: string };
  createOpenAI: ReturnType<typeof mock>;
  restore: () => void;
} {
  const state: { options?: Record<string, unknown>; modelId?: string } = {};
  const mockModel = {} as unknown as LanguageModel;

  const createOpenAI = mock((options: Record<string, unknown>) => {
    state.options = options;
    return {
      responses: (modelId: string) => {
        state.modelId = modelId;
        return mockModel;
      },
    };
  });

  const openAIImportSpy = spyOn(PROVIDER_REGISTRY, "openai").mockResolvedValue({
    createOpenAI,
  } as unknown as Awaited<ReturnType<(typeof PROVIDER_REGISTRY)["openai"]>>);

  return {
    state,
    createOpenAI,
    restore: () => {
      openAIImportSpy.mockRestore();
    },
  };
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

  describe("OpenAI Entra auth", () => {
    it("returns Ok for Entra auth when authMode=entra and baseUrl is set without API key", async () => {
      await withOpenAIEnv({}, async () => {
        const { state, restore } = mockOpenAIProviderImport();

        try {
          await withTempConfig(async (config, factory) => {
            config.saveProvidersConfig({
              openai: {
                authMode: "entra",
                baseUrl: "https://myendpoint.openai.azure.com",
              },
            });

            const result = await factory.createModel("openai:gpt-5");

            expect(result.success).toBe(true);
            expect(state.options).toBeDefined();
            expect(state.options?.apiKey).toBe("entra-managed");
            expect(state.options?.baseURL).toBe("https://myendpoint.openai.azure.com");
            expect(state.modelId).toBe("gpt-5");
          });
        } finally {
          restore();
        }
      });
    });

    it("uses API key auth when API key exists even if authMode=entra", async () => {
      await withOpenAIEnv({}, async () => {
        const { state, restore } = mockOpenAIProviderImport();

        try {
          await withTempConfig(async (config, factory) => {
            config.saveProvidersConfig({
              openai: {
                apiKey: "sk-test",
                authMode: "entra",
                baseUrl: "https://myendpoint.openai.azure.com",
              },
            });

            const result = await factory.createModel("openai:gpt-5");

            expect(result.success).toBe(true);
            expect(state.options?.apiKey).toBe("sk-test");
            expect(state.options?.baseURL).toBe("https://myendpoint.openai.azure.com");
          });
        } finally {
          restore();
        }
      });
    });

    it("returns api_key_not_found when authMode=entra but baseUrl is missing", async () => {
      await withOpenAIEnv({}, async () => {
        const { createOpenAI, restore } = mockOpenAIProviderImport();

        try {
          await withTempConfig(async (config, factory) => {
            config.saveProvidersConfig({
              openai: {
                authMode: "entra",
              },
            });

            const result = await factory.createModel("openai:gpt-5");

            expect(result.success).toBe(false);
            if (!result.success) {
              expect(result.error).toEqual({
                type: "api_key_not_found",
                provider: "openai",
              });
            }

            expect(createOpenAI).not.toHaveBeenCalled();
          });
        } finally {
          restore();
        }
      });
    });

    it("uses Entra auth when OPENAI_AUTH_MODE=entra is set via environment", async () => {
      await withOpenAIEnv(
        {
          OPENAI_AUTH_MODE: "entra",
          OPENAI_BASE_URL: "https://env-endpoint.openai.azure.com",
        },
        async () => {
          const { state, restore } = mockOpenAIProviderImport();

          try {
            await withTempConfig(async (config, factory) => {
              config.saveProvidersConfig({
                openai: {},
              });

              const result = await factory.createModel("openai:gpt-5");

              expect(result.success).toBe(true);
              expect(state.options?.apiKey).toBe("entra-managed");
              expect(state.options?.baseURL).toBe("https://env-endpoint.openai.azure.com");
            });
          } finally {
            restore();
          }
        }
      );
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
