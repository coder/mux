import { generateObject } from "ai";
import { z } from "zod";
import type { AIService } from "./aiService";
import { log } from "./log";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import { getKnownModel } from "@/common/constants/knownModels";

/** Models to try in order of preference for name generation (small, fast models) */
const PREFERRED_MODELS = [getKnownModel("HAIKU").id, getKnownModel("GPT_MINI").id] as const;

const workspaceNameSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(3)
    .max(50)
    .describe("Git-safe branch/workspace name: lowercase, hyphens only"),
});

/**
 * Get the preferred model for name generation by testing which models the AIService
 * can actually create. This delegates credential checking to AIService, avoiding
 * duplication of provider-specific API key logic.
 */
export async function getPreferredNameModel(aiService: AIService): Promise<string | null> {
  for (const modelId of PREFERRED_MODELS) {
    const result = await aiService.createModel(modelId);
    if (result.success) {
      return modelId;
    }
    // If it's an API key error, try the next model; other errors are also skipped
  }
  return null;
}

/**
 * Generate workspace name using AI.
 * If AI cannot be used (e.g. missing credentials, unsupported provider, invalid model),
 * returns a SendMessageError so callers can surface the standard provider error UX.
 */
export async function generateWorkspaceName(
  message: string,
  modelString: string,
  aiService: AIService
): Promise<Result<string, SendMessageError>> {
  try {
    const modelResult = await aiService.createModel(modelString);
    if (!modelResult.success) {
      return Err(modelResult.error);
    }

    const result = await generateObject({
      model: modelResult.data,
      schema: workspaceNameSchema,
      mode: "json",
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

/**
 * Validate and sanitize branch name to be git-safe
 */
function validateBranchName(name: string): string {
  return sanitizeBranchName(name, 50);
}
