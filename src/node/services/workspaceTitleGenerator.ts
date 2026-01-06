import { generateObject } from "ai";
import { z } from "zod";
import type { AIService } from "./aiService";
import { log } from "./log";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import crypto from "crypto";
import { KNOWN_MODELS, getKnownModel } from "@/common/constants/knownModels";

/** Small, fast models preferred for name generation (cheap and quick) */
const DEFAULT_NAME_GENERATION_MODELS = [getKnownModel("HAIKU").id, getKnownModel("GPT_MINI").id];

/** Schema for AI-generated workspace identity (area name + descriptive title) */
const workspaceIdentitySchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(2)
    .max(20)
    .describe(
      "Codebase area (1-2 words): lowercase, hyphens only, e.g. 'sidebar', 'auth', 'config'"
    ),
  title: z
    .string()
    .min(5)
    .max(60)
    .describe("Human-readable title (2-5 words): verb-noun format like 'Fix plan mode'"),
});

export interface WorkspaceIdentity {
  /** Codebase area with 4-char suffix (e.g., "sidebar-a1b2", "auth-k3m9") */
  name: string;
  /** Human-readable title (e.g., "Fix plan mode over SSH") */
  title: string;
}

/**
 * Find the first model from the list that the AIService can create.
 * Frontend is responsible for providing models in the correct format
 * (direct or gateway) based on user configuration.
 */
export async function findAvailableModel(
  aiService: AIService,
  models: string[]
): Promise<string | null> {
  for (const modelId of models) {
    const result = await aiService.createModel(modelId);
    if (result.success) {
      return modelId;
    }
  }
  return null;
}

/**
 * Convert a model ID to a gateway variant (mux-gateway or openrouter).
 * e.g., toGatewayVariant("anthropic:claude-haiku-4-5", "mux-gateway") -> "mux-gateway:anthropic/claude-haiku-4-5"
 */
function toGatewayVariant(modelId: string, gateway: "mux-gateway" | "openrouter"): string {
  const [provider, model] = modelId.split(":");
  if (!provider || !model) return modelId;
  return `${gateway}:${provider}/${model}`;
}

/**
 * Select a model for name generation with intelligent fallback.
 *
 * Priority order:
 * 1. Try preferred models (Haiku, GPT-Mini) directly
 * 2. Try Mux Gateway variants of preferred models
 * 3. Try OpenRouter variants of preferred models
 * 4. Try user's selected model (for Ollama/Bedrock/custom providers)
 * 5. Fallback to any available model from the known models list
 *
 * This ensures name generation works with any provider setup:
 * direct API keys, Mux Gateway (coupon), OpenRouter, or custom providers.
 *
 * Note: createModel() validates provider configuration internally,
 * returning Err({ type: "api_key_not_found" }) for unconfigured providers.
 * We only use models where createModel succeeds.
 */
export async function selectModelForNameGeneration(
  aiService: Pick<AIService, "createModel">,
  preferredModels: string[] = DEFAULT_NAME_GENERATION_MODELS,
  userModel?: string
): Promise<string | null> {
  // 1. Try preferred models directly
  for (const modelId of preferredModels) {
    const result = await aiService.createModel(modelId);
    if (result.success) {
      return modelId;
    }
  }

  // 2. Try Mux Gateway variants of preferred models
  for (const modelId of preferredModels) {
    const gatewayVariant = toGatewayVariant(modelId, "mux-gateway");
    const result = await aiService.createModel(gatewayVariant);
    if (result.success) {
      return gatewayVariant;
    }
  }

  // 3. Try OpenRouter variants of preferred models
  for (const modelId of preferredModels) {
    const openRouterVariant = toGatewayVariant(modelId, "openrouter");
    const result = await aiService.createModel(openRouterVariant);
    if (result.success) {
      return openRouterVariant;
    }
  }

  // 4. Try user's selected model (supports Ollama, Bedrock, custom providers)
  if (userModel) {
    const result = await aiService.createModel(userModel);
    if (result.success) {
      return userModel;
    }
  }

  // 5. Fallback to any available model from known models
  // Try each known model directly, then via gateway/OpenRouter
  const knownModelIds = Object.values(KNOWN_MODELS).map((m) => m.id);
  for (const modelId of knownModelIds) {
    // Try direct first
    const directResult = await aiService.createModel(modelId);
    if (directResult.success) {
      return modelId;
    }

    // Try Mux Gateway variant
    const gatewayVariant = toGatewayVariant(modelId, "mux-gateway");
    const gatewayResult = await aiService.createModel(gatewayVariant);
    if (gatewayResult.success) {
      return gatewayVariant;
    }

    // Try OpenRouter variant
    const openRouterVariant = toGatewayVariant(modelId, "openrouter");
    const openRouterResult = await aiService.createModel(openRouterVariant);
    if (openRouterResult.success) {
      return openRouterVariant;
    }
  }

  // No models available at all
  return null;
}

