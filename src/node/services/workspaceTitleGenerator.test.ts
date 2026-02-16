import { APICallError, RetryError } from "ai";
import { describe, expect, test } from "bun:test";
import type { SendMessageError } from "@/common/types/errors";
import {
  extractIdentityFromText,
  extractTextFromContentParts,
  mapModelCreationError,
  mapNameGenerationError,
} from "./workspaceTitleGenerator";

describe("extractIdentityFromText", () => {
  test("extracts from markdown bold + backtick format", () => {
    const text = [
      'Based on the development task "testing", here are my recommendations:',
      "",
      "**name:** `testing`",
      "- Concise, git-safe (lowercase), and clearly identifies the codebase area",
      "",
      "**title:** `Improve test coverage`",
      "- Follows the verb-noun format and describes the testing work generically",
    ].join("\n");

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "testing", title: "Improve test coverage" });
  });

  test("extracts from embedded JSON object", () => {
    const text =
      'Here is the result: {"name": "sidebar", "title": "Fix sidebar layout"} as requested.';
    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "sidebar", title: "Fix sidebar layout" });
  });

  test("extracts from JSON with reverse field order", () => {
    const text = '{"title": "Add user auth", "name": "auth"}';
    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "auth", title: "Add user auth" });
  });

  test("extracts from quoted values in prose", () => {
    const text = 'The name: "config" and title: "Refactor config loading"';
    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "config", title: "Refactor config loading" });
  });

  test("sanitizes name to be git-safe", () => {
    const text = ["**name:** `My Feature`", "**title:** `Add cool feature`"].join("\n");
    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "my-feature", title: "Add cool feature" });
  });

  test("returns null for empty text", () => {
    expect(extractIdentityFromText("")).toBeNull();
  });

  test("returns null when only name is present", () => {
    const text = "**name:** `testing`\nSome other content without title";
    expect(extractIdentityFromText(text)).toBeNull();
  });

  test("returns null when only title is present", () => {
    const text = "**title:** `Fix bugs`\nSome other content without name";
    expect(extractIdentityFromText(text)).toBeNull();
  });

  test("returns null when name is too short after sanitization", () => {
    const text = "**name:** `-`\n**title:** `Fix something here`";
    expect(extractIdentityFromText(text)).toBeNull();
  });

  test("returns null when title is too short", () => {
    const text = "**name:** `auth`\n**title:** `Fix`";
    expect(extractIdentityFromText(text)).toBeNull();
  });

  test("returns null for completely unrelated text", () => {
    const text = "I'm sorry, I cannot help with that request. Please try again.";
    expect(extractIdentityFromText(text)).toBeNull();
  });

  test("handles the exact failing response from the bug report", () => {
    // This is the exact text content from the claude-haiku response that triggered the bug.
    // In the raw API response JSON, newlines are escaped as \n — once parsed they become
    // real newline characters in the string that NoObjectGeneratedError.text carries.
    const text = [
      'Based on the development task "testing", here are my recommendations:',
      "",
      "**name:** `testing`",
      "- Concise, git-safe (lowercase), and clearly identifies the codebase area",
      "",
      "**title:** `Improve test coverage`",
      "- Follows the verb-noun format and describes the testing work generically",
      "",
      "These are suitable for a testing-focused development task.",
    ].join("\n");

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "testing", title: "Improve test coverage" });
  });
});

