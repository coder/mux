// Bun test file - doesn't support Jest mocking, so we skip this test for now
// These tests would need to be rewritten to work with Bun's test runner
// For now, the commandProcessor tests demonstrate our testing approach

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect, beforeEach } from "bun:test";

import {
  AIService,
  normalizeAnthropicBaseURL,
  buildAnthropicHeaders,
  buildAppAttributionHeaders,
  ANTHROPIC_1M_CONTEXT_HEADER,
  discoverAvailableSubagentsForToolContext,
} from "./aiService";
import { HistoryService } from "./historyService";
import { PartialService } from "./partialService";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import { Config } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";

import { createTaskTool } from "./tools/task";
import { createTestToolConfig } from "./tools/testHelpers";
import { MUX_APP_ATTRIBUTION_TITLE, MUX_APP_ATTRIBUTION_URL } from "@/constants/appAttribution";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { CODEX_ENDPOINT } from "@/common/constants/codexOAuth";

describe("AIService", () => {
  let service: AIService;

  beforeEach(() => {
    const config = new Config();
    const historyService = new HistoryService(config);
    const partialService = new PartialService(config, historyService);
    const initStateManager = new InitStateManager(config);
    const providerService = new ProviderService(config);
    service = new AIService(
      config,
      historyService,
      partialService,
      initStateManager,
      providerService
    );
  });

  // Note: These tests are placeholders as Bun doesn't support Jest mocking
  // In a production environment, we'd use dependency injection or other patterns
  // to make the code more testable without mocking

  it("should create an AIService instance", () => {
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(AIService);
  });
});

describe("AIService.resolveGatewayModelString", () => {
  async function writeMuxConfig(
    root: string,
    config: { muxGatewayEnabled?: boolean; muxGatewayModels?: string[] }
  ): Promise<void> {
    await fs.writeFile(
      path.join(root, "config.json"),
      JSON.stringify(
        {
          projects: [],
          ...config,
        },
        null,
        2
      ),
      "utf-8"
    );
  }

  async function writeProvidersConfig(root: string, config: object): Promise<void> {
    await fs.writeFile(
      path.join(root, "providers.jsonc"),
      JSON.stringify(config, null, 2),
      "utf-8"
    );
  }

  function toGatewayModelString(modelString: string): string {
    const colonIndex = modelString.indexOf(":");
    const provider = colonIndex === -1 ? modelString : modelString.slice(0, colonIndex);
    const modelId = colonIndex === -1 ? "" : modelString.slice(colonIndex + 1);
    return `mux-gateway:${provider}/${modelId}`;
  }

  function createService(root: string): AIService {
    const config = new Config(root);
    const historyService = new HistoryService(config);
    const partialService = new PartialService(config, historyService);
    const initStateManager = new InitStateManager(config);
    const providerService = new ProviderService(config);
    return new AIService(config, historyService, partialService, initStateManager, providerService);
  }

  it("routes allowlisted models when gateway is enabled + configured", async () => {
    using muxHome = new DisposableTempDir("gateway-routing");

    await writeMuxConfig(muxHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [KNOWN_MODELS.SONNET.id],
    });
    await writeProvidersConfig(muxHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createService(muxHome.path);

    // @ts-expect-error - accessing private method for testing
    const resolved = service.resolveGatewayModelString(KNOWN_MODELS.SONNET.id);

    expect(resolved).toBe(toGatewayModelString(KNOWN_MODELS.SONNET.id));
  });

  it("does not route when gateway is disabled", async () => {
    using muxHome = new DisposableTempDir("gateway-routing-disabled");

    await writeMuxConfig(muxHome.path, {
      muxGatewayEnabled: false,
      muxGatewayModels: [KNOWN_MODELS.SONNET.id],
    });
    await writeProvidersConfig(muxHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createService(muxHome.path);

    // @ts-expect-error - accessing private method for testing
    const resolved = service.resolveGatewayModelString(KNOWN_MODELS.SONNET.id);

    expect(resolved).toBe(KNOWN_MODELS.SONNET.id);
  });

  it("does not route when gateway is not configured", async () => {
    using muxHome = new DisposableTempDir("gateway-routing-unconfigured");

    await writeMuxConfig(muxHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [KNOWN_MODELS.SONNET.id],
    });

    const service = createService(muxHome.path);

    // @ts-expect-error - accessing private method for testing
    const resolved = service.resolveGatewayModelString(KNOWN_MODELS.SONNET.id);

    expect(resolved).toBe(KNOWN_MODELS.SONNET.id);
  });

  it("does not route unsupported providers even when allowlisted", async () => {
    using muxHome = new DisposableTempDir("gateway-routing-unsupported-provider");

    const modelString = "openrouter:some-model";
    await writeMuxConfig(muxHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [modelString],
    });
    await writeProvidersConfig(muxHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createService(muxHome.path);

    // @ts-expect-error - accessing private method for testing
    const resolved = service.resolveGatewayModelString(modelString);

    expect(resolved).toBe(modelString);
  });

  it("routes model variants when the base model is allowlisted via modelKey", async () => {
    using muxHome = new DisposableTempDir("gateway-routing-model-key");

    const variant = "xai:grok-4-1-fast-reasoning";
    await writeMuxConfig(muxHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [KNOWN_MODELS.GROK_4_1.id],
    });
    await writeProvidersConfig(muxHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createService(muxHome.path);

    // @ts-expect-error - accessing private method for testing
    const resolved = service.resolveGatewayModelString(variant, KNOWN_MODELS.GROK_4_1.id);

    expect(resolved).toBe(toGatewayModelString(variant));
  });

  it("honors explicit mux-gateway prefixes from legacy clients", async () => {
    using muxHome = new DisposableTempDir("gateway-routing-explicit");

    await writeMuxConfig(muxHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [],
    });
    await writeProvidersConfig(muxHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createService(muxHome.path);

    // @ts-expect-error - accessing private method for testing
    const resolved = service.resolveGatewayModelString(KNOWN_MODELS.GPT.id, undefined, true);

    expect(resolved).toBe(toGatewayModelString(KNOWN_MODELS.GPT.id));
  });
});

