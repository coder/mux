import { APICallError, NoOutputGeneratedError, RetryError } from "ai";
import { describe, expect, test } from "bun:test";
import {
  buildWorkspaceIdentityPrompt,
  mapModelCreationError,
  mapNameGenerationError,
} from "./workspaceTitleGenerator";

describe("buildWorkspaceIdentityPrompt", () => {
  test("includes overall-scope guidance, conversation turns, and latest-user context without precedence", () => {
    const prompt = buildWorkspaceIdentityPrompt(
      "Refactor workspace title generation",
      "Turn 1 (User):\nOutline the plan\n\nTurn 2 (Assistant):\nImplement incrementally",
      "Please prioritize reliability work"
    );

    expect(prompt).toContain('Primary user objective: "Refactor workspace title generation"');
    expect(prompt).toContain("Conversation turns");
    expect(prompt).toContain("Outline the plan");
    expect(prompt).toContain("Please prioritize reliability work");
    // Recent message is included as context but not given priority
    expect(prompt).toContain("Most recent user message");
    expect(prompt).toContain("do not prefer it over earlier turns");
    // Scope guidance: weigh all turns equally
    expect(prompt).toContain("Weigh all turns equally");
    // No temporal recency bias in requirements
    expect(prompt).not.toContain("highest priority");
    expect(prompt).not.toContain("precedence");
  });

  test("omits conversation-specific sections when no conversation block is provided", () => {
    const prompt = buildWorkspaceIdentityPrompt(
      "Fix flaky tests",
      undefined,
      "Most recent instruction that should be ignored without context"
    );

    expect(prompt).toContain('Primary user objective: "Fix flaky tests"');
    expect(prompt).not.toContain("Conversation turns");
    expect(prompt).not.toContain("Most recent instruction that should be ignored without context");
  });
});

const createApiCallError = (
  statusCode: number,
  message = `HTTP ${statusCode}`,
  overrides?: {
    data?: unknown;
    responseBody?: string;
  }
): APICallError =>
  new APICallError({
    message,
    statusCode,
    url: "https://api.example.com/v1/responses",
    requestBodyValues: {},
    data: overrides?.data,
    responseBody: overrides?.responseBody,
  });

