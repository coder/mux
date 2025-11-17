import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { Config } from "@/node/config";
import { log } from "./log";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { MODEL_NAMES } from "@/common/constants/knownModels";

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
 * this function throws a SendMessageError-compatible object so callers can surface
 * the same provider error UX used elsewhere in the app.
 */
export async function generateWorkspaceName(
  message: string,
  modelString: string,
  config: Config
): Promise<string> {
  try {
    const model = getModelForTitleGeneration(modelString, config);

    if (!model) {
      // No usable model — infer error from modelString + providers config like sendMessage does
      const [providerName, modelId] = modelString.split(":", 2);
      if (!providerName || !modelId) {
        throw { type: "invalid_model_string", message: `Invalid model string format: "${modelString}". Expected "provider:model-id"` };
      }
      const providers = config.loadProvidersConfig();
      const hasProvider = Boolean(providers && providers[providerName]);
      if (!hasProvider || !providers?.[providerName]?.apiKey) {
        throw { type: "api_key_not_found", provider: providerName };
      }
      throw { type: "provider_not_supported", provider: providerName };
    }

    const result = await generateObject({
      model,
      schema: workspaceNameSchema,
      prompt: `Generate a git-safe branch/workspace name for this development task:\n\n"${message}"\n\nRequirements:\n- Git-safe identifier (e.g., "automatic-title-generation")\n- Lowercase, hyphens only, no spaces\n- Concise (2-5 words) and descriptive of the task`,
    });

    return validateBranchName(result.object.name);
  } catch (error) {
    // If error is already a structured SendMessageError, rethrow as-is
    if (error && typeof error === "object" && "type" in (error as Record<string, unknown>)) {
      throw error;
    }
    const messageText = error instanceof Error ? error.message : String(error);
    log.error("Failed to generate workspace name with AI", error);
    throw { type: "unknown", raw: `Failed to generate workspace name: ${messageText}` };
  }
}

/**
 * Get model for title generation - prefers fast/cheap models
 * Priority: Haiku 4.5 (Anthropic) → GPT-5-mini (OpenAI) → fallback to user's model
 * Falls back to null if no provider configured
 */
function getModelForTitleGeneration(modelString: string, config: Config): LanguageModel | null {
  const providersConfig = config.loadProvidersConfig();

  if (!providersConfig) {
    return null;
  }

  try {
    // Try Anthropic Haiku first (fastest/cheapest)
    if (providersConfig.anthropic?.apiKey) {
      const provider = createAnthropic({
        apiKey: String(providersConfig.anthropic.apiKey),
      });
      return provider(MODEL_NAMES.anthropic.HAIKU);
    }

    // Try OpenAI GPT-5-mini second
    if (providersConfig.openai?.apiKey) {
      const provider = createOpenAI({
        apiKey: String(providersConfig.openai.apiKey),
      });
      return provider(MODEL_NAMES.openai.GPT_MINI);
    }

    // Parse user's model as fallback
    const [providerName, modelId] = modelString.split(":", 2);
    if (!providerName || !modelId) {
      log.error("Invalid model string format:", modelString);
      return null;
    }

    if (providerName === "anthropic" && providersConfig.anthropic?.apiKey) {
      const provider = createAnthropic({
        apiKey: String(providersConfig.anthropic.apiKey),
      });
      return provider(modelId);
    }

    if (providerName === "openai" && providersConfig.openai?.apiKey) {
      const provider = createOpenAI({
        apiKey: String(providersConfig.openai.apiKey),
      });
      return provider(modelId);
    }

    log.error(`Provider ${providerName} not configured or not supported`);
    return null;
  } catch (error) {
    log.error(`Failed to create model for title generation`, error);
    return null;
  }
}

/**
 * Create fallback name using timestamp
 * NOTE: Not used by current flow; kept for potential future use.
 */
function createFallbackName(): string {
  const timestamp = Date.now().toString(36);
  return `chat-${timestamp}`;
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
