import type { ProvidersConfigMap } from "@/common/orpc/types";
import { APICallError, RetryError } from "ai";

const OPENAI_RESPONSES_BASE_URL_HINT =
  "Your custom base URL may not support the OpenAI Responses API. In Settings -> Providers -> OpenAI set Wire format to Chat completions, or add the endpoint as a custom OpenAI-compatible provider.";

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
  model: string;
  providersConfig: ProvidersConfigMap | null;
  error: unknown;
}): string | undefined {
  if (!options.model.startsWith("openai:")) {
    return undefined;
  }

  const openAIConfig = options.providersConfig?.openai;
  if (!openAIConfig?.baseUrl?.trim() || openAIConfig.wireFormat === "chatCompletions") {
    return undefined;
  }

  const statusCode = getApiCallError(options.error)?.statusCode;
  if (statusCode !== 400 && statusCode !== 404 && statusCode !== 405) {
    return undefined;
  }

  return OPENAI_RESPONSES_BASE_URL_HINT;
}
