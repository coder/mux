import { describe, expect, test } from "bun:test";

import {
  isGatewayModelAccessibleFromAuthoritativeCatalog,
  isProviderModelAccessibleFromAuthoritativeCatalog,
} from "./gatewayModelCatalog";

describe("gatewayModelCatalog", () => {
  test("treats non-Copilot providers as permissive even with custom model lists", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("openrouter", "openai/gpt-5", [
        "team-only-model",
      ])
    ).toBe(true);
  });

  test("treats an empty Copilot catalog as permissive", () => {
    expect(isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.4", [])).toBe(
      true
    );
  });

  test("treats malformed Copilot catalog entries as missing", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.4", [
        null as unknown as string,
      ])
    ).toBe(true);
  });

  test("treats blank Copilot catalog strings as missing", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.4", ["   "])
    ).toBe(true);
  });

  test("matches Copilot Claude ids after dot-vs-dash normalization", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "claude-opus-4-6", [
        "claude-opus-4.6",
      ])
    ).toBe(true);
  });

  test("does not match unrelated Copilot Claude ids after normalization", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "claude-opus-4-6", [
        "claude-sonnet-4.5",
      ])
    ).toBe(false);
  });

  test("rejects direct Copilot model ids missing from the authoritative catalog", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.4", [
        "gpt-5.4-mini",
      ])
    ).toBe(false);
  });

  test("accepts Codex models when the Copilot catalog includes them", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.3-codex", [
        "gpt-5.3-codex",
      ])
    ).toBe(true);
  });

  test("keeps the gateway-specific helper behavior aligned", () => {
    expect(
      isGatewayModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.4", [
        "gpt-5.4-mini",
      ])
    ).toBe(false);
  });
});
