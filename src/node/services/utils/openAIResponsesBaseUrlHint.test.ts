import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";

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
  providerId?: string;
  baseUrlResolved?: string;
  wireFormat?: "responses" | "chatCompletions";
  statusCode?: number;
}): string | undefined {
  return getOpenAIResponsesBaseUrlHint({
    providerId: options.providerId ?? "openai",
    baseUrlResolved: options.baseUrlResolved,
    wireFormat: options.wireFormat ?? "responses",
    error: createApiCallError(options.statusCode ?? 400),
  });
}

describe("getOpenAIResponsesBaseUrlHint", () => {
  test("returns a hint for Responses requests to a custom OpenAI base URL", () => {
    const hint = getHint({ baseUrlResolved: "http://localhost:8080/v1" });

    expect(hint).toBeDefined();
    expect(hint?.length).toBeGreaterThan(0);
  });

  test.each([
    {
      name: "chat completions wire format",
      options: {
        baseUrlResolved: "http://localhost:8080/v1",
        wireFormat: "chatCompletions" as const,
      },
    },
    { name: "no configured base URL", options: {} },
    {
      name: "default OpenAI base URL",
      options: { baseUrlResolved: "https://api.openai.com/v1" },
    },
    {
      name: "non-OpenAI provider",
      options: { providerId: "local", baseUrlResolved: "http://localhost:8080/v1" },
    },
    {
      name: "auth error",
      options: { baseUrlResolved: "http://localhost:8080/v1", statusCode: 401 },
    },
  ])("omits the hint for $name", ({ options }) => {
    expect(getHint(options)).toBeUndefined();
  });

  test.each([400, 404, 405])("returns a hint for HTTP %s", (statusCode) => {
    expect(getHint({ baseUrlResolved: "http://localhost:8080/v1", statusCode })).toBeDefined();
  });
});