// Crockford Base32 alphabet (excludes I, L, O, U to avoid confusion)
const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Generate a 4-character random suffix using Crockford Base32.
 * Uses 20 bits of randomness (4 chars × 5 bits each).
 */
function generateNameSuffix(): string {
  const bytes = crypto.randomBytes(3); // 24 bits, we'll use 20
  const value = (bytes[0] << 12) | (bytes[1] << 4) | (bytes[2] >> 4);
  return (
    CROCKFORD_ALPHABET[(value >> 15) & 0x1f] +
    CROCKFORD_ALPHABET[(value >> 10) & 0x1f] +
    CROCKFORD_ALPHABET[(value >> 5) & 0x1f] +
    CROCKFORD_ALPHABET[value & 0x1f]
  );
}

/**
 * Generate workspace identity (name + title) using AI.
 * - name: Codebase area with 4-char suffix (e.g., "sidebar-a1b2")
 * - title: Human-readable description (e.g., "Fix plan mode over SSH")
 *
 * If AI cannot be used (e.g. missing credentials, unsupported provider, invalid model),
 * returns a SendMessageError so callers can surface the standard provider error UX.
 */
export async function generateWorkspaceIdentity(
  message: string,
  modelString: string,
  aiService: AIService
): Promise<Result<WorkspaceIdentity, SendMessageError>> {
  try {
    const modelResult = await aiService.createModel(modelString);
    if (!modelResult.success) {
      return Err(modelResult.error);
    }

    const result = await generateObject({
      model: modelResult.data,
      schema: workspaceIdentitySchema,
      mode: "json",
      prompt: `Generate a workspace name and title for this development task:

"${message}"

Requirements:
- name: The area of the codebase being worked on (1-2 words, git-safe: lowercase, hyphens only). Random bytes will be appended for uniqueness, so focus on the area not the specific task. Examples: "sidebar", "auth", "config", "api"
- title: A 2-5 word description in verb-noun format. Examples: "Fix plan mode", "Add user authentication", "Refactor sidebar layout"`,
    });

    const suffix = generateNameSuffix();
    const sanitizedName = sanitizeBranchName(result.object.name, 20);
    const nameWithSuffix = `${sanitizedName}-${suffix}`;

    return Ok({
      name: nameWithSuffix,
      title: result.object.title.trim(),
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    log.error("Failed to generate workspace identity with AI", error);
    return Err({ type: "unknown", raw: `Failed to generate workspace identity: ${messageText}` });
  }
}

/**
 * @deprecated Use generateWorkspaceIdentity instead
 * Generate workspace name using AI (legacy function for backwards compatibility).
 */
export async function generateWorkspaceName(
  message: string,
  modelString: string,
  aiService: AIService
): Promise<Result<string, SendMessageError>> {
  const result = await generateWorkspaceIdentity(message, modelString, aiService);
  if (!result.success) {
    return result;
  }
  return Ok(result.data.name);
}

/**
 * Sanitize a string to be git-safe: lowercase, hyphens only, no leading/trailing hyphens.
 */
function sanitizeBranchName(name: string, maxLength: number): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .substring(0, maxLength);
}
