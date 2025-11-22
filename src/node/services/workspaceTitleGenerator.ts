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
