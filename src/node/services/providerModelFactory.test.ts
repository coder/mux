import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { CODEX_ENDPOINT } from "@/common/constants/codexOAuth";
import { PROVIDER_REGISTRY } from "@/common/constants/providers";
import { resolveProviderOptionsNamespaceKey } from "@/common/utils/ai/providerOptions";
import { Ok } from "@/common/types/result";
import {
  ProviderModelFactory,
  buildAIProviderRequestHeaders,
  classifyCopilotInitiator,
  countAnthropicCacheBreakpoints,
  modelCostsIncluded,
  MUX_AI_PROVIDER_USER_AGENT,
  normalizeCodexResponsesBody,
  resolveAIProviderHeaderSource,
  wrapFetchWithAnthropicCacheControl,
} from "./providerModelFactory";
import { MUX_ANTHROPIC_EFFORT_OVERRIDE_HEADER } from "@/common/utils/ai/providerOptions";
import { CodexOauthService } from "./codexOauthService";
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

describe("normalizeCodexResponsesBody", () => {
  it("enforces Codex-compatible fields and lifts system prompts into instructions", () => {
    const normalized = JSON.parse(
      normalizeCodexResponsesBody(
        JSON.stringify({
          model: "gpt-5.3-codex",
          input: [
            { role: "system", content: "Follow project rules." },
            {
              role: "developer",
              content: [{ type: "text", text: "Use concise updates." }],
            },
            { role: "user", content: "Ship the fix." },
            { type: "item_reference", id: "rs_123" },
          ],
          store: true,
          truncation: "server-default",
          temperature: 0.2,
          metadata: { ignored: true },
          text: { format: { type: "json_schema", name: "result" } },
        })
      )
    ) as {
      instructions: string;
      input: Array<Record<string, unknown>>;
      metadata?: unknown;
      store: boolean;
      temperature: number;
      text: unknown;
      truncation: string;
    };

    expect(normalized.store).toBe(false);
    expect(normalized.truncation).toBe("disabled");
    expect(normalized.temperature).toBe(0.2);
    expect(normalized.text).toEqual({ format: { type: "json_schema", name: "result" } });
    expect(normalized.metadata).toBeUndefined();
    expect(normalized.instructions).toBe("Follow project rules.\n\nUse concise updates.");
    expect(normalized.input).toEqual([{ role: "user", content: "Ship the fix." }]);
  });

  it("preserves explicit auto truncation", () => {
    const normalized = JSON.parse(
      normalizeCodexResponsesBody(
        JSON.stringify({
          model: "gpt-5.3-codex",
          input: [{ role: "user", content: "Hello" }],
          truncation: "auto",
        })
      )
    ) as { truncation: string; store: boolean };

    expect(normalized.truncation).toBe("auto");
    expect(normalized.store).toBe(false);
  });
});

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
        routePriority: ["mux-gateway", "direct"],
      });

      const result = await factory.createModel("openai:gpt-5");
      if (!result.success) {
        expect(result.error.type).not.toBe("provider_disabled");
      }
    });
  });
});