describe("AIService.createModel (Codex OAuth routing)", () => {
  async function writeProvidersConfig(root: string, config: object): Promise<void> {
    await fs.writeFile(
      path.join(root, "providers.jsonc"),
      JSON.stringify(config, null, 2),
      "utf-8"
    );
  }

  function createService(root: string): AIService {
    const config = new Config(root);
    const historyService = new HistoryService(config);
    const partialService = new PartialService(config, historyService);
    const initStateManager = new InitStateManager(config);
    const providerService = new ProviderService(config);
    return new AIService(config, historyService, partialService, initStateManager, providerService);
  }

  function getFetchUrl(input: Parameters<typeof fetch>[0]): string {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.toString();
    }
    if (typeof input === "object" && input !== null && "url" in input) {
      const possibleUrl = (input as { url?: unknown }).url;
      if (typeof possibleUrl === "string") {
        return possibleUrl;
      }
    }
    return "";
  }

  it("returns oauth_not_connected for required Codex models when both OAuth and API key are missing", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-missing");

    await writeProvidersConfig(muxHome.path, {
      openai: {},
    });

    // Temporarily clear OPENAI_API_KEY so resolveProviderCredentials doesn't find it
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const service = createService(muxHome.path);
      const result = await service.createModel(KNOWN_MODELS.GPT_52_CODEX.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({ type: "oauth_not_connected", provider: "openai" });
      }
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it("falls back to API key for required Codex models when OAuth is missing but API key is present", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-missing-apikey-present");

    await writeProvidersConfig(muxHome.path, {
      openai: { apiKey: "sk-test-key" },
    });

    const service = createService(muxHome.path);
    const result = await service.createModel(KNOWN_MODELS.GPT_52_CODEX.id);

    // Should succeed — falls back to API key instead of erroring with oauth_not_connected
    expect(result.success).toBe(true);
  });

  it("does not require an OpenAI API key when Codex OAuth is configured", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-present");

    await writeProvidersConfig(muxHome.path, {
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

    const service = createService(muxHome.path);
    const result = await service.createModel(KNOWN_MODELS.GPT_52_CODEX.id);

    expect(result.success).toBe(true);
  });

  it("defaults OAuth-allowed models to ChatGPT OAuth when both auth methods are configured", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-default-auth-oauth");

    const config = new Config(muxHome.path);
    const historyService = new HistoryService(config);
    const partialService = new PartialService(config, historyService);
    const initStateManager = new InitStateManager(config);
    const providerService = new ProviderService(config);

    const service = new AIService(
      config,
      historyService,
      partialService,
      initStateManager,
      providerService
    );

    const requests: Array<{
      input: Parameters<typeof fetch>[0];
      init?: Parameters<typeof fetch>[1];
    }> = [];

    const baseFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push({ input, init });

      // Minimal valid OpenAI Responses payload for the provider's response schema.
      const responseBody = {
        id: "resp_test",
        created_at: 0,
        model: "gpt-5.2",
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
      };

      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      );
    };

    // Ensure createModel sees a function fetch (providers.jsonc can't store functions).
    config.loadProvidersConfig = () => ({
      openai: {
        apiKey: "test-openai-api-key",
        codexOauth: {
          type: "oauth",
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "test-account-id",
        },
        fetch: baseFetch,
      },
    });

    // fetchWithOpenAITruncation closes over codexOauthService during createModel.
    // @ts-expect-error - accessing private field for testing
    service.codexOauthService = {
      getValidAuth: () =>
        Promise.resolve({
          success: true,
          data: {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "test-account-id",
          },
        }),
    };

    const modelResult = await service.createModel(KNOWN_MODELS.GPT.id);
    expect(modelResult.success).toBe(true);
    if (!modelResult.success) return;

    const model = modelResult.data;
    if (typeof model === "string") {
      throw new Error("Expected a LanguageModelV2 instance, got a model id string");
    }

    await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    });

    expect(requests.length).toBeGreaterThan(0);
    const lastRequest = requests[requests.length - 1];
    expect(getFetchUrl(lastRequest.input)).toBe(CODEX_ENDPOINT);
  });

  it("does not rewrite OAuth-allowed models when default auth is set to apiKey", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-default-auth-api-key");

    const config = new Config(muxHome.path);
    const historyService = new HistoryService(config);
    const partialService = new PartialService(config, historyService);
    const initStateManager = new InitStateManager(config);
    const providerService = new ProviderService(config);

    const service = new AIService(
      config,
      historyService,
      partialService,
      initStateManager,
      providerService
    );

    const requests: Array<{
      input: Parameters<typeof fetch>[0];
      init?: Parameters<typeof fetch>[1];
    }> = [];

    const baseFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push({ input, init });

      // Minimal valid OpenAI Responses payload for the provider's response schema.
      const responseBody = {
        id: "resp_test",
        created_at: 0,
        model: "gpt-5.2",
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
      };

      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      );
    };

    // Ensure createModel sees a function fetch (providers.jsonc can't store functions).
    config.loadProvidersConfig = () => ({
      openai: {
        apiKey: "test-openai-api-key",
        codexOauth: {
          type: "oauth",
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "test-account-id",
        },
        codexOauthDefaultAuth: "apiKey",
        fetch: baseFetch,
      },
    });

    const modelResult = await service.createModel(KNOWN_MODELS.GPT.id);
    expect(modelResult.success).toBe(true);
    if (!modelResult.success) return;

    const model = modelResult.data;
    if (typeof model === "string") {
      throw new Error("Expected a LanguageModelV2 instance, got a model id string");
    }

    await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    });

    expect(requests.length).toBeGreaterThan(0);
    const lastRequest = requests[requests.length - 1];
    expect(getFetchUrl(lastRequest.input)).not.toBe(CODEX_ENDPOINT);
  });

  it("ensures Codex OAuth routed Responses requests include non-empty instructions", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-instructions");

    const config = new Config(muxHome.path);
    const historyService = new HistoryService(config);
    const partialService = new PartialService(config, historyService);
    const initStateManager = new InitStateManager(config);
    const providerService = new ProviderService(config);

    const service = new AIService(
      config,
      historyService,
      partialService,
      initStateManager,
      providerService
    );

    const requests: Array<{
      input: Parameters<typeof fetch>[0];
      init?: Parameters<typeof fetch>[1];
    }> = [];

    const baseFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push({ input, init });

      // Minimal valid OpenAI Responses payload for the provider's response schema.
      const responseBody = {
        id: "resp_test",
        created_at: 0,
        model: "gpt-5.2-codex",
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
      };

      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      );
    };

    // Ensure createModel sees a function fetch (providers.jsonc can't store functions).
    config.loadProvidersConfig = () => ({
      openai: {
        apiKey: "test-openai-api-key",
        codexOauth: {
          type: "oauth",
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "test-account-id",
        },
        fetch: baseFetch,
      },
    });

    // fetchWithOpenAITruncation closes over codexOauthService during createModel.
    // @ts-expect-error - accessing private field for testing
    service.codexOauthService = {
      getValidAuth: () =>
        Promise.resolve({
          success: true,
          data: {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "test-account-id",
          },
        }),
    };

    const modelResult = await service.createModel(KNOWN_MODELS.GPT_52_CODEX.id);
    expect(modelResult.success).toBe(true);
    if (!modelResult.success) return;

    const model = modelResult.data;
    if (typeof model === "string") {
      throw new Error("Expected a LanguageModelV2 instance, got a model id string");
    }

    const systemPrompt = "Test system prompt";

    await model.doGenerate({
      prompt: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    });

    expect(requests.length).toBeGreaterThan(0);

    const lastRequest = requests[requests.length - 1];

    // URL rewrite to chatgpt.com
    expect(lastRequest.input).toBe(CODEX_ENDPOINT);

    // Auth header injection
    const headers = new Headers(lastRequest.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-access-token");
    expect(headers.get("chatgpt-account-id")).toBe("test-account-id");

    // Body mutation: non-empty instructions
    const bodyString = lastRequest.init?.body;
    expect(typeof bodyString).toBe("string");
    if (typeof bodyString !== "string") {
      throw new Error("Expected request body to be a string");
    }

    const parsedBody = JSON.parse(bodyString) as unknown;
    if (!parsedBody || typeof parsedBody !== "object") {
      throw new Error("Expected request body to parse as an object");
    }

    const instructions = (parsedBody as { instructions?: unknown }).instructions;
    expect(typeof instructions).toBe("string");
    if (typeof instructions !== "string") {
      throw new Error("Expected instructions to be a string");
    }

    expect(instructions.trim().length).toBeGreaterThan(0);
    expect(instructions).toBe(systemPrompt);

    // Codex endpoint requires store=false
    const store = (parsedBody as { store?: unknown }).store;
    expect(store).toBe(false);

    // System message should be removed from input to avoid double-system
    const input = (parsedBody as { input?: unknown[] }).input;
    if (Array.isArray(input)) {
      for (const item of input) {
        if (item && typeof item === "object" && "role" in item) {
          expect((item as { role: string }).role).not.toBe("system");
          expect((item as { role: string }).role).not.toBe("developer");
        }
      }
    }
  });

  it("filters out item_reference entries and preserves inline items when routing through Codex OAuth", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-filter-refs");

    const config = new Config(muxHome.path);
    const historyService = new HistoryService(config);
    const partialService = new PartialService(config, historyService);
    const initStateManager = new InitStateManager(config);
    const providerService = new ProviderService(config);

    const service = new AIService(
      config,
      historyService,
      partialService,
      initStateManager,
      providerService
    );

    const requests: Array<{
      input: Parameters<typeof fetch>[0];
      init?: Parameters<typeof fetch>[1];
    }> = [];

    const baseFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push({ input, init });

      const responseBody = {
        id: "resp_test",
        created_at: 0,
        model: "gpt-5.2-codex",
        output: [
          {
            type: "message",
            role: "assistant",
            id: "msg_test",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      };

      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    };

    config.loadProvidersConfig = () => ({
      openai: {
        apiKey: "test-openai-api-key",
        codexOauth: {
          type: "oauth",
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "test-account-id",
        },
        fetch: baseFetch,
      },
    });

    // @ts-expect-error - accessing private field for testing
    service.codexOauthService = {
      getValidAuth: () =>
        Promise.resolve({
          success: true,
          data: {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "test-account-id",
          },
        }),
    };

    const modelResult = await service.createModel(KNOWN_MODELS.GPT_52_CODEX.id);
    expect(modelResult.success).toBe(true);
    if (!modelResult.success) return;

    const model = modelResult.data;
    if (typeof model === "string") {
      throw new Error("Expected a LanguageModelV2 instance, got a model id string");
    }

    await model.doGenerate({
      prompt: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
    });

    expect(requests.length).toBeGreaterThan(0);

    const lastRequest = requests[requests.length - 1];
    const bodyString = lastRequest.init?.body;
    expect(typeof bodyString).toBe("string");
    if (typeof bodyString !== "string") {
      throw new Error("Expected request body to be a string");
    }

    const parsedBody = JSON.parse(bodyString) as { store?: boolean; input?: unknown[] };

    // Verify Codex transform ran (store=false is set)
    expect(parsedBody.store).toBe(false);

    // Verify no item_reference entries exist in output
    const input = parsedBody.input;
    expect(Array.isArray(input)).toBe(true);
    if (Array.isArray(input)) {
      for (const item of input) {
        if (item && typeof item === "object" && item !== null) {
          expect((item as Record<string, unknown>).type).not.toBe("item_reference");
        }
      }
    }
  });

  it("item_reference filter removes references and preserves inline items", () => {
    // Direct unit test of the item_reference filtering logic used in the
    // Codex body transformation, independent of the full AIService pipeline.
    const input: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "item_reference", id: "rs_abc123" },
      {
        type: "message",
        role: "assistant",
        id: "msg_001",
        content: [{ type: "output_text", text: "hi" }],
      },
      {
        type: "function_call",
        id: "fc_xyz",
        call_id: "call_1",
        name: "test_fn",
        arguments: "{}",
      },
      { type: "item_reference", id: "rs_def456" },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ];

    // Same filter logic as in aiService.ts Codex body transformation
    const filtered = input.filter(
      (item) => !(item && typeof item === "object" && item.type === "item_reference")
    );

    // Both item_reference entries removed
    expect(filtered).toHaveLength(4);
    expect(filtered.some((i) => i.type === "item_reference")).toBe(false);

    // Inline items preserved with their IDs intact
    expect(filtered.find((i) => i.role === "assistant")?.id).toBe("msg_001");
    expect(filtered.find((i) => i.type === "function_call")?.id).toBe("fc_xyz");
    expect(filtered.find((i) => i.type === "function_call_output")?.call_id).toBe("call_1");
    expect(filtered.find((i) => i.role === "user")).toBeDefined();
  });
});

