import { APICallError, RetryError } from "ai";

const OPENAI_RESPONSES_BASE_URL_HINT =
  "Your custom OpenAI base URL may not support the Responses API. In Settings -> Providers -> OpenAI set Wire format to 'chat completions', or add the endpoint as a custom OpenAI-compatible provider instead.";

function getApiCallError(error: unknown): APICallError | undefined {
  if (APICallError.isInstance(error)) {
    return error;
  }

  if (RetryError.isInstance(error) && error.lastError && APICallError.isInstance(error.lastError)) {
    return error.lastError;
  }

  return undefined;
}

export function getOpenAIResponsesBaseUrlHint(options: {
  providerId: string;
  baseUrlConfigured: string | undefined;
  wireFormat: "responses" | "chatCompletions";
  error: unknown;
}): string | undefined {
  if (options.providerId !== "openai" || options.wireFormat !== "responses") {
    return undefined;
  }

  const baseUrl = options.baseUrlConfigured?.trim();
  if (!baseUrl) {
    return undefined;
  }

  try {
    if (new URL(baseUrl).hostname.toLowerCase() === "api.openai.com") {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const statusCode = getApiCallError(options.error)?.statusCode;
  if (statusCode !== 400 && statusCode !== 404 && statusCode !== 405) {
    return undefined;
  }

  return OPENAI_RESPONSES_BASE_URL_HINT;
}
