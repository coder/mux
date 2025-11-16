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
 * Generate workspace name using AI
 * Falls back to timestamp-based name if AI generation fails
 * @param message - The user's first message
 * @param modelString - Model string from send message options (e.g., "anthropic:claude-3-5-sonnet-20241022")
 * @param config - Config instance for provider access
 */
export async function generateWorkspaceName(
  message: string,
  modelString: string,
  config: Config
): Promise<string> {
  try {
    const model = getModelForTitleGeneration(modelString, config);

    if (!model) {
      // No providers available, use fallback immediately
      return createFallbackName();
    }

    const result = await generateObject({
      model,
      schema: workspaceNameSchema,
      prompt: `Generate a git-safe branch/workspace name for this development task:

"${message}"

Requirements:
- Git-safe identifier (e.g., "automatic-title-generation")
- Lowercase, hyphens only, no spaces
- Concise (2-5 words) and descriptive of the task`,
    });

    return validateBranchName(result.object.name);
  } catch (error) {
    log.error("Failed to generate workspace name with AI, using fallback", error);
    return createFallbackName();
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
