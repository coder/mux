import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { Config } from "@/node/config";
import { log } from "./log";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { PROVIDER_REGISTRY } from "@/common/constants/providers";

import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";

const workspaceNameSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(3)
    .max(50)
    .describe("Git-safe branch/workspace name: lowercase, hyphens only"),
});

/**
 * Generate workspace name using AI.
 * If AI cannot be used (e.g. missing credentials, unsupported provider, invalid model),
 * returns a SendMessageError so callers can surface the standard provider error UX.
 */
export async function generateWorkspaceName(
  message: string,
  modelString: string,
  config: Config
): Promise<Result<string, SendMessageError>> {
  try {
    const model = await getModelForTitleGeneration(modelString, config);

    if (!model) {
      // Infer error from provider + config (mirrors createModel in aiService)
      const [providerName, modelId] = modelString.split(":", 2);
      if (!providerName || !modelId) {
        return Err({
          type: "invalid_model_string",
          message: `Invalid model string format: "${modelString}". Expected "provider:model-id"`,
        });
      }

      const providers = config.loadProvidersConfig();

      // Require API keys for providers that need them
      if (
        (providerName === "anthropic" ||
          providerName === "openai" ||
          providerName === "openrouter") &&
        !providers?.[providerName]?.apiKey
      ) {
        return Err({ type: "api_key_not_found", provider: providerName });
      }

      // Unknown/unsupported provider
      return Err({ type: "provider_not_supported", provider: providerName });
    }

    const result = await generateObject({
      model,
      schema: workspaceNameSchema,
      prompt: `Generate a git-safe branch/workspace name for this development task:\n\n"${message}"\n\nRequirements:\n- Git-safe identifier (e.g., "automatic-title-generation")\n- Lowercase, hyphens only, no spaces\n- Concise (2-5 words) and descriptive of the task`,
    });

    return Ok(validateBranchName(result.object.name));
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    log.error("Failed to generate workspace name with AI", error);
    return Err({ type: "unknown", raw: `Failed to generate workspace name: ${messageText}` });
  }
}

/**
 * Get model for title generation - prefers fast/cheap models
 * Priority: Haiku 4.5 (Anthropic) → GPT-5-mini (OpenAI) → fallback to user's model
 * Falls back to null if no provider configured
 */
async function getModelForTitleGeneration(
  modelString: string,
  config: Config
): Promise<LanguageModel | null> {
  const providersConfig = config.loadProvidersConfig();

  if (!providersConfig) {
    return null;
  }

  try {
    // Use exactly what the user selected. Prefer their model over any defaults.
    const [providerName, modelId] = modelString.split(":", 2);
    if (!providerName || !modelId) {
      log.error("Invalid model string format:", modelString);
      return null;
    }

    if (providerName === "anthropic") {
      if (!providersConfig.anthropic?.apiKey) return null;
      const provider = createAnthropic({ apiKey: String(providersConfig.anthropic.apiKey) });
      return provider(modelId);
    }

    if (providerName === "openai") {
      if (!providersConfig.openai?.apiKey) return null;
      const provider = createOpenAI({ apiKey: String(providersConfig.openai.apiKey) });
      // Use Responses API model variant to match aiService
      return provider.responses(modelId);
    }

    if (providerName === "openrouter") {
      if (!providersConfig.openrouter?.apiKey) return null;
      const { createOpenRouter } = await PROVIDER_REGISTRY.openrouter();
      const provider = createOpenRouter({
        apiKey: String(providersConfig.openrouter.apiKey),
        baseURL: providersConfig.openrouter.baseUrl,
        headers: providersConfig.openrouter.headers as Record<string, string> | undefined,
      });
      return provider(modelId);
    }

    if (providerName === "ollama") {
      const { createOllama } = await PROVIDER_REGISTRY.ollama();
      const provider = createOllama({
        baseURL: (providersConfig.ollama?.baseUrl ?? providersConfig.ollama?.baseURL) as
          | string
          | undefined,
      });
      return provider(modelId);
    }

    // Unknown provider
    log.error(`Provider ${providerName} not configured or not supported for titles`);
    return null;
  } catch (error) {
    log.error(`Failed to create model for title generation`, error);
    return null;
  }
}

/**
 * Validate and sanitize branch name to be git-safe
 */
function validateBranchName(name: string): string {
  // Ensure git-safe
  const cleaned = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  // Remove leading/trailing hyphens and collapse multiple hyphens
  return cleaned
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .substring(0, 50);
}
