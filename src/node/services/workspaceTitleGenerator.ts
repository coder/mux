import { generateObject } from "ai";
import { z } from "zod";
import type { AIService } from "./aiService";
import { log } from "./log";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import crypto from "crypto";

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

export interface GenerateWorkspaceIdentityResult extends WorkspaceIdentity {
  /** The model that successfully generated the identity */
  modelUsed: string;
}

/**
 * Generate workspace identity (name + title) using AI.
 * Tries candidates in order, retrying on API errors (invalid keys, quota, etc.).
 *
 * - name: Codebase area with 4-char suffix (e.g., "sidebar-a1b2")
 * - title: Human-readable description (e.g., "Fix plan mode over SSH")
 */
export async function generateWorkspaceIdentity(
  message: string,
  candidates: string[],
  aiService: AIService
): Promise<Result<GenerateWorkspaceIdentityResult, SendMessageError>> {
  if (candidates.length === 0) {
    return Err({ type: "unknown", raw: "No model candidates provided for name generation" });
  }

  // Try up to 3 candidates
  const maxAttempts = Math.min(candidates.length, 3);

  // Track the last API error to return if all candidates fail
  let lastApiError: string | undefined;

  for (let i = 0; i < maxAttempts; i++) {
    const modelString = candidates[i];

    const modelResult = await aiService.createModel(modelString);
    if (!modelResult.success) {
      // No credentials for this model, try next
      log.debug(`Name generation: skipping ${modelString} (${modelResult.error.type})`);
      continue;
    }

    try {
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
        modelUsed: modelString,
      });
    } catch (error) {
      // API error (invalid key, quota, network, etc.) - try next candidate
      lastApiError = error instanceof Error ? error.message : String(error);
      log.warn(`Name generation failed with ${modelString}, trying next candidate`, {
        error: lastApiError,
      });
      continue;
    }
  }

  // Return the last API error if available (more actionable than generic message)
  const errorMessage = lastApiError
    ? `Name generation failed: ${lastApiError}`
    : "Name generation failed - no working model found";
  return Err({ type: "unknown", raw: errorMessage });
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
