import { describe, expect, it } from "bun:test";
import {
  getModelCapabilities,
  getSupportedEndpoints,
  getSupportedEndpointsResolved,
  getSupportedInputMediaTypes,
} from "./modelCapabilities";

describe("getModelCapabilities", () => {
  it("returns capabilities for known models", () => {
    const caps = getModelCapabilities("anthropic:claude-sonnet-4-5");
    expect(caps).not.toBeNull();
    expect(caps?.supportsPdfInput).toBe(true);
    expect(caps?.supportsVision).toBe(true);
  });

  it("merges models.json + modelsExtra so overrides don't wipe capabilities", () => {
    // claude-opus-4-5 exists in both sources; modelsExtra intentionally overrides
    // pricing/token limits, but it should not wipe upstream capability flags.
    const caps = getModelCapabilities("anthropic:claude-opus-4-5");
    expect(caps).not.toBeNull();
    expect(caps?.supportsPdfInput).toBe(true);
  });

  it("keeps explicit PDF support for Opus 4.6 from models-extra", () => {
    const caps = getModelCapabilities("anthropic:claude-opus-4-6");
    expect(caps).not.toBeNull();
    expect(caps?.supportsPdfInput).toBe(true);
  });

  it("resolves provider key aliases (github-copilot -> github_copilot)", () => {
    const caps = getModelCapabilities("github-copilot:gpt-41-copilot");
    expect(caps).not.toBeNull();
  });

  it("resolves gateway-scoped vendor/model ids that stay outside the canonical provider set", () => {
    const caps = getModelCapabilities("openrouter:z-ai/glm-4.6");
    expect(caps).not.toBeNull();
  });

  it("infers PDF support for OpenAI vision models when models-extra omits the flag", () => {
    const caps = getModelCapabilities("openai:gpt-5.4");
    expect(caps).not.toBeNull();
    expect(caps?.supportsPdfInput).toBe(true);
    expect(caps?.supportsVision).toBe(true);
  });

  it("returns maxPdfSizeMb when present in model metadata", () => {
    const caps = getModelCapabilities("google:gemini-1.5-flash");
    expect(caps).not.toBeNull();
    expect(caps?.supportsPdfInput).toBe(true);
    expect(caps?.maxPdfSizeMb).toBeGreaterThan(0);
  });

  it("returns null for unknown models", () => {
    expect(getModelCapabilities("anthropic:this-model-does-not-exist")).toBeNull();
  });

  it("inherits bare-model capabilities when provider-scoped entry omits them", () => {
    // github_copilot/gpt-4o in models.json lacks supports_pdf_input,
    // but bare gpt-4o has it. The merge-across-keys strategy must fill
    // in the missing field from the bare model.
    const caps = getModelCapabilities("github-copilot:gpt-4o");
    expect(caps).not.toBeNull();
    expect(caps?.supportsPdfInput).toBe(true);
  });
});

describe("getSupportedInputMediaTypes", () => {
  it("includes pdf when model supports_pdf_input is true", () => {
    const supported = getSupportedInputMediaTypes("anthropic:claude-sonnet-4-5");
    expect(supported).not.toBeNull();
    expect(supported?.has("pdf")).toBe(true);
  });

  it("includes pdf for OpenAI vision models that rely on the fallback", () => {
    const supported = getSupportedInputMediaTypes("openai:gpt-5.4");
    expect(supported).not.toBeNull();
    expect(supported?.has("pdf")).toBe(true);
  });
});

