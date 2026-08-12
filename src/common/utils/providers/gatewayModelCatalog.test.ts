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
    expect(isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.5", [])).toBe(
      true
    );
  });

  test("treats malformed Copilot catalog entries as missing", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.5", [
        null as unknown as string,
      ])
    ).toBe(true);
  });

  test("treats blank Copilot catalog strings as missing", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.5", ["   "])
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
      isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.5", [
        "gpt-5.4-mini",
      ])
    ).toBe(false);
  });

  test("accepts Coder models present in the discovered bridge catalog", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("coder", "anthropic/claude-sonnet-4-5", [
        "anthropic/claude-sonnet-4-5",
        "openai/gpt-5",
      ])
    ).toBe(true);
  });

  test("rejects Coder models absent from the discovered bridge catalog", () => {
    // The AI Bridge only serves models its upstreams expose: an anthropic
    // model missing from coder.models must not be routed through Coder (it
    // should fall back to a configured direct provider instead).
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("coder", "anthropic/claude-opus-4-1", [
        "openai/gpt-5",
      ])
    ).toBe(false);
  });

  test("treats an empty Coder catalog as exhaustive (nothing accessible)", () => {
    // Login always overwrites the catalog — an empty list means the bridge
    // exposed no models (e.g. not entitled), not that discovery is pending.
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("coder", "anthropic/claude-sonnet-4-5", [])
    ).toBe(false);
  });

  test("treats a missing Coder catalog as unknown (fail open)", () => {
    // Login deletes the catalog key and discovery only persists conclusive
    // results: a missing list means "unknown" (discovery pending or failed
    // transiently), and blocking would strand routing until the next login
    // even after the bridge recovers.
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/claude-sonnet-4-5",
        undefined
      )
    ).toBe(true);
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
      isGatewayModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.5", [
        "gpt-5.4-mini",
      ])
    ).toBe(false);
  });
});