describe("ProviderModelFactory GitHub Copilot", () => {
  it("creates routed gpt-5.4 models with the chat completions API mode", async () => {
    await withTempConfig(async (config, factory) => {
      const originalOpenAIRegistry = PROVIDER_REGISTRY.openai;
      let capturedProviderName: string | undefined;

      config.saveProvidersConfig({
        "github-copilot": {
          apiKey: "copilot-token",
          models: ["gpt-5.4"],
        },
      });

      PROVIDER_REGISTRY.openai = async () => {
        const module = await originalOpenAIRegistry();
        return {
          ...module,
          createOpenAI: (options) => {
            capturedProviderName = options?.name;
            return module.createOpenAI(options);
          },
        };
      };

      try {
        const projectConfig = config.loadConfigOrDefault();
        await config.saveConfig({
          ...projectConfig,
          routePriority: ["github-copilot", "direct"],
        });

        const result = await factory.resolveAndCreateModel("openai:gpt-5.4", "off");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(capturedProviderName).toBe(
          resolveProviderOptionsNamespaceKey("openai", "github-copilot")
        );
        expect((result.data.model as { provider?: unknown }).provider).toBe("github-copilot.chat");
        expect(result.data.routeProvider).toBe("github-copilot");
        expect(result.data.effectiveModelString).toBe("github-copilot:gpt-5.4");
        expect(result.data.model.constructor.name).toBe("OpenAIChatLanguageModel");
      } finally {
        PROVIDER_REGISTRY.openai = originalOpenAIRegistry;
      }
    });
  });

  it("rewrites Claude model ids back to Copilot's dot form before creating chat models", async () => {
    await withTempConfig(async (config, factory) => {
      const originalOpenAIRegistry = PROVIDER_REGISTRY.openai;
      let capturedModelId: string | undefined;

      config.saveProvidersConfig({
        "github-copilot": {
          apiKey: "copilot-token",
          models: ["claude-opus-4.6"],
        },
      });

      PROVIDER_REGISTRY.openai = async () => {
        const module = await originalOpenAIRegistry();
        return {
          ...module,
          createOpenAI: (options) => {
            const provider = module.createOpenAI(options);
            return Object.assign(
              ((requestedModelId: Parameters<typeof provider>[0]) =>
                provider(requestedModelId)) as typeof provider,
              provider,
              {
                chat(requestedModelId: Parameters<typeof provider.chat>[0]) {
                  capturedModelId = requestedModelId;
                  return provider.chat(requestedModelId);
                },
              }
            );
          },
        };
      };

      try {
        const result = await factory.createModel("github-copilot:claude-opus-4-6");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(capturedModelId).toBe("claude-opus-4.6");
        expect((result.data as { provider?: unknown }).provider).toBe("github-copilot.chat");
      } finally {
        PROVIDER_REGISTRY.openai = originalOpenAIRegistry;
      }
    });
  });

  it("routes Codex models through the Copilot Responses API path", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        "github-copilot": {
          apiKey: "copilot-token",
          models: ["gpt-5.3-codex"],
        },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        routePriority: ["github-copilot", "direct"],
      });

      const result = await factory.resolveAndCreateModel("openai:gpt-5.3-codex", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect((result.data.model as { provider?: unknown }).provider).toBe(
        "github-copilot.responses"
      );
      expect(result.data.routeProvider).toBe("github-copilot");
      expect(result.data.effectiveModelString).toBe("github-copilot:gpt-5.3-codex");
      expect(result.data.model.constructor.name).toBe("CopilotResponsesLanguageModel");
    });
  });

  it("normalizes Request bodies for the Codex OAuth responses endpoint", async () => {
    await withTempConfig(async (config, factory) => {
      const originalOpenAIRegistry = PROVIDER_REGISTRY.openai;
      const requests: Array<{
        input: Parameters<typeof fetch>[0];
        init?: Parameters<typeof fetch>[1];
      }> = [];
      let capturedFetch: typeof fetch | undefined;
      const auth = {
        type: "oauth" as const,
        access: "test-access-token",
        refresh: "test-refresh-token",
        expires: Date.now() + 60_000,
        accountId: "test-account-id",
      };

      const baseFetch = (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        requests.push({ input, init });

        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "resp_test",
              created_at: 0,
              model: "gpt-5.3-codex",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  id: "msg_test",
                  content: [{ type: "output_text", text: "ok", annotations: [] }],
                },
              ],
              usage: {
                input_tokens: 1,
                output_tokens: 1,
              },
            }),
            {
              headers: {
                "Content-Type": "application/json",
              },
            }
          )
        );
      };

      config.loadProvidersConfig = () => ({
        openai: {
          codexOauth: auth,
          fetch: baseFetch,
        },
      });

      const codexOauthService = Object.create(CodexOauthService.prototype) as CodexOauthService;
      codexOauthService.getValidAuth = () => Promise.resolve(Ok(auth));
      factory.codexOauthService = codexOauthService;

      PROVIDER_REGISTRY.openai = async () => {
        const module = await originalOpenAIRegistry();
        return {
          ...module,
          createOpenAI: (options) => {
            capturedFetch = options?.fetch;
            return module.createOpenAI(options);
          },
        };
      };

      try {
        const result = await factory.createModel("openai:gpt-5.3-codex");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        if (!capturedFetch) {
          throw new Error("Expected OpenAI fetch wrapper to be captured");
        }

        const originalBody = JSON.stringify({
          model: "gpt-5.3-codex",
          input: [
            { role: "user", content: [{ type: "input_text", text: "Ship the fix." }] },
            { type: "item_reference", id: "rs_123" },
          ],
          store: true,
          truncation: "server-default",
          metadata: { ignored: true },
        });
        const request = new Request("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer sdk-key",
          },
          body: originalBody,
        });

        await capturedFetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: originalBody,
        });

        expect(requests).toHaveLength(1);
        expect(requests[0]?.input).toBe(CODEX_ENDPOINT);
        expect(requests[0]?.init?.body).toBe(normalizeCodexResponsesBody(originalBody));

        const headers = new Headers(requests[0]?.init?.headers);
        expect(headers.get("authorization")).toBe("Bearer test-access-token");
        expect(headers.get("chatgpt-account-id")).toBe("test-account-id");
        expect(headers.get("content-type")).toBe("application/json");
      } finally {
        PROVIDER_REGISTRY.openai = originalOpenAIRegistry;
      }
    });
  });

  it("does not force store=false for Copilot Responses requests", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        "github-copilot": {
          apiKey: "copilot-token",
          models: ["gpt-5.3-codex"],
        },
      });

      const result = await factory.createModel("github-copilot:gpt-5.3-codex");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect((result.data as { provider?: unknown }).provider).toBe("github-copilot.responses");
      expect(result.data.constructor.name).toBe("CopilotResponsesLanguageModel");
    });
  });

  it("returns api_key_not_found before checking a stale Copilot model catalog", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        "github-copilot": {
          models: ["gpt-4.1"],
        },
      });

      const result = await factory.createModel("github-copilot:gpt-5.4");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          type: "api_key_not_found",
          provider: "github-copilot",
        });
      }
    });
  });

  it("fails when the requested model is missing from the stored Copilot model list", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        "github-copilot": {
          apiKey: "copilot-token",
          models: ["gpt-4.1"],
        },
      });

      const result = await factory.createModel("github-copilot:gpt-5.4");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          type: "model_not_available",
          provider: "github-copilot",
          modelId: "gpt-5.4",
        });
      }
    });
  });

  it("allows Copilot model creation when the stored model list is malformed", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        "github-copilot": {
          apiKey: "copilot-token",
          models: "not-an-array",
        },
      } as unknown as Parameters<Config["saveProvidersConfig"]>[0]);

      const result = await factory.createModel("github-copilot:gpt-5.4");

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.constructor.name).toBe("OpenAIChatLanguageModel");
    });
  });

  it("allows Copilot model creation when the stored model list contains malformed entries", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        "github-copilot": {
          apiKey: "copilot-token",
          models: ["   ", null],
        },
      } as unknown as Parameters<Config["saveProvidersConfig"]>[0]);

      const result = await factory.createModel("github-copilot:gpt-5.4");

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.constructor.name).toBe("OpenAIChatLanguageModel");
    });
  });

  it("allows Copilot model creation when no stored model list exists yet", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        "github-copilot": {
          apiKey: "copilot-token",
          models: [],
        },
      });

      const result = await factory.createModel("github-copilot:gpt-5.4");

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.constructor.name).toBe("OpenAIChatLanguageModel");
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
describe("ProviderModelFactory routing", () => {
  it("honors non-mux gateway routes end-to-end", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        openrouter: {
          apiKey: "or-test",
        },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        routePriority: ["openrouter", "direct"],
      });

      const resolved = factory.resolveGatewayModelString("openai:gpt-5", "openai:gpt-5");
      expect(resolved).toBe("openrouter:openai/gpt-5");

      const created = await factory.createModel("openai:gpt-5");
      expect(created.success).toBe(true);

      const result = await factory.resolveAndCreateModel("openai:gpt-5", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.effectiveModelString).toBe("openrouter:openai/gpt-5");
      expect(result.data.routeProvider).toBe("openrouter");
      expect(result.data.routedThroughGateway).toBe(false);
    });
  });

  it("passes gateway model accessibility to routing by skipping inaccessible Copilot models", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
        "github-copilot": {
          apiKey: "copilot-token",
          models: ["gpt-4.1"],
        },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        routePriority: ["github-copilot", "direct"],
      });

      const result = await factory.resolveAndCreateModel("openai:gpt-5.4", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.effectiveModelString).toBe("openai:gpt-5.4");
      expect(result.data.routeProvider).toBe("openai");
      expect(result.data.routedThroughGateway).toBe(false);
    });
  });

  it("does not treat custom gateway model entries as an exhaustive routed catalog", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openrouter: {
          apiKey: "or-test",
          models: ["team-only-model"],
        },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        routePriority: ["openrouter", "direct"],
      });

      const result = await factory.resolveAndCreateModel("openai:gpt-5", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.effectiveModelString).toBe("openrouter:openai/gpt-5");
      expect(result.data.routeProvider).toBe("openrouter");
      expect(result.data.routedThroughGateway).toBe(false);
    });
  });

  it("routes Anthropic models through Bedrock when Bedrock is configured and prioritized", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        anthropic: { apiKey: "ant-test", enabled: false },
        bedrock: { region: "us-east-1" },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        routePriority: ["bedrock", "direct"],
      });

      const result = await factory.resolveAndCreateModel("anthropic:claude-sonnet-4-5", "off");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.effectiveModelString).toBe("bedrock:anthropic.claude-sonnet-4-5");
      expect(result.data.routeProvider).toBe("bedrock");
    });
  });

  it("skips disabled gateway providers even when credentials exist", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        openrouter: {
          apiKey: "or-test",
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
        routePriority: ["openrouter", "mux-gateway", "direct"],
      });

      const resolved = factory.resolveGatewayModelString("openai:gpt-5", "openai:gpt-5");
      expect(resolved).toBe("mux-gateway:openai/gpt-5");
    });
  });

  it("falls back deterministically to the next configured route", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        openrouter: {
          apiKey: "or-test",
        },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        routePriority: ["mux-gateway", "openrouter", "direct"],
      });

      const resolved = factory.resolveGatewayModelString("openai:gpt-5", "openai:gpt-5");
      expect(resolved).toBe("openrouter:openai/gpt-5");

      const created = await factory.createModel("openai:gpt-5");
      expect(created.success).toBe(true);
    });
  });

  it("preserves explicit OpenRouter model strings when OpenRouter is configured", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        openrouter: {
          apiKey: "or-test",
        },
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        muxGatewayEnabled: true,
        routePriority: ["mux-gateway", "direct"],
      });

      const resolved = factory.resolveGatewayModelString(
        "openrouter:openai/gpt-5",
        "openai:gpt-5",
        "openrouter"
      );
      expect(resolved).toBe("openrouter:openai/gpt-5");

      const result = await factory.resolveAndCreateModel("openrouter:openai/gpt-5", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.effectiveModelString).toBe("openrouter:openai/gpt-5");
      expect(result.data.routeProvider).toBe("openrouter");
      expect(result.data.routedThroughGateway).toBe(false);
    });
  });

  it("falls back from explicit OpenRouter model strings when OpenRouter is unavailable", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        openrouter: {
          apiKey: "or-test",
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
        routePriority: ["openrouter", "mux-gateway", "direct"],
      });

      const resolved = factory.resolveGatewayModelString(
        "openrouter:openai/gpt-5",
        "openai:gpt-5",
        "openrouter"
      );
      expect(resolved).toBe("mux-gateway:openai/gpt-5");

      const result = await factory.resolveAndCreateModel("openrouter:openai/gpt-5", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.effectiveModelString).toBe("mux-gateway:openai/gpt-5");
      expect(result.data.routeProvider).toBe("mux-gateway");
      expect(result.data.routedThroughGateway).toBe(true);
    });
  });

  it("honors explicit mux-gateway prefixes for compatibility", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        muxGatewayEnabled: true,
        routePriority: ["direct"],
      });

      const resolved = factory.resolveGatewayModelString(
        "mux-gateway:anthropic/claude-sonnet-4-6",
        KNOWN_MODELS.SONNET.id,
        "mux-gateway"
      );
      expect(resolved).toBe("mux-gateway:anthropic/claude-sonnet-4-6");

      const result = await factory.resolveAndCreateModel(
        "mux-gateway:anthropic/claude-sonnet-4-6",
        "off"
      );
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.effectiveModelString).toBe("mux-gateway:anthropic/claude-sonnet-4-6");
      expect(result.data.routeProvider).toBe("mux-gateway");
      expect(result.data.routedThroughGateway).toBe(true);
    });
  });

  it("treats OpenAI as available for routing when only Codex OAuth is configured", async () => {
    // Temporarily remove OPENAI_API_KEY so the test only succeeds via Codex OAuth,
    // not by falling through to an env-var credential path.
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await withTempConfig(async (config, factory) => {
        config.saveProvidersConfig({
          openai: {
            // No apiKey — only Codex OAuth credentials.
            codexOauth: {
              type: "oauth",
              access: "test-access-token",
              refresh: "test-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
          openrouter: {
            apiKey: "or-test",
          },
        });

        const projectConfig = config.loadConfigOrDefault();
        await config.saveConfig({
          ...projectConfig,
          routePriority: ["direct", "openrouter"],
        });

        // Direct OpenAI should win because Codex OAuth makes it available for routing.
        // Use a model from CODEX_OAUTH_ALLOWED_MODELS so createModel can route through OAuth.
        const result = await factory.resolveAndCreateModel("openai:gpt-5.2", "off");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(result.data.effectiveModelString).toBe("openai:gpt-5.2");
        expect(result.data.routeProvider).toBe("openai");
        expect(result.data.routedThroughGateway).toBe(false);
      });
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it("leaves direct-provider model strings unchanged when direct routing wins", async () => {
    await withTempConfig(async (config, factory) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
        openrouter: {
          apiKey: "or-test",
        },
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      const projectConfig = config.loadConfigOrDefault();
      await config.saveConfig({
        ...projectConfig,
        muxGatewayEnabled: true,
        routePriority: ["direct", "mux-gateway", "openrouter"],
      });

      const result = await factory.resolveAndCreateModel("openai:gpt-5", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.effectiveModelString).toBe("openai:gpt-5");
      expect(result.data.canonicalModelString).toBe("openai:gpt-5");
      expect(result.data.routeProvider).toBe("openai");
      expect(result.data.routedThroughGateway).toBe(false);
    });
  });
});

describe("classifyCopilotInitiator", () => {
  it("returns 'user' when last message role is user", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
    expect(classifyCopilotInitiator(body)).toBe("user");
  });

  it("returns 'agent' when last message role is tool", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "1", type: "function", function: { name: "test", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "1", content: "result" },
      ],
    });
    expect(classifyCopilotInitiator(body)).toBe("agent");
  });

  it("returns 'agent' when last message role is assistant", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "..." },
      ],
    });
    expect(classifyCopilotInitiator(body)).toBe("agent");
  });

  it("returns 'user' when the last Responses input item is a user turn", () => {
    const body = JSON.stringify({
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    });
    expect(classifyCopilotInitiator(body)).toBe("user");
  });

  it("returns 'agent' when the last Responses input item is a stored tool reference", () => {
    const body = JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "item_reference", id: "fc_123" },
      ],
    });
    expect(classifyCopilotInitiator(body)).toBe("agent");
  });

  it("returns 'user' for empty messages array", () => {
    expect(classifyCopilotInitiator(JSON.stringify({ messages: [] }))).toBe("user");
  });

  it("returns 'user' for non-string body", () => {
    expect(classifyCopilotInitiator(undefined)).toBe("user");
    expect(classifyCopilotInitiator(null)).toBe("user");
  });

  it("returns 'user' for malformed JSON", () => {
    expect(classifyCopilotInitiator("not json")).toBe("user");
  });

  it("returns 'user' when body has no messages field", () => {
    expect(classifyCopilotInitiator(JSON.stringify({ model: "gpt-4o" }))).toBe("user");
  });
});