describe("extractTextFromContentParts", () => {
  test("joins top-level text parts", () => {
    const content = [
      { type: "text", text: "First chunk" },
      { type: "reasoning", text: "Second chunk" },
    ];

    expect(extractTextFromContentParts(content)).toBe("First chunk\n\nSecond chunk");
  });

  test("extracts nested text parts", () => {
    const content = [
      {
        type: "wrapper",
        content: [
          { type: "text", text: "Nested one" },
          { type: "text", text: "Nested two" },
        ],
      },
    ];

    expect(extractTextFromContentParts(content)).toBe("Nested one\n\nNested two");
  });

  test("supports provider content payloads that wrap name/title in text", () => {
    const content = [
      {
        type: "text",
        text: [
          'Based on the development task "testing", here are my recommendations:',
          "",
          "**name:** `testing`",
          "**title:** `Improve test coverage`",
        ].join("\n"),
      },
    ];

    const flattened = extractTextFromContentParts(content);
    expect(flattened).not.toBeNull();
    expect(extractIdentityFromText(flattened ?? "")).toEqual({
      name: "testing",
      title: "Improve test coverage",
    });
  });

  test("returns null for non-array input", () => {
    expect(extractTextFromContentParts({ type: "text", text: "nope" })).toBeNull();
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
    test("maps APICallError 401 to authentication", () => {
      const mapped = mapNameGenerationError(
        createApiCallError(401, "Unauthorized"),
        "openai:gpt-4.1-mini"
      );
      expect(mapped).toMatchObject({
        type: "authentication",
        authKind: "invalid_credentials",
      });
    });

    test("maps APICallError 403 to permission_denied", () => {
      const mapped = mapNameGenerationError(
        createApiCallError(403, "Forbidden"),
        "openai:gpt-4.1-mini"
      );
      expect(mapped).toMatchObject({ type: "permission_denied" });
    });

    test("maps APICallError 402 to quota", () => {
      const mapped = mapNameGenerationError(
        createApiCallError(402, "Payment Required"),
        "openai:gpt-4.1-mini"
      );
      expect(mapped).toMatchObject({ type: "quota" });
    });

    test("maps APICallError 429 with quota payload to quota", () => {
      const mapped = mapNameGenerationError(
        createApiCallError(429, "Request failed", {
          data: { error: { code: "insufficient_quota", message: "Please add credits" } },
          responseBody: '{"error":{"code":"insufficient_quota","message":"Please add credits"}}',
        }),
        "openai:gpt-4.1-mini"
      );
      expect(mapped).toMatchObject({ type: "quota" });
    });

    test("maps APICallError 429 throttling to rate_limit", () => {
      const mapped = mapNameGenerationError(
        createApiCallError(429, "Too Many Requests"),
        "openai:gpt-4.1-mini"
      );
      expect(mapped).toMatchObject({ type: "rate_limit" });
    });

    test("maps APICallError 429 with quota wording but no billing markers to rate_limit", () => {
      const mapped = mapNameGenerationError(
        createApiCallError(429, "Per-minute quota limit reached. Retry in 10s."),
        "openai:gpt-4.1-mini"
      );
      expect(mapped).toMatchObject({ type: "rate_limit" });
    });

    test("maps APICallError 500 to service_unavailable", () => {
      const mapped = mapNameGenerationError(
        createApiCallError(500, "Internal Server Error"),
        "openai:gpt-4.1-mini"
      );
      expect(mapped).toMatchObject({ type: "service_unavailable" });
    });

    test("maps APICallError 503 to service_unavailable", () => {
      const mapped = mapNameGenerationError(
        createApiCallError(503, "Service Unavailable"),
        "openai:gpt-4.1-mini"
      );
      expect(mapped).toMatchObject({ type: "service_unavailable" });
    });

    test("unwraps RetryError lastError when mapping", () => {
      const apiCallError = createApiCallError(401, "Unauthorized");
      const retryError = new RetryError({
        message: "Retry failed",
        reason: "maxRetriesExceeded",
        errors: [apiCallError],
      });

      const mapped = mapNameGenerationError(retryError, "openai:gpt-4.1-mini");
      expect(mapped).toMatchObject({
        type: "authentication",
        authKind: "invalid_credentials",
      });
    });

    test("maps fetch TypeError to network", () => {
      const mapped = mapNameGenerationError(new TypeError("fetch failed"), "openai:gpt-4.1-mini");
      expect(mapped).toMatchObject({ type: "network" });
    });

    test("maps generic Error to unknown", () => {
      const mapped = mapNameGenerationError(new Error("something"), "openai:gpt-4.1-mini");
      expect(mapped).toMatchObject({ type: "unknown" });
    });

    test("maps non-Error input to unknown", () => {
      const mapped = mapNameGenerationError("something", "openai:gpt-4.1-mini");
      expect(mapped).toMatchObject({ type: "unknown" });
    });
  });

  describe("mapModelCreationError", () => {
    test("maps api_key_not_found to authentication with provider", () => {
      const error: SendMessageError = { type: "api_key_not_found", provider: "anthropic" };
      const mapped = mapModelCreationError(error, "openai:gpt-4.1-mini");
      expect(mapped).toEqual({
        type: "authentication",
        authKind: "api_key_missing",
        provider: "anthropic",
      });
    });

    test("maps oauth_not_connected to authentication with provider", () => {
      const error: SendMessageError = { type: "oauth_not_connected", provider: "openai" };
      const mapped = mapModelCreationError(error, "anthropic:claude-3-5-haiku");
      expect(mapped).toEqual({
        type: "authentication",
        authKind: "oauth_not_connected",
        provider: "openai",
      });
    });

    test("maps provider_disabled to configuration", () => {
      const error: SendMessageError = { type: "provider_disabled", provider: "google" };
      const mapped = mapModelCreationError(error, "google:gemini-2.0-flash");
      expect(mapped).toMatchObject({ type: "configuration" });
    });

    test("maps provider_not_supported to configuration", () => {
      const error: SendMessageError = { type: "provider_not_supported", provider: "custom" };
      const mapped = mapModelCreationError(error, "custom:model");
      expect(mapped).toMatchObject({ type: "configuration" });
    });

    test("maps policy_denied to policy", () => {
      const error: SendMessageError = { type: "policy_denied", message: "Provider blocked" };
      const mapped = mapModelCreationError(error, "openai:gpt-4.1-mini");
      expect(mapped).toMatchObject({ type: "policy" });
    });

    test("maps unknown to unknown with raw preserved", () => {
      const result = mapModelCreationError(
        { type: "unknown", raw: "Some detailed error" },
        "openai:gpt-4o"
      );
      expect(result).toEqual({ type: "unknown", raw: "Some detailed error" });
    });
  });
});
