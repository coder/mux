import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";

import type { ProvidersConfigMap } from "@/common/orpc/types";
import { getOpenAIResponsesBaseUrlHint } from "./openAIResponsesBaseUrlHint";

function createApiCallError(statusCode: number): APICallError {
  return new APICallError({
    message: "request failed",
    url: "http://localhost:8080/v1/responses",
    requestBodyValues: {},
    statusCode,
    responseHeaders: {},
    responseBody: "{}",
    isRetryable: false,
  });
}

function getHint(options: {
  model?: string;
  openAIConfig?: Pick<NonNullable<ProvidersConfigMap["openai"]>, "baseUrl" | "wireFormat">;
  statusCode?: number;
}): string | undefined {
  return getOpenAIResponsesBaseUrlHint({
    model: options.model ?? "openai:test-model",
    providersConfig: options.openAIConfig
      ? {
          openai: {
            apiKeySet: false,
            isEnabled: true,
            isConfigured: true,
            ...options.openAIConfig,
          },
        }
      : {},
    error: createApiCallError(options.statusCode ?? 400),
  });
}

describe("getOpenAIResponsesBaseUrlHint", () => {
  test("returns a hint for Responses requests to a custom OpenAI base URL", () => {
    const hint = getHint({
      openAIConfig: { baseUrl: "http://localhost:8080/v1", wireFormat: "responses" },
    });

    expect(hint).toContain("Wire format");
  });

  test.each([
    {
      name: "chat completions wire format",
      options: {
        openAIConfig: {
          baseUrl: "http://localhost:8080/v1",
          wireFormat: "chatCompletions" as const,
        },
      },
    },
    { name: "default OpenAI base URL", options: { openAIConfig: {} } },
    {
      name: "non-OpenAI provider",
      options: {
        model: "local:test-model",
        openAIConfig: { baseUrl: "http://localhost:8080/v1" },
      },
    },
    {
      name: "server error",
      options: {
        openAIConfig: { baseUrl: "http://localhost:8080/v1" },
        statusCode: 500,
      },
    },
  ])("omits the hint for $name", ({ options }) => {
    expect(getHint(options)).toBeUndefined();
  });
});
