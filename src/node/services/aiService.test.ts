// Bun test file - doesn't support Jest mocking, so we skip this test for now
// These tests would need to be rewritten to work with Bun's test runner
// For now, the commandProcessor tests demonstrate our testing approach

import { describe, it, expect, beforeEach } from "bun:test";
import {
  AIService,
  normalizeAnthropicBaseURL,
  buildAnthropicHeaders,
  buildAppAttributionHeaders,
  ANTHROPIC_1M_CONTEXT_HEADER,
} from "./aiService";
import { HistoryService } from "./historyService";
import { PartialService } from "./partialService";
import { InitStateManager } from "./initStateManager";
import { Config } from "@/node/config";
import { MUX_APP_ATTRIBUTION_TITLE, MUX_APP_ATTRIBUTION_URL } from "@/constants/appAttribution";

describe("AIService", () => {
  let service: AIService;

  beforeEach(() => {
    const config = new Config();
    const historyService = new HistoryService(config);
    const partialService = new PartialService(config, historyService);
    const initStateManager = new InitStateManager(config);
    service = new AIService(config, historyService, partialService, initStateManager);
  });

  // Note: These tests are placeholders as Bun doesn't support Jest mocking
  // In a production environment, we'd use dependency injection or other patterns
  // to make the code more testable without mocking

  it("should create an AIService instance", () => {
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(AIService);
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
