import { generateObject } from "ai";
import { z } from "zod";
import type { AIService } from "./aiService";
import { log } from "./log";
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

/**
 * Generate a placeholder name from the user's message for immediate display
 * while the AI generates the real title. This is git-safe and human-readable.
 */
export function generatePlaceholderName(message: string): string {
  const truncated = message.slice(0, 40).trim();
  return sanitizeBranchName(truncated, 30) || "new-workspace";
}
