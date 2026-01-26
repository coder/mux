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

  it("includes docx when model supports_docx_input is true", () => {
    // Gemini 3 Pro supports DOCX input
    const supported = getSupportedInputMediaTypes("google:gemini-3-pro-preview");
    expect(supported).not.toBeNull();
    expect(supported?.has("docx")).toBe(true);
    expect(supported?.has("pdf")).toBe(true);
  });

  it("does not include docx for models without docx support", () => {
    // Claude doesn't support DOCX
    const supported = getSupportedInputMediaTypes("anthropic:claude-sonnet-4-5");
    expect(supported).not.toBeNull();
    expect(supported?.has("docx")).toBe(false);
    expect(supported?.has("pdf")).toBe(true);
  });
});