describe("normalizeAnthropicBaseURL", () => {
  it("appends /v1 to URLs without it", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1"
    );
    expect(normalizeAnthropicBaseURL("https://custom-proxy.com")).toBe(
      "https://custom-proxy.com/v1"
    );
  });

  it("preserves URLs already ending with /v1", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com/v1")).toBe(
      "https://api.anthropic.com/v1"
    );
    expect(normalizeAnthropicBaseURL("https://custom-proxy.com/v1")).toBe(
      "https://custom-proxy.com/v1"
    );
  });

  it("removes trailing slashes before appending /v1", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com/")).toBe(
      "https://api.anthropic.com/v1"
    );
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com///")).toBe(
      "https://api.anthropic.com/v1"
    );
  });

  it("removes trailing slash after /v1", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com/v1/")).toBe(
      "https://api.anthropic.com/v1"
    );
  });

  it("handles URLs with ports", () => {
    expect(normalizeAnthropicBaseURL("http://localhost:8080")).toBe("http://localhost:8080/v1");
    expect(normalizeAnthropicBaseURL("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
  });

  it("handles URLs with paths that include v1 in the middle", () => {
    // This should still append /v1 because the path doesn't END with /v1
    expect(normalizeAnthropicBaseURL("https://proxy.com/api/v1-beta")).toBe(
      "https://proxy.com/api/v1-beta/v1"
    );
  });
});

