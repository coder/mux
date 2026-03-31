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

  test("rejects direct Copilot model ids missing from the authoritative catalog", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.4", [
        "gpt-5.4-mini",
      ])
    ).toBe(false);
  });

  test("keeps the gateway-specific helper behavior aligned", () => {
    expect(
      isGatewayModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.4", [
        "gpt-5.4-mini",
      ])
    ).toBe(false);
  });
});