describe("countAnthropicCacheBreakpoints", () => {
  it("counts the intended three manual Anthropic cache breakpoints for direct requests", () => {
    const requestBody = {
      model: "claude-sonnet-4-5",
      system: [
        {
          type: "text",
          text: "You are a helpful assistant",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            {
              type: "text",
              text: "world",
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "read_file",
          input_schema: { type: "object" },
        },
        {
          name: "bash",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    };

    expect(countAnthropicCacheBreakpoints(requestBody)).toBe(3);
  });

  it("treats a top-level Anthropic cache_control block as an extra breakpoint", () => {
    const requestBody = {
      cache_control: { type: "ephemeral", ttl: "1h" },
      system: [
        {
          type: "text",
          text: "You are a helpful assistant",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "world",
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "bash",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    };

    expect(countAnthropicCacheBreakpoints(requestBody)).toBe(4);
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

  it("prepends Mux attribution to an existing User-Agent", () => {
    const result = buildAIProviderRequestHeaders({ "User-Agent": "custom-agent/1.0" });
    expect(result.get("user-agent")).toBe(`${MUX_AI_PROVIDER_USER_AGENT} custom-agent/1.0`);
  });

  it("does not duplicate Mux attribution when already present", () => {
    const existing = `${MUX_AI_PROVIDER_USER_AGENT} ai-sdk/anthropic/3.0.37`;
    const result = buildAIProviderRequestHeaders({ "User-Agent": existing });
    expect(result.get("user-agent")).toBe(existing);
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

interface CapturedFetchCall {
  url: string;
  init: RequestInit;
}

function createCapturingFetch(): { calls: CapturedFetchCall[]; fakeFetch: typeof fetch } {
  const calls: CapturedFetchCall[] = [];
  const fakeFetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : "";
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  // Preserve Bun's fetch extensions (preconnect, certificate) expected by `typeof fetch`.
  const fakeFetch = Object.assign(fakeFetchImpl, fetch) as typeof fetch;
  return { calls, fakeFetch };
}

function parseSentBody(call: CapturedFetchCall): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

describe("wrapFetchWithAnthropicCacheControl — Opus 4.7 wire transforms", () => {
  it("injects thinking.display=summarized for Opus 4.7 adaptive thinking", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch);
    const body = JSON.stringify({
      model: "claude-opus-4-7",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    await wrapped("https://api.anthropic.com/v1/messages", { method: "POST", body });
    expect(calls.length).toBe(1);
    const sent = parseSentBody(calls[0]);
    expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("preserves a user-supplied display value on Opus 4.7", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch);
    const body = JSON.stringify({
      model: "claude-opus-4-7",
      thinking: { type: "adaptive", display: "omitted" },
    });
    await wrapped("https://api.anthropic.com/v1/messages", { method: "POST", body });
    const sent = parseSentBody(calls[0]) as { thinking: { display: string } };
    expect(sent.thinking.display).toBe("omitted");
  });

  it("rewrites output_config.effort to xhigh when override header is present", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch);
    const body = JSON.stringify({
      model: "claude-opus-4-7",
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    });
    await wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body,
      headers: { [MUX_ANTHROPIC_EFFORT_OVERRIDE_HEADER]: "xhigh" },
    });
    const sent = parseSentBody(calls[0]) as { output_config: { effort: string } };
    expect(sent.output_config.effort).toBe("xhigh");
    // Override header is stripped before forwarding
    const outHeaders = new Headers(calls[0].init.headers);
    expect(outHeaders.get(MUX_ANTHROPIC_EFFORT_OVERRIDE_HEADER)).toBeNull();
  });

  it("does not inject display for Opus 4.6 adaptive thinking", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch);
    const body = JSON.stringify({
      model: "claude-opus-4-6",
      thinking: { type: "adaptive" },
    });
    await wrapped("https://api.anthropic.com/v1/messages", { method: "POST", body });
    const sent = parseSentBody(calls[0]);
    expect(sent.thinking).toEqual({ type: "adaptive" });
  });

  it("does not inject display when thinking is disabled", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch);
    const body = JSON.stringify({
      model: "claude-opus-4-7",
      thinking: { type: "disabled" },
    });
    await wrapped("https://api.anthropic.com/v1/messages", { method: "POST", body });
    const sent = parseSentBody(calls[0]);
    expect(sent.thinking).toEqual({ type: "disabled" });
  });
});

describe("wrapFetchWithAnthropicCacheControl — gateway (AI SDK) body shape", () => {
  it("injects display=summarized into providerOptions.anthropic.thinking for Opus 4.7 via gateway", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch, null, {
      injectCacheControl: false,
    });
    const body = JSON.stringify({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: {
        anthropic: { thinking: { type: "adaptive" }, effort: "medium" },
      },
    });
    await wrapped("https://gateway.example.com/v1/language-model", {
      method: "POST",
      body,
      headers: { "ai-model-id": "anthropic/claude-opus-4-7" },
    });
    const sent = parseSentBody(calls[0]) as {
      providerOptions: { anthropic: { thinking: unknown } };
    };
    expect(sent.providerOptions.anthropic.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  it("rewrites providerOptions.anthropic.effort to xhigh via gateway", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch, null, {
      injectCacheControl: false,
    });
    const body = JSON.stringify({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: {
        anthropic: { thinking: { type: "adaptive" }, effort: "max" },
      },
    });
    await wrapped("https://gateway.example.com/v1/language-model", {
      method: "POST",
      body,
      headers: {
        "ai-model-id": "anthropic/claude-opus-4-7",
        [MUX_ANTHROPIC_EFFORT_OVERRIDE_HEADER]: "xhigh",
      },
    });
    const sent = parseSentBody(calls[0]) as {
      providerOptions: { anthropic: { effort: string } };
    };
    expect(sent.providerOptions.anthropic.effort).toBe("xhigh");
  });
});