describe("buildAnthropicHeaders", () => {
  it("returns undefined when use1MContext is false and no existing headers", () => {
    expect(buildAnthropicHeaders(undefined, false)).toBeUndefined();
  });

  it("returns existing headers unchanged when use1MContext is false", () => {
    const existing = { "x-custom": "value" };
    expect(buildAnthropicHeaders(existing, false)).toBe(existing);
  });

  it("returns existing headers unchanged when use1MContext is undefined", () => {
    const existing = { "x-custom": "value" };
    expect(buildAnthropicHeaders(existing, undefined)).toBe(existing);
  });

  it("adds 1M context header when use1MContext is true and no existing headers", () => {
    const result = buildAnthropicHeaders(undefined, true);
    expect(result).toEqual({ "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER });
  });

  it("merges 1M context header with existing headers when use1MContext is true", () => {
    const existing = { "x-custom": "value" };
    const result = buildAnthropicHeaders(existing, true);
    expect(result).toEqual({
      "x-custom": "value",
      "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER,
    });
  });

  it("overwrites existing anthropic-beta header when use1MContext is true", () => {
    const existing = { "anthropic-beta": "other-beta" };
    const result = buildAnthropicHeaders(existing, true);
    expect(result).toEqual({ "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER });
  });
});

describe("buildAppAttributionHeaders", () => {
  it("adds both headers when no headers exist", () => {
    expect(buildAppAttributionHeaders(undefined)).toEqual({
      "HTTP-Referer": MUX_APP_ATTRIBUTION_URL,
      "X-Title": MUX_APP_ATTRIBUTION_TITLE,
    });
  });

  it("adds only the missing header when one is present", () => {
    const existing = { "HTTP-Referer": "https://example.com" };
    const result = buildAppAttributionHeaders(existing);
    expect(result).toEqual({
      "HTTP-Referer": "https://example.com",
      "X-Title": MUX_APP_ATTRIBUTION_TITLE,
    });
  });

  it("does not overwrite existing values (case-insensitive)", () => {
    const existing = { "http-referer": "https://example.com", "X-TITLE": "My App" };
    const result = buildAppAttributionHeaders(existing);
    expect(result).toEqual(existing);
  });

  it("preserves unrelated headers", () => {
    const existing = { "x-custom": "value" };
    const result = buildAppAttributionHeaders(existing);
    expect(result).toEqual({
      "x-custom": "value",
      "HTTP-Referer": MUX_APP_ATTRIBUTION_URL,
      "X-Title": MUX_APP_ATTRIBUTION_TITLE,
    });
  });

  it("does not mutate the input object", () => {
    const existing = { "x-custom": "value" };
    const existingSnapshot = { ...existing };

    buildAppAttributionHeaders(existing);

    expect(existing).toEqual(existingSnapshot);
  });
});

describe("discoverAvailableSubagentsForToolContext", () => {
  it("includes derived agents that inherit subagent.runnable from base", async () => {
    using project = new DisposableTempDir("available-subagents");
    using muxHome = new DisposableTempDir("available-subagents-home");

    const agentsRoot = path.join(project.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    // Derived agent: base exec but no explicit subagent.runnable.
    await fs.writeFile(
      path.join(agentsRoot, "custom.md"),
      `---\nname: Custom Exec Derivative\nbase: exec\n---\nBody\n`,
      "utf-8"
    );

    const runtime = new LocalRuntime(project.path);
    const cfg = new Config(muxHome.path).loadConfigOrDefault();

    const availableSubagents = await discoverAvailableSubagentsForToolContext({
      runtime,
      workspacePath: project.path,
      cfg,
      roots: {
        projectRoot: agentsRoot,
        globalRoot: path.join(project.path, "empty-global-agents"),
      },
    });

    const custom = availableSubagents.find((agent) => agent.id === "custom");
    expect(custom).toBeDefined();
    expect(custom?.subagentRunnable).toBe(true);

    // Ensure the task tool description includes the derived agent in the runnable sub-agent list.
    const taskTool = createTaskTool({
      ...createTestToolConfig(project.path, { workspaceId: "test-workspace" }),
      availableSubagents,
    });

    const description = (taskTool as unknown as { description?: unknown }).description;
    expect(typeof description).toBe("string");
    if (typeof description === "string") {
      expect(description).toContain("Available sub-agents");
      expect(description).toContain("- custom");
    }
  });
});
