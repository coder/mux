// Bun test file - doesn't support Jest mocking, so we skip this test for now
// These tests would need to be rewritten to work with Bun's test runner
// For now, the commandProcessor tests demonstrate our testing approach

import { describe, it, expect, beforeEach } from "bun:test";
import { AIService, normalizeAnthropicBaseURL } from "./aiService";
import { HistoryService } from "./historyService";
import { PartialService } from "./partialService";
import { InitStateManager } from "./initStateManager";
import { Config } from "@/node/config";

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
