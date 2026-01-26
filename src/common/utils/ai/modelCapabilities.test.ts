import { describe, it, expect } from "bun:test";
import { getModelCapabilities, getSupportedInputMediaTypes } from "./modelCapabilities";

describe("getModelCapabilities", () => {
  it("returns capabilities for known models", () => {
    const caps = getModelCapabilities("anthropic:claude-sonnet-4-5");
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
});

describe("getSupportedInputMediaTypes", () => {
  it("includes pdf when model supports_pdf_input is true", () => {
    const supported = getSupportedInputMediaTypes("anthropic:claude-sonnet-4-5");
    expect(supported).not.toBeNull();
    expect(supported?.has("pdf")).toBe(true);
  });
});
