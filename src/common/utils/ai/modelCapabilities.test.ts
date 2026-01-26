import { describe, expect, it } from "bun:test";
import { getModelCapabilities, getSupportedInputMediaTypes } from "./modelCapabilities";

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

  it("returns capabilities for models present only in models-extra", () => {
    // This model is defined in models-extra.ts but not (yet) in upstream models.json.
    const caps = getModelCapabilities("openrouter:z-ai/glm-4.6");
    expect(caps).not.toBeNull();
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
});

describe("getSupportedInputMediaTypes", () => {
  it("includes pdf when model supports_pdf_input is true", () => {
    const supported = getSupportedInputMediaTypes("anthropic:claude-sonnet-4-5");
    expect(supported).not.toBeNull();
    expect(supported?.has("pdf")).toBe(true);
  });
});