describe("getSupportedEndpoints", () => {
  it("returns endpoints for a responses-only model", () => {
    // gpt-5.4-pro in models-extra has supported_endpoints: ["/v1/responses"]
    const endpoints = getSupportedEndpoints("openai:gpt-5.4-pro");
    expect(endpoints).toEqual(["/v1/responses"]);
  });

  it("returns endpoints for a chat-only Copilot model", () => {
    // github_copilot/claude-sonnet-4 in models.json has supported_endpoints: ["/v1/chat/completions"]
    const endpoints = getSupportedEndpoints("github-copilot:claude-sonnet-4");
    expect(endpoints).toEqual(["/v1/chat/completions"]);
  });

  it("returns both endpoints for a model supporting chat and responses", () => {
    // gpt-5.4 in models-extra has supported_endpoints: ["/v1/chat/completions", "/v1/responses"]
    const endpoints = getSupportedEndpoints("openai:gpt-5.4");
    expect(endpoints).toContain("/v1/chat/completions");
    expect(endpoints).toContain("/v1/responses");
  });

  it("returns endpoints for Copilot model using provider alias lookup", () => {
    // github_copilot/gpt-5.2 in models.json has both endpoints
    const endpoints = getSupportedEndpoints("github-copilot:gpt-5.2");
    expect(endpoints).toContain("/v1/chat/completions");
    expect(endpoints).toContain("/v1/responses");
  });

  it("prefers provider-scoped endpoints over bare model endpoints", () => {
    // bare "gpt-5.2" includes /v1/batch, but github_copilot/gpt-5.2 does not.
    // The provider-scoped entry should win when queried with a provider prefix.
    const endpoints = getSupportedEndpoints("github-copilot:gpt-5.2");
    expect(endpoints).not.toContain("/v1/batch");

    // Sanity: the bare model does include /v1/batch
    const bareEndpoints = getSupportedEndpoints("gpt-5.2");
    expect(bareEndpoints).toContain("/v1/batch");
  });

  it("returns null when model metadata exists but has no endpoint info", () => {
    // claude-opus-4-5 in models-extra has no supported_endpoints
    const endpoints = getSupportedEndpoints("anthropic:claude-opus-4-5");
    expect(endpoints).toBeNull();
  });

  it("returns null for completely unknown models", () => {
    expect(getSupportedEndpoints("unknown:does-not-exist")).toBeNull();
  });
});

describe("getSupportedEndpointsResolved", () => {
  it("resolves Copilot model with provider-scoped metadata", () => {
    // github_copilot/gpt-5.1-codex-max in models.json has supported_endpoints: ["/v1/responses"]
    const endpoints = getSupportedEndpointsResolved("github-copilot:gpt-5.1-codex-max", null);
    expect(endpoints).toEqual(["/v1/responses"]);
  });

  it("prefers provider-scoped endpoints over bare model in resolved path", () => {
    // github_copilot/gpt-5.2 restricts to chat+responses (no /v1/batch),
    // while bare gpt-5.2 includes /v1/batch. Provider-scoped must win.
    const endpoints = getSupportedEndpointsResolved("github-copilot:gpt-5.2", null);
    expect(endpoints).toContain("/v1/chat/completions");
    expect(endpoints).toContain("/v1/responses");
    expect(endpoints).not.toContain("/v1/batch");
  });

  it("falls back to bare model name when provider-scoped entry is missing", () => {
    // github_copilot/gpt-5.4 does NOT exist in models.json, but
    // bare "gpt-5.4" in models-extra has supported_endpoints.
    const endpoints = getSupportedEndpointsResolved("github-copilot:gpt-5.4", null);
    expect(endpoints).toContain("/v1/responses");
  });

  it("resolves endpoints via config-based mappedToModel alias", () => {
    // "custom-copilot-alias" has no provider-scoped or bare-model metadata,
    // but the providers config maps it to gpt-5.4 which has known endpoints.
    const config = {
      "github-copilot": {
        models: [{ id: "custom-copilot-alias", mappedToModel: "gpt-5.4" }],
      },
    };
    const endpoints = getSupportedEndpointsResolved("github-copilot:custom-copilot-alias", config);
    expect(endpoints).toContain("/v1/responses");
  });

  it("returns null for unknown model when config has no mapping", () => {
    // Without config, the same unknown model returns null.
    expect(getSupportedEndpointsResolved("github-copilot:custom-copilot-alias", null)).toBeNull();
  });

  it("returns null for unknown model without any metadata", () => {
    expect(getSupportedEndpointsResolved("github-copilot:totally-fake-model", null)).toBeNull();
  });
});
