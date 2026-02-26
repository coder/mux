import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError, RetryError } from "ai";
import { describe, expect, test } from "bun:test";
import {
  buildWorkspaceIdentityPrompt,
  extractIdentityFromText,
  extractTextFromContentParts,
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

describe("extractIdentityFromText", () => {
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

  test("extracts from punctuation-delimited prose values", () => {
    const text = 'Suggested fields (name: "config", title: "Refactor config loading")';
    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "config", title: "Refactor config loading" });
  });

  test("ignores snake_case metadata keys and uses standalone name/title labels", () => {
    const text = [
      'branch_name: "metadata-branch"',
      'workspace_title: "Metadata title"',
      'name: "auth"',
      'title: "Fix login flow"',
    ].join("\n");

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "auth", title: "Fix login flow" });
  });

  test("allows valid titles that include words like format", () => {
    const text = 'Output fields: name: "config" and title: "Format config output"';
    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "config", title: "Format config output" });
  });

  test("prefers structured fields over earlier free-form guidance text", () => {
    const text = [
      "Naming guidance: name: should be lowercase and short",
      "",
      "Suggested output:",
      "**name:** `auth`",
      "**title:** `Fix login`",
    ].join("\n");

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "auth", title: "Fix login" });
  });

  test("skips emphasized bare guidance values before later usable bare labels", () => {
    const text = [
      "**name:** should be lowercase and short",
      "**title:** should be verb-noun format",
      "",
      "**name:** auth",
      "**title:** Fix login flow",
    ].join("\n");

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "auth", title: "Fix login flow" });
  });

  test("skips structured quoted guidance before later structured values", () => {
    const text = [
      '**name:** "should be lowercase and short"',
      '**title:** "should be verb-noun format"',
      "",
      "**name:** `auth`",
      "**title:** `Fix login flow`",
    ].join("\n");

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "auth", title: "Fix login flow" });
  });

  test("does not re-accept quoted guidance when bare fallback re-scans labels", () => {
    const text = [
      "**name:** auth",
      '**title:** "sentence case"',
      "",
      "**title:** Fix login flow",
    ].join("\n");

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "auth", title: "Fix login flow" });
  });

  test("skips bare echoed title requirements before later usable titles", () => {
    const text = [
      'name: "auth"',
      "title: 2-5 words, verb-noun format",
      "title: Fix login flow",
    ].join("\n");

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "auth", title: "Fix login flow" });
  });

  test("skips quoted guidance and continues scanning structured matches", () => {
    const text = [
      'Naming guidance: name: "should be lowercase and short"',
      'Title guidance: title: "verb-noun format"',
      "",
      "Suggested output:",
      "**name:** `auth`",
      "**title:** `Fix login flow`",
    ].join("\n");

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "auth", title: "Fix login flow" });
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

  test("extracts from prose bullets when markdown uses **name**: style", () => {
    const text =
      "Based on the issue, this task involves encryption work. - **name**: `db-encrypt` - **title**: `Encrypt git SSH private keys`.";

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "db-encrypt", title: "Encrypt git SSH private keys" });
  });

  test("extracts from single-quoted prose values", () => {
    const text = "Suggested fields: name: 'config' and title: 'Refactor config loading'";
    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "config", title: "Refactor config loading" });
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

    test("maps NoObjectGeneratedError to a sanitized unknown message", () => {
      const parseFailure = new NoObjectGeneratedError({
        message:
          "No object generated: could not parse the response. [cause: JSON parsing failed: Text: Based on ...]",
        text: "Based on the issue, **name**: `db-encrypt`, **title**: `Encrypt git SSH private keys`",
        response: {
          id: "resp_123",
          timestamp: new Date("2026-01-01T00:00:00Z"),
          modelId: "gpt-4o-mini",
        },
        usage: {
          inputTokens: undefined,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: undefined,
          outputTokenDetails: {
            textTokens: undefined,
            reasoningTokens: undefined,
          },
          totalTokens: undefined,
        },
        finishReason: "stop",
      });

      expect(mapNameGenerationError(parseFailure, "openai:gpt-4.1-mini")).toEqual({
        type: "unknown",
        raw: "The model returned an unexpected format while generating a workspace name.",
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
