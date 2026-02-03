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
    return new AIService(config, historyService, partialService, initStateManager);
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