describe("workspaceTitleGenerator error mappers", () => {
  describe("mapNameGenerationError", () => {
    test("preserves provider context for auth and permission API failures", () => {
      const modelString = "openai:gpt-4.1-mini";

      const auth = mapNameGenerationError(createApiCallError(401, "Unauthorized"), modelString);
      expect(auth).toEqual({
        type: "authentication",
        authKind: "invalid_credentials",
        provider: "openai",
        raw: "Unauthorized",
      });

      const permission = mapNameGenerationError(createApiCallError(403, "Forbidden"), modelString);
      expect(permission).toEqual({
        type: "permission_denied",
        provider: "openai",
        raw: "Forbidden",
      });
    });

    test("treats explicit billing failures as quota", () => {
      const paymentRequired = mapNameGenerationError(
        createApiCallError(402, "Payment Required"),
        "openai:gpt-4.1-mini"
      );
      expect(paymentRequired).toEqual({ type: "quota", raw: "Payment Required" });

      const capacityWithBillingSignal = mapNameGenerationError(
        createApiCallError(429, "Request failed", {
          data: { error: { code: "insufficient_quota", message: "Please add credits" } },
          responseBody: '{"error":{"code":"insufficient_quota","message":"Please add credits"}}',
        }),
        "openai:gpt-4.1-mini"
      );
      expect(capacityWithBillingSignal).toEqual({ type: "quota", raw: "Request failed" });
    });

    test("classifies throttling as rate_limit when no billing markers are present", () => {
      const burstRateLimit = mapNameGenerationError(
        createApiCallError(429, "Too Many Requests"),
        "openai:gpt-4.1-mini"
      );
      expect(burstRateLimit).toEqual({ type: "rate_limit", raw: "Too Many Requests" });

      const quotaWordingOnly = mapNameGenerationError(
        createApiCallError(429, "Per-minute quota limit reached. Retry in 10s."),
        "openai:gpt-4.1-mini"
      );
      expect(quotaWordingOnly).toEqual({
        type: "rate_limit",
        raw: "Per-minute quota limit reached. Retry in 10s.",
      });
    });

    test("maps any 5xx API failure to service_unavailable", () => {
      for (const statusCode of [500, 503]) {
        const message = `HTTP ${statusCode}`;
        const mapped = mapNameGenerationError(
          createApiCallError(statusCode, message),
          "openai:gpt-4.1-mini"
        );
        expect(mapped).toEqual({ type: "service_unavailable", raw: message });
      }
    });

    test("unwraps RetryError and applies inner error classification", () => {
      const retryError = new RetryError({
        message: "Retry failed",
        reason: "maxRetriesExceeded",
        errors: [createApiCallError(401, "Unauthorized")],
      });

      expect(mapNameGenerationError(retryError, "openai:gpt-4.1-mini")).toMatchObject({
        type: "authentication",
        authKind: "invalid_credentials",
      });
    });

    test("maps NoOutputGeneratedError to a user-friendly message", () => {
      const noOutput = new NoOutputGeneratedError({
        message: "No output generated. Check the stream for errors.",
      });

      expect(mapNameGenerationError(noOutput, "openai:gpt-4.1-mini")).toEqual({
        type: "unknown",
        raw: "No output generated from the AI provider.",
      });
    });

    test("only treats fetch TypeError as network; all other failures fall back to unknown", () => {
      expect(mapNameGenerationError(new TypeError("fetch failed"), "openai:gpt-4.1-mini")).toEqual({
        type: "network",
        raw: "fetch failed",
      });
      expect(mapNameGenerationError(new Error("boom"), "openai:gpt-4.1-mini")).toEqual({
        type: "unknown",
        raw: "boom",
      });
      expect(mapNameGenerationError("boom", "openai:gpt-4.1-mini")).toEqual({
        type: "unknown",
        raw: "boom",
      });
    });
  });

  describe("mapModelCreationError", () => {
    test("maps auth setup failures to authentication and keeps provider from the error", () => {
      const apiKeyMissing = mapModelCreationError(
        { type: "api_key_not_found", provider: "anthropic" },
        "openai:gpt-4.1-mini"
      );
      const oauthMissing = mapModelCreationError(
        { type: "oauth_not_connected", provider: "openai" },
        "anthropic:claude-3-5-haiku"
      );

      expect(apiKeyMissing).toEqual({
        type: "authentication",
        authKind: "api_key_missing",
        provider: "anthropic",
      });
      expect(oauthMissing).toEqual({
        type: "authentication",
        authKind: "oauth_not_connected",
        provider: "openai",
      });
    });

    test("groups provider availability issues under configuration", () => {
      const providerDisabled = mapModelCreationError(
        { type: "provider_disabled", provider: "google" },
        "google:gemini-2.0-flash"
      );
      const providerNotSupported = mapModelCreationError(
        { type: "provider_not_supported", provider: "custom" },
        "custom:model"
      );

      expect(providerDisabled).toEqual({ type: "configuration", raw: "Provider disabled" });
      expect(providerNotSupported).toEqual({
        type: "configuration",
        raw: "Provider not supported",
      });
    });

    test("derives provider from model string for policy_denied errors", () => {
      const mapped = mapModelCreationError(
        { type: "policy_denied", message: "Provider blocked" },
        "openai:gpt-4.1-mini"
      );
      expect(mapped).toEqual({
        type: "policy",
        provider: "openai",
        raw: "Provider blocked",
      });
    });

    test("preserves unknown raw messages and uses message fallback for unmapped variants", () => {
      const unknownWithRaw = mapModelCreationError(
        { type: "unknown", raw: "Some detailed error" },
        "openai:gpt-4o"
      );
      expect(unknownWithRaw).toEqual({ type: "unknown", raw: "Some detailed error" });

      const fallbackFromMessage = mapModelCreationError(
        { type: "runtime_not_ready", message: "Container booting" },
        "openai:gpt-4o"
      );
      expect(fallbackFromMessage).toEqual({ type: "unknown", raw: "Container booting" });
    });
  });
});
